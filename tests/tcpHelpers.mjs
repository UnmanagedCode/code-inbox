import net from 'node:net';
import { transportFactory } from '../server.js';
import { createEngine } from '../src/engine.js';
import { loadIdentity } from '../src/identity.js';
import { createStore } from '../src/store.js';
import { TCP_FRAME_MAX, createDecoder, encodeFrame } from '../src/transport/frames.js';
import { boundFps, makeProofs, newHandshakeNonce, proofSigner } from '../src/transport/handshake.js';
import { silentLog, tmpDir } from './helpers.mjs';

// Helpers for the TCP transport tests: real loopback sockets on ephemeral ports, everything closed by the test.

// Polls `cond` until it holds (or fails after `ms`): for effects that land on a socket event.
export async function waitFor(cond, what = 'the condition', ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// A listener that counts connections and destroys each at once (a dead peer). `close()` frees the port.
export async function countingListener(port = 0) {
  const sockets = new Set();
  const state = { count: 0 };
  const srv = net.createServer((s) => { state.count += 1; sockets.add(s); s.destroy(); });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  state.port = srv.address().port;
  state.addr = `tcp://127.0.0.1:${state.port}`;
  state.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); });
  return state;
}

// A raw protocol connection over `socket`, collecting every frame it receives (decoded JSON, unvalidated).
// `next()` resolves the next unread frame, or null once the socket closed. `onFrame(f, conn)` sees each frame first.
export function rawConn(socket, { onFrame } = {}) {
  const decoder = createDecoder({ maxFrame: TCP_FRAME_MAX });
  const frames = [];
  let read = 0;
  let wake = null;
  const conn = {
    socket,
    frames,
    closed: false,
    send: (obj) => socket.write(encodeFrame(obj)),
    write: (bytes) => socket.write(bytes),
    async next() {
      while (read >= frames.length && !conn.closed) await new Promise((r) => { wake = r; });
      return read < frames.length ? frames[read++] : null;
    },
    // The next frame of type `t`, skipping pings and the like; null once closed.
    async nextOf(t) {
      for (;;) {
        const f = await conn.next();
        if (!f || f.t === t) return f;
      }
    },
    whenClosed: null,
    destroy: () => socket.destroy(),
  };
  conn.whenClosed = new Promise((r) => socket.once('close', () => { conn.closed = true; wake?.(); r(); }));
  socket.on('data', (chunk) => {
    decoder.push(chunk);
    for (let f; (f = decoder.next()) !== null;) { frames.push(f); onFrame?.(f, conn); }
    wake?.();
  });
  socket.on('error', () => {});
  return conn;
}

export async function rawConnect(port, opts) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return rawConn(socket, opts);
}

// A minimal well-behaved peer's answers: every pull denied, no cards, pongs.
function answer(f, conn) {
  if (f.t === 'pull') conn.send({ t: 'recs', id: f.id, from: f.to, to: f.from, routes: f.routes.map(({ route }) => ({ route, status: 'denied' })) });
  if (f.t === 'whois') conn.send({ t: 'cards', id: f.id, from: f.to, to: f.from, recs: [] });
  if (f.t === 'ping') conn.send({ t: 'pong' });
}

// Dials `port` as `identity` aiming at `target` and completes the handshake; resolves the connection plus the
// frames it sent (`hello`, `prove`). `nonce` fixes the dialer's nonce (to replay a proof exactly). It answers like
// a minimal peer; `onFrame(f, conn)` returning true answers a frame instead.
export async function rawPeer(port, identity, target, { onFrame, nonce = newHandshakeNonce() } = {}) {
  const conn = await rawConnect(port, { onFrame: (f, c) => { if (!onFrame?.(f, c)) answer(f, c); } });
  const theirs = await conn.nextOf('hello');
  const hello = { t: 'hello', v: 1, nonce };
  const prove = { t: 'prove', target, ids: makeProofs([proofSigner(identity)], 'dial', nonce, theirs.nonce, target) };
  conn.send(hello);
  conn.send(prove);
  const accept = await conn.nextOf('prove');
  if (!accept) throw new Error(`the handshake was refused: ${JSON.stringify(conn.frames.at(-1))}`);
  conn.send({ t: 'ok' });
  return Object.assign(conn, { sent: { hello, prove }, theirNonce: theirs.nonce, myNonce: nonce, accept });
}

// The acceptor's proof `signers` would give a dialer: used by a raw acceptor to answer (rightly or not).
export const acceptProofs = (signers, role, myNonce, dialerNonce, dialerFps) => makeProofs(signers.map(proofSigner), role, myNonce, dialerNonce, boundFps(dialerFps));

// A stand-in engine view: `contacts`, `addrs` (fp → [addr]), `announces` (fp → bytes, for any requester), `serve`;
// every route may be pulled from anyone.
export function stubView({ contacts = [], addrs = {}, announces = {}, serve = () => ({ status: 'denied' }) } = {}) {
  return { contacts: () => contacts, addrsOf: (fp) => addrs[fp] ?? [], announceFor: (_requester, fp) => announces[fp] ?? null, mayPull: () => true, serve };
}

export function stubSink() {
  const sink = { records: [], online: [], record: async (i) => { sink.records.push(i); return { retry: false }; }, peerOnline: (fp) => { sink.online.push(fp); } };
  return sink;
}

export const memCursors = () => { let data = {}; return { load: async () => data, save: async (c) => { data = c; }, get: () => data }; };

// A whole engine over TCP with its own data dir. `endpoint` attaches it to a shared endpoint instead of its own;
// `wrapView(view)` lets a test spy on what the transport asks of the engine. Every record the transport offers is
// kept in `node.offered`. With `name`, the name is set and announced. Booting a data dir whose settings already
// configure TCP reuses them.
export async function tcpNode(name, { dataDir = tmpDir('code-inbox-tcp-'), port = 0, endpoint, wrapView = (v) => v, configure = true } = {}) {
  const store = createStore(dataDir, { log: silentLog });
  await store.load();
  const identity = await loadIdentity(dataDir);
  const cursors = { load: store.loadPeerCursors, save: store.savePeerCursors };
  const base = transportFactory({ identity, store, tcpSyncMs: 3_600_000, log: silentLog });
  const node = { name, dataDir, fp: identity.fp, identity, store, transport: null, view: null, offered: [] };
  node.engine = createEngine({
    store, identity, log: silentLog,
    makeTransport: (config, view) => {
      node.view = wrapView(view);
      const t = endpoint ? endpoint.attach({ identity: proofSigner(identity), view: node.view, cursors }) : base(config, node.view);
      const start = t.start;
      t.start = (sink) => start({ record: (i) => { node.offered.push(i); return sink.record(i); }, peerOnline: (fp) => sink.peerOnline(fp) });
      node.transport = t;
      return t;
    },
  });
  await node.engine.boot();
  if (configure && !node.engine.state().transport.configured) await node.engine.setTcp({ port });
  if (name && !node.engine.settings().name) {
    await node.engine.setName(name);
    await node.engine.announce();
  }
  node.card = () => node.engine.state().transport.card;
  node.close = () => node.engine.stop();
  return node;
}

// Every node syncs, `rounds` times round.
export async function settle(nodes, rounds = 2) {
  for (let i = 0; i < rounds; i += 1) for (const n of nodes) await n.engine.sync();
}

// `a` invites `b` to a personal inbox and `b` accepts; resolves the inbox id.
export async function personal(a, b, all = [a, b]) {
  const { id, inbox } = await a.engine.invite(b.fp);
  await settle(all);
  await b.engine.respondInvite(id, true);
  await settle(all);
  return inbox;
}
