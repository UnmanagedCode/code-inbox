import net from 'node:net';
import { CodedError } from '../errors.js';
import { decodeRecord } from '../records.js';
import { isHost } from '../transport/addr.js';
import { FrameError, encodeFrame } from '../transport/frames.js';
import { createHubConn } from '../transport/hubConn.js';
import { SESSION_LIMITS } from '../transport/tcpSession.js';

// The hub (docs/hub.md): a standalone router every install can connect out to. Clients prove their fingerprints on
// their link (`register`); a stream opened to a fingerprint reaches only the link that proved it, and its bytes pass
// through as opaque chunks the hub never parses. Each client gives the hub its own signed announce, and the hub keeps
// every link told who else is registered (the roster: `peer` and `gone`). It stores nothing on disk, holds no key and
// is never trusted for authenticity: endpoints run their own handshake inside each stream.

export const HUB_DEFAULT_PORT = 47822;
export const HUB_MAX_LINKS = 1024;
export const HUB_MAX_HANDSHAKING = 64;
export const HUB_MAX_STREAMS = 64; // per link, opened or received
export const HUB_WRITE_BUFFER_MAX = 4 * 1024 * 1024; // per stream end: unflushed bytes the hub holds toward it
export const HUB_CONTROL_BUFFER_MAX = 64 * 1024; // per link: what its total may hold beyond the stream-data cap

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
  // What the hub holds toward one link, at most: `dataMax` + `controlBufferMax`. Stream data is admitted up to
  // `dataMax` (every stream end at its cap; counted across the link, so ends of closed streams still unflushed count
  // too) and only while the whole total has room; a control frame is admitted while the whole total has room (it is
  // no reserve: control frames may fill data room data does not use). A frame that does not fit is dropped, never
  // the link: a peer that stops reading misses `close`, `incoming` or `presence` notices (its sessions time out,
  // pulls recover) and keeps its link and identities.
  const dataMax = lim.maxStreams * lim.writeBufferMax;
  const linkLimits = { ...lim, writeBufferMax: dataMax + lim.controlBufferMax };
  const links = new Set();
  const byFp = new Map(); // fp → the link that proved it (newest registration)
  const counters = { handshakeFailures: 0, dropped: 0 };
  let server = null;
  let bound = null;

  const handshaking = () => [...links].filter((c) => !c.ready).length;
  const streamCount = () => [...links].reduce((n, c) => n + (c.streams?.size ?? 0), 0) / 2;

  // ---- the roster ----
  // Each link owes the roster entries in its `dirty` set: one frame per fp, built from the current state when it is
  // written (`peer` while the fp is registered on another ready link, else `gone`). An entry that does not fit the
  // link's whole total waits there, never dropped; a flush toward the link pumps it again. So a slow reader gets
  // every fp's latest state late, never a stale or lost one, and the queue is bounded by the fps registered.
  const readyLinks = () => [...links].filter((l) => l.ready && !l.closed);

  function rosterFrame(L, fp) {
    const holder = byFp.get(fp);
    if (holder && holder !== L && holder.ready && !holder.closed) {
      const rec = holder.anns.get(fp);
      return { t: 'peer', fp, rec: rec ? Buffer.from(rec).toString('base64url') : null };
    }
    return { t: 'gone', fp };
  }

  function pump(L) {
    L.pumpArmed = false;
    if (L.closed || !L.ready) return;
    for (const fp of [...L.dirty]) {
      const buf = encodeFrame(rosterFrame(L, fp));
      if (!L.fits(buf.length)) return;
      L.dirty.delete(fp);
      L.send(buf);
    }
  }

  // Pumps once, after the current event: a burst of changes (a registration replacing another) settles first.
  function kick(L) {
    if (L.pumpArmed || !L.dirty.size) return;
    L.pumpArmed = true;
    setImmediate(() => pump(L));
  }

  function markDirty(fps, except) {
    for (const L of readyLinks()) {
      if (L === except) continue;
      for (const fp of fps) L.dirty.add(fp);
      kick(L);
    }
  }

  // Forgets a stream pair; the end that did not ask hears `close {reason}`.
  function dropPair(end, reason, tellBoth = false) {
    const { peer } = end;
    end.conn.streams.delete(end.s);
    peer.conn.streams.delete(peer.s);
    peer.conn.send({ t: 'close', s: peer.s, reason });
    if (tellBoth) end.conn.send({ t: 'close', s: end.s, reason });
  }

  // Newest registration wins: every other link holding one of these fps is told DUPLICATE and torn down.
  function onRegistered(c, fps) {
    for (const fp of fps) {
      const other = byFp.get(fp);
      if (other && other !== c) other.close('DUPLICATE');
    }
    for (const fp of fps) byFp.set(fp, c);
  }

  // A newcomer: every other link hears of its fps, and it hears of every fp registered on another link.
  function onReady(c) {
    markDirty(c.fps, c);
    for (const [fp, holder] of byFp) if (holder !== c) c.dirty.add(fp);
    kick(c);
  }

  function onFrame(c, f) {
    if (f.t === 'open') {
      if (c.streams.has(f.s)) throw new FrameError('PROTOCOL', `stream ${f.s} is already open`);
      const target = byFp.get(f.to);
      if (c.streams.size >= lim.maxStreams) { c.send({ t: 'close', s: f.s, reason: 'LIMIT' }); return; }
      if (!target || target === c) { c.send({ t: 'close', s: f.s, reason: 'ABSENT' }); return; }
      if (target.streams.size >= lim.maxStreams) { c.send({ t: 'close', s: f.s, reason: 'LIMIT' }); return; }
      const s2 = target.nextS;
      target.nextS += 2;
      const mine = { conn: c, s: f.s, bytes: 0, peer: null };
      const theirs = { conn: target, s: s2, bytes: 0, peer: mine };
      mine.peer = theirs;
      c.streams.set(f.s, mine);
      target.streams.set(s2, theirs);
      target.send({ t: 'incoming', s: s2 });
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
    } else if (f.t === 'announce') {
      // Bound by its own signature to its signer, which must be an fp this link proved and still holds.
      const d = decodeRecord(f.rec);
      if (!d.ok || d.payload.type !== 'announce' || byFp.get(d.payload.signer) !== c) throw new FrameError('PROTOCOL', 'an announce must be signed by an identity this link registered');
      c.anns.set(d.payload.signer, f.rec);
      markDirty([d.payload.signer], c);
    }
  }

  function onClose(c) {
    links.delete(c);
    c.anns.clear();
    c.dirty.clear();
    if (!c.ready) { counters.handshakeFailures += 1; return; }
    const gone = c.fps.filter((fp) => byFp.get(fp) === c);
    for (const fp of gone) byFp.delete(fp);
    markDirty(gone, c);
    for (const end of [...c.streams.values()]) dropPair(end, 'GONE');
  }

  function accept(socket) {
    if (links.size >= lim.maxLinks || handshaking() >= lim.maxHandshaking) { socket.destroy(); return; }
    const c = createHubConn({ socket, role: 'hub', limits: linkLimits, dropOverflow: true, onDrop: () => { counters.dropped += 1; }, schedule, onRegistered, onReady, onFrame, onClose });
    c.streams = new Map(); // s → {conn, s, bytes, peer}
    c.dataBytes = 0; // unflushed stream data toward this link, every end counted
    c.nextS = 2;
    c.anns = new Map(); // fp → this link's announce bytes for it
    c.dirty = new Set(); // roster entries owed to this link
    c.pumpArmed = false;
    // Room left under the link's whole total, and a pump after every flush while roster entries wait.
    c.fits = (n) => socket.writableLength + n <= linkLimits.writeBufferMax;
    const send = c.send;
    c.send = (frame, onFlushed) => send(frame, (...a) => { onFlushed?.(...a); kick(c); });
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
      announces: [...links].reduce((n, c) => n + c.anns.size, 0),
      rosterPending: [...links].reduce((n, c) => n + c.dirty.size, 0),
      handshakeFailures: counters.handshakeFailures,
      dropped: counters.dropped,
    }),
  };
}
