import net from 'node:net';
import { createHub } from '../src/hub/hub.js';
import { decodeRecord } from '../src/records.js';
import { TCP_FRAME_MAX, createDecoder, encodeFrame } from '../src/transport/frames.js';
import { dialBound, makeProofs, newHandshakeNonce, proofSigner } from '../src/transport/handshake.js';
import { createHubConn } from '../src/transport/hubConn.js';
import { SESSION_LIMITS } from '../src/transport/tcpSession.js';
import { helloFrame, rawConnect } from './tcpHelpers.mjs';

// Helpers for the hub tests: a real hub on a loopback ephemeral port, raw hub links, raw endpoints tunneled through
// a stream, and a test-only hub that lies. Engines reach a hub through a connection (netHelpers.mjs → netNode).
// Everything is closed by the test.

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

// A real hub on 127.0.0.1:0. `createServer` reaches the accepted sockets (tests that cork them).
export async function startHub(t, { limits, schedule, createServer, port = 0 } = {}) {
  const hub = createHub({ port, limits, ...(schedule ? { schedule } : {}), ...(createServer ? { createServer } : {}) });
  const bound = await hub.listen();
  t?.after(() => hub.close());
  return { hub, port: bound.port, addr: `127.0.0.1:${bound.port}` };
}

// A raw hub link: hello, then (with identities) `register` proofs and `ok`. Collects every frame (decoded JSON,
// unvalidated) like tcpHelpers' rawConn. `register: false` stops after the hello exchange.
export async function rawHubLink(port, identities = [], { register = true } = {}) {
  const conn = await rawConnect(port);
  const theirs = await conn.nextOf('hello');
  const nonce = newHandshakeNonce();
  conn.send(helloFrame(nonce));
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
// endpoint handshake. Answers like a minimal peer (every pull denied, pongs) unless `onFrame(f, tun)` returns true.
// Resolves the tunnel once ready.
export async function tunnelPeer(link, identity, target, { s = 1, onFrame } = {}) {
  link.send({ t: 'open', s, to: target });
  const tun = tunnelOf(link, s);
  const theirs = await tun.nextOf('hello');
  if (!theirs) throw new Error(`the stream closed: ${tun.closed}`);
  const nonce = newHandshakeNonce();
  tun.send(helloFrame(nonce));
  tun.send({ t: 'prove', target, ids: makeProofs([proofSigner(identity)], 'dial', nonce, theirs.nonce, dialBound(target)) });
  if (!(await tun.nextOf('prove'))) throw new Error('the handshake was refused');
  tun.send({ t: 'ok' });
  let answered = tun.read;
  const answer = setInterval(() => {
    tun.pump();
    for (; answered < tun.frames.length; answered += 1) {
      const f = tun.frames[answered];
      if (onFrame?.(f, tun)) continue;
      if (f.t === 'pull') tun.send({ t: 'recs', id: f.id, from: f.to, to: f.from, routes: f.routes.map(({ route }) => ({ route, status: 'denied' })) });
      if (f.t === 'ping') tun.send({ t: 'pong' });
    }
    if (tun.closed || link.closed) clearInterval(answer);
  }, 2);
  link.whenClosed.then(() => clearInterval(answer));
  tun.stop = () => clearInterval(answer);
  return tun;
}

// A test-only hub that lies, built on hubConn (role `hub`, so its hello says kind `hub` and a connection detects it
// as a hub). It verifies registrations like the real one, keeps every link told of the others like the real roster
// (`peer` on registration and on `announce`, `gone` on close; no back-pressure), relays streams faithfully by default
// and records what each link sent.
//   refuse: answer every registration `bye PROOF`; `accepted` counts the connections made
//   route(to, from) → the link an `open` goes to (default: the one that registered `to`), or null for ABSENT
//   onOpen(link, f) → true when the test handled the open itself
//   inject(link, s, frame) writes an endpoint frame into stream `s` of `link`; notify(link, frame) a hub frame
//   linkOf(fp), received(link) → the frames that link sent (decoded hub frames; `announce` rec as bytes)
export async function lyingHub(t, { route, onOpen, refuse = false } = {}) {
  const links = new Set();
  const byFp = new Map();
  const limits = { ...SESSION_LIMITS, writeBufferMax: 64 * 1024 * 1024 };
  let accepted = 0;
  const srv = net.createServer((socket) => {
    accepted += 1;
    const link = createHubConn({
      socket, role: 'hub', limits, schedule: (fn, ms) => { const x = setTimeout(fn, ms); x.unref(); return () => clearTimeout(x); },
      onRegistered: (c, fps) => { if (refuse) c.close('PROOF'); else for (const fp of fps) byFp.set(fp, c); },
      onReady: (c) => {
        const peer = (fp) => ({ t: 'peer', fp, rec: byFp.get(fp).anns.get(fp) ?? null });
        for (const other of links) if (other !== c && other.ready) for (const fp of c.fps) other.send(peer(fp));
        for (const fp of byFp.keys()) if (byFp.get(fp) !== c && byFp.get(fp).ready) c.send(peer(fp));
      },
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
        } else if (f.t === 'announce') {
          const signer = decodeRecord(f.rec).payload?.signer;
          c.anns.set(signer, b64(f.rec));
          for (const other of links) if (other !== c && other.ready) other.send({ t: 'peer', fp: signer, rec: b64(f.rec) });
        }
      },
      onClose: (c) => {
        links.delete(c);
        for (const [fp, x] of byFp) {
          if (x !== c) continue;
          byFp.delete(fp);
          for (const other of links) if (other.ready) other.send({ t: 'gone', fp });
        }
        for (const [peer, s2] of c.pairs.values()) { peer.pairs.delete(s2); peer.send({ t: 'close', s: s2, reason: 'GONE' }); }
      },
    });
    link.got = [];
    link.anns = new Map();
    link.pairs = new Map();
    link.nextS = 2;
    links.add(link);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const lying = {
    port,
    addr: `127.0.0.1:${port}`,
    get accepted() { return accepted; },
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
