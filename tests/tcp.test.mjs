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
import { TCP_HANDSHAKE_MS } from '../src/transport/tcpSession.js';
import { proofSigner } from '../src/transport/handshake.js';
import { routeKey } from '../src/transport/index.js';
import { TCP_REDIAL_MIN_MS } from '../src/transport/endpoint.js';
import { createNetworkEndpoint, resolveNetworkConfig } from '../src/transport/network.js';
import { fakeClock, makeInstall, silentLog, tmpDir } from './helpers.mjs';
import { lyingHub, rawHubLink } from './hubHelpers.mjs';
import { netNode } from './netHelpers.mjs';
import {
  acceptProofs, countingListener, freePort, helloFrame, memCursors, personal, rawConn, rawConnect, rawPeer, settle, stubSink, stubView, waitFor,
} from './tcpHelpers.mjs';

// The network endpoint's listener and direct connections over real loopback sockets on ephemeral ports. Engines run
// with an hour-long maintain interval: every sync is driven by the test. Each test closes every socket, listener and
// engine it opened.

const newIdentity = () => loadIdentity(tmpDir('code-inbox-id-'));
const announceOf = (identity) => encodeRecord(identity, { type: 'announce', signer: identity.fp, ts: Date.now(), name: `n${identity.fp.slice(0, 6)}` }).bytes;
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const randomFp = () => crypto.randomBytes(32).toString('hex');
const nonce = () => crypto.randomBytes(32).toString('hex');

// One endpoint with one identity attached and a stub view and sink: the transport alone, no engine. It listens
// unless `listen` is null, and keeps `connections`.
async function stubEndpoint(t, { view = stubView(), limits, now, schedule, listen = { port: 0 }, connections = [], identity } = {}) {
  identity ??= await newIdentity();
  const endpoint = createNetworkEndpoint({ listen, connections, limits, now, schedule, syncMs: 3_600_000, log: silentLog });
  const transport = endpoint.attach({ identity: proofSigner(identity), view, cursors: memCursors() });
  const sink = stubSink();
  await transport.start(sink);
  t.after(() => endpoint.close());
  return { identity, fp: identity.fp, endpoint, transport, sink, port: endpoint.stats().listening?.port };
}

// A raw TCP server collecting a rawConn per accepted socket.
async function rawServer(t) {
  const conns = [];
  const srv = net.createServer((s) => conns.push(rawConn(s)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { for (const c of conns) c.destroy(); srv.close(); });
  return { conns, addr: `127.0.0.1:${srv.address().port}` };
}

const closeAll = (t, ...things) => t.after(async () => { for (const x of things) await (x.close ?? x.destroy).call(x); });

test('one endpoint serves several identities over one pooled connection', async (t) => {
  const e1 = createNetworkEndpoint({ listen: { port: 0 }, syncMs: 3_600_000, log: silentLog });
  const alice = await netNode('alice', { endpoint: e1 });
  const carol = await netNode('carol', { endpoint: e1 });
  const bob = await netNode('bob', { connections: [`127.0.0.1:${e1.stats().listening.port}`] });
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
  const e1 = createNetworkEndpoint({ listen: { port: 0 }, syncMs: 3_600_000, log: silentLog });
  const alice = await netNode('alice', { endpoint: e1 });
  const carol = await netNode('carol', { endpoint: e1 });
  const bob = await netNode('bob', { connections: [`127.0.0.1:${e1.stats().listening.port}`] });
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
  raw.send(helloFrame());
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

// Invariant (D3): a listener accepts an untargeted dial proof (bound ''), and still refuses a proof naming a target
// not attached here; a dialer refuses an acceptor's proof signed for the dial role.
test('a proof bound to another target or role is refused', async (t) => {
  const a = await stubEndpoint(t);
  const mallory = await newIdentity();
  // An untargeted dial: whoever the listener serves.
  const untargeted = await rawPeer(a.port, mallory, null);
  closeAll(t, untargeted);
  assert.equal(untargeted.accept.t, 'prove');
  await waitFor(() => a.endpoint.stats().sessions.length === 1, 'the untargeted session');
  // A dialer proof naming a target not attached here (a relay of a proof meant for someone else).
  const elsewhere = randomFp();
  const raw = await rawConnect(a.port);
  closeAll(t, raw);
  const { nonce: theirs } = await raw.nextOf('hello');
  const mine = nonce();
  raw.send(helloFrame(mine));
  raw.send({ t: 'prove', target: elsewhere, ids: [{ key: b64(mallory.publicRaw), sig: b64(proofSigner(mallory).signProof('dial', mine, theirs, elsewhere)) }] });
  await raw.whenClosed;
  assert.deepEqual(raw.frames.map((f) => [f.t, f.reason]), [['hello', undefined], ['bye', 'PROOF']]);

  // An acceptor answering with a proof signed for the dial role: the dialer (a connection) refuses it.
  const target = await newIdentity();
  const srv = await rawServer(t);
  const dialer = await stubEndpoint(t, { listen: null, connections: [srv.addr] });
  await waitFor(() => srv.conns.length === 1, 'the connection');
  const acc = srv.conns[0];
  const myNonce = nonce();
  acc.send(helloFrame(myNonce));
  const dHello = await acc.nextOf('hello');
  assert.equal((await acc.nextOf('prove')).target, null);
  acc.send({ t: 'prove', ids: acceptProofs([target], 'dial', myNonce, dHello.nonce, [dialer.fp]) });
  await waitFor(() => dialer.endpoint.stats().connections[0].error?.code === 'CONNECTION_REFUSED', 'the refusal on the connection');
  await waitFor(() => acc.frames.some((f) => f.t === 'bye'), 'the bye');
  assert.equal(acc.frames.find((f) => f.t === 'bye').reason, 'PROOF');
  assert.deepEqual(dialer.endpoint.stats().sessions, []);
});

// Invariant (misrouting defence): a targeted dial (a hub stream) refuses an acceptor that validly proves someone
// other than its target.
test('a dialer refuses an acceptor that validly proves someone other than its target', async (t) => {
  const target = await newIdentity();
  const impostor = await newIdentity();
  const opened = [];
  const lying = await lyingHub(t, { onOpen: (link, f) => { opened.push({ link, s: f.s }); return true; } });
  const dialer = await stubEndpoint(t, { listen: null, connections: [lying.addr], view: stubView({ contacts: [target.fp] }) });
  await waitFor(() => dialer.endpoint.stats().connections[0].state === 'up', 'the hub link');
  // The target registers on the hub: the roster reports it, and the dialer opens a stream to it.
  const targetLink = await rawHubLink(lying.port, [target]);
  closeAll(t, targetLink);
  const syncing = dialer.transport.sync();
  await waitFor(() => opened.length === 1, 'the stream open');
  const { link, s } = opened[0];
  const inStream = streamReader(lying, link, s);
  const myNonce = nonce();
  lying.inject(link, s, helloFrame(myNonce));
  const dHello = await inStream.nextOf('hello');
  assert.equal((await inStream.nextOf('prove')).target, target.fp);
  // A correct accept proof (role, nonces, bound to the dialer) by an identity the dialer never asked for.
  lying.inject(link, s, { t: 'prove', ids: acceptProofs([impostor], 'accept', myNonce, dHello.nonce, [dialer.fp]) });
  assert.equal((await inStream.nextOf('bye')).reason, 'PROOF');
  await syncing;
  assert.deepEqual(dialer.endpoint.stats().sessions, []);
});

// The endpoint frames a lying hub's `link` sent on stream `s` (decoded from its `data` frames).
function streamReader(lying, link, s) {
  const r = { read: 0 };
  const frames = () => {
    const out = [];
    let buf = Buffer.alloc(0);
    for (const f of lying.received(link)) {
      if (f.t !== 'data' || f.s !== s) continue;
      buf = Buffer.concat([buf, Buffer.from(f.b, 'base64url')]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        out.push(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString('utf8')));
        buf = buf.subarray(4 + buf.readUInt32BE(0));
      }
    }
    return out;
  };
  // The next frame of `type`; fails after `ms` rather than hang when it never comes.
  r.nextOf = async (type, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const all = frames();
      while (r.read < all.length) { const f = all[r.read++]; if (f.t === type) return f; }
      if (Date.now() > end) throw new Error(`timed out waiting for a ${type} on stream ${s}`);
      await new Promise((res) => setTimeout(res, 2));
    }
  };
  return r;
}

// Invariant (D3, dialer side): an untargeted dialer refuses an acceptor that validly proves one of the dialer's own
// identities. The far end here is a raw acceptor holding the dialer's key, so no acceptor-side check intervenes.
test('an untargeted dialer refuses an acceptor that proves one of its own identities', async (t) => {
  const self = await newIdentity();
  const srv = await rawServer(t);
  const dialer = await stubEndpoint(t, { identity: self, listen: null, connections: [srv.addr] });
  await waitFor(() => srv.conns.length === 1, 'the connection');
  const acc = srv.conns[0];
  const myNonce = nonce();
  acc.send(helloFrame(myNonce));
  const dHello = await acc.nextOf('hello');
  assert.equal((await acc.nextOf('prove')).target, null);
  // A correct accept proof (role, both nonces, bound to the dialer's fps), signed by the dialer's own key.
  acc.send({ t: 'prove', ids: acceptProofs([self], 'accept', myNonce, dHello.nonce, [dialer.fp]) });
  // Bounded: without the refusal the dialer would answer `ok` and no `bye` would ever come.
  await waitFor(() => dialer.endpoint.stats().connections[0].error?.code === 'CONNECTION_REFUSED', 'the refusal on the connection');
  await waitFor(() => acc.frames.some((f) => f.t === 'bye'), 'the bye');
  assert.equal(acc.frames.find((f) => f.t === 'bye').reason, 'PROOF');
  assert.deepEqual(dialer.endpoint.stats().sessions, []);
});

// Invariant (D3): a connection names no fingerprint: it reaches whoever proves at its address, but never this
// install's own identities (a connection to its own listener is refused, shown and backed off).
test('an untargeted dialer accepts whoever proves, never its own identities', async (t) => {
  const b = await stubEndpoint(t);
  const addrB = `127.0.0.1:${b.port}`;
  const a = await stubEndpoint(t, { listen: null, connections: [addrB] });
  await waitFor(() => a.endpoint.stats().connections[0].state === 'up', 'the connection');
  assert.deepEqual(a.endpoint.stats().sessions, [{ role: 'dial', via: 'direct', address: addrB, remote: [b.fp] }]);
  assert.deepEqual(a.endpoint.stats().connections[0], { address: addrB, kind: 'peer', state: 'up', remote: [b.fp], error: null });

  const clock = fakeClock();
  const port = await freePort();
  const self = await stubEndpoint(t, { listen: { port }, connections: [`127.0.0.1:${port}`], now: clock.now, schedule: clock.schedule });
  await waitFor(() => self.endpoint.stats().connections[0].error?.code === 'CONNECTION_REFUSED', 'the refusal');
  assert.equal(self.endpoint.stats().connections[0].state, 'waiting');
  assert.deepEqual(self.endpoint.stats().sessions, []);
});

test('no frame is acted on before the handshake completes', async (t) => {
  let served = 0;
  const a = await stubEndpoint(t, { view: stubView({ serve: () => { served += 1; return { status: 'ok', recs: [], more: false, head: 0 }; } }) });
  const mallory = await newIdentity();
  // A record pushed before any proof.
  const early = await rawConnect(a.port);
  closeAll(t, early);
  await early.nextOf('hello');
  early.send(helloFrame());
  early.send({ t: 'rec', from: mallory.fp, to: a.fp, route: { kind: 'directory' }, rec: b64(announceOf(mallory)) });
  await early.whenClosed;
  assert.equal(early.frames.at(-1).reason, 'PROTOCOL');
  // A pull sent after both proofs but before `ok`.
  const raw = await rawConnect(a.port);
  closeAll(t, raw);
  const { nonce } = await raw.nextOf('hello');
  const mine = crypto.randomBytes(32).toString('hex');
  raw.send(helloFrame(mine));
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
  const alice = await netNode('alice');
  closeAll(t, alice);
  const mallory = await newIdentity();
  const bob = await newIdentity();
  const raw = await rawPeer(alice.port(), mallory, alice.fp);
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

  // A connection target that never says hello: the attempt ends CONNECTION_TIMEOUT and waits out its backoff.
  const clock = fakeClock();
  const silentSrv = await rawServer(t);
  const c = await stubEndpoint(t, { listen: null, connections: [silentSrv.addr], now: clock.now, schedule: clock.schedule });
  await waitFor(() => silentSrv.conns.length === 1, 'the connection');
  clock.advance(TCP_HANDSHAKE_MS);
  await waitFor(() => c.endpoint.stats().connections[0].error?.code === 'CONNECTION_TIMEOUT', 'the timeout');
  assert.equal(c.endpoint.stats().connections[0].state, 'waiting');
  clock.advance(TCP_REDIAL_MIN_MS - 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(silentSrv.conns.length, 1);
  clock.advance(1);
  await waitFor(() => silentSrv.conns.length === 2, 'the reconnect after the backoff');
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
  assert.equal(a.endpoint.stats().sessionCount, 2);
});

test('an offline recipient gets the record from the outbox when it reconnects', async (t) => {
  const alice = await netNode('alice');
  let bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
  const bobDir = bob.dataDir;
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  await bob.close();
  await waitFor(() => alice.transport.stats().sessions.length === 0, 'alice to see bob leave');
  await alice.engine.sendMessage(inbox, 'while you were out');
  assert.equal(alice.engine.state().diagnostics.outbox, 1);
  bob = await netNode('bob', { dataDir: bobDir });
  assert.deepEqual(bob.engine.settings().transport.connections, [alice.addr()]);
  await bob.engine.sync(); // bob's connection is up: alice hears peerOnline(bob) and flushes her outbox
  await waitFor(() => alice.engine.state().diagnostics.outbox === 0, 'the outbox to drain');
  await settle([alice, bob]);
  assert.deepEqual(bob.engine.messages(inbox).map((m) => m.body), ['while you were out']);
});

test('a late joiner pulls the history from the per-peer cursor', async (t) => {
  let served = 0;
  const countServe = (view) => ({ ...view, serve: (...a) => { const r = view.serve(...a); served += r.recs?.length ?? 0; return r; } });
  const alice = await netNode('alice', { wrapView: countServe });
  let bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
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
  bob = await netNode('bob', { dataDir: bobDir });
  await bob.engine.sync();
  assert.equal(served, 0);
  assert.deepEqual(bob.engine.messages(team).map((m) => m.body), ['m1', 'm2', 'm3']);
});

test('a denied pull keeps its cursor', async (t) => {
  const denied = [];
  const spyServe = (view) => ({ ...view, serve: (reader, route, ...a) => { const r = view.serve(reader, route, ...a); if (r.status === 'denied') denied.push(routeKey(route)); return r; } });
  const alice = await netNode('alice', { wrapView: spyServe });
  const bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
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
  const alice = await netNode('alice');
  const bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  await alice.engine.sendMessage(inbox, 'private');
  await alice.engine.createSharedInbox('team'); // an inbox-create: what alice's directory route serves
  const carol = await newIdentity();
  const raw = await rawPeer(alice.port(), carol, alice.fp);
  closeAll(t, raw);
  const routes = [{ kind: 'inbox', id: inbox }, { kind: 'mailbox', fp: bob.fp }, { kind: 'directory' }];
  raw.send({ t: 'pull', id: 7, from: carol.fp, to: alice.fp, routes: routes.map((route) => ({ route, since: 0 })) });
  const recs = await raw.nextOf('recs');
  assert.deepEqual(recs.routes.map((r) => [routeKey(r.route), r.status, (r.recs?.length ?? 0) > 0]), [[`inbox:${inbox}`, 'denied', false], [`mailbox:${bob.fp}`, 'denied', false], ['directory', 'ok', true]]);
  // A denial says nothing about how much alice holds.
  for (const r of recs.routes.slice(0, 2)) assert.deepEqual(Object.keys(r).sort(), ['route', 'status']);
});

test('a peer\'s pull names only the routes it could serve', async (t) => {
  const alice = await netNode('alice');
  const bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
  t.after(async () => { await alice.close(); await bob.close(); });
  await bob.engine.importCard(alice.card());
  await settle([alice, bob]);
  const inbox = await personal(alice, bob);
  const { id: team } = await alice.engine.createSharedInbox('team');
  assert.ok(alice.engine.state().inboxes.some((b) => b.id === inbox));
  // A stranger connects: alice's pull on the new session names her directory and her mailbox, nothing else.
  const mallory = await newIdentity();
  const raw = await rawPeer(alice.port(), mallory, alice.fp);
  closeAll(t, raw);
  const pull = await raw.nextOf('pull');
  assert.deepEqual(pull.routes.map((r) => routeKey(r.route)).sort(), ['directory', `mailbox:${alice.fp}`]);
  await alice.engine.sync();
  const pulls = raw.frames.filter((f) => f.t === 'pull');
  for (const p of pulls) for (const r of p.routes) assert.ok(!routeKey(r.route).startsWith('inbox:'), `${routeKey(r.route)} was named to a stranger`);
  assert.ok(!JSON.stringify(raw.frames).includes(team) && !JSON.stringify(raw.frames).includes(inbox));
});


// Invariant (D6): a stranger (a proven non-contact) is served while its session lives, but never becomes a contact
// and is never dialed, whether it dialed in, this install met it on one of its connections, or a hub reports it.
test('a stranger is served but never dialed, whether it dialed in, was met on a connection or is on a hub', async (t) => {
  const lying = await lyingHub(t);
  const mallory = await newIdentity();
  const eve = await stubEndpoint(t);
  const alice = await netNode('alice', { connections: [lying.addr, `127.0.0.1:${eve.port}`] });
  closeAll(t, alice);
  await waitFor(() => alice.status(lying.addr).state === 'up' && alice.status(`127.0.0.1:${eve.port}`).state === 'up', 'both connections');
  // eve, met on a connection, is served: she pulled alice's directory.
  assert.deepEqual(alice.status(`127.0.0.1:${eve.port}`).remote, [eve.fp]);
  // mallory dials in and pushes his announce.
  const raw = await rawPeer(alice.port(), mallory, alice.fp);
  raw.send({ t: 'rec', from: mallory.fp, to: alice.fp, route: { kind: 'directory' }, rec: b64(announceOf(mallory)) });
  await waitFor(() => alice.engine.state().directory.some((d) => d.fp === mallory.fp), 'mallory in the directory');
  raw.destroy();
  await raw.whenClosed;
  await waitFor(() => alice.sessionsWith(mallory.fp).length === 0, 'mallory to leave');
  // mallory registers on alice's hub: the roster tells alice he is there.
  const onHub = await rawHubLink(lying.port, [mallory]);
  closeAll(t, onHub);
  await waitFor(() => alice.transport.stats().presence[mallory.fp]?.some((p) => p.via === 'hub'), 'mallory on the hub');
  await alice.engine.announce();
  await alice.engine.sync();
  assert.deepEqual(alice.view.contacts(), []);
  const opens = lying.received(lying.linkOf(alice.fp)).filter((f) => f.t === 'open');
  assert.deepEqual(opens, []);
});

// Invariant: two direct sessions between the same endpoints (each has a connection to the other's listener) leave
// one, the same on both sides, and nothing is lost.
test('simultaneous dials leave one session and lose nothing', async (t) => {
  // Connections fail until the gate opens, then both retry on the same clock tick.
  const clock = fakeClock();
  const dead = await freePort();
  const gate = { open: false };
  const connect = (opts) => net.connect(gate.open ? opts : { host: '127.0.0.1', port: dead });
  const [pa, pb] = [await freePort(), await freePort()];
  const opts = { connect, schedule: clock.schedule, now: clock.now };
  const alice = await netNode('alice', { ...opts, listen: { port: pa }, connections: [`127.0.0.1:${pb}`] });
  const bob = await netNode('bob', { ...opts, listen: { port: pb }, connections: [`127.0.0.1:${pa}`] });
  t.after(async () => { await alice.close(); await bob.close(); });
  await waitFor(() => alice.transport.stats().connections[0].state === 'waiting' && bob.transport.stats().connections[0].state === 'waiting', 'both connections to fail once');
  await bob.engine.importCard(alice.card());
  await alice.engine.importCard(bob.card());
  gate.open = true;
  let peak = 0;
  let racing = true;
  const sample = () => { if (!racing) return; peak = Math.max(peak, alice.transport.stats().sessionCount); setImmediate(sample); };
  sample();
  clock.advance(TCP_REDIAL_MIN_MS);
  await waitFor(() => peak === 2, 'both sides dialed');
  await waitFor(() => alice.transport.stats().sessionCount === 1 && bob.transport.stats().sessionCount === 1, 'one session each');
  racing = false;
  const inbox = await personal(alice, bob);
  await alice.engine.sendMessage(inbox, 'from alice');
  await bob.engine.sendMessage(inbox, 'from bob');
  await settle([alice, bob]);
  for (const n of [alice, bob]) assert.deepEqual(n.engine.messages(inbox).map((m) => m.body).sort(), ['from alice', 'from bob']);
  assert.equal(alice.transport.stats().sessions.length, 1);
  assert.equal(bob.transport.stats().sessions.length, 1);
});

// Invariant (D5): a connection reconnects on its own timer: the delay doubles from TCP_REDIAL_MIN_MS up to the
// maximum, and a handshake that completes resets it.
test('a connection reconnects with backoff, doubling to the maximum, and resets after a handshake', async (t) => {
  const clock = fakeClock();
  let dead = await countingListener();
  const { port } = dead;
  const a = await stubEndpoint(t, { listen: null, connections: [dead.addr], now: clock.now, schedule: clock.schedule, limits: { redialMaxMs: 4 * TCP_REDIAL_MIN_MS } });
  const attempts = async (ms, expect) => {
    clock.advance(ms);
    if (expect !== dead.count) await waitFor(() => dead.count === expect && a.endpoint.stats().connections[0].state === 'waiting', `attempt ${expect}`);
    await new Promise((r) => setTimeout(r, 10));
    return dead.count;
  };
  assert.equal(await attempts(0, 1), 1); // start's own attempt
  assert.equal(await attempts(TCP_REDIAL_MIN_MS - 1, 1), 1);
  assert.equal(await attempts(1, 2), 2);
  assert.equal(await attempts(2 * TCP_REDIAL_MIN_MS - 1, 2), 2);
  assert.equal(await attempts(1, 3), 3);
  assert.equal(await attempts(4 * TCP_REDIAL_MIN_MS, 4), 4);
  // The maximum: the next wait is 4 × MIN again, not 8 ×.
  assert.equal(await attempts(4 * TCP_REDIAL_MIN_MS - 1, 4), 4);
  assert.equal(await attempts(1, 5), 5);
  // bob comes up on that port: the next attempt (once its backoff ends) succeeds.
  await dead.close();
  const bob = await newIdentity();
  const b = createNetworkEndpoint({ listen: { port }, syncMs: 3_600_000, log: silentLog });
  await b.attach({ identity: proofSigner(bob), view: stubView(), cursors: memCursors() }).start(stubSink());
  clock.advance(4 * TCP_REDIAL_MIN_MS);
  await waitFor(() => a.endpoint.stats().sessions.length === 1, 'the session');
  assert.equal(a.endpoint.stats().connections[0].state, 'up');
  // bob goes away again: the spacing starts over from the minimum.
  b.close();
  await waitFor(() => a.endpoint.stats().sessions.length === 0 && a.endpoint.stats().connections[0].state === 'waiting', 'the session to end');
  dead = await countingListener(port);
  t.after(() => dead.close());
  assert.equal(await attempts(TCP_REDIAL_MIN_MS - 1, 0), 0);
  assert.equal(await attempts(1, 1), 1);
  assert.equal(await attempts(TCP_REDIAL_MIN_MS - 1, 1), 1);
  assert.equal(await attempts(1, 2), 2);
});

test('the listener binds loopback unless a host is given', async (t) => {
  const alice = await netNode('alice', { configure: false });
  closeAll(t, alice);
  const saved = await alice.engine.setNetwork({ listen: { port: 0 } });
  assert.equal(saved.listening.host, '127.0.0.1');
  assert.deepEqual(saved.listen, { host: '127.0.0.1', port: 0 });
  assert.deepEqual(saved.connections, []);
  assert.equal(alice.transport.stats().listening.host, '127.0.0.1');
  assert.equal(alice.engine.state().transport.listening.host, '127.0.0.1');
});

test('re-saving network settings on the same port rebinds', async (t) => {
  const port = await freePort();
  const alice = await netNode('alice', { listen: { port } });
  const bob = await netNode('bob', { listen: null, connections: [`127.0.0.1:${port}`] });
  t.after(async () => { await alice.close(); await bob.close(); });
  await waitFor(() => bob.transport.stats().sessions.length === 1, 'the session');
  // Under the engine lock, with a live session: the old listener must be gone before the new one binds.
  assert.deepEqual((await alice.engine.setNetwork({ listen: { port } })).listening, { host: '127.0.0.1', port });
  assert.deepEqual((await alice.engine.setNetwork({ listen: { port } })).listening, { host: '127.0.0.1', port });
  await waitFor(() => bob.transport.stats().sessions.length === 0, 'the old session to end');
  await bob.engine.sync();
  await waitFor(() => bob.transport.stats().sessions.length === 1, 'bob\'s connection back');
});

test('a port in use refuses LISTEN_FAILED and leaves the transport unconfigured', async (t) => {
  const busy = net.createServer();
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const { port } = busy.address();
  const alice = await netNode(null, { configure: false });
  t.after(async () => { await alice.close(); if (busy.listening) busy.close(); });
  await assert.rejects(alice.engine.setNetwork({ listen: { port } }), { code: 'LISTEN_FAILED' });
  const st = alice.engine.state().transport;
  assert.equal(st.configured, false);
  assert.equal(st.error.code, 'LISTEN_FAILED');
  await assert.rejects(alice.engine.announce(), { code: 'TRANSPORT_UNCONFIGURED' });
  // Once the port is free, saving again listens and clears the error.
  await new Promise((r) => busy.close(r));
  await alice.engine.setNetwork({ listen: { port } });
  assert.equal(alice.engine.state().transport.configured, true);
  assert.equal(alice.engine.state().transport.error, null);
});

// Invariant: an admission owed when no transport could start (the port was taken at boot) is written as soon as a
// transport starts, without another restart.
test('an owed admission completes after a boot listen failure followed by setNetwork', async (t) => {
  const port = await freePort();
  let alice = await netNode('alice', { listen: { port } });
  const bob = await netNode('bob', { listen: null, connections: [`127.0.0.1:${port}`] });
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
  alice = await netNode('alice', { dataDir: aliceDir, configure: false });
  assert.equal(alice.engine.state().transport.error.code, 'LISTEN_FAILED');
  assert.deepEqual(alice.engine.listInboxes()[0].members.map((m) => m.fp), [alice.fp]);
  await new Promise((r) => busy.close(r));
  await alice.engine.setNetwork({ listen: { port } });
  assert.deepEqual(alice.engine.listInboxes()[0].members.map((m) => m.fp).sort(), [alice.fp, bob.fp].sort());
});

// Invariant: a connection host that is, or resolves to, every interface is refused like 0.0.0.0, however it is
// spelt; a listener may bind every interface (nothing is advertised). An unresolvable connection host is refused
// on a save and accepted at boot; a listen host must resolve.
test('a connection host that is, or resolves to, every interface is refused NETWORK_INVALID; a listener may bind every interface', async (t) => {
  // What a resolver answers for these spellings (inet_aton reads each as 0.0.0.0); injected, so no resolver is needed.
  const lookup = async (name) => {
    if (['0', '00.0.0.0', '0x0.0.0.0'].includes(name)) return [{ address: '0.0.0.0', family: 4 }];
    if (name === 'multi.example') return [{ address: '10.0.0.1', family: 4 }, { address: '::', family: 6 }];
    if (name.endsWith('.local')) return [{ address: '127.0.0.1', family: 4 }];
    throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  };
  const alice = await netNode('alice', { lookup });
  closeAll(t, alice);
  for (const a of ['0.0.0.0:5', '[::]:5', '[::0]:5', '[0:0:0:0:0:0:0:0]:5', '[::ffff:0.0.0.0]:5']) {
    await assert.rejects(alice.engine.setNetwork({ listen: null, connections: [a] }), { code: 'NETWORK_INVALID' }, a);
  }
  for (const name of ['0', '00.0.0.0', '0x0.0.0.0', 'multi.example']) {
    await assert.rejects(alice.engine.setNetwork({ listen: null, connections: [`${name}:5`] }), { code: 'NETWORK_INVALID' }, name);
    await assert.rejects(resolveNetworkConfig({ connections: [`${name}:5`] }, { lookup, mustResolve: false }), { code: 'NETWORK_INVALID' }, `${name} at boot`);
  }
  assert.equal(alice.engine.state().transport.configured, true);
  for (const host of ['0.0.0.0', '::', 'every.local']) {
    assert.deepEqual((await resolveNetworkConfig({ listen: { host, port: 0 } }, { lookup })).listen, { host, port: 0 });
  }
  await assert.rejects(resolveNetworkConfig({ listen: { host: 'nowhere.example' } }, { lookup }), { code: 'NETWORK_INVALID' });
  await assert.rejects(resolveNetworkConfig({ listen: { host: 'nowhere.example' } }, { lookup, mustResolve: false }), { code: 'NETWORK_INVALID' });
  await assert.rejects(resolveNetworkConfig({ connections: ['nowhere.example:5'] }, { lookup }), { code: 'NETWORK_INVALID' });
  assert.deepEqual((await resolveNetworkConfig({ connections: ['nowhere.example:5'] }, { lookup, mustResolve: false })).connections, ['nowhere.example:5']);
});

// Invariant (C3): a listener that fails after it is up is closed and forgotten: its port is free to bind again and
// the sessions it accepted carry on.
test('a listener that fails after it is up frees its port and keeps its sessions', async (t) => {
  let srv;
  const identity = await newIdentity();
  const endpoint = createNetworkEndpoint({ listen: { port: 0 }, syncMs: 3_600_000, log: silentLog, createServer: (onConnection) => { srv = net.createServer(onConnection); return srv; } });
  const transport = endpoint.attach({ identity: proofSigner(identity), view: stubView(), cursors: memCursors() });
  await transport.start(stubSink());
  t.after(() => endpoint.close());
  const { port } = endpoint.stats().listening;
  const raw = await rawPeer(port, await newIdentity(), identity.fp);
  closeAll(t, raw);
  await waitFor(() => endpoint.stats().sessions.length === 1, 'the session');
  srv.emit('error', Object.assign(new Error('accept failed'), { code: 'EMFILE' }));
  assert.equal(endpoint.stats().listening, null);
  const again = net.createServer();
  await new Promise((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', resolve); });
  await new Promise((r) => again.close(r));
  raw.send({ t: 'ping' });
  assert.equal((await raw.nextOf('pong')).t, 'pong');
  assert.equal(endpoint.stats().sessions.length, 1);
});

// Invariant (T4): DNS lookups run before the engine lock is taken (a slow resolver blocks no other action) and are
// bounded: a lookup that does not answer in time is refused NETWORK_INVALID.
test('network settings are resolved outside the engine lock, with a timeout', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const lookup = async (name) => { if (name === 'slow.example') await gate; return [{ address: '127.0.0.1', family: 4 }]; };
  const dead = await freePort();
  const alice = await netNode('alice', { lookup, connect: () => net.connect({ host: '127.0.0.1', port: dead }) });
  closeAll(t, alice);
  const saving = alice.engine.setNetwork({ listen: { port: 0 }, connections: ['slow.example:9'] });
  assert.deepEqual(await alice.engine.setName('alice2'), { name: 'alice2' }, 'another action ran while the lookup waited');
  release();
  assert.deepEqual((await saving).connections, ['slow.example:9']);
  const never = () => new Promise(() => {});
  await assert.rejects(resolveNetworkConfig({ listen: { host: 'hang.example' } }, { lookup: never, lookupMs: 20 }), { code: 'NETWORK_INVALID' });
  await assert.rejects(resolveNetworkConfig({ connections: ['hang.example:5'] }, { lookup: never, lookupMs: 20 }), { code: 'NETWORK_INVALID' });
});

// Invariant (U3): an install built by wire takes its clock for the network endpoint too: a fake clock decides when a
// silent connection's handshake deadline passes.
test('wire threads the injected clock through to the network endpoint', async (t) => {
  const clock = fakeClock();
  const a = await makeInstall(null, { schedule: clock.schedule, now: clock.now });
  t.after(() => a.close());
  await a.engine.setNetwork({ listen: { port: 0 } });
  const { port } = a.engine.state().transport.listening;
  const raw = await rawConnect(port);
  closeAll(t, raw);
  assert.equal((await raw.next()).t, 'hello');
  clock.advance(TCP_HANDSHAKE_MS - 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(raw.closed, false, 'not before the deadline');
  clock.advance(1);
  await waitFor(() => raw.closed, 'the handshake deadline on the fake clock', 2000);
});
