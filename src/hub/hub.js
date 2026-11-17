import net from 'node:net';
import { CodedError } from '../errors.js';
import { isHost } from '../transport/addr.js';
import { FrameError, HUB_WATCH_MAX, encodeFrame } from '../transport/frames.js';
import { createHubConn } from '../transport/hubConn.js';
import { SESSION_LIMITS } from '../transport/tcpSession.js';

// The hub (docs/transport.md → Hub): a standalone router every install can dial out to. Clients prove their
// fingerprints on their link (`register`); a stream opened to a fingerprint reaches only the link that proved it,
// and its bytes pass through as opaque chunks the hub never parses. It stores nothing, holds no key and is never
// trusted for authenticity: endpoints run their own handshake inside each stream.

export const HUB_DEFAULT_PORT = 47822;
export const HUB_MAX_LINKS = 1024;
export const HUB_MAX_HANDSHAKING = 64;
export const HUB_MAX_STREAMS = 64; // per link, opened or received
export const HUB_WRITE_BUFFER_MAX = 4 * 1024 * 1024; // per stream end: unflushed bytes the hub holds toward it
export const HUB_CONTROL_BUFFER_MAX = 64 * 1024; // per link, on top of its stream data: room for control frames

export const HUB_LIMITS = {
  handshakeMs: SESSION_LIMITS.handshakeMs,
  frameMs: SESSION_LIMITS.frameMs,
  idleMs: SESSION_LIMITS.idleMs,
  pingMs: SESSION_LIMITS.pingMs,
  maxLinks: HUB_MAX_LINKS,
  maxHandshaking: HUB_MAX_HANDSHAKING,
  maxStreams: HUB_MAX_STREAMS,
  writeBufferMax: HUB_WRITE_BUFFER_MAX,
  controlBufferMax: HUB_CONTROL_BUFFER_MAX,
};

const defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

// The host and port the hub listens on, or a CodedError HUB_INVALID. A wildcard host is allowed: that is how the
// hub is exposed.
export function validateHubListen({ host, port }) {
  if (!isHost(host)) throw new CodedError('HUB_INVALID', 'host must be an IP address or a hostname');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new CodedError('HUB_INVALID', 'port must be an integer 0–65535');
  return { host, port };
}

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');
// Reachable from this machine only: `localhost`, 127.0.0.0/8 or ::1.
export function isLoopbackHost(host) {
  const family = net.isIP(host);
  return host === 'localhost' || (family !== 0 && LOOPBACK.check(host, family === 6 ? 'ipv6' : 'ipv4'));
}

/**
 * `createServer` builds the listener (net.createServer); tests inject one to reach the accepted sockets.
 * → {listen(): Promise<{host, port}>, close(), stats()}
 */
export function createHub({ host = '127.0.0.1', port = HUB_DEFAULT_PORT, limits = {}, schedule = defaultSchedule, createServer = net.createServer } = {}) {
  const lim = { ...HUB_LIMITS, ...limits };
  // What the hub holds toward one link, at most: stream data up to `dataMax` (every stream end at its cap; counted
  // across the link, so ends of closed streams still unflushed count too) plus `controlBufferMax` for control frames.
  // A frame the link cannot take is dropped, never the link: a peer that stops reading misses `close`, `incoming` or
  // `presence` notices (its sessions time out, pulls recover) and keeps its link and identities.
  const dataMax = lim.maxStreams * lim.writeBufferMax;
  const linkLimits = { ...lim, writeBufferMax: dataMax + lim.controlBufferMax };
  const links = new Set();
  const byFp = new Map(); // fp → the ready link that proved it
  const watchers = new Map(); // fp → Set<link> watching it
  const counters = { handshakeFailures: 0, dropped: 0 };
  let server = null;
  let bound = null;

  const handshaking = () => [...links].filter((c) => !c.ready).length;
  const streamCount = () => [...links].reduce((n, c) => n + (c.streams?.size ?? 0), 0) / 2;

  // A control frame for `c`: dropped (and counted) when the link cannot take it.
  function control(c, frame) {
    if (!c.send(frame) && !c.closed) counters.dropped += 1;
  }

  function notify(fp, online, except) {
    for (const w of watchers.get(fp) ?? []) if (w !== except) control(w, { t: 'presence', fp, online });
  }

  // Forgets a stream pair; the end that did not ask hears `close {reason}`.
  function dropPair(end, reason, tellBoth = false) {
    const { peer } = end;
    end.conn.streams.delete(end.s);
    peer.conn.streams.delete(peer.s);
    control(peer.conn, { t: 'close', s: peer.s, reason });
    if (tellBoth) control(end.conn, { t: 'close', s: end.s, reason });
  }

  function setWatch(c, fps) {
    for (const fp of c.watch) {
      const set = watchers.get(fp);
      set.delete(c);
      if (!set.size) watchers.delete(fp);
    }
    c.watch = new Set(fps.slice(0, HUB_WATCH_MAX));
    for (const fp of c.watch) {
      if (!watchers.has(fp)) watchers.set(fp, new Set());
      watchers.get(fp).add(c);
    }
  }

  // Newest registration wins: every other link holding one of these fps is told DUPLICATE and torn down.
  function onRegistered(c, fps) {
    for (const fp of fps) {
      const other = byFp.get(fp);
      if (other && other !== c) other.close('DUPLICATE');
    }
    for (const fp of fps) byFp.set(fp, c);
  }

  function onReady(c) {
    for (const fp of c.fps) notify(fp, true, c);
  }

  function onFrame(c, f) {
    if (f.t === 'open') {
      if (c.streams.has(f.s)) throw new FrameError('PROTOCOL', `stream ${f.s} is already open`);
      const target = byFp.get(f.to);
      if (c.streams.size >= lim.maxStreams) { control(c, { t: 'close', s: f.s, reason: 'LIMIT' }); return; }
      if (!target || target === c) { control(c, { t: 'close', s: f.s, reason: 'ABSENT' }); return; }
      if (target.streams.size >= lim.maxStreams) { control(c, { t: 'close', s: f.s, reason: 'LIMIT' }); return; }
      const s2 = target.nextS;
      target.nextS += 2;
      const mine = { conn: c, s: f.s, bytes: 0, peer: null };
      const theirs = { conn: target, s: s2, bytes: 0, peer: mine };
      mine.peer = theirs;
      c.streams.set(f.s, mine);
      target.streams.set(s2, theirs);
      control(target, { t: 'incoming', s: s2 });
    } else if (f.t === 'data') {
      const end = c.streams.get(f.s);
      if (!end) { counters.dropped += 1; return; } // it raced a close
      const { peer } = end;
      const buf = encodeFrame({ t: 'data', s: peer.s, b: f.b });
      // A receiver that does not keep up loses this stream, never its link, nor its other streams before the link's
      // whole data budget is held.
      const to = peer.conn;
      if (peer.bytes + buf.length > lim.writeBufferMax || to.dataBytes + buf.length > dataMax) { dropPair(end, 'LIMIT', true); return; }
      peer.bytes += buf.length;
      to.dataBytes += buf.length;
      let flushed = false;
      const release = () => { if (!flushed) { flushed = true; peer.bytes -= buf.length; to.dataBytes -= buf.length; } };
      if (!to.send(buf, release)) { release(); if (!to.closed) dropPair(end, 'LIMIT', true); }
    } else if (f.t === 'close') {
      const end = c.streams.get(f.s);
      if (end) dropPair(end, 'CLOSED');
    } else if (f.t === 'watch') {
      setWatch(c, f.fps);
      control(c, { t: 'present', id: f.id, fps: [...c.watch].filter((fp) => byFp.has(fp) && byFp.get(fp) !== c) });
    }
  }

  function onClose(c) {
    links.delete(c);
    if (!c.ready) { counters.handshakeFailures += 1; return; }
    for (const fp of c.fps) {
      if (byFp.get(fp) !== c) continue;
      byFp.delete(fp);
      notify(fp, false, c);
    }
    for (const end of [...c.streams.values()]) dropPair(end, 'GONE');
    setWatch(c, []);
  }

  function accept(socket) {
    if (links.size >= lim.maxLinks || handshaking() >= lim.maxHandshaking) { socket.destroy(); return; }
    const c = createHubConn({ socket, role: 'hub', limits: linkLimits, dropOverflow: true, schedule, onRegistered, onReady, onFrame, onClose });
    c.streams = new Map(); // s → {conn, s, bytes, peer}
    c.dataBytes = 0; // unflushed stream data toward this link, every end counted
    c.nextS = 2;
    c.watch = new Set();
    links.add(c);
  }

  return {
    listen() {
      const srv = createServer(accept);
      server = srv;
      return new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, host, () => {
          srv.off('error', reject);
          bound = { host, port: srv.address().port };
          resolve(bound);
        });
      });
    },
    // Closes the listener synchronously, then tells every link STOP.
    close() {
      if (server) server.close();
      server = null;
      bound = null;
      for (const c of [...links]) c.close('STOP');
    },
    stats: () => ({
      listening: bound,
      links: links.size,
      handshaking: handshaking(),
      fps: byFp.size,
      streams: streamCount(),
      handshakeFailures: counters.handshakeFailures,
      dropped: counters.dropped,
    }),
  };
}
