import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentity } from '../src/identity.js';
import { ANNOUNCE_MAX_BYTES, decodeRecord, encodeCard, encodeRecord } from '../src/records.js';
import { HUB_FRAME_MAX, TCP_HELLO_FRAME_MAX } from '../src/transport/frames.js';
import { makeProofs, newHandshakeNonce, proofSigner } from '../src/transport/handshake.js';
import { routeKey } from '../src/transport/index.js';
import { TCP_REDIAL_MAX_MS, TCP_REDIAL_MIN_MS } from '../src/transport/endpoint.js';
import { createNetworkEndpoint } from '../src/transport/network.js';
import { fakeClock, silentLog, tmpDir } from './helpers.mjs';
import { lyingHub, rawHubLink, startHub, tunnelPeer } from './hubHelpers.mjs';
import { netNode } from './netHelpers.mjs';
import { helloFrame, memCursors, personal, rawConnect, settle, stubSink, stubView, waitFor } from './tcpHelpers.mjs';

// The hub and the hub mode of a connection over real loopback sockets on ephemeral ports. Engines run with an
// hour-long maintain interval: every sync is driven by the test. Each test closes every hub, link and engine it opened.

const newIdentity = () => loadIdentity(tmpDir('code-inbox-id-'));
const announceOf = (identity, name = `n${identity.fp.slice(0, 6)}`) => encodeRecord(identity, { type: 'announce', signer: identity.fp, ts: Date.now(), name }).bytes;
const cardOf = (identity) => encodeCard(announceOf(identity));
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const randomFp = () => crypto.randomBytes(32).toString('hex');
const closeAll = (t, ...things) => t.after(async () => { for (const x of things) await (x.close ?? x.destroy).call(x); });
const header = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const of = (frames, t) => frames.filter((f) => f.t === t);
const decodeRecordOf = (b64rec) => decodeRecord(Buffer.from(b64rec, 'base64url')).payload;
const sessionsWith = (node, fp) => node.transport.stats().sessions.filter((s) => s.remote.includes(fp));
// An engine whose one connection is the hub at `addr`.
const hubNode = (name, addr, opts = {}) => netNode(name, { listen: null, connections: [addr], ...opts });
const hubRow = (node) => node.transport.stats().connections[0];
const connected = (node) => hubRow(node)?.state === 'up';

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
  assert.deepEqual(C.frames.map((f) => f.t).filter((x) => !['ping', 'peer'].includes(x)), ['hello', 'ok']);
  assert.equal(hub.stats().streams, 1);
});

// Invariant: an unauthenticated connection can make the hub write only its `hello`: no stream, no announce, no
// registered fingerprint, no roster, and a bad proof ends it with PROOF.
test('an unregistered connection can open no stream, announce nothing and receive no roster', async (t) => {
  const { hub, port } = await startHub(t);
  const b = await newIdentity();
  const B = await rawHubLink(port, [b]);
  closeAll(t, B);
  const tries = [
    [{ t: 'open', s: 1, to: b.fp }, 'PROTOCOL'],
    [{ t: 'announce', rec: b64(announceOf(b)) }, 'PROTOCOL'],
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
  assert.equal(hub.stats().announces, 0);
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

  // A hub that hands a client an endpoint's nonce as its own gets a `hub` proof over it; relayed as a `prove` to that
  // endpoint's listener, it is refused.
  const x = await newIdentity();
  const endpoint = createNetworkEndpoint({ listen: { port: 0 }, syncMs: 3_600_000, log: silentLog });
  await endpoint.attach({ identity: proofSigner(x), view: stubView(), cursors: memCursors() }).start(stubSink());
  t.after(() => endpoint.close());
  const tcp = await rawConnect(endpoint.stats().listening.port);
  closeAll(t, tcp);
  const theirs = await tcp.nextOf('hello');
  const clientNonce = newHandshakeNonce();
  tcp.send(helloFrame(clientNonce));
  tcp.send({ t: 'prove', target: x.fp, ids: makeProofs([proofSigner(victim)], 'hub', clientNonce, theirs.nonce, '') });
  await tcp.whenClosed;
  assert.equal(tcp.frames.at(-1).reason, 'PROOF');
});

// Invariant: newest registration wins: the older link is told DUPLICATE, its streams close GONE at their peers, the
// roster keeps the fp present (no `gone`), and new opens reach the new link.
test('a second link proving the same fingerprint replaces the first', async (t) => {
  const { hub, port } = await startHub(t);
  const [a, b] = [await newIdentity(), await newIdentity()];
  const A = await rawHubLink(port, [a]);
  const B = await rawHubLink(port, [b]);
  closeAll(t, A, B);
  assert.deepEqual(await A.nextOf('peer'), { t: 'peer', fp: b.fp, rec: null });
  A.send({ t: 'open', s: 1, to: b.fp });
  await B.nextOf('incoming');
  const B2 = await rawHubLink(port, [b]);
  closeAll(t, B2);
  await B.whenClosed;
  assert.deepEqual(B.frames.at(-1), { t: 'bye', reason: 'DUPLICATE' });
  await waitFor(() => of(A.frames, 'peer').length === 2, 'b to be reported again');
  assert.deepEqual(of(A.frames, 'close'), [{ t: 'close', s: 1, reason: 'GONE' }]);
  assert.deepEqual(of(A.frames, 'gone'), []);
  A.send({ t: 'open', s: 3, to: b.fp });
  assert.equal((await B2.nextOf('incoming')).t, 'incoming');
  assert.deepEqual([hub.stats().links, hub.stats().fps], [2, 2]);
});

// Invariant: a client pushed off by a duplicate registration (a copied identity) stops: no reconnect however long
// the clock runs, and the page shows HUB_DUPLICATE.
test('a hub client replaced by a duplicate stops reconnecting and shows HUB_DUPLICATE', async (t) => {
  const clock = fakeClock();
  const { hub, port, addr } = await startHub(t);
  const alice = await hubNode('alice', addr, { schedule: clock.schedule, now: clock.now });
  closeAll(t, alice);
  await waitFor(() => connected(alice), 'alice registered');
  const copy = await rawHubLink(port, [alice.identity]);
  closeAll(t, copy);
  await waitFor(() => hubRow(alice).error?.code === 'HUB_DUPLICATE', 'HUB_DUPLICATE');
  for (let i = 0; i < 10; i += 1) { clock.advance(TCP_REDIAL_MAX_MS); await alice.engine.sync(); await sleep(5); }
  assert.equal(hub.stats().links, 1);
  assert.equal(hubRow(alice).state, 'stopped');
  assert.equal(alice.engine.state().transport.connections[0].error.code, 'HUB_DUPLICATE');
  assert.equal(copy.closed, false);
});

// Invariant (conductor note 2): a client that re-registers on its own (an identity detached from a shared
// endpoint, or a second one attached) is never stopped as a duplicate of itself: only the current link may record
// HUB_DUPLICATE.
test('a client that re-registers its own identities is not stopped as its own duplicate', async (t) => {
  const { hub, port, addr } = await startHub(t);
  const endpoint = createNetworkEndpoint({ connections: [addr], syncMs: 3_600_000, log: silentLog });
  const alice = await hubNode('alice', addr, { endpoint });
  const carol = await hubNode('carol', addr, { endpoint });
  t.after(async () => { await alice.close(); await carol.close(); endpoint.close(); });
  await waitFor(() => hub.stats().fps === 2 && connected(alice), 'both identities on one link');
  assert.equal(hub.stats().links, 1);
  await carol.close();
  await waitFor(() => hub.stats().fps === 1 && hub.stats().links === 1 && connected(alice), 'alice re-registered alone');
  await sleep(50);
  assert.equal(connected(alice), true);
  assert.equal(hubRow(alice).error, null);
  // The link that is current takes streams.
  const m = await rawHubLink(port, [await newIdentity()]);
  closeAll(t, m);
  m.send({ t: 'open', s: 1, to: alice.fp });
  assert.equal((await m.tunnel(1).nextOf('hello')).t, 'hello');
});

// Invariant (review C2): a connection the client has left never arms a reconnect: after re-registering on a detach,
// or after close() with a binding still attached, the redial delay passes with exactly the links expected.
test('a link the client left arms no reconnect', async (t) => {
  const clock = fakeClock();
  const { hub, addr } = await startHub(t);
  const shared = createNetworkEndpoint({ connections: [addr], syncMs: 3_600_000, log: silentLog, schedule: clock.schedule, now: clock.now });
  const alice = await hubNode('alice', addr, { endpoint: shared, schedule: clock.schedule, now: clock.now });
  const carol = await hubNode('carol', addr, { endpoint: shared, schedule: clock.schedule, now: clock.now });
  t.after(async () => { await alice.close(); await carol.close(); shared.close(); });
  await waitFor(() => hub.stats().fps === 2 && connected(alice), 'both identities on one link');
  await carol.close();
  await waitFor(() => hub.stats().fps === 1 && hub.stats().links === 1 && connected(alice), 'alice re-registered alone');
  clock.advance(2 * TCP_REDIAL_MIN_MS);
  await sleep(50);
  assert.deepEqual([hub.stats().links, connected(alice), hubRow(alice).error], [1, true, null]);

  const own = createNetworkEndpoint({ connections: [addr], syncMs: 3_600_000, log: silentLog, schedule: clock.schedule, now: clock.now });
  const bob = await hubNode('bob', addr, { endpoint: own, schedule: clock.schedule, now: clock.now });
  closeAll(t, bob);
  await waitFor(() => connected(bob) && hub.stats().links === 2, 'bob registered');
  own.close(); // the binding stays attached
  await waitFor(() => hub.stats().links === 1, 'bob\'s link to go');
  clock.advance(2 * TCP_REDIAL_MIN_MS);
  await sleep(50);
  assert.equal(hub.stats().links, 1);
});

// Invariant (review C1): detaching an identity re-registers the rest even after HUB_DUPLICATE stopped the link: a
// copy of the detached identity no longer conflicts, so the client comes back.
test('detaching the duplicated identity brings a stopped client back', async (t) => {
  const { hub, port, addr } = await startHub(t);
  const shared = createNetworkEndpoint({ connections: [addr], syncMs: 3_600_000, log: silentLog });
  const alice = await hubNode('alice', addr, { endpoint: shared });
  const carol = await hubNode('carol', addr, { endpoint: shared });
  t.after(async () => { await alice.close(); await carol.close(); shared.close(); });
  await waitFor(() => hub.stats().fps === 2 && connected(alice), 'both identities on one link');
  const copy = await rawHubLink(port, [carol.identity]);
  closeAll(t, copy);
  await waitFor(() => hubRow(alice).error?.code === 'HUB_DUPLICATE', 'HUB_DUPLICATE');
  await carol.close();
  await waitFor(() => connected(alice), 'alice back on the hub');
  assert.equal(hubRow(alice).error, null);
  assert.equal(copy.closed, false);
  assert.equal(hub.stats().fps, 2);
});

// Invariant (review C4): a hub that refuses the registration proof shows HUB_REFUSED, and the client keeps trying
// with backoff (a refusal is not a duplicate).
test('a hub that refuses the registration shows HUB_REFUSED and the client retries', async (t) => {
  const clock = fakeClock();
  const lying = await lyingHub(t, { refuse: true });
  const alice = await hubNode('alice', lying.addr, { schedule: clock.schedule, now: clock.now });
  closeAll(t, alice);
  await waitFor(() => hubRow(alice).error?.code === 'HUB_REFUSED', 'HUB_REFUSED');
  assert.equal(lying.accepted, 1);
  clock.advance(TCP_REDIAL_MIN_MS);
  await waitFor(() => lying.accepted === 2, 'a reconnect after the backoff');
  await sleep(20);
  assert.equal(hubRow(alice).error.code, 'HUB_REFUSED');
  clock.advance(TCP_REDIAL_MIN_MS);
  await sleep(50);
  assert.equal(lying.accepted, 2, 'the second wait is longer: backoff doubles');
  clock.advance(TCP_REDIAL_MIN_MS);
  await waitFor(() => lying.accepted === 3, 'the third attempt');
});

// ---- end-to-end authenticity through an untrusted hub ----

// Invariant: the endpoint handshake binds the target end to end: a hub that routes A's stream for B to M gets no
// session, no peerOnline and nothing offered on either side.
test('a misrouting hub cannot make a session with the wrong identity', async (t) => {
  let ids = {};
  const lying = await lyingHub(t, { route: (to) => lying.linkOf(to === ids.bob ? ids.mallory : to) });
  const alice = await hubNode('alice', lying.addr);
  const bob = await hubNode('bob', lying.addr);
  const mallory = await hubNode('mallory', lying.addr);
  closeAll(t, alice, bob, mallory);
  ids = { bob: bob.fp, mallory: mallory.fp };
  await waitFor(() => connected(alice) && connected(bob) && connected(mallory), 'all registered');
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
  const alice = await hubNode('alice', lying.addr);
  const bob = await hubNode('bob', lying.addr);
  closeAll(t, alice, bob);
  await waitFor(() => connected(alice) && connected(bob), 'both registered');
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

// Invariant: peerOnline comes only from an end-to-end session, never the hub's word: a roster `peer` notice followed
// by a stream that answers garbage leaves the outbox as it was.
test('hub presence never fires peerOnline', async (t) => {
  const garbage = Buffer.concat([header(5), Buffer.from('{oops')]);
  const lying = await lyingHub(t, { onOpen: (link, f) => { link.send({ t: 'data', s: f.s, b: b64(garbage) }); return true; } });
  const alice = await hubNode('alice', lying.addr);
  closeAll(t, alice);
  await waitFor(() => connected(alice), 'alice registered');
  const bob = await newIdentity();
  await alice.engine.importCard(cardOf(bob));
  await alice.engine.invite(bob.fp);
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  lying.notify(lying.linkOf(alice.fp), { t: 'peer', fp: bob.fp, rec: b64(announceOf(bob)) });
  await waitFor(() => alice.transport.stats().handshakeFailures >= 1, 'the garbage answer to fail the handshake');
  await alice.engine.sync();
  assert.deepEqual(alice.online, []);
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
});

// ---- delivery ----

// Invariant: the hub stores nothing: a record for an offline peer waits in the sender's outbox and goes out when
// the peer's session through the hub becomes ready.
test('an offline peer gets the record from the outbox when it comes back through the hub', async (t) => {
  const { addr } = await startHub(t);
  const alice = await hubNode('alice', addr);
  let bob = await hubNode('bob', addr);
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  await bob.close();
  await waitFor(() => sessionsWith(alice, bob.fp).length === 0, 'alice to see bob leave');
  await alice.engine.sendMessage(inbox, 'while you were out');
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  bob = await hubNode('bob', addr, { dataDir: bob.dataDir });
  await waitFor(() => bob.engine.messages(inbox).length === 1, 'the message');
  assert.deepEqual(bob.engine.messages(inbox).map((m) => m.body), ['while you were out']);
  await waitFor(() => alice.engine.state().diagnostics.outbox === 0, 'the outbox to drain');
  assert.ok(alice.online.includes(bob.fp));
});

// Invariant: many clients share one hub, and members reach each other through it: co-members are contacts, and the
// roster says where they are.
test('many clients on one hub exchange a shared inbox', async (t) => {
  const { hub, addr } = await startHub(t);
  const owner = await hubNode('owner', addr);
  const members = [];
  for (let i = 0; i < 6; i += 1) members.push(await hubNode(`m${i}`, addr));
  const all = [owner, ...members];
  t.after(async () => { for (const n of all) await n.close(); });
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
});

// Invariant: least disclosure binds peers end to end through the hub: a stranger's pull is answered only for what
// it may read (denials carry no head), alice's pull names only routes the stranger could serve, and no frame asks
// about anyone else (a whois closes the session).
test('least disclosure holds through the hub', async (t) => {
  const { port, addr } = await startHub(t);
  const alice = await hubNode('alice', addr);
  const bob = await hubNode('bob', addr);
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
  await alice.engine.sync();
  for (const p of of(tun.frames, 'pull')) for (const r of p.routes) assert.ok(!routeKey(r.route).startsWith('inbox:'));
  assert.ok(!JSON.stringify(tun.frames.filter((f) => f.t === 'pull')).includes(team));
  tun.send({ t: 'whois', id: 9, from: mallory.fp, to: alice.fp, fps: [bob.fp] });
  assert.deepEqual(await tun.nextOf('bye'), { t: 'bye', reason: 'PROTOCOL' });
});

// Invariant (A1): a hub never receives a contact list: what a client sends it is its registration, its own
// announces and stream frames. Every announce is signed by a registered fp, and no other fp appears outside `open.to`.
test('a client sends a hub only its registration, its own announces and stream frames', async (t) => {
  const lying = await lyingHub(t);
  const alice = await hubNode('alice', lying.addr);
  const bob = await hubNode('bob', lying.addr);
  closeAll(t, alice, bob);
  await waitFor(() => connected(alice) && connected(bob), 'both registered');
  const [carol, dave] = [await newIdentity(), await newIdentity()];
  await alice.engine.importCard(cardOf(carol));
  await alice.engine.importCard(cardOf(dave));
  await alice.engine.importCard(bob.card());
  await alice.engine.invite(carol.fp);
  await alice.engine.announce();
  await settle([alice, bob]);
  const sent = lying.received(lying.linkOf(alice.fp));
  assert.ok(sent.every((f) => ['open', 'data', 'close', 'announce', 'ping', 'pong', 'bye'].includes(f.t)), [...new Set(sent.map((f) => f.t))].join());
  assert.ok(of(sent, 'announce').length >= 2);
  assert.ok(of(sent, 'announce').every((f) => decodeRecordOf(f.rec).signer === alice.fp));
  assert.deepEqual([...new Set(of(sent, 'open').map((f) => f.to))], [bob.fp]);
  const control = JSON.stringify(sent.filter((f) => f.t !== 'data' && f.t !== 'open' && f.t !== 'announce'));
  for (const fp of [bob.fp, carol.fp, dave.fp]) assert.ok(!control.includes(fp));
});

// ---- the roster ----

// Invariant (A1 D13): a newcomer is told every fp registered on other links with its announce, and every other link
// is told the newcomer's fps, then its announce once given.
test('the hub sends a newcomer every registered announce and every other link the newcomer\'s', async (t) => {
  const { hub, port } = await startHub(t);
  const [a, b, c] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const A = await rawHubLink(port, [a]);
  A.send({ t: 'announce', rec: b64(announceOf(a, 'alice')) });
  const B = await rawHubLink(port, [b]);
  closeAll(t, A, B);
  B.send({ t: 'announce', rec: b64(announceOf(b, 'bob')) });
  const peerOf = (L, fp) => of(L.frames, 'peer').filter((f) => f.fp === fp).at(-1);
  await waitFor(() => peerOf(B, a.fp)?.rec && peerOf(A, b.fp)?.rec, 'both announces relayed');
  assert.equal(decodeRecordOf(peerOf(B, a.fp).rec).name, 'alice');
  assert.equal(decodeRecordOf(peerOf(A, b.fp).rec).name, 'bob');
  const C = await rawHubLink(port, [c]);
  closeAll(t, C);
  await waitFor(() => peerOf(C, a.fp) && peerOf(C, b.fp) && peerOf(A, c.fp) && peerOf(B, c.fp), 'the newcomer burst and fan-out');
  assert.deepEqual([decodeRecordOf(peerOf(C, a.fp).rec).name, decodeRecordOf(peerOf(C, b.fp).rec).name], ['alice', 'bob']);
  assert.deepEqual(peerOf(A, c.fp), { t: 'peer', fp: c.fp, rec: null });
  assert.equal(of(C.frames, 'peer').some((f) => f.fp === c.fp), false);
  assert.deepEqual([hub.stats().announces, hub.stats().rosterPending], [2, 0]);
  // An announce must be signed by an fp the link registered.
  A.send({ t: 'announce', rec: b64(announceOf(c)) });
  await A.whenClosed;
  assert.deepEqual(A.frames.at(-1), { t: 'bye', reason: 'PROTOCOL' });
});

// Invariant (A1 D13): a link that closes is reported gone for the fps it still held; a fp re-registered on another
// link is never reported gone, only present again.
test('a closed link\'s fingerprints are reported gone; a re-registered one is not', async (t) => {
  const { port } = await startHub(t);
  const [a, b, c] = [await newIdentity(), await newIdentity(), await newIdentity()];
  const A = await rawHubLink(port, [a]);
  const B = await rawHubLink(port, [b, c]);
  closeAll(t, A);
  await waitFor(() => of(A.frames, 'peer').length === 2, 'b and c present');
  const C2 = await rawHubLink(port, [c]); // c moves to a new link: B is closed DUPLICATE
  closeAll(t, C2);
  await B.whenClosed;
  await waitFor(() => of(A.frames, 'gone').length === 1 && of(A.frames, 'peer').length === 3, 'b gone, c present again');
  assert.deepEqual(of(A.frames, 'gone'), [{ t: 'gone', fp: b.fp }]);
  assert.deepEqual(of(A.frames, 'peer').at(-1), { t: 'peer', fp: c.fp, rec: null });
});

// Invariant (A1 D13, realistic availability): roster entries that do not fit a link that is not reading wait, never
// dropped: once it reads again it gets every fp's latest state, coalesced, and keeps its link.
test('a slow reader receives the roster late and coalesced, never loses an entry, and keeps its link', async (t) => {
  const accepted = [];
  const createServer = (onConn) => net.createServer((s) => { accepted.push(s); onConn(s); });
  const limits = { maxStreams: 1, writeBufferMax: 1024, controlBufferMax: 1024 };
  const { hub, port } = await startHub(t, { limits, createServer });
  const r = await newIdentity();
  const R = await rawHubLink(port, [r]);
  closeAll(t, R);
  accepted[0].cork();
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push(await newIdentity());
  const links = [];
  for (const id of ids) {
    const L = await rawHubLink(port, [id]);
    for (let k = 0; k < 3; k += 1) L.send({ t: 'announce', rec: b64(announceOf(id, `v${k}`)) });
    links.push(L);
  }
  closeAll(t, ...links);
  // Half of them leave again.
  for (const L of links.slice(0, 4)) L.destroy();
  await waitFor(() => hub.stats().links === 5, 'four links gone');
  await waitFor(() => hub.stats().rosterPending > 0, 'entries waiting for the corked link');
  assert.ok(accepted[0].writableLength <= limits.maxStreams * limits.writeBufferMax + limits.controlBufferMax);
  assert.equal(hub.stats().dropped, 0);
  accepted[0].uncork();
  const latest = () => {
    const state = new Map();
    for (const f of R.frames) if (f.t === 'peer' || f.t === 'gone') state.set(f.fp, f);
    return state;
  };
  await waitFor(() => {
    const st = latest();
    return ids.slice(4).every((id) => st.get(id.fp)?.t === 'peer' && st.get(id.fp).rec && decodeRecordOf(st.get(id.fp).rec).name === 'v2')
      && ids.slice(0, 4).every((id) => !st.has(id.fp) || st.get(id.fp).t === 'gone');
  }, 'the final roster', 5000);
  assert.equal(R.closed, false);
  assert.equal(hub.stats().rosterPending, 0);
});

// Invariant: a client shows only announces that verify as the fp the roster names (the kept signature check).
test('a forwarded announce whose signature fails is not shown', async (t) => {
  const lying = await lyingHub(t);
  const alice = await hubNode('alice', lying.addr);
  closeAll(t, alice);
  await waitFor(() => connected(alice), 'alice registered');
  const [bob, carol] = [await newIdentity(), await newIdentity()];
  const forged = Buffer.from(announceOf(bob, 'bob'));
  forged[forged.length - 5] ^= 1; // the signature no longer verifies
  const link = lying.linkOf(alice.fp);
  const before = alice.transport.stats().dropped;
  lying.notify(link, { t: 'peer', fp: bob.fp, rec: b64(forged) });
  lying.notify(link, { t: 'peer', fp: bob.fp, rec: b64(announceOf(carol, 'carol')) }); // carol's, named as bob's
  lying.notify(link, { t: 'peer', fp: carol.fp, rec: b64(announceOf(carol, 'carol')) });
  await waitFor(() => alice.engine.state().directory.some((d) => d.fp === carol.fp), 'carol shown');
  assert.deepEqual(alice.engine.state().directory.map((d) => d.name), ['carol']);
  assert.equal(alice.transport.stats().dropped, before + 2);
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
    { t: 'announce', rec: b64(Buffer.alloc(ANNOUNCE_MAX_BYTES + 1, 1)) },
    { t: 'watch', id: 1, fps: [a.fp] },
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

// Invariant (review S1): stream caps never cost the receiver its link. A sender that fills every stream it may open
// to a receiver that does not read, then keeps opening and filling, gets only LIMIT closes; the hub holds at most
// its stated per-link bound toward the receiver, which keeps its link and reads everything once it reads again.
test('filling every stream to a non-reading receiver closes streams, never its link', async (t) => {
  const accepted = [];
  const createServer = (onConn) => net.createServer((s) => { accepted.push(s); onConn(s); });
  const limits = { maxStreams: 4, writeBufferMax: 8192, controlBufferMax: 4096 };
  const { hub, port } = await startHub(t, { limits, createServer });
  const [r, a] = [await newIdentity(), await newIdentity()];
  const R = await rawHubLink(port, [r]);
  const A = await rawHubLink(port, [a]);
  closeAll(t, R, A);
  accepted[0].cork();
  const chunk = 'C'.repeat(2500);
  let s = 1;
  for (let round = 0; round < 3; round += 1) {
    const opened = [];
    for (let i = 0; i < limits.maxStreams; i += 1, s += 2) { A.send({ t: 'open', s, to: r.fp }); opened.push(s); }
    for (let i = 0; i < 4; i += 1) for (const x of opened) A.send({ t: 'data', s: x, b: chunk });
    A.send({ t: 'ping' });
    await A.nextOf('pong');
    await waitFor(() => opened.every((x) => A.frames.some((f) => f.t === 'close' && f.s === x)), `round ${round}: every stream closed`);
    for (const x of opened) assert.equal(A.frames.find((f) => f.t === 'close' && f.s === x).reason, 'LIMIT');
    assert.ok(accepted[0].writableLength <= limits.maxStreams * limits.writeBufferMax + limits.controlBufferMax, `round ${round}: ${accepted[0].writableLength} bytes held`);
  }
  assert.equal(hub.stats().links, 2);
  accepted[0].uncork();
  R.send({ t: 'ping' });
  await R.nextOf('pong');
  assert.equal(R.closed, false);
  assert.ok(of(R.frames, 'close').every((f) => f.reason === 'LIMIT'));
});

// Invariant (review R1): control frames owed to a link that holds its whole data budget and does not read are
// dropped and counted, never the link: here the receiver itself asks for `pong` answers it cannot take.
test('control frames a full link cannot take are dropped, never the link', async (t) => {
  const accepted = [];
  const createServer = (onConn) => net.createServer((s) => { accepted.push(s); onConn(s); });
  const limits = { maxStreams: 2, writeBufferMax: 8192, controlBufferMax: 1024 };
  const { hub, port } = await startHub(t, { limits, createServer });
  const [r, a] = [await newIdentity(), await newIdentity()];
  const R = await rawHubLink(port, [r]);
  const A = await rawHubLink(port, [a]);
  closeAll(t, R, A);
  A.send({ t: 'open', s: 1, to: r.fp });
  A.send({ t: 'open', s: 3, to: r.fp });
  await R.nextOf('incoming');
  await R.nextOf('incoming');
  accepted[0].cork();
  // Each stream end just under its cap: together the link's data total, all but a frame's worth.
  const chunk = 'D'.repeat(2600);
  for (const s of [1, 3]) for (let i = 0; i < 3; i += 1) A.send({ t: 'data', s, b: chunk });
  A.send({ t: 'ping' });
  await A.nextOf('pong');
  assert.deepEqual(of(A.frames, 'close'), [], 'no stream over its cap');
  const held = accepted[0].writableLength;
  assert.ok(held > limits.maxStreams * limits.writeBufferMax - 3000, `${held} bytes of data held`);
  const before = hub.stats().dropped;
  for (let i = 0; i < 400; i += 1) R.send({ t: 'ping' });
  await waitFor(() => hub.stats().dropped > before, 'pong answers to be dropped');
  assert.ok(accepted[0].writableLength <= limits.maxStreams * limits.writeBufferMax + limits.controlBufferMax);
  assert.equal(hub.stats().links, 2);
  accepted[0].uncork();
  R.send({ t: 'ping' });
  await R.nextOf('pong');
  assert.equal(R.closed, false);
  assert.equal(of(R.frames, 'data').length, 6, 'every data chunk arrived');
});

// Invariant (conductor note 1, client side): a session's back-pressure counts only its own unflushed bytes, so a
// session with bytes waiting on the shared hub link does not close another session on that link.
test('a busy session on a hub link does not close another session on it', async (t) => {
  const { addr } = await startHub(t);
  let socket;
  const connect = (opts) => { socket = net.connect(opts); return socket; };
  const alice = await hubNode('alice', addr, { connect, limits: { writeBufferMax: 20_000 } });
  const bob = await hubNode('bob', addr);
  const carol = await hubNode('carol', addr);
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
  const alice = await hubNode('alice', first.addr, { limits });
  const bob = await hubNode('bob', first.addr, { limits });
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  first.hub.close();
  await waitFor(() => !connected(alice) && sessionsWith(alice, bob.fp).length === 0, 'the hub to go');
  await alice.engine.sendMessage(inbox, 'after the restart');
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  const second = await startHub(t, { port: first.port });
  await waitFor(() => bob.engine.messages(inbox).length === 1, 'the message through the new hub', 5000);
  assert.deepEqual(bob.engine.messages(inbox).map((m) => m.body), ['after the restart']);
  assert.equal(second.hub.stats().links, 2);
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
