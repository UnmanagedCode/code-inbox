import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { loadIdentity } from '../src/identity.js';
import { createStore } from '../src/store.js';
import { TCP_REDIAL_MIN_MS } from '../src/transport/endpoint.js';
import { proofSigner } from '../src/transport/handshake.js';
import { TCP_DEFAULT_PORT, createNetworkEndpoint, validateNetworkConfig } from '../src/transport/network.js';
import { encodeFrame } from '../src/transport/frames.js';
import { fakeClock, makeInstall, silentLog, tmpDir } from './helpers.mjs';
import { lyingHub, startHub } from './hubHelpers.mjs';
import { netNode, relay } from './netHelpers.mjs';
import { countingListener, freePort, helloFrame, memCursors, personal, rawConnect, settle, stubSink, stubView, waitFor } from './tcpHelpers.mjs';

// Network mode end to end: a listener plus configured connections, each reaching a peer or a hub, over real
// loopback sockets on ephemeral ports. Engines run with an hour-long maintain interval (every sync is driven by the
// test); reconnects run on short real timers (SHORT) or a fake clock. Each test closes everything it opened.

const SHORT = { redialMinMs: 20, redialMaxMs: 40 };
const closeAll = (t, ...things) => t.after(async () => { for (const x of things) await (x.close ?? x.destroy).call(x); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viaOf = (node, fp) => node.sessionsWith(fp).map((s) => s.via);

// Two data dirs whose identities sort: `low` has the smaller fingerprint.
async function sortedDirs() {
  const dirs = [tmpDir('code-inbox-net-'), tmpDir('code-inbox-net-')];
  const fps = await Promise.all(dirs.map(async (d) => (await loadIdentity(d)).fp));
  return fps[0] < fps[1] ? { low: dirs[0], high: dirs[1] } : { low: dirs[1], high: dirs[0] };
}

// A connect() that sends `port` to a dead port until `gate.open`: a direct route that comes up when the test says.
async function gatedConnect(port) {
  const dead = await freePort();
  const gate = { open: false };
  const connect = (o) => net.connect(o.port === port && !gate.open ? { host: '127.0.0.1', port: dead } : o);
  return { gate, connect };
}

// Invariant: one address form; the far end's hello says what it is. A connection to a listener runs the endpoint
// handshake (kind peer), one to a hub registers (kind hub), and only an end-to-end session fires peerOnline.
test('a connection detects a peer or a hub from the far end\'s hello', async (t) => {
  const hub = await startHub(t);
  const bob = await netNode('bob');
  const alice = await netNode('alice', { listen: null, connections: [bob.addr(), hub.addr] });
  closeAll(t, alice, bob);
  await waitFor(() => alice.status(bob.addr()).state === 'up' && alice.status(hub.addr).state === 'up', 'both connections up');
  assert.deepEqual(alice.status(bob.addr()), { address: bob.addr(), kind: 'peer', state: 'up', remote: [bob.fp], error: null });
  assert.deepEqual(alice.status(hub.addr), { address: hub.addr, kind: 'hub', state: 'up', remote: [], error: null });
  assert.equal(hub.hub.stats().fps, 1);
  assert.deepEqual(alice.online, [bob.fp]);
});

// Invariant (realistic input): a far end that is not a v2 endpoint or hub (an old peer, another service, one that
// says bye) fails the attempt CONNECTION_PROTOCOL on the connection's row and is retried with doubling backoff; a
// listener refuses a hello that claims to be a hub.
test('a far end that does not speak a v2 hello is refused, shown on the connection, and retried with backoff', async (t) => {
  const answers = [
    encodeFrame({ t: 'hello', v: 1, nonce: 'c'.repeat(64) }),
    encodeFrame({ t: 'hello', v: 2, nonce: 'c'.repeat(64), kind: 'relay' }),
    Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'),
    encodeFrame({ t: 'bye', reason: 'STOP' }),
  ];
  for (const answer of answers) {
    const clock = fakeClock();
    let accepted = 0;
    const srv = net.createServer((s) => { accepted += 1; s.on('error', () => {}); s.write(answer); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const addr = `127.0.0.1:${srv.address().port}`;
    const identity = await loadIdentity(tmpDir());
    const e = createNetworkEndpoint({ connections: [addr], syncMs: 3_600_000, log: silentLog, now: clock.now, schedule: clock.schedule });
    await e.attach({ identity: proofSigner(identity), view: stubView(), cursors: memCursors() }).start(stubSink());
    const what = answer.subarray(0, 30).toString();
    await waitFor(() => e.stats().connections[0].error?.code === 'CONNECTION_PROTOCOL', `the refusal of ${what}`);
    assert.equal(e.stats().connections[0].state, 'waiting', what);
    assert.equal(e.stats().connections[0].kind, null, what);
    clock.advance(TCP_REDIAL_MIN_MS);
    await waitFor(() => accepted === 2 && e.stats().connections[0].state === 'waiting', `the retry of ${what}`);
    clock.advance(TCP_REDIAL_MIN_MS);
    await sleep(20);
    assert.equal(accepted, 2, `${what}: the second wait doubles`);
    e.close();
    srv.close();
  }
  const bob = await netNode('bob');
  closeAll(t, bob);
  const raw = await rawConnect(bob.port());
  closeAll(t, raw);
  await raw.nextOf('hello');
  raw.send(helloFrame(undefined, 'hub'));
  await raw.whenClosed;
  assert.deepEqual(raw.frames.at(-1), { t: 'bye', reason: 'PROTOCOL' });
});

// Two installs on one hub, with a hub session formed first (dialed by `hubDialer`), then a direct session (dialed
// by `directDialer` to the other's listener). Fingerprints are arranged so that the hub session's dialer sorts lowest
// or the dialers tie (the hub session is then the older): the fingerprint rule alone would keep the hub session.
async function hubThenDirect(t, { hubDialer, directDialer }) {
  const hub = await startHub(t);
  const dirs = await sortedDirs();
  const listener = directDialer === 'low' ? 'high' : 'low';
  const port = await freePort();
  const { gate, connect } = await gatedConnect(port);
  const nodes = {};
  nodes[listener] = await netNode(listener, { dataDir: dirs[listener], listen: { port }, connections: [hub.addr], limits: SHORT });
  nodes[directDialer] = await netNode(directDialer, { dataDir: dirs[directDialer], listen: null, connections: [hub.addr, `127.0.0.1:${port}`], connect, limits: SHORT });
  const { low, high } = nodes;
  closeAll(t, low, high);
  const [a, b] = hubDialer === 'low' ? [low, high] : [high, low];
  await waitFor(() => low.status(hub.addr).state === 'up' && high.status(hub.addr).state === 'up', 'both on the hub');
  await waitFor(() => a.transport.stats().presence[b.fp]?.length, 'the roster');
  await a.engine.importCard(b.card());
  await a.engine.sync();
  await waitFor(() => viaOf(a, b.fp).join() === 'hub' && viaOf(b, a.fp).join() === 'hub', 'the hub session');
  assert.equal(a.sessionsWith(b.fp)[0].role, 'dial');
  return { low, high, a, b, gate, hub };
}

const directOnly = async (x, y) => waitFor(() => viaOf(x, y.fp).join() === 'direct' && viaOf(y, x.fp).join() === 'direct', 'one direct session on both sides');

// Invariant (D4): a direct session outranks a hub session in the duplicate rule. Once the direct route is up, both
// ends keep the same (direct) session, the hub session is closed by its own dialer, and nothing sent meanwhile is lost.
test('direct wins: a hub session is replaced by a direct one and both ends keep the same session', async (t) => {
  const { low, high, a, b, gate } = await hubThenDirect(t, { hubDialer: 'low', directDialer: 'high' });
  const inbox = await personal(a, b);
  await a.engine.sendMessage(inbox, 'over the hub');
  gate.open = true;
  await directOnly(low, high);
  await a.engine.sendMessage(inbox, 'direct');
  await b.engine.sendMessage(inbox, 'back');
  await settle([a, b]);
  for (const n of [a, b]) assert.deepEqual(n.engine.messages(inbox).map((m) => m.body), ['over the hub', 'direct', 'back']);
  for (const n of [a, b]) assert.equal(n.engine.state().diagnostics.outbox, 0);
  await sleep(100);
  await directOnly(low, high); // and it stays so: no close loop
  assert.equal(high.status(`127.0.0.1:${low.port()}`).state, 'up');
});

// Invariant (D4): the route ranks before the fingerprint, whichever side dialed which route: in each case the
// fingerprint rule alone would keep the hub session, and both ends pool the direct one.
test('the route outranks the fingerprint in the duplicate rule, whichever side dialed which route', async (t) => {
  const cases = [
    { hubDialer: 'low', directDialer: 'high' },
    { hubDialer: 'low', directDialer: 'low' },
    { hubDialer: 'high', directDialer: 'high' },
  ];
  for (const c of cases) {
    await t.test(`hub dialed by ${c.hubDialer}, direct by ${c.directDialer}`, async (tt) => {
      const { low, high, gate } = await hubThenDirect(tt, c);
      gate.open = true;
      await directOnly(low, high);
      await sleep(100);
      await directOnly(low, high);
    });
  }
});

// Invariant (D7, §4.4): a contact whose direct route goes down is reached through a hub, and moves back to direct once
// the connection's own timer finds the route again.
test('a contact moves to a hub when its direct connection is down and back to direct when it returns', async (t) => {
  const hub = await startHub(t);
  const lowPort = await freePort();
  const alice = await netNode('alice', { listen: { port: lowPort }, connections: [hub.addr], limits: SHORT });
  const forward = await relay(t, lowPort);
  const bob = await netNode('bob', { listen: null, connections: [hub.addr, forward.addr], limits: SHORT });
  closeAll(t, alice, bob);
  await bob.engine.importCard(alice.card());
  await alice.engine.importCard(bob.card());
  await directOnly(alice, bob);
  const inbox = await personal(alice, bob);
  await forward.close();
  await waitFor(() => bob.sessionsWith(alice.fp).length === 0, 'the direct session to end');
  await bob.engine.sync();
  await waitFor(() => viaOf(bob, alice.fp).join() === 'hub', 'a hub session');
  await bob.engine.sendMessage(inbox, 'through the hub');
  await settle([alice, bob]);
  assert.deepEqual(alice.engine.messages(inbox).map((m) => m.body), ['through the hub']);
  await relay(t, lowPort, { port: forward.port });
  await directOnly(alice, bob);
});

// Invariant (D7, owner decision 5): every hub is asked, in configured order: a contact present on both hubs is
// dialed through the first, one present only on the second is dialed there.
test('a contact present on several hubs is dialed through the first in configured order, and one present only on the second is dialed there', async (t) => {
  const [h1, h2] = [await startHub(t), await startHub(t)];
  const alice = await netNode('alice', { listen: null, connections: [h1.addr, h2.addr] });
  const bob = await netNode('bob', { listen: null, connections: [h1.addr, h2.addr] });
  const carol = await netNode('carol', { listen: null, connections: [h2.addr] });
  closeAll(t, alice, bob, carol);
  await waitFor(() => (alice.transport.stats().presence[bob.fp]?.length ?? 0) === 2 && alice.transport.stats().presence[carol.fp]?.length === 1, 'the rosters');
  await alice.engine.importCard(bob.card());
  await alice.engine.importCard(carol.card());
  await alice.engine.sync();
  await waitFor(() => alice.sessionsWith(bob.fp).length && alice.sessionsWith(carol.fp).length, 'both sessions');
  assert.deepEqual(alice.sessionsWith(bob.fp).map((s) => [s.via, s.address]), [['hub', h1.addr]]);
  assert.deepEqual(alice.sessionsWith(carol.fp).map((s) => [s.via, s.address]), [['hub', h2.addr]]);
});

// Invariant (§4.4 idle rule): a peer-mode connection whose session lost the duplicate rule to another direct session
// stays idle while that session lives (no reconnect churn), and reconnects at the next maintain once it ends.
test('a peer-mode connection that lost the duplicate rule stays idle while a direct session lives and reconnects when it ends', async (t) => {
  const dirs = await sortedDirs();
  const [lowPort, highPort] = [await freePort(), await freePort()];
  const toHigh = await relay(t, highPort); // low's route: its session wins (its dialer sorts lowest)
  const toLow = await relay(t, lowPort); // high's route: its session loses
  const low = await netNode('low', { dataDir: dirs.low, listen: { port: lowPort }, connections: [toHigh.addr], limits: SHORT });
  const high = await netNode('high', { dataDir: dirs.high, listen: { port: highPort }, connections: [toLow.addr], limits: SHORT });
  closeAll(t, low, high);
  await waitFor(() => high.status(toLow.addr).state === 'idle', 'high\'s connection to go idle');
  await directOnly(low, high);
  assert.deepEqual(low.sessionsWith(high.fp).map((s) => s.role), ['dial']);
  const attempts = toLow.conns.length;
  await sleep(150);
  assert.equal(high.status(toLow.addr).state, 'idle');
  assert.equal(toLow.conns.length, attempts, 'no reconnect while the winning session lives');
  await toHigh.close();
  await waitFor(() => high.sessionsWith(low.fp).length === 0, 'the winning session to end');
  await high.engine.sync();
  await waitFor(() => high.status(toLow.addr).state === 'up' && high.sessionsWith(low.fp).length === 1, 'high\'s connection back up');
});

// Invariant: a port forward (or an SSH tunnel) is a direct route to the real peer: the session proves the far
// listener's identity, and the writer of what arrives is that proven identity.
test('a port forward yields the real peer, with the writer bound end to end', async (t) => {
  const bob = await netNode('bob');
  const forward = await relay(t, bob.port());
  const alice = await netNode('alice', { listen: null, connections: [forward.addr] });
  closeAll(t, alice, bob);
  await waitFor(() => alice.status(forward.addr).state === 'up', 'the connection');
  assert.deepEqual(alice.status(forward.addr).remote, [bob.fp]);
  assert.deepEqual(alice.sessionsWith(bob.fp).map((s) => s.via), ['direct']);
  const inbox = await personal(alice, bob);
  await bob.engine.sendMessage(inbox, 'via the forward');
  await settle([alice, bob]);
  assert.deepEqual(alice.engine.messages(inbox).map((m) => m.body), ['via the forward']);
  assert.ok(alice.offered.filter((i) => i.route.kind === 'inbox').every((i) => i.writer === bob.fp));
  assert.ok(forward.conns[0].fromTarget.some((f) => f.t === 'prove'));
});

// Invariant (interim, until the owner relays shared-inbox records): members exchange records only over a session
// between them. On a common hub they reach each other (co-members are contacts); connected only to the owner's
// listener, each exchanges with the owner but never with the other.
test('members of a shared inbox reach each other through a common hub, and not without a shared route', async (t) => {
  async function team(nodes) {
    const [owner, m1, m2] = nodes;
    for (const m of [m1, m2]) await m.engine.importCard(owner.card());
    await settle(nodes);
    const { id } = await owner.engine.createSharedInbox('team');
    for (const m of [m1, m2]) await owner.engine.inviteMember(id, m.fp);
    await settle(nodes);
    for (const m of [m1, m2]) await m.engine.respondInvite(m.engine.state().invites.incoming[0].id, true);
    await settle(nodes, 3);
    await m1.engine.sendMessage(id, 'from m1');
    await settle(nodes, 3);
    return id;
  }
  const hub = await startHub(t);
  const onHub = [];
  for (const name of ['owner', 'm1', 'm2']) onHub.push(await netNode(name, { listen: null, connections: [hub.addr] }));
  closeAll(t, ...onHub);
  const id = await team(onHub);
  for (const n of onHub) assert.deepEqual(n.engine.messages(id).map((m) => m.body), ['from m1'], n.name);

  const owner = await netNode('owner');
  const direct = [owner];
  for (const name of ['m1', 'm2']) direct.push(await netNode(name, { listen: null, connections: [owner.addr()] }));
  closeAll(t, ...direct);
  const id2 = await team(direct);
  assert.deepEqual(direct[0].engine.messages(id2).map((m) => m.body), ['from m1']);
  assert.deepEqual(direct[2].engine.messages(id2), []);
});

// Invariant: network settings are checked on save (NETWORK_INVALID over REST) and at boot, where a connection host
// that does not resolve yet still starts; the listener defaults to loopback and `listen: null` opens no port.
test('network settings are validated on save and checked at boot', async (t) => {
  const install = await makeInstall(null);
  t.after(() => install.close());
  const bad = [
    { listen: { host: 'not a host' } },
    { listen: { port: 70000 } },
    { listen: 'yes' },
    { listen: null, connections: ['no-port'] },
    { listen: null, connections: ['127.0.0.1:0'] },
    { listen: null, connections: ['0.0.0.0:5'] },
    { listen: null, connections: ['127.0.0.1:5', '127.0.0.1:5'] },
    { listen: null, connections: ['Peer.Example:5', 'peer.example:5'] },
    { listen: null, connections: Array.from({ length: 33 }, (_, i) => `127.0.0.1:${i + 1}`) },
    { listen: null, connections: [`${'a'.repeat(250)}.example:5`] },
    { listen: null, connections: 'peer:5' },
    { listen: null, connections: ['nowhere.invalid:5'] },
  ];
  for (const body of bad) {
    const res = await install.rest('POST', '/api/network', body);
    assert.deepEqual([res.status, res.json.code], [400, 'NETWORK_INVALID'], JSON.stringify(body).slice(0, 80));
  }
  assert.deepEqual(validateNetworkConfig({ listen: {} }), { listen: { host: '127.0.0.1', port: TCP_DEFAULT_PORT }, connections: [] });
  assert.deepEqual(validateNetworkConfig({ connections: ['[::1]:5', ' Host.Example:7 '] }).connections, ['[::1]:5', 'host.example:7']);

  // A stored config whose connection host does not resolve yet still starts and keeps trying; no listener.
  const dataDir = tmpDir('code-inbox-net-');
  const store = createStore(dataDir, { log: silentLog });
  const { settings } = await store.load();
  await store.saveSettings({ ...settings, transport: { kind: 'network', listen: null, connections: ['nowhere.example:5'] } });
  const dead = await freePort();
  const lookup = async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); };
  const offline = await netNode('offline', { dataDir, lookup, connect: () => net.connect({ host: '127.0.0.1', port: dead }) });
  closeAll(t, offline);
  const view = offline.engine.state().transport;
  assert.deepEqual([view.kind, view.configured, view.error, view.listening], ['network', true, null, null]);
  await waitFor(() => offline.engine.state().transport.connections[0].error?.code === 'ECONNREFUSED', 'the refused connect to show');
});

// Invariant: stop() is synchronous: the listener's port is free, no connection's timer fires afterwards, and a hub
// link is told STOP.
test('stop() tears down the listener and every connection synchronously', async (t) => {
  const clock = fakeClock();
  const lying = await lyingHub(t);
  const dead = await countingListener();
  t.after(() => dead.close());
  const port = await freePort();
  const alice = await netNode('alice', { listen: { port }, connections: [dead.addr, lying.addr], now: clock.now, schedule: clock.schedule });
  await waitFor(() => alice.status(lying.addr).state === 'up' && alice.status(dead.addr).state === 'waiting', 'both connections');
  const link = lying.linkOf(alice.fp);
  const stopping = alice.close();
  const again = net.createServer();
  await new Promise((resolve, reject) => { again.once('error', reject); again.listen(port, '127.0.0.1', resolve); });
  await new Promise((r) => again.close(r));
  await stopping;
  const attempts = dead.count;
  clock.advance(60 * 60_000);
  await sleep(30);
  assert.equal(dead.count, attempts);
  await waitFor(() => link.closed, 'the hub link to close');
  assert.equal(link.bye, 'STOP');
});

// Invariant: api/state shows each configured connection (its detected kind, state, the identities it reached, its
// error) and, per directory identity, whether it is a contact and where it is present.
test('api/state shows each connection\'s kind, state, peers and error, and where each identity is', async (t) => {
  const hub = await startHub(t);
  const bob = await netNode('bob');
  const carol = await netNode('carol', { listen: null, connections: [hub.addr] });
  const dead = await countingListener();
  t.after(() => dead.close());
  const alice = await netNode('alice', { listen: null, connections: [bob.addr(), hub.addr, dead.addr] });
  closeAll(t, alice, bob, carol);
  await waitFor(() => {
    const rows = alice.engine.state().transport.connections;
    return rows[0].state === 'up' && rows[0].peers[0]?.name === 'bob' && rows[1].state === 'up' && rows[2].error;
  }, 'the rows');
  const [toBob, toHub, toDead] = alice.engine.state().transport.connections;
  assert.deepEqual(toBob, { address: bob.addr(), kind: 'peer', state: 'up', peers: [{ fp: bob.fp, name: 'bob' }], error: null });
  assert.deepEqual(toHub, { address: hub.addr, kind: 'hub', state: 'up', peers: [], error: null });
  assert.equal(toDead.kind, null);
  assert.equal(toDead.state, 'waiting');
  assert.match(toDead.error.code, /^(CONNECTION_PROTOCOL|ECONNRESET)$/);
  await waitFor(() => alice.engine.state().directory.some((d) => d.fp === carol.fp), 'carol from the roster');
  const dir = Object.fromEntries(alice.engine.state().directory.map((d) => [d.name, d]));
  assert.deepEqual([dir.bob.contact, dir.bob.presence], [false, [{ via: 'direct', address: bob.addr() }]]);
  assert.deepEqual([dir.carol.contact, dir.carol.presence], [false, [{ via: 'hub', address: hub.addr }]]);
  assert.equal(alice.engine.state().transport.listening, null);
});

// Invariant (A1 D6): a stranger seen on a hub is listed with its presence and never dialed; a human's invite makes it
// a counterparty, reaches it through that hub, and it can accept with no card exchanged.
test('a stranger seen on a hub is shown with its presence and never dialed; a personal invite reaches it through that hub and it can accept', async (t) => {
  const hub = await startHub(t);
  const alice = await netNode('alice', { listen: null, connections: [hub.addr] });
  const bob = await netNode('bob', { listen: null, connections: [hub.addr] });
  closeAll(t, alice, bob);
  await waitFor(() => alice.engine.state().directory.some((d) => d.fp === bob.fp) && bob.engine.state().directory.some((d) => d.fp === alice.fp), 'each other on the roster');
  await settle([alice, bob]);
  assert.deepEqual(alice.engine.state().directory.find((d) => d.fp === bob.fp), {
    fp: bob.fp, fingerprint: bob.engine.state().identity.fingerprint, name: 'bob', contact: false, presence: [{ via: 'hub', address: hub.addr }],
  });
  assert.deepEqual([alice.transport.stats().sessions, bob.transport.stats().sessions], [[], []]);
  const { id, inbox } = await alice.engine.invite(bob.fp);
  await waitFor(() => bob.engine.state().invites.incoming.some((i) => i.id === id), 'the invite at bob');
  assert.equal(bob.engine.state().invites.incoming[0].from.name, 'alice');
  await bob.engine.respondInvite(id, true);
  await settle([alice, bob]);
  await alice.engine.sendMessage(inbox, 'hello stranger');
  await settle([alice, bob]);
  assert.deepEqual(bob.engine.messages(inbox).map((m) => m.body), ['hello stranger']);
  assert.equal(alice.engine.state().directory.find((d) => d.fp === bob.fp).contact, true);
});

// Invariant (A1 D6): a stranger met on a direct connection is listed and can be invited over that connection, to a
// personal inbox or a shared one.
test('a stranger met on a direct connection can be invited over that connection, to a personal or a shared inbox', async (t) => {
  const alice = await netNode('alice');
  const bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
  closeAll(t, alice, bob);
  await waitFor(() => alice.engine.state().directory.some((d) => d.fp === bob.fp), 'bob in alice\'s directory');
  const inbox = await personal(alice, bob);
  await bob.engine.sendMessage(inbox, 'personal');
  await settle([alice, bob]);
  assert.deepEqual(alice.engine.messages(inbox).map((m) => m.body), ['personal']);
  const { id: team } = await alice.engine.createSharedInbox('team');
  const inv = await alice.engine.inviteMember(team, bob.fp);
  await settle([alice, bob]);
  await bob.engine.respondInvite(inv.id, true);
  await settle([alice, bob], 3);
  await bob.engine.sendMessage(team, 'shared');
  await settle([alice, bob], 3);
  assert.deepEqual(alice.engine.messages(team).map((m) => m.body), ['shared']);
});
