import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentity } from '../src/identity.js';
import { decodeCard, decodeRecord, encodeCard, encodeRecord } from '../src/records.js';
import { createStore } from '../src/store.js';
import { HUB_FRAME_MAX, HUB_WATCH_MAX, TCP_HELLO_FRAME_MAX, encodeFrame } from '../src/transport/frames.js';
import { makeProofs, newHandshakeNonce, proofSigner } from '../src/transport/handshake.js';
import { createHubEndpoint, resolveHubConfig } from '../src/transport/hubClient.js';
import { routeKey } from '../src/transport/index.js';
import { TCP_REDIAL_MAX_MS, createTcpEndpoint } from '../src/transport/tcp.js';
import { fakeClock, makeInstall, silentLog, tmpDir } from './helpers.mjs';
import { hubNode, lyingHub, rawHubLink, startHub, tunnelPeer } from './hubHelpers.mjs';
import { freePort, memCursors, personal, rawConnect, settle, stubSink, stubView, waitFor } from './tcpHelpers.mjs';

// The hub and the hub client over real loopback sockets on ephemeral ports. Engines run with an hour-long maintain
// interval: every sync is driven by the test. Each test closes every hub, link and engine it opened.

const newIdentity = () => loadIdentity(tmpDir('code-inbox-id-'));
const announceOf = (identity, addr = []) => encodeRecord(identity, { type: 'announce', signer: identity.fp, ts: Date.now(), name: `n${identity.fp.slice(0, 6)}`, addr }).bytes;
const cardOf = (identity) => encodeCard(announceOf(identity));
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const randomFp = () => crypto.randomBytes(32).toString('hex');
const closeAll = (t, ...things) => t.after(async () => { for (const x of things) await (x.close ?? x.destroy).call(x); });
const header = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const of = (frames, t) => frames.filter((f) => f.t === t);
const sessionsWith = (node, fp) => node.transport.stats().sessions.filter((s) => s.remote.includes(fp));

// ---- routing ----

// Invariant: the hub routes only by proven fingerprint: a stream reaches the one link that registered its target,
// nobody else hears of it, and an open to an unregistered fp or to the opener's own is ABSENT.
test('the hub routes a stream only to the link that proved its target', async (t) => {
  const { hub, port } = await startHub(t);
  const [a, b, c] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const A = await rawHubLink(port, [a]);
  const B = await rawHubLink(port, [b]);
  const C = await rawHubLink(port, [c]);
  closeAll(t, A, B, C);
  A.send({ t: 'open', s: 1, to: b.fp });
  const incoming = await B.nextOf('incoming');
  assert.equal(incoming.s % 2, 0);
  A.send({ t: 'data', s: 1, b: 'aGVsbG8' });
  assert.deepEqual(await B.nextOf('data'), { t: 'data', s: incoming.s, b: 'aGVsbG8' });
  B.send({ t: 'data', s: incoming.s, b: 'YmFjaw' });
  assert.deepEqual(await A.nextOf('data'), { t: 'data', s: 1, b: 'YmFjaw' });
  A.send({ t: 'open', s: 3, to: randomFp() });
  assert.deepEqual(await A.nextOf('close'), { t: 'close', s: 3, reason: 'ABSENT' });
  A.send({ t: 'open', s: 5, to: a.fp });
  assert.deepEqual(await A.nextOf('close'), { t: 'close', s: 5, reason: 'ABSENT' });
  A.send({ t: 'ping' });
  await A.nextOf('pong');
  assert.deepEqual(C.frames.map((f) => f.t).filter((x) => x !== 'ping'), ['hello', 'ok']);
  assert.equal(hub.stats().streams, 1);
});

// Invariant: an unauthenticated connection can make the hub write only its `hello`: no stream, no watch, no
// registered fingerprint, and a bad proof ends it with PROOF.
test('an unregistered connection can open no stream, watch nothing and learn nothing', async (t) => {
  const { hub, port } = await startHub(t);
  const b = await newIdentity();
  const B = await rawHubLink(port, [b]);
  closeAll(t, B);
  const tries = [
    [{ t: 'open', s: 1, to: b.fp }, 'PROTOCOL'],
    [{ t: 'watch', id: 1, fps: [b.fp] }, 'PROTOCOL'],
    [{ t: 'register', ids: [{ key: b64(b.publicRaw), sig: b64(crypto.randomBytes(64)) }] }, 'PROOF'],
  ];
  for (const [frame, reason] of tries) {
    const raw = await rawHubLink(port, [], { register: false });
    closeAll(t, raw);
    raw.send(frame);
    await raw.whenClosed;
    assert.deepEqual(raw.frames.map((f) => [f.t, f.reason]), [['hello', undefined], ['bye', reason]], frame.t);
  }
  assert.equal(hub.stats().handshakeFailures, 3);
  assert.deepEqual(B.frames.map((f) => f.t).filter((x) => x !== 'ping'), ['hello', 'ok']);
});

// Invariant: a registration proof is bound to both nonces and the role `hub`: it fails on any other connection, a
// proof of another role fails as a registration, and a hub proof relayed as a TCP dial proof is refused.
test('a registration proof from another connection or role is refused, and a hub proof is no TCP dial proof', async (t) => {
  const { port } = await startHub(t);
  const victim = await newIdentity();
  const first = await rawHubLink(port, [victim]);
  closeAll(t, first);
  // The proof the first connection registered with (Ed25519 signs deterministically), on a fresh connection.
  const ids = makeProofs([proofSigner(victim)], 'hub', first.myNonce, first.hubNonce, '');
  const replay = await rawHubLink(port, [], { register: false });
  closeAll(t, replay);
  replay.send({ t: 'register', ids });
  await replay.whenClosed;
  assert.equal(replay.frames.at(-1).reason, 'PROOF');
  // A dial proof over this connection's nonces is no registration.
  const role = await rawHubLink(port, [], { register: false });
  closeAll(t, role);
  role.send({ t: 'register', ids: makeProofs([proofSigner(victim)], 'dial', role.myNonce, role.hubNonce, '') });
  await role.whenClosed;
  assert.equal(role.frames.at(-1).reason, 'PROOF');

  // A hub that hands a client a TCP endpoint's nonce as its own gets a `hub` proof over it; relayed as a `prove`
  // to that endpoint, it is refused.
  const x = await newIdentity();
  const endpoint = createTcpEndpoint({ port: 0, syncMs: 3_600_000, log: silentLog });
  await endpoint.attach({ identity: proofSigner(x), view: stubView(), cursors: memCursors() }).start(stubSink());
  t.after(() => endpoint.close());
  const tcp = await rawConnect(endpoint.stats().listening.port);
  closeAll(t, tcp);
  const theirs = await tcp.nextOf('hello');
  const clientNonce = newHandshakeNonce();
  tcp.send({ t: 'hello', v: 1, nonce: clientNonce });
  tcp.send({ t: 'prove', target: x.fp, ids: makeProofs([proofSigner(victim)], 'hub', clientNonce, theirs.nonce, '') });
  await tcp.whenClosed;
  assert.equal(tcp.frames.at(-1).reason, 'PROOF');
});

// Invariant: newest registration wins: the older link is told DUPLICATE, its streams close GONE at their peers,
// watchers hear it leave and come back, and new opens reach the new link.
test('a second link proving the same fingerprint replaces the first', async (t) => {
  const { hub, port } = await startHub(t);
  const [a, b] = [await newIdentity(), await newIdentity()];
  const A = await rawHubLink(port, [a]);
  const B = await rawHubLink(port, [b]);
  closeAll(t, A, B);
  A.send({ t: 'watch', id: 1, fps: [b.fp] });
  assert.deepEqual(await A.nextOf('present'), { t: 'present', id: 1, fps: [b.fp] });
  A.send({ t: 'open', s: 1, to: b.fp });
  await B.nextOf('incoming');
  const B2 = await rawHubLink(port, [b]);
  closeAll(t, B2);
  await B.whenClosed;
  assert.deepEqual(B.frames.at(-1), { t: 'bye', reason: 'DUPLICATE' });
  await waitFor(() => of(A.frames, 'presence').length === 2, 'b to leave and come back');
  assert.deepEqual(of(A.frames, 'close'), [{ t: 'close', s: 1, reason: 'GONE' }]);
  assert.deepEqual(of(A.frames, 'presence'), [{ t: 'presence', fp: b.fp, online: false }, { t: 'presence', fp: b.fp, online: true }]);
  A.send({ t: 'open', s: 3, to: b.fp });
  assert.equal((await B2.nextOf('incoming')).t, 'incoming');
  assert.deepEqual([hub.stats().links, hub.stats().fps], [2, 2]);
});

// Invariant: a client pushed off by a duplicate registration (a copied identity) stops: no reconnect however long
// the clock runs, and the page shows HUB_DUPLICATE.
test('a hub client replaced by a duplicate stops reconnecting and shows HUB_DUPLICATE', async (t) => {
  const clock = fakeClock();
  const { hub, port, url } = await startHub(t);
  const alice = await hubNode('alice', { url, schedule: clock.schedule, now: clock.now });
  closeAll(t, alice);
  await waitFor(() => alice.connected(), 'alice registered');
  const copy = await rawHubLink(port, [alice.identity]);
  closeAll(t, copy);
  await waitFor(() => alice.transport.stats().hub.error?.code === 'HUB_DUPLICATE', 'HUB_DUPLICATE');
  for (let i = 0; i < 10; i += 1) { clock.advance(TCP_REDIAL_MAX_MS); await sleep(5); }
  assert.equal(hub.stats().links, 1);
  assert.equal(alice.connected(), false);
  assert.equal(alice.engine.state().transport.hub.error.code, 'HUB_DUPLICATE');
  assert.equal(copy.closed, false);
});

// Invariant (conductor note 2): a client that re-registers on its own (an identity detached from a shared
// endpoint, or a second one attached) is never stopped as a duplicate of itself: only the current link may record
// HUB_DUPLICATE.
test('a client that re-registers its own identities is not stopped as its own duplicate', async (t) => {
  const { hub, port, url } = await startHub(t);
  const endpoint = createHubEndpoint({ url, syncMs: 3_600_000, log: silentLog });
  const alice = await hubNode('alice', { url, endpoint });
  const carol = await hubNode('carol', { url, endpoint });
  t.after(async () => { await alice.close(); await carol.close(); endpoint.close(); });
  await waitFor(() => hub.stats().fps === 2 && alice.connected(), 'both identities on one link');
  assert.equal(hub.stats().links, 1);
  await carol.close();
  await waitFor(() => hub.stats().fps === 1 && hub.stats().links === 1 && alice.connected(), 'alice re-registered alone');
  await sleep(50);
  assert.equal(alice.connected(), true);
  assert.equal(alice.transport.stats().hub.error, null);
  // The link that is current takes streams.
  const m = await rawHubLink(port, [await newIdentity()]);
  closeAll(t, m);
  m.send({ t: 'open', s: 1, to: alice.fp });
  assert.equal((await m.tunnel(1).nextOf('hello')).t, 'hello');
});

// ---- end-to-end authenticity through an untrusted hub ----

// Invariant: the endpoint handshake binds the target end to end: a hub that routes A's stream for B to M gets no
// session, no peerOnline and nothing offered on either side.
test('a misrouting hub cannot make a session with the wrong identity', async (t) => {
  let ids = {};
  const lying = await lyingHub(t, { route: (to) => lying.linkOf(to === ids.bob ? ids.mallory : to) });
  const alice = await hubNode('alice', { url: lying.url });
  const bob = await hubNode('bob', { url: lying.url });
  const mallory = await hubNode('mallory', { url: lying.url });
  closeAll(t, alice, bob, mallory);
  ids = { bob: bob.fp, mallory: mallory.fp };
  await waitFor(() => alice.connected() && bob.connected() && mallory.connected(), 'all registered');
  await alice.engine.importCard(bob.card());
  await alice.engine.sync();
  await waitFor(() => alice.transport.stats().handshakeFailures >= 1, 'the misrouted handshake to fail');
  assert.ok(lying.received(lying.linkOf(alice.fp)).some((f) => f.t === 'open' && f.to === bob.fp));
  assert.deepEqual(alice.transport.stats().sessions, []);
  assert.deepEqual(mallory.transport.stats().sessions, []);
  assert.deepEqual([alice.online, mallory.online], [[], []]);
  assert.ok(!alice.offered.some((i) => i.writer === mallory.fp) && !mallory.offered.some((i) => i.writer === alice.fp));
  assert.ok(mallory.transport.stats().handshakeFailures >= 1);
});

// Invariant: the writer is the `from` the remote endpoint proved: a hub injecting into a relayed session can neither
// claim an unproven `from` (the session closes PROTOCOL) nor pass a third party's record as the proven peer's
// (ROUTE_MISMATCH).
test('a hub that forges from is refused end to end', async (t) => {
  const lying = await lyingHub(t);
  const alice = await hubNode('alice', { url: lying.url });
  const bob = await hubNode('bob', { url: lying.url });
  closeAll(t, alice, bob);
  await waitFor(() => alice.connected() && bob.connected(), 'both registered');
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  assert.equal(sessionsWith(alice, bob.fp).length, 1);
  const carol = await newIdentity();
  const atAlice = lying.linkOf(alice.fp);
  const s = lying.streamTo(atAlice, lying.linkOf(bob.fp));
  // A genuine announce of carol's, as if bob pushed it.
  lying.inject(atAlice, s, { t: 'rec', from: bob.fp, to: alice.fp, route: { kind: 'directory' }, rec: b64(announceOf(carol)) });
  await waitFor(() => alice.engine.state().diagnostics.recent.some((r) => r.reason === 'ROUTE_MISMATCH'), 'ROUTE_MISMATCH');
  // A `from` nobody proved on the session.
  const offered = alice.offered.length;
  lying.inject(atAlice, s, { t: 'rec', from: carol.fp, to: alice.fp, route: { kind: 'directory' }, rec: b64(announceOf(carol)) });
  await waitFor(() => sessionsWith(alice, bob.fp).length === 0, 'the session to close');
  assert.equal(alice.offered.length, offered);
  assert.ok(!alice.engine.state().directory.some((d) => d.fp === carol.fp));
});

// Invariant: peerOnline comes only from an end-to-end session, never the hub's word: a presence notice followed by
// a stream that answers garbage leaves the outbox as it was.
test('hub presence never fires peerOnline', async (t) => {
  const garbage = Buffer.concat([header(5), Buffer.from('{oops')]);
  const lying = await lyingHub(t, { onOpen: (link, f) => { link.send({ t: 'data', s: f.s, b: b64(garbage) }); return true; } });
  const alice = await hubNode('alice', { url: lying.url });
  closeAll(t, alice);
  await waitFor(() => alice.connected(), 'alice registered');
  const bob = await newIdentity();
  await alice.engine.importCard(cardOf(bob));
  await alice.engine.invite(bob.fp);
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  lying.notify(lying.linkOf(alice.fp), { t: 'presence', fp: bob.fp, online: true });
  await waitFor(() => alice.transport.stats().handshakeFailures >= 1, 'the garbage answer to fail the handshake');
  await alice.engine.sync();
  assert.deepEqual(alice.online, []);
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
});

// ---- delivery ----

// Invariant: the hub stores nothing: a record for an offline peer waits in the sender's outbox and goes out when
// the peer's session through the hub becomes ready.
test('an offline peer gets the record from the outbox when it comes back through the hub', async (t) => {
  const { url } = await startHub(t);
  const alice = await hubNode('alice', { url });
  let bob = await hubNode('bob', { url });
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  await bob.close();
  await waitFor(() => sessionsWith(alice, bob.fp).length === 0, 'alice to see bob leave');
  await alice.engine.sendMessage(inbox, 'while you were out');
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  bob = await hubNode('bob', { dataDir: bob.dataDir });
  await waitFor(() => bob.engine.messages(inbox).length === 1, 'the message');
  assert.deepEqual(bob.engine.messages(inbox).map((m) => m.body), ['while you were out']);
  await waitFor(() => alice.engine.state().diagnostics.outbox === 0, 'the outbox to drain');
  assert.ok(alice.online.includes(bob.fp));
});

// Invariant: many clients share one hub, and members known only by fingerprint reach each other through it with no
// whois (no install answers one).
test('many clients on one hub exchange a shared inbox', async (t) => {
  const { hub, url } = await startHub(t);
  let whois = 0;
  const counting = (node) => { const f = node.view.announceFor; node.view.announceFor = (...a) => { whois += 1; return f(...a); }; };
  const owner = await hubNode('owner', { url });
  const members = [];
  for (let i = 0; i < 6; i += 1) members.push(await hubNode(`m${i}`, { url }));
  const all = [owner, ...members];
  t.after(async () => { for (const n of all) await n.close(); });
  for (const n of all) counting(n);
  for (const m of members) await m.engine.importCard(owner.card());
  await settle(all);
  const { id: team } = await owner.engine.createSharedInbox('team');
  for (const m of members) await owner.engine.inviteMember(team, m.fp);
  await settle(all);
  for (const m of members) await m.engine.respondInvite(m.engine.state().invites.incoming[0].id, true);
  await settle(all, 3);
  for (const m of members) await m.engine.sendMessage(team, `from ${m.name}`);
  await settle(all, 3);
  const expected = members.map((m) => `from ${m.name}`).sort();
  for (const n of all) assert.deepEqual(n.engine.messages(team).map((x) => x.body).sort(), expected, n.name);
  assert.equal(hub.stats().links, 7);
  assert.equal(whois, 0);
});

// Invariant: least disclosure binds peers end to end through the hub: a stranger's pull is answered only for what
// it may read (denials carry no head), alice's pull names only routes the stranger could serve, and whois about
// someone the stranger shares no inbox with answers nothing.
test('least disclosure holds through the hub', async (t) => {
  const { port, url } = await startHub(t);
  const alice = await hubNode('alice', { url });
  const bob = await hubNode('bob', { url });
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  await alice.engine.sendMessage(inbox, 'private');
  const { id: team } = await alice.engine.createSharedInbox('team');
  const mallory = await newIdentity();
  const link = await rawHubLink(port, [mallory]);
  closeAll(t, link);
  const tun = await tunnelPeer(link, mallory, alice.fp);
  const pull = await tun.nextOf('pull');
  assert.deepEqual(pull.routes.map((r) => routeKey(r.route)).sort(), ['directory', `mailbox:${alice.fp}`]);
  const routes = [{ kind: 'inbox', id: inbox }, { kind: 'mailbox', fp: bob.fp }, { kind: 'directory' }];
  tun.send({ t: 'pull', id: 7, from: mallory.fp, to: alice.fp, routes: routes.map((route) => ({ route, since: 0 })) });
  const recs = await tun.nextOf('recs');
  assert.deepEqual(recs.routes.map((r) => [routeKey(r.route), r.status, (r.recs?.length ?? 0) > 0]), [[`inbox:${inbox}`, 'denied', false], [`mailbox:${bob.fp}`, 'denied', false], ['directory', 'ok', true]]);
  for (const r of recs.routes.slice(0, 2)) assert.deepEqual(Object.keys(r).sort(), ['route', 'status']);
  tun.send({ t: 'whois', id: 9, from: mallory.fp, to: alice.fp, fps: [bob.fp] });
  assert.deepEqual((await tun.nextOf('cards')).recs, []);
  await alice.engine.sync();
  for (const p of of(tun.frames, 'pull')) for (const r of p.routes) assert.ok(!routeKey(r.route).startsWith('inbox:'));
  assert.ok(!JSON.stringify(tun.frames.filter((f) => f.t === 'pull')).includes(team));
});

// Invariant: what the hub learns of a client's contacts is its dial set: the watch is exactly its contacts, and a
// stranger whose stream arrived is neither watched nor dialed.
test('a hub client watches only its dial set', async (t) => {
  const lying = await lyingHub(t);
  const alice = await hubNode('alice', { url: lying.url });
  closeAll(t, alice);
  await waitFor(() => alice.connected(), 'alice registered');
  const bob = await newIdentity();
  const carol = await newIdentity();
  await alice.engine.importCard(cardOf(bob));
  await alice.engine.importCard(cardOf(carol));
  await alice.engine.invite(carol.fp);
  await alice.engine.sync();
  const atAlice = lying.linkOf(alice.fp);
  const lastWatch = () => of(lying.received(atAlice), 'watch').at(-1).fps;
  assert.deepEqual(lastWatch(), [...alice.view.contacts()].sort());
  assert.deepEqual(lastWatch(), [bob.fp, carol.fp].sort());
  // A stranger dials in and pushes its announce; alice announces to everyone she knows, the stranger included.
  const mallory = await newIdentity();
  const link = await rawHubLink(lying.port, [mallory]);
  closeAll(t, link);
  const tun = await tunnelPeer(link, mallory, alice.fp);
  tun.send({ t: 'rec', from: mallory.fp, to: alice.fp, route: { kind: 'directory' }, rec: b64(announceOf(mallory)) });
  await waitFor(() => alice.engine.state().directory.some((d) => d.fp === mallory.fp), 'mallory in the directory');
  link.destroy();
  await waitFor(() => sessionsWith(alice, mallory.fp).length === 0, 'mallory to leave');
  lying.notify(atAlice, { t: 'presence', fp: mallory.fp, online: true });
  await alice.engine.announce();
  await alice.engine.sync();
  for (const w of of(lying.received(atAlice), 'watch')) assert.ok(!w.fps.includes(mallory.fp));
  assert.ok(!of(lying.received(atAlice), 'open').some((f) => f.to === mallory.fp));
});

// ---- the open port ----

// Invariant: framing on the hub's open port: size limits per phase are checked from the header, deadlines close
// stalled connections, and every schema violation ends the link with PROTOCOL.
test('hub framing limits close a link', async (t) => {
  const { hub, port } = await startHub(t, { limits: { handshakeMs: 200, frameMs: 100 } });
  const a = await newIdentity();
  const before = await rawHubLink(port, [], { register: false });
  closeAll(t, before);
  before.write(header(TCP_HELLO_FRAME_MAX + 1));
  await before.whenClosed;
  assert.equal(before.frames.at(-1).reason, 'LIMIT');
  const after = await rawHubLink(port, [a]);
  closeAll(t, after);
  after.write(header(HUB_FRAME_MAX + 1));
  await after.whenClosed;
  assert.equal(after.frames.at(-1).reason, 'LIMIT');
  const stalled = await rawHubLink(port, [], { register: false });
  closeAll(t, stalled);
  await stalled.whenClosed;
  const partial = await rawHubLink(port, [a]);
  closeAll(t, partial);
  partial.write(Buffer.concat([header(100), Buffer.from('{"t":')]));
  await partial.whenClosed;
  assert.equal(partial.frames.at(-1).reason, 'LIMIT');
  const violations = [
    { t: 'nope' },
    { t: 'ping', x: 1 },
    { t: 'open', s: 2, to: a.fp },
    { t: 'incoming', s: 2 },
    { t: 'data', s: 1, b: 'a+b/' },
    { t: 'watch', id: 1, fps: Array(HUB_WATCH_MAX + 1).fill(a.fp) },
  ];
  for (const f of violations) {
    const raw = await rawHubLink(port, [a]);
    closeAll(t, raw);
    raw.send(f);
    await raw.whenClosed;
    assert.deepEqual(raw.frames.at(-1), { t: 'bye', reason: 'PROTOCOL' }, JSON.stringify(f).slice(0, 60));
  }
  // A reopened stream id.
  const b = await newIdentity();
  const B = await rawHubLink(port, [b]);
  closeAll(t, B);
  const re = await rawHubLink(port, [a]);
  closeAll(t, re);
  re.send({ t: 'open', s: 1, to: b.fp });
  re.send({ t: 'open', s: 1, to: b.fp });
  await re.whenClosed;
  assert.deepEqual(re.frames.at(-1), { t: 'bye', reason: 'PROTOCOL' });
  assert.equal(hub.stats().links, 1);
});

// Invariant: per-client caps: links beyond maxLinks or maxHandshaking are destroyed at accept, opens beyond
// maxStreams (the opener's or the target's) get LIMIT, and a receiver that does not keep up loses only the stream,
// never its link.
test('hub connection and stream caps hold and a flooded receiver keeps its link', async (t) => {
  const accepted = [];
  const createServer = (onConn) => net.createServer((s) => { accepted.push(s); onConn(s); });
  const { hub, port } = await startHub(t, { limits: { maxLinks: 4, maxHandshaking: 1, maxStreams: 2, writeBufferMax: 4096 }, createServer });
  const [r, s, c] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const R = await rawHubLink(port, [r]);
  const S = await rawHubLink(port, [s]);
  closeAll(t, R, S);
  const handshaking = await rawHubLink(port, [], { register: false });
  closeAll(t, handshaking);
  const refused = await rawConnect(port);
  await refused.whenClosed;
  assert.deepEqual(refused.frames, []);
  handshaking.destroy();
  await waitFor(() => hub.stats().links === 2, 'the handshaking link to go');
  const C = await rawHubLink(port, [c]);
  closeAll(t, C);
  const extra = await rawHubLink(port, [], { register: false });
  closeAll(t, extra);
  const overLinks = await rawConnect(port);
  await overLinks.whenClosed;
  assert.deepEqual(overLinks.frames, []);
  extra.destroy();
  // Streams: S opens two to r, the third is over S's cap; C's open finds r at its cap.
  S.send({ t: 'open', s: 1, to: r.fp });
  S.send({ t: 'open', s: 3, to: r.fp });
  S.send({ t: 'open', s: 5, to: r.fp });
  assert.deepEqual(await S.nextOf('close'), { t: 'close', s: 5, reason: 'LIMIT' });
  C.send({ t: 'open', s: 1, to: r.fp });
  assert.deepEqual(await C.nextOf('close'), { t: 'close', s: 1, reason: 'LIMIT' });
  const toR = await R.nextOf('incoming');
  await R.nextOf('incoming');
  // R stops reading: the hub's writes to it stay buffered. One stream pushed past the cap is closed on both ends.
  accepted[0].cork();
  const chunk = 'A'.repeat(1500);
  for (let i = 0; i < 4; i += 1) S.send({ t: 'data', s: 1, b: chunk });
  assert.deepEqual(await S.nextOf('close'), { t: 'close', s: 1, reason: 'LIMIT' });
  accepted[0].uncork();
  await waitFor(() => R.frames.some((f) => f.t === 'close' && f.s === toR.s), 'the close at R');
  assert.deepEqual(R.frames.find((f) => f.t === 'close'), { t: 'close', s: toR.s, reason: 'LIMIT' });
  R.send({ t: 'ping' });
  await R.nextOf('pong');
  assert.equal(R.closed, false);
});

// Invariant (conductor note 1, hub side): what the hub holds toward a receiver is capped per stream, so a stream
// near its cap never closes another stream to the same receiver.
test('a slow receiver loses only the stream over its own cap', async (t) => {
  const accepted = [];
  const createServer = (onConn) => net.createServer((s) => { accepted.push(s); onConn(s); });
  const { port } = await startHub(t, { limits: { writeBufferMax: 8192 }, createServer });
  const [r, s1, s2] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const R = await rawHubLink(port, [r]);
  const S1 = await rawHubLink(port, [s1]);
  const S2 = await rawHubLink(port, [s2]);
  closeAll(t, R, S1, S2);
  S1.send({ t: 'open', s: 1, to: r.fp });
  S2.send({ t: 'open', s: 1, to: r.fp });
  await R.nextOf('incoming');
  await R.nextOf('incoming');
  accepted[0].cork();
  const chunk = 'B'.repeat(3000);
  for (let i = 0; i < 2; i += 1) S1.send({ t: 'data', s: 1, b: chunk });
  S1.send({ t: 'ping' });
  await S1.nextOf('pong');
  for (let i = 0; i < 2; i += 1) S2.send({ t: 'data', s: 1, b: chunk });
  S2.send({ t: 'ping' });
  await S2.nextOf('pong');
  accepted[0].uncork();
  await waitFor(() => of(R.frames, 'data').length === 4, 'all four chunks at R');
  assert.deepEqual([...of(S1.frames, 'close'), ...of(S2.frames, 'close'), ...of(R.frames, 'close')], []);
});

// Invariant (conductor note 1, client side): a session's back-pressure counts only its own unflushed bytes, so a
// session with bytes waiting on the shared hub link does not close another session on that link.
test('a busy session on a hub link does not close another session on it', async (t) => {
  const { url } = await startHub(t);
  let socket;
  const connect = (opts) => { socket = net.connect(opts); return socket; };
  const alice = await hubNode('alice', { url, connect, limits: { writeBufferMax: 20_000 } });
  const bob = await hubNode('bob', { url });
  const carol = await hubNode('carol', { url });
  const all = [alice, bob, carol];
  t.after(async () => { for (const n of all) await n.close(); });
  await bob.engine.importCard(alice.card());
  await carol.engine.importCard(alice.card());
  await settle(all);
  const withBob = await personal(alice, bob, all);
  const withCarol = await personal(alice, carol, all);
  assert.equal(sessionsWith(alice, bob.fp).length + sessionsWith(alice, carol.fp).length, 2);
  // Nothing alice writes leaves her process until uncorked; each message is about 60% of a session's cap.
  socket.cork();
  await alice.engine.sendMessage(withBob, 'b'.repeat(8000));
  await alice.engine.sendMessage(withCarol, 'c'.repeat(8000));
  assert.equal(alice.engine.state().diagnostics.outbox, 0);
  assert.equal(sessionsWith(alice, carol.fp).length, 1);
  socket.uncork();
  await waitFor(() => bob.engine.messages(withBob).length === 1 && carol.engine.messages(withCarol).length === 1, 'both messages');
});

// Invariant: the hub is stateless: after it restarts, clients reconnect, re-register and deliver what waited in
// their outboxes.
test('a hub restart: clients reconnect, re-register and deliver what waited', async (t) => {
  const first = await startHub(t);
  const limits = { redialMinMs: 20, redialMaxMs: 100 };
  const alice = await hubNode('alice', { url: first.url, limits });
  const bob = await hubNode('bob', { url: first.url, limits });
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  first.hub.close();
  await waitFor(() => !alice.connected() && sessionsWith(alice, bob.fp).length === 0, 'the hub to go');
  await alice.engine.sendMessage(inbox, 'after the restart');
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  const second = await startHub(t, { port: first.port });
  await waitFor(() => bob.engine.messages(inbox).length === 1, 'the message through the new hub', 5000);
  assert.deepEqual(bob.engine.messages(inbox).map((m) => m.body), ['after the restart']);
  assert.equal(second.hub.stats().links, 2);
});

// ---- settings ----

// Invariant: hub settings are checked like TCP and share settings: refused HUB_INVALID on a save (malformed,
// wildcard, unresolvable, too long), checked at boot where an unresolvable host still starts, resolved outside the
// engine lock, and the announce and card carry the hub address.
test('hub settings are validated on save and checked at boot', async (t) => {
  const install = await makeInstall(null);
  t.after(() => install.close());
  for (const url of ['tcp://127.0.0.1:5', 'hub://127.0.0.1:0', 'hub://0.0.0.0:5', 'hub://[::]:5', `hub://${'a'.repeat(250)}.example:5`, 'hub://127.0.0.1', 5]) {
    const res = await install.rest('POST', '/api/hub', { url });
    assert.deepEqual([res.status, res.json.code], [400, 'HUB_INVALID'], String(url));
  }
  const lookup = async (name) => {
    if (name === 'zero.example') return [{ address: '0.0.0.0', family: 4 }];
    if (name === 'hub.example') return [{ address: '127.0.0.1', family: 4 }];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  await assert.rejects(resolveHubConfig({ url: 'hub://zero.example:5' }, { lookup }), { code: 'HUB_INVALID' });
  await assert.rejects(resolveHubConfig({ url: 'hub://nowhere.example:5' }, { lookup }), { code: 'HUB_INVALID' });
  assert.deepEqual(await resolveHubConfig({ url: 'hub://nowhere.example:5' }, { lookup, mustResolve: false }), { url: 'hub://nowhere.example:5' });
  await assert.rejects(resolveHubConfig({ url: 'hub://zero.example:5' }, { lookup, mustResolve: false }), { code: 'HUB_INVALID' });
  assert.deepEqual(await resolveHubConfig({ url: 'hub://[::1]:5' }), { url: 'hub://[::1]:5' });

  // A stored hub whose host does not resolve yet still starts (and keeps trying); a malformed one starts nothing.
  const seeded = async (url) => {
    const dataDir = tmpDir('code-inbox-hub-');
    const store = createStore(dataDir, { log: silentLog });
    const { settings } = await store.load();
    await store.saveSettings({ ...settings, transport: { kind: 'hub', url } });
    return dataDir;
  };
  const deadPort = await freePort();
  const offline = await hubNode('offline', { dataDir: await seeded('hub://nowhere.example:5'), lookup, connect: () => net.connect({ host: '127.0.0.1', port: deadPort }) });
  closeAll(t, offline);
  assert.deepEqual([offline.engine.state().transport.kind, offline.engine.state().transport.configured, offline.engine.state().transport.error], ['hub', true, null]);
  await waitFor(() => offline.engine.state().transport.hub.error?.code === 'ECONNREFUSED', 'the refused connect to show');
  const malformed = await hubNode('bad', { dataDir: await seeded('hub://0.0.0.0:5'), lookup });
  closeAll(t, malformed);
  assert.equal(malformed.engine.state().transport.configured, false);
  assert.equal(malformed.engine.state().transport.error.code, 'HUB_INVALID');

  // The lookup runs before the engine lock is taken.
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = await hubNode('slow', { lookup: async (name) => { if (name === 'hub.example') await gate; return lookup(name); }, connect: () => net.connect({ host: '127.0.0.1', port: deadPort }) });
  closeAll(t, slow);
  await slow.engine.setTcp({ port: 0 });
  await slow.engine.announce();
  const saving = slow.engine.setHub({ url: 'hub://hub.example:9' });
  assert.deepEqual(await slow.engine.setName('slow2'), { name: 'slow2' }, 'another action ran while the lookup waited');
  release();
  assert.deepEqual(await saving, { url: 'hub://hub.example:9', addresses: ['hub://hub.example:9'] });
  const view = slow.engine.state().transport;
  assert.deepEqual([view.kind, view.url, view.addresses, view.cardStale], ['hub', 'hub://hub.example:9', ['hub://hub.example:9'], true]);
  await slow.engine.announce();
  assert.equal(slow.engine.state().transport.cardStale, false);
  assert.deepEqual(decodeRecord(decodeCard(slow.card())).payload.addr, ['hub://hub.example:9']);
});

// Invariant: the hub is standalone: nothing it imports reaches the plugin host's modules.
test('the hub imports nothing of the plugin host', () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'(\.[^']+)'/gm)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(root, 'hub.js'));
  const reached = [...seen].map((f) => path.relative(root, f));
  assert.ok(reached.includes(path.join('src', 'hub', 'hub.js')));
  const host = ['server.js', ...['engine', 'store', 'state', 'routes', 'http', 'mcp', 'notifier', 'cc', 'config'].map((m) => path.join('src', `${m}.js`))];
  assert.deepEqual(reached.filter((f) => host.includes(f)), []);
});
