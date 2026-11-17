import net from 'node:net';
import { transportFactory } from '../server.js';
import { createEngine } from '../src/engine.js';
import { createHub } from '../src/hub/hub.js';
import { loadIdentity } from '../src/identity.js';
import { createStore } from '../src/store.js';
import { HUB_FRAME_MAX, TCP_FRAME_MAX, createDecoder, encodeFrame } from '../src/transport/frames.js';
import { makeProofs, newHandshakeNonce, proofSigner } from '../src/transport/handshake.js';
import { createHubConn } from '../src/transport/hubConn.js';
import { createHubEndpoint } from '../src/transport/hubClient.js';
import { SESSION_LIMITS } from '../src/transport/tcpSession.js';
import { silentLog, tmpDir } from './helpers.mjs';
import { rawConnect } from './tcpHelpers.mjs';

// Helpers for the hub tests: a real hub on a loopback ephemeral port, engines over the hub client, raw hub links,
// raw endpoints tunneled through a stream, and a test-only hub that lies. Everything is closed by the test.

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

// A real hub on 127.0.0.1:0. `createServer` reaches the accepted sockets (tests that cork them).
export async function startHub(t, { limits, schedule, createServer, port = 0 } = {}) {
  const hub = createHub({ port, limits, ...(schedule ? { schedule } : {}), ...(createServer ? { createServer } : {}) });
  const bound = await hub.listen();
  t?.after(() => hub.close());
  return { hub, port: bound.port, url: `hub://127.0.0.1:${bound.port}` };
}

// A whole engine over the hub client with its own data dir, in the mould of tcpNode. `limits`, `connect` or
// `endpoint` build the client from createHubEndpoint (else server.js's transportFactory, as in production);
// `schedule` and `now` reach the engine's outbox timer and the client. `node.online` keeps every peerOnline the
// transport reports, `node.offered` every record it offers. Booting a data dir whose settings already configure a
// hub reuses them.
export async function hubNode(name, { url, dataDir = tmpDir('code-inbox-hub-'), limits, connect, endpoint, schedule, now, lookup, configure = true } = {}) {
  const store = createStore(dataDir, { log: silentLog });
  await store.load();
  const identity = await loadIdentity(dataDir);
  const cursors = { load: store.loadPeerCursors, save: store.savePeerCursors };
  const base = transportFactory({ identity, store, tcpSyncMs: 3_600_000, now, schedule, log: silentLog });
  const node = { name, dataDir, fp: identity.fp, identity, store, transport: null, view: null, offered: [], online: [] };
  const own = (config) => (endpoint ?? createHubEndpoint({
    url: config.url, limits, syncMs: 3_600_000, log: silentLog, ...(connect ? { connect } : {}), ...(now ? { now } : {}), ...(schedule ? { schedule } : {}),
  }));
  node.engine = createEngine({
    store, identity, log: silentLog, ...(schedule ? { schedule } : {}), ...(lookup ? { lookup } : {}),
    makeTransport: (config, view) => {
      node.view = view;
      const custom = endpoint || limits || connect;
      const t = config.kind === 'hub' && custom ? own(config).attach({ identity: proofSigner(identity), view, cursors }) : base(config, view);
      const start = t.start;
      t.start = (sink) => start({
        record: (i) => { node.offered.push(i); return sink.record(i); },
        peerOnline: (fp) => { node.online.push(fp); sink.peerOnline(fp); },
      });
      node.transport = t;
      return t;
    },
  });
  await node.engine.boot();
  if (configure && url && !node.engine.state().transport.configured) await node.engine.setHub({ url });
  if (name && !node.engine.settings().name) {
    await node.engine.setName(name);
    if (node.engine.state().transport.configured) await node.engine.announce();
  }
  node.card = () => node.engine.state().transport.card;
  node.connected = () => !!node.transport?.stats().hub.connected;
  node.close = () => node.engine.stop();
  return node;
}

// A raw hub link: hello, then (with identities) `register` proofs and `ok`. Collects every frame (decoded JSON,
// unvalidated) like tcpHelpers' rawConn. `register: false` stops after the hello exchange.
export async function rawHubLink(port, identities = [], { register = true } = {}) {
  const conn = await rawConnect(port);
  const theirs = await conn.nextOf('hello');
  const nonce = newHandshakeNonce();
  conn.send({ t: 'hello', v: 1, nonce });
  conn.hubNonce = theirs.nonce;
  conn.myNonce = nonce;
  if (register && identities.length) {
    conn.send({ t: 'register', ids: makeProofs(identities.map(proofSigner), 'hub', nonce, theirs.nonce, '') });
    const ok = await conn.nextOf('ok');
    if (!ok) throw new Error(`the registration was refused: ${JSON.stringify(conn.frames.at(-1))}`);
  }
  // The frames received for stream `s`, reassembled from `data` chunks (decoded JSON).
  conn.tunnel = (s) => tunnelOf(conn, s);
  return conn;
}

// A raw endpoint on stream `s` of a raw hub link: `send(obj)` writes an endpoint frame into the stream; `frames`
// collects what arrives on it; `next()` / `nextOf(t)` read them; `closed` once the hub closes the stream.
function tunnelOf(link, s) {
  const decoder = createDecoder({ maxFrame: TCP_FRAME_MAX });
  const tun = { s, frames: [], closed: null, read: 0 };
  let seen = 0;
  const pump = tun.pump = () => {
    for (; seen < link.frames.length; seen += 1) {
      const f = link.frames[seen];
      if (f.s !== s) continue;
      if (f.t === 'data') { decoder.push(Buffer.from(f.b, 'base64url')); for (let x; (x = decoder.next()) !== null;) tun.frames.push(x); }
      if (f.t === 'close') tun.closed = f.reason;
    }
  };
  tun.send = (obj) => link.send({ t: 'data', s, b: b64(encodeFrame(obj)) });
  tun.next = async () => {
    for (;;) {
      pump();
      if (tun.read < tun.frames.length) return tun.frames[tun.read++];
      if (tun.closed || link.closed) return null;
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  tun.nextOf = async (t) => { for (;;) { const f = await tun.next(); if (!f || f.t === t) return f; } };
  return tun;
}

// Through a raw hub link registered as `identity`: opens stream `s` to `target` and runs the dialer's side of the
// endpoint handshake. Answers like a minimal peer (every pull denied, no cards, pongs) unless `onFrame(f, tun)`
// returns true. Resolves the tunnel once ready.
export async function tunnelPeer(link, identity, target, { s = 1, onFrame } = {}) {
  link.send({ t: 'open', s, to: target });
  const tun = tunnelOf(link, s);
  const theirs = await tun.nextOf('hello');
  if (!theirs) throw new Error(`the stream closed: ${tun.closed}`);
  const nonce = newHandshakeNonce();
  tun.send({ t: 'hello', v: 1, nonce });
  tun.send({ t: 'prove', target, ids: makeProofs([proofSigner(identity)], 'dial', nonce, theirs.nonce, target) });
  if (!(await tun.nextOf('prove'))) throw new Error('the handshake was refused');
  tun.send({ t: 'ok' });
  let answered = tun.read;
  const answer = setInterval(() => {
    tun.pump();
    for (; answered < tun.frames.length; answered += 1) {
      const f = tun.frames[answered];
      if (onFrame?.(f, tun)) continue;
      if (f.t === 'pull') tun.send({ t: 'recs', id: f.id, from: f.to, to: f.from, routes: f.routes.map(({ route }) => ({ route, status: 'denied' })) });
      if (f.t === 'whois') tun.send({ t: 'cards', id: f.id, from: f.to, to: f.from, recs: [] });
      if (f.t === 'ping') tun.send({ t: 'pong' });
    }
    if (tun.closed || link.closed) clearInterval(answer);
  }, 2);
  link.whenClosed.then(() => clearInterval(answer));
  tun.stop = () => clearInterval(answer);
  return tun;
}

// A test-only hub that lies, built on hubConn (role `hub`). It verifies registrations like the real one, answers a
// watch with every registered fp in it, relays streams faithfully by default and records what each link sent.
//   route(to, from) → the link an `open` goes to (default: the one that registered `to`), or null for ABSENT
//   onOpen(link, f) → true when the test handled the open itself
//   inject(link, s, frame) writes an endpoint frame into stream `s` of `link`; notify(link, frame) a hub frame
//   linkOf(fp), received(link) → the frames that link sent
export async function lyingHub(t, { route, onOpen } = {}) {
  const links = new Set();
  const byFp = new Map();
  const limits = { ...SESSION_LIMITS, writeBufferMax: 64 * 1024 * 1024 };
  const srv = net.createServer((socket) => {
    const link = createHubConn({
      socket, role: 'hub', limits, schedule: (fn, ms) => { const x = setTimeout(fn, ms); x.unref(); return () => clearTimeout(x); },
      onRegistered: (c, fps) => { for (const fp of fps) byFp.set(fp, c); },
      onReady: () => {},
      onFrame: (c, f) => {
        c.got.push(f);
        if (f.t === 'open') {
          if (onOpen?.(c, f)) return;
          const target = route ? route(f.to, c) : byFp.get(f.to);
          if (!target) { c.send({ t: 'close', s: f.s, reason: 'ABSENT' }); return; }
          const s2 = target.nextS;
          target.nextS += 2;
          c.pairs.set(f.s, [target, s2]);
          target.pairs.set(s2, [c, f.s]);
          target.send({ t: 'incoming', s: s2 });
        } else if (f.t === 'data') {
          const p = c.pairs.get(f.s);
          if (p) p[0].send({ t: 'data', s: p[1], b: f.b });
        } else if (f.t === 'close') {
          const p = c.pairs.get(f.s);
          if (p) { c.pairs.delete(f.s); p[0].pairs.delete(p[1]); p[0].send({ t: 'close', s: p[1], reason: 'CLOSED' }); }
        } else if (f.t === 'watch') {
          c.send({ t: 'present', id: f.id, fps: f.fps.filter((fp) => byFp.has(fp)) });
        }
      },
      onClose: (c) => {
        links.delete(c);
        for (const [fp, x] of byFp) if (x === c) byFp.delete(fp);
        for (const [peer, s2] of c.pairs.values()) { peer.pairs.delete(s2); peer.send({ t: 'close', s: s2, reason: 'GONE' }); }
      },
    });
    link.got = [];
    link.pairs = new Map();
    link.nextS = 2;
    links.add(link);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const lying = {
    port,
    url: `hub://127.0.0.1:${port}`,
    linkOf: (fp) => byFp.get(fp) ?? null,
    received: (link) => link.got,
    // The stream id `link` uses for the stream it shares with `other` (a relayed pair), or null.
    streamTo(link, other) {
      for (const [s, [peer]] of link.pairs) if (peer === other) return s;
      return null;
    },
    inject: (link, s, frame) => link.send({ t: 'data', s, b: b64(encodeFrame(frame)) }),
    notify: (link, frame) => link.send(frame),
    close() {
      srv.close();
      for (const c of [...links]) c.destroy();
    },
  };
  t.after(() => lying.close());
  return lying;
}
