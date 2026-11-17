import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadIdentity } from '../src/identity.js';
import { decodeRecord, encodeRecord } from '../src/records.js';
import { FILES } from '../src/store.js';
import { TCP_FRAME_MAX, TCP_HELLO_FRAME_MAX, encodeFrame } from '../src/transport/frames.js';
import { proofSigner } from '../src/transport/handshake.js';
import { routeKey } from '../src/transport/index.js';
import { TCP_REDIAL_MIN_MS, createTcpEndpoint, resolveTcpConfig } from '../src/transport/tcp.js';
import { fakeClock, silentLog, tmpDir } from './helpers.mjs';
import {
  acceptProofs, countingListener, freePort, memCursors, personal, rawConn, rawConnect, rawPeer, settle, stubSink, stubView, tcpNode, waitFor,
} from './tcpHelpers.mjs';

// The TCP transport over real loopback sockets on ephemeral ports. Engines run with an hour-long maintain interval:
// every sync is driven by the test. Each test closes every socket, listener and engine it opened.

const newIdentity = () => loadIdentity(tmpDir('code-inbox-id-'));
const announceOf = (identity, addr = []) => encodeRecord(identity, { type: 'announce', signer: identity.fp, ts: Date.now(), name: `n${identity.fp.slice(0, 6)}`, addr }).bytes;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const randomFp = () => crypto.randomBytes(32).toString('hex');

// One endpoint with one identity attached and a stub view and sink: the transport alone, no engine.
async function stubEndpoint(t, { view = stubView(), limits, now, schedule } = {}) {
  const identity = await newIdentity();
  const endpoint = createTcpEndpoint({ port: 0, limits, now, schedule, syncMs: 3_600_000, log: silentLog });
  const transport = endpoint.attach({ identity: proofSigner(identity), view, cursors: memCursors() });
  const sink = stubSink();
  await transport.start(sink);
  t.after(() => endpoint.close());
  return { identity, fp: identity.fp, endpoint, transport, sink, port: endpoint.stats().listening.port };
}

const closeAll = (t, ...things) => t.after(async () => { for (const x of things) await (x.close ?? x.destroy).call(x); });

test('one endpoint serves several identities over one pooled connection', async (t) => {
  const e1 = createTcpEndpoint({ port: 0, syncMs: 3_600_000, log: silentLog });
  const alice = await tcpNode('alice', { endpoint: e1 });
  const carol = await tcpNode('carol', { endpoint: e1 });
  const bob = await tcpNode('bob');
  closeAll(t, alice, carol, bob, e1);
  await bob.engine.importCard(alice.card());
  await bob.engine.importCard(carol.card());
  await settle([alice, carol, bob]);
  const withAlice = await personal(bob, alice, [alice, carol, bob]);
  const withCarol = await personal(bob, carol, [alice, carol, bob]);
  await bob.engine.sendMessage(withAlice, 'to alice');
  await bob.engine.sendMessage(withCarol, 'to carol');
  await settle([alice, carol, bob]);
  assert.deepEqual(alice.engine.messages(withAlice).map((m) => m.body), ['to alice']);
  assert.deepEqual(carol.engine.messages(withCarol).map((m) => m.body), ['to carol']);
  // Exactly one session on each side, proving both identities served by e1.
  const both = [alice.fp, carol.fp].sort();
  assert.deepEqual(e1.stats().sessions.map((s) => s.remote), [[bob.fp]]);
  assert.deepEqual(bob.transport.stats().sessions.map((s) => [...s.remote].sort()), [both]);
});

test('a frame is delivered to the addressed identity only', async (t) => {
  const e1 = createTcpEndpoint({ port: 0, syncMs: 3_600_000, log: silentLog });
  const alice = await tcpNode('alice', { endpoint: e1 });
  const carol = await tcpNode('carol', { endpoint: e1 });
  const bob = await tcpNode('bob');
  closeAll(t, alice, carol, bob, e1);
  await bob.engine.importCard(alice.card());
  await settle([alice, carol, bob]);
  const inbox = await personal(bob, alice, [alice, carol, bob]);
  await bob.engine.sendMessage(inbox, 'for alice only');
  await settle([alice, carol, bob]);
  assert.deepEqual(alice.engine.messages(inbox).map((m) => m.body), ['for alice only']);
  // carol shares alice's endpoint and session; she was offered nothing but the directory (bob's announce, pulled).
  assert.ok(carol.offered.length > 0);
  assert.deepEqual([...new Set(carol.offered.map((i) => routeKey(i.route)))], ['directory']);
  // A pushed frame addressed to an identity not attached here is dropped and counted.
  const mallory = await newIdentity();
  const raw = await rawPeer(e1.stats().listening.port, mallory, alice.fp);
  closeAll(t, raw);
  const before = e1.stats().dropped;
  raw.send({ t: 'rec', from: mallory.fp, to: randomFp(), route: { kind: 'directory' }, rec: b64(announceOf(mallory)) });
  await waitFor(() => e1.stats().dropped === before + 1, 'the drop to be counted');
  assert.equal(raw.closed, false);
});

test('a bad proof closes the connection and the acceptor signs nothing', async (t) => {
  const a = await stubEndpoint(t);
  const mallory = await newIdentity();
  const raw = await rawConnect(a.port);
  closeAll(t, raw);
  const hello = await raw.next();
  raw.send({ t: 'hello', v: 1, nonce: crypto.randomBytes(32).toString('hex') });
  raw.send({ t: 'prove', target: a.fp, ids: [{ key: b64(mallory.publicRaw), sig: b64(crypto.randomBytes(64)) }] });
  await raw.whenClosed;
  assert.equal(hello.t, 'hello');
  assert.deepEqual(raw.frames.map((f) => f.t), ['hello', 'bye']);
  assert.equal(raw.frames[1].reason, 'PROOF');
  assert.equal(a.endpoint.stats().handshakeFailures, 1);
  assert.deepEqual(a.sink.records, []);
});

test('a proof from another connection is refused', async (t) => {
  const a = await stubEndpoint(t);
  const mallory = await newIdentity();
  const first = await rawPeer(a.port, mallory, a.fp);
  closeAll(t, first);
  // The same dialer nonce and the same signed proof, on a fresh connection: the acceptor's nonce differs.
  const raw = await rawConnect(a.port);
  closeAll(t, raw);
  await raw.nextOf('hello');
  raw.send(first.sent.hello);
  raw.send(first.sent.prove);
  await raw.whenClosed;
  assert.deepEqual(raw.frames.map((f) => [f.t, f.reason]), [['hello', undefined], ['bye', 'PROOF']]);
});

test('a proof bound to another target or role is refused', async (t) => {
  const a = await stubEndpoint(t);
  const mallory = await newIdentity();
  // A dialer proof naming a target not attached here (a relay of a proof meant for someone else).
  const elsewhere = randomFp();
  const raw = await rawConnect(a.port);
  closeAll(t, raw);
  const { nonce } = await raw.nextOf('hello');
  const mine = crypto.randomBytes(32).toString('hex');
  raw.send({ t: 'hello', v: 1, nonce: mine });
  raw.send({ t: 'prove', target: elsewhere, ids: [{ key: b64(mallory.publicRaw), sig: b64(proofSigner(mallory).signProof('dial', mine, nonce, elsewhere)) }] });
  await raw.whenClosed;
  assert.deepEqual(raw.frames.map((f) => [f.t, f.reason]), [['hello', undefined], ['bye', 'PROOF']]);

  // An acceptor answering with a proof signed for the dial role: the dialer refuses it.
  const target = await newIdentity();
  const conns = [];
  const srv = net.createServer((s) => conns.push(rawConn(s)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { for (const c of conns) c.destroy(); srv.close(); });
  const dialer = await stubEndpoint(t, { view: stubView({ contacts: [target.fp], addrs: { [target.fp]: [`tcp://127.0.0.1:${srv.address().port}`] } }) });
  const syncing = dialer.transport.sync();
  await waitFor(() => conns.length === 1, 'the dial');
  const acc = conns[0];
  const myNonce = crypto.randomBytes(32).toString('hex');
  acc.send({ t: 'hello', v: 1, nonce: myNonce });
  const dHello = await acc.nextOf('hello');
  assert.equal((await acc.nextOf('prove')).target, target.fp);
  acc.send({ t: 'prove', ids: acceptProofs([target], 'dial', myNonce, dHello.nonce, [dialer.fp]) });
  assert.equal((await acc.nextOf('bye')).reason, 'PROOF');
  await syncing;
  assert.deepEqual(dialer.endpoint.stats().sessions, []);
});

test('a dialer refuses an acceptor that validly proves someone other than its target', async (t) => {
  const target = await newIdentity();
  const impostor = await newIdentity();
  const conns = [];
  const srv = net.createServer((s) => conns.push(rawConn(s)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { for (const c of conns) c.destroy(); srv.close(); });
  const dialer = await stubEndpoint(t, { view: stubView({ contacts: [target.fp], addrs: { [target.fp]: [`tcp://127.0.0.1:${srv.address().port}`] } }) });
  const syncing = dialer.transport.sync();
  await waitFor(() => conns.length === 1, 'the dial');
  const acc = conns[0];
  const myNonce = crypto.randomBytes(32).toString('hex');
  acc.send({ t: 'hello', v: 1, nonce: myNonce });
  const dHello = await acc.nextOf('hello');
  await acc.nextOf('prove');
  // A correct accept proof (role, nonces, bound to the dialer) by an identity the dialer never asked for.
  acc.send({ t: 'prove', ids: acceptProofs([impostor], 'accept', myNonce, dHello.nonce, [dialer.fp]) });
  assert.equal((await acc.nextOf('bye')).reason, 'PROOF');
  await syncing;
  assert.deepEqual(dialer.endpoint.stats().sessions, []);
});

test('no frame is acted on before the handshake completes', async (t) => {
  let served = 0;
  const a = await stubEndpoint(t, { view: stubView({ serve: () => { served += 1; return { status: 'ok', recs: [], more: false, head: 0 }; } }) });
  const mallory = await newIdentity();
  // A record pushed before any proof.
  const early = await rawConnect(a.port);
  closeAll(t, early);
  await early.nextOf('hello');
  early.send({ t: 'hello', v: 1, nonce: crypto.randomBytes(32).toString('hex') });
  early.send({ t: 'rec', from: mallory.fp, to: a.fp, route: { kind: 'directory' }, rec: b64(announceOf(mallory)) });
  await early.whenClosed;
  assert.equal(early.frames.at(-1).reason, 'PROTOCOL');
  // A pull sent after both proofs but before `ok`.
  const raw = await rawConnect(a.port);
  closeAll(t, raw);
  const { nonce } = await raw.nextOf('hello');
  const mine = crypto.randomBytes(32).toString('hex');
  raw.send({ t: 'hello', v: 1, nonce: mine });
  raw.send({ t: 'prove', target: a.fp, ids: [{ key: b64(mallory.publicRaw), sig: b64(proofSigner(mallory).signProof('dial', mine, nonce, a.fp)) }] });
  await raw.nextOf('prove');
  raw.send({ t: 'pull', id: 1, from: mallory.fp, to: a.fp, routes: [{ route: { kind: 'directory' }, since: 0 }] });
  await raw.whenClosed;
  assert.equal(raw.frames.at(-1).reason, 'PROTOCOL');
  assert.equal(served, 0);
  assert.deepEqual(a.sink.records, []);
});

test('a record whose from is not proven on the session is refused', async (t) => {
  const a = await stubEndpoint(t);
  a.transport.setInterest([{ kind: 'directory' }]);
  const mallory = await newIdentity();
  const other = await newIdentity();
  const raw = await rawPeer(a.port, mallory, a.fp);
  closeAll(t, raw);
  raw.send({ t: 'rec', from: other.fp, to: a.fp, route: { kind: 'directory' }, rec: b64(announceOf(other)) });
  await raw.whenClosed;
  assert.equal(raw.frames.at(-1).reason, 'PROTOCOL');
  assert.deepEqual(a.sink.records, []);
});

test('a record signed by someone other than its from is refused ROUTE_MISMATCH', async (t) => {
  const alice = await tcpNode('alice');
  closeAll(t, alice);
  const mallory = await newIdentity();
  const bob = await newIdentity();
  const raw = await rawPeer(alice.transport.stats().listening.port, mallory, alice.fp);
  closeAll(t, raw);
  // A genuine announce of bob's, relayed by mallory.
  raw.send({ t: 'rec', from: mallory.fp, to: alice.fp, route: { kind: 'directory' }, rec: b64(announceOf(bob)) });
  await waitFor(() => alice.engine.state().diagnostics.recent.some((r) => r.reason === 'ROUTE_MISMATCH'), 'ROUTE_MISMATCH');
  assert.deepEqual(alice.engine.state().directory, []);
});

test('an oversize length header closes the socket before the body is read', async (t) => {
  const a = await stubEndpoint(t);
  const header = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  // Before the session is ready.
  const early = await rawConnect(a.port);
  closeAll(t, early);
  await early.nextOf('hello');
  early.write(header(TCP_HELLO_FRAME_MAX + 1));
  await early.whenClosed;
  assert.equal(early.frames.at(-1).reason, 'LIMIT');
  // After.
  const mallory = await newIdentity();
  const raw = await rawPeer(a.port, mallory, a.fp);
  closeAll(t, raw);
  raw.write(header(TCP_FRAME_MAX + 1));
  await raw.whenClosed;
  assert.equal(raw.frames.at(-1).reason, 'LIMIT');
});

test('a stalled partial frame and a stalled handshake are closed', async (t) => {
  const slowHello = await stubEndpoint(t, { limits: { handshakeMs: 50 } });
  const silent = await rawConnect(slowHello.port);
  closeAll(t, silent);
  await silent.whenClosed;
  assert.deepEqual(silent.frames.map((f) => f.t), ['hello']);

  const slowFrame = await stubEndpoint(t, { limits: { frameMs: 50 } });
  const raw = await rawPeer(slowFrame.port, await newIdentity(), slowFrame.fp);
  closeAll(t, raw);
  raw.write(encodeFrame({ t: 'ping' }).subarray(0, 6));
  await raw.whenClosed;
  assert.equal(raw.frames.at(-1).reason, 'LIMIT');
});

test('connections beyond the cap are refused at accept', async (t) => {
  const a = await stubEndpoint(t, { limits: { maxConnections: 2 } });
  const c1 = await rawConnect(a.port);
  const c2 = await rawConnect(a.port);
  closeAll(t, c1, c2);
  assert.equal((await c1.next()).t, 'hello');
  assert.equal((await c2.next()).t, 'hello');
  const c3 = await rawConnect(a.port);
  closeAll(t, c3);
  await c3.whenClosed;
  assert.deepEqual(c3.frames, []);
  assert.equal(a.endpoint.stats().connections, 2);
});

test('an offline recipient gets the record from the outbox when it reconnects', async (t) => {
  const port = await freePort();
  const alice = await tcpNode('alice');
  let bob = await tcpNode('bob', { port });
  const bobDir = bob.dataDir;
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  await bob.close();
  await waitFor(() => alice.transport.stats().sessions.length === 0, 'alice to see bob leave');
  await alice.engine.sendMessage(inbox, 'while you were out');
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  bob = await tcpNode('bob', { dataDir: bobDir });
  assert.deepEqual(bob.transport.addresses(), [`tcp://127.0.0.1:${port}`]);
  await bob.engine.sync(); // bob dials alice: alice hears peerOnline(bob) and flushes her outbox
  await waitFor(() => alice.engine.state().diagnostics.outbox === 0, 'the outbox to drain');
  await settle([alice, bob]);
  assert.deepEqual(bob.engine.messages(inbox).map((m) => m.body), ['while you were out']);
});

test('a late joiner pulls the history from the per-peer cursor', async (t) => {
  let served = 0;
  const countServe = (view) => ({ ...view, serve: (...a) => { const r = view.serve(...a); served += r.recs?.length ?? 0; return r; } });
  const alice = await tcpNode('alice', { wrapView: countServe });
  let bob = await tcpNode('bob');
  const bobDir = bob.dataDir;
  t.after(async () => { await alice.close(); await bob.close(); });
  const { id: team } = await alice.engine.createSharedInbox('team');
  for (const body of ['m1', 'm2', 'm3']) await alice.engine.sendMessage(team, body);
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const { id } = await alice.engine.inviteMember(team, bob.fp);
  await settle([alice, bob]);
  const inv = bob.engine.state().invites.incoming.find((i) => i.id === id);
  await bob.engine.respondInvite(inv.id, true);
  await settle([alice, bob], 3);
  assert.deepEqual(bob.engine.messages(team).map((m) => m.body), ['m1', 'm2', 'm3']);
  // The cursor is alice's acceptance seq of her last record on that route.
  const aliceLast = (await alice.store.load()).accepted.filter((e) => routeKey(e.route) === `inbox:${team}`).at(-1).seq;
  const cursors = JSON.parse(fs.readFileSync(path.join(bobDir, FILES.peerCursors), 'utf8'));
  assert.equal(cursors[alice.fp][`inbox:${team}`], aliceLast);
  served = 0;
  await bob.engine.sync();
  assert.equal(served, 0);
  // And across a restart of bob's backend.
  await bob.close();
  bob = await tcpNode('bob', { dataDir: bobDir });
  await bob.engine.sync();
  assert.equal(served, 0);
  assert.deepEqual(bob.engine.messages(team).map((m) => m.body), ['m1', 'm2', 'm3']);
});

test('a denied pull keeps its cursor', async (t) => {
  const denied = [];
  const watchServe = (view) => ({ ...view, serve: (reader, route, ...a) => { const r = view.serve(reader, route, ...a); if (r.status === 'denied') denied.push(routeKey(route)); return r; } });
  const alice = await tcpNode('alice', { wrapView: watchServe });
  const bob = await tcpNode('bob');
  t.after(async () => { await alice.close(); await bob.close(); });
  const { id: team } = await alice.engine.createSharedInbox('team');
  await alice.engine.sendMessage(team, 'm1');
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  await alice.engine.inviteMember(team, bob.fp);
  await settle([alice, bob]);
  // bob wants the inbox (he is invited) but is not a member yet: refused, and his cursor stays where it was.
  assert.ok(denied.includes(`inbox:${team}`));
  const cursors = await bob.store.loadPeerCursors();
  assert.equal(cursors[alice.fp]?.[`inbox:${team}`], undefined);
  await bob.engine.respondInvite(bob.engine.state().invites.incoming[0].id, true);
  await settle([alice, bob], 3);
  assert.deepEqual(bob.engine.messages(team).map((m) => m.body), ['m1']);
});

test('inbox and mailbox records are served only to parties or members', async (t) => {
  const alice = await tcpNode('alice');
  const bob = await tcpNode('bob');
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  await alice.engine.sendMessage(inbox, 'private');
  const carol = await newIdentity();
  const raw = await rawPeer(alice.transport.stats().listening.port, carol, alice.fp);
  closeAll(t, raw);
  const routes = [{ kind: 'inbox', id: inbox }, { kind: 'mailbox', fp: bob.fp }, { kind: 'directory' }];
  raw.send({ t: 'pull', id: 7, from: carol.fp, to: alice.fp, routes: routes.map((route) => ({ route, since: 0 })) });
  const recs = await raw.nextOf('recs');
  assert.deepEqual(recs.routes.map((r) => [routeKey(r.route), r.status, (r.recs?.length ?? 0) > 0]), [[`inbox:${inbox}`, 'denied', false], [`mailbox:${bob.fp}`, 'denied', false], ['directory', 'ok', true]]);
  // A denial says nothing about how much alice holds.
  for (const r of recs.routes.slice(0, 2)) assert.deepEqual(Object.keys(r).sort(), ['route', 'status']);
});

test('a peer\'s pull names only the routes it could serve', async (t) => {
  const alice = await tcpNode('alice');
  const bob = await tcpNode('bob');
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  const { id: team } = await alice.engine.createSharedInbox('team');
  assert.ok(alice.engine.state().inboxes.some((b) => b.id === inbox));
  // A stranger connects: alice's pull on the new session names her directory and her mailbox, nothing else.
  const mallory = await newIdentity();
  const raw = await rawPeer(alice.transport.stats().listening.port, mallory, alice.fp);
  closeAll(t, raw);
  const pull = await raw.nextOf('pull');
  assert.deepEqual(pull.routes.map((r) => routeKey(r.route)).sort(), ['directory', `mailbox:${alice.fp}`]);
  await alice.engine.sync();
  const pulls = raw.frames.filter((f) => f.t === 'pull');
  for (const p of pulls) for (const r of p.routes) assert.ok(!routeKey(r.route).startsWith('inbox:'), `${routeKey(r.route)} was named to a stranger`);
  assert.ok(!JSON.stringify(raw.frames).includes(team) && !JSON.stringify(raw.frames).includes(inbox));
});

test('members discover each other through a verified whois hint', async (t) => {
  const alice = await tcpNode('alice');
  const bob = await tcpNode('bob');
  const carol = await tcpNode('carol');
  const all = [alice, bob, carol];
  t.after(async () => { for (const n of all) await n.close(); });
  // bob and carol each know only alice's card.
  await bob.engine.importCard(alice.card());
  await carol.engine.importCard(alice.card());
  await settle(all);
  const { id: team } = await alice.engine.createSharedInbox('team');
  await alice.engine.inviteMember(team, bob.fp);
  await alice.engine.inviteMember(team, carol.fp);
  await settle(all);
  for (const n of [bob, carol]) await n.engine.respondInvite(n.engine.state().invites.incoming[0].id, true);
  await settle(all, 3);
  await carol.engine.sendMessage(team, 'hi bob');
  await settle(all, 3);
  assert.deepEqual(bob.engine.messages(team).map((m) => m.body), ['hi bob']);
  assert.ok(carol.transport.stats().sessions.some((s) => s.remote.includes(bob.fp)), 'carol reached bob directly');

  // alice answers whois about bob to a co-member of bob's (carol), and to nobody else.
  const port = alice.transport.stats().listening.port;
  const whois = async (identity) => {
    const raw = await rawPeer(port, identity, alice.fp);
    raw.send({ t: 'whois', id: 9, from: identity.fp, to: alice.fp, fps: [bob.fp] });
    const cards = await raw.nextOf('cards');
    raw.destroy();
    return cards.recs.map((r) => decodeRecord(Buffer.from(r, 'base64url')).payload);
  };
  assert.deepEqual((await whois(carol.identity)).map((p) => [p.type, p.signer]), [['announce', bob.fp]]);
  assert.deepEqual(await whois(await newIdentity()), []);

  // A whois reply signed by anyone but the identity asked about is never a dial hint.
  const dave = await newIdentity();
  const eve = await newIdentity();
  const trap = await countingListener();
  t.after(() => trap.close());
  const x = await stubEndpoint(t, { view: stubView({ contacts: [dave.fp] }) });
  const asked = [];
  const m = await rawPeer(x.port, await newIdentity(), x.fp, {
    onFrame: (f, conn) => {
      if (f.t !== 'whois') return false;
      asked.push(...f.fps);
      conn.send({ t: 'cards', id: f.id, from: f.to, to: f.from, recs: [b64(announceOf(eve, [trap.addr]))] });
      return true;
    },
  });
  closeAll(t, m);
  await waitFor(() => x.endpoint.stats().sessions.length === 1, 'the session');
  await x.transport.sync();
  assert.deepEqual(asked, [dave.fp]);
  assert.equal(trap.count, 0);
});

test('a stranger\'s announce never makes this install dial it', async (t) => {
  const alice = await tcpNode('alice');
  closeAll(t, alice);
  const trap = await countingListener();
  t.after(() => trap.close());
  const mallory = await newIdentity();
  const raw = await rawPeer(alice.transport.stats().listening.port, mallory, alice.fp);
  raw.send({ t: 'rec', from: mallory.fp, to: alice.fp, route: { kind: 'directory' }, rec: b64(announceOf(mallory, [trap.addr])) });
  await waitFor(() => alice.engine.state().directory.some((d) => d.fp === mallory.fp), 'mallory in the directory');
  raw.destroy();
  await raw.whenClosed;
  await waitFor(() => alice.transport.stats().sessions.length === 0, 'mallory to leave');
  await alice.engine.announce(); // addressed to every known identity, mallory included: pending, not dialed
  await alice.engine.sync();
  assert.equal(trap.count, 0);
});

test('simultaneous dials leave one session and lose nothing', async (t) => {
  // Contacts stay hidden from both transports until both are ready to dial each other in the same tick.
  const gate = { open: false };
  const gated = (view) => ({ ...view, contacts: () => (gate.open ? view.contacts() : []) });
  const alice = await tcpNode('alice', { wrapView: gated });
  const bob = await tcpNode('bob', { wrapView: gated });
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await alice.engine.importCard(bob.card());
  await Promise.all([alice.transport.sync(), bob.transport.sync()]);
  assert.equal(alice.transport.stats().connections + bob.transport.stats().connections, 0);
  gate.open = true;
  let peak = 0;
  let racing = true;
  const watch = () => { if (!racing) return; peak = Math.max(peak, alice.transport.stats().connections); setImmediate(watch); };
  watch();
  await Promise.all([alice.engine.sync(), bob.engine.sync()]);
  racing = false;
  assert.equal(peak, 2, 'both sides dialed');
  await waitFor(() => alice.transport.stats().connections === 1 && bob.transport.stats().connections === 1, 'one connection each');
  const inbox = await personal(alice, bob);
  await alice.engine.sendMessage(inbox, 'from alice');
  await bob.engine.sendMessage(inbox, 'from bob');
  await settle([alice, bob]);
  for (const n of [alice, bob]) assert.deepEqual(n.engine.messages(inbox).map((m) => m.body).sort(), ['from alice', 'from bob']);
  assert.equal(alice.transport.stats().sessions.length, 1);
  assert.equal(bob.transport.stats().sessions.length, 1);
});

test('redials back off and reset after a successful handshake', async (t) => {
  const clock = fakeClock();
  let dead = await countingListener();
  const port = dead.port;
  const bob = await newIdentity();
  const a = await stubEndpoint(t, { now: clock.now, schedule: clock.schedule, view: stubView({ contacts: [bob.fp], addrs: { [bob.fp]: [dead.addr] } }) });
  const attempts = async (ms) => { clock.advance(ms); await a.transport.sync(); return dead.count; };
  assert.equal(await attempts(0), 1); // start's own maintain dialed once
  assert.equal(await attempts(TCP_REDIAL_MIN_MS - 1), 1);
  assert.equal(await attempts(1), 2);
  assert.equal(await attempts(2 * TCP_REDIAL_MIN_MS - 1), 2);
  assert.equal(await attempts(1), 3);
  // bob comes up on that port: the next dial (once its backoff ends) succeeds.
  await dead.close();
  const b = createTcpEndpoint({ port, syncMs: 3_600_000, log: silentLog });
  await b.attach({ identity: proofSigner(bob), view: stubView(), cursors: memCursors() }).start(stubSink());
  await attempts(4 * TCP_REDIAL_MIN_MS);
  assert.equal(a.endpoint.stats().sessions.length, 1);
  // bob goes away again: the spacing starts over from the minimum.
  b.close();
  await waitFor(() => a.endpoint.stats().sessions.length === 0, 'the session to end');
  dead = await countingListener(port);
  t.after(() => dead.close());
  assert.equal(await attempts(0), 1);
  assert.equal(await attempts(TCP_REDIAL_MIN_MS - 1), 1);
  assert.equal(await attempts(1), 2);
});

test('TCP listens on loopback unless a host is given', async (t) => {
  const alice = await tcpNode('alice');
  closeAll(t, alice);
  assert.equal(alice.transport.stats().listening.host, '127.0.0.1');
  assert.match(alice.engine.state().transport.addresses[0], /^tcp:\/\/127\.0\.0\.1:\d+$/);
  await assert.rejects(alice.engine.setTcp({ host: '0.0.0.0', port: 0 }), { code: 'TCP_INVALID' });
  // Every spelling of the unspecified address is a wildcard, as a host and as an advertised host.
  for (const host of ['::', '::0', '0:0:0:0:0:0:0:0', '0000::', '::ffff:0.0.0.0']) {
    await assert.rejects(alice.engine.setTcp({ host, port: 0 }), { code: 'TCP_INVALID' }, host);
    await assert.rejects(alice.engine.setTcp({ advertise: host, port: 0 }), { code: 'TCP_INVALID' }, `advertise ${host}`);
  }
  assert.equal(alice.engine.state().transport.configured, true);
});

test('re-saving TCP settings on the same port rebinds', async (t) => {
  const port = await freePort();
  const alice = await tcpNode('alice', { port });
  const bob = await tcpNode('bob');
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  assert.equal(bob.transport.stats().sessions.length, 1);
  // Under the engine lock, with a live session: the old listener must be gone before the new one binds.
  assert.deepEqual((await alice.engine.setTcp({ port })).addresses, [`tcp://127.0.0.1:${port}`]);
  assert.deepEqual((await alice.engine.setTcp({ port })).addresses, [`tcp://127.0.0.1:${port}`]);
  await waitFor(() => bob.transport.stats().sessions.length === 0, 'the old session to end');
  await bob.engine.sync();
  assert.equal(bob.transport.stats().sessions.length, 1);
});

test('a port in use refuses TCP_LISTEN_FAILED and leaves the transport unconfigured', async (t) => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const { port } = busy.address();
  const alice = await tcpNode(null, { configure: false });
  t.after(async () => { await alice.close(); if (busy.listening) busy.close(); });
  await assert.rejects(alice.engine.setTcp({ port }), { code: 'TCP_LISTEN_FAILED' });
  const st = alice.engine.state().transport;
  assert.equal(st.configured, false);
  assert.equal(st.error.code, 'TCP_LISTEN_FAILED');
  await assert.rejects(alice.engine.announce(), { code: 'TRANSPORT_UNCONFIGURED' });
  // Once the port is free, saving again listens and clears the error.
  await new Promise((r) => busy.close(r));
  await alice.engine.setTcp({ port });
  assert.equal(alice.engine.state().transport.configured, true);
  assert.equal(alice.engine.state().transport.error, null);
});

// Invariant: an admission owed when no transport could start (the port was taken at boot) is written as soon as a
// transport starts, without another restart.
test('an owed admission completes after a boot listen failure followed by setTcp', async (t) => {
  const port = await freePort();
  let alice = await tcpNode('alice', { port });
  const bob = await tcpNode('bob');
  const aliceDir = alice.dataDir;
  const busy = net.createServer();
  t.after(async () => { await alice.close(); await bob.close(); if (busy.listening) busy.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const { id: team } = await alice.engine.createSharedInbox('team');
  const inv = await alice.engine.inviteMember(team, bob.fp);
  await settle([alice, bob]);
  await alice.close();
  await bob.engine.respondInvite(inv.id, true);
  // alice's backend accepted bob's acceptance and stopped before admitting him.
  const response = (await bob.store.load()).accepted.find((e) => decodeRecord(e.bytes).payload.type === 'invite-response');
  await alice.store.appendAccepted({ id: response.id, route: response.route, bytes: response.bytes });
  await new Promise((r) => busy.listen(port, '127.0.0.1', r));
  alice = await tcpNode('alice', { dataDir: aliceDir, configure: false });
  assert.equal(alice.engine.state().transport.error.code, 'TCP_LISTEN_FAILED');
  assert.deepEqual(alice.engine.listInboxes()[0].members.map((m) => m.fp), [alice.fp]);
  await new Promise((r) => busy.close(r));
  await alice.engine.setTcp({ port });
  assert.deepEqual(alice.engine.listInboxes()[0].members.map((m) => m.fp).sort(), [alice.fp, bob.fp].sort());
});

// Invariant (D7): a listen or advertised host that resolves to every interface is refused like 0.0.0.0, however it
// is spelt; a listen host that does not resolve is refused, an advertised one need not resolve here.
test('a host that resolves to an unspecified address is refused TCP_INVALID', async (t) => {
  const alice = await tcpNode('alice');
  closeAll(t, alice);
  for (const name of ['0', '00.0.0.0', '0x0.0.0.0']) {
    await assert.rejects(alice.engine.setTcp({ host: name, port: 0, advertise: '127.0.0.1' }), { code: 'TCP_INVALID' }, `host ${name}`);
    await assert.rejects(alice.engine.setTcp({ advertise: name, port: 0 }), { code: 'TCP_INVALID' }, `advertise ${name}`);
  }
  assert.equal(alice.engine.state().transport.configured, true);
  const nowhere = async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); };
  await assert.rejects(resolveTcpConfig({ host: 'nowhere.example', advertise: '127.0.0.1' }, { lookup: nowhere }), { code: 'TCP_INVALID' });
  assert.equal((await resolveTcpConfig({ advertise: 'peer.example' }, { lookup: nowhere })).advertise, 'peer.example');
  const everywhere = async () => [{ address: '10.0.0.1', family: 4 }, { address: '::', family: 6 }];
  await assert.rejects(resolveTcpConfig({ host: 'multi.example', advertise: '127.0.0.1' }, { lookup: everywhere }), { code: 'TCP_INVALID' });
});

// Invariant (C3): a listener that fails after it is up is closed and forgotten: its port is free to bind again and
// the sessions it accepted carry on.
test('a listener that fails after it is up frees its port and keeps its sessions', async (t) => {
  let srv;
  const identity = await newIdentity();
  const endpoint = createTcpEndpoint({ port: 0, syncMs: 3_600_000, log: silentLog, createServer: (onConnection) => { srv = net.createServer(onConnection); return srv; } });
  const transport = endpoint.attach({ identity: proofSigner(identity), view: stubView(), cursors: memCursors() });
  await transport.start(stubSink());
  t.after(() => endpoint.close());
  const { port } = endpoint.stats().listening;
  const raw = await rawPeer(port, await newIdentity(), identity.fp);
  closeAll(t, raw);
  await waitFor(() => endpoint.stats().sessions.length === 1, 'the session');
  srv.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' }));
  assert.equal(endpoint.stats().listening, null);
  assert.deepEqual(transport.addresses(), []);
  const again = net.createServer();
  await new Promise((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', resolve); });
  await new Promise((r) => again.close(r));
  raw.send({ t: 'ping' });
  assert.equal((await raw.nextOf('pong')).t, 'pong');
  assert.equal(endpoint.stats().sessions.length, 1);
});
