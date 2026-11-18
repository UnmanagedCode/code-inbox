import { EventEmitter } from 'node:events';
import { decodeRecord } from '../records.js';
import { FrameError, HUB_CHUNK_BYTES } from './frames.js';
import { TCP_WRITE_BUFFER_MAX } from './tcpSession.js';

// The hub mode of a connection (docs/hub.md → The hub mode of a connection): over one registered link to a hub,
// every session is a stream; each stream runs the unchanged endpoint handshake (tcpSession.js), so the writer is the
// `from` the remote endpoint proved, never the hub's word. Hub presence is a dial hint only: `peerOnline` fires when
// an end-to-end session becomes ready. Connecting, registering and reconnecting are the connection's
// (connection.js); this module is what happens on one registered link.

export const HUB_STREAM_BUFFER_MAX = TCP_WRITE_BUFFER_MAX; // inbound bytes a paused stream holds before it is closed

// ---- streams ----

// The socket-like byte pipe one tunneled session runs on: the subset of net.Socket that tcpSession.js uses. `pipe`
// = {data(b64, onFlushed) → bool, close(reason)} on the stream's own link connection. `writableLength` counts only
// this stream's bytes not yet flushed to the link socket, so a session's back-pressure limit sees its own writes, not
// those of the other sessions sharing the link. A paused stream holds inbound chunks and never pauses the link; over
// HUB_STREAM_BUFFER_MAX held bytes it is closed LIMIT (pulls recover).
export class HubStream extends EventEmitter {
  constructor(pipe) {
    super();
    this.pipe = pipe;
    this.destroyed = false;
    this.closedBy = null; // the hub's close reason, when the hub ended it
    this.paused = false;
    this.held = [];
    this.heldBytes = 0;
    this.writableLength = 0;
  }

  write(buf) {
    if (this.destroyed) return false;
    for (let i = 0; i < buf.length; i += HUB_CHUNK_BYTES) {
      const part = buf.subarray(i, i + HUB_CHUNK_BYTES);
      this.writableLength += part.length;
      let flushed = false;
      const release = () => { if (!flushed) { flushed = true; this.writableLength -= part.length; } };
      if (!this.pipe.data(part.toString('base64url'), release)) release();
    }
    return true;
  }

  destroy() { this.end('CLOSED'); }

  destroySoon() { this.end('CLOSED'); }

  setNoDelay() {}

  pause() { this.paused = true; }

  resume() {
    this.paused = false;
    while (this.held.length && !this.paused && !this.destroyed) {
      const b = this.held.shift();
      this.heldBytes -= b.length;
      this.emit('data', b);
    }
  }

  // Inbound bytes from the link.
  receive(buf) {
    if (this.destroyed) return;
    if (!this.paused) { this.emit('data', buf); return; }
    this.held.push(buf);
    this.heldBytes += buf.length;
    if (this.heldBytes > HUB_STREAM_BUFFER_MAX) this.end('LIMIT');
  }

  // Ended by the hub (`close`) or by the link going down: nothing is sent.
  ended(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closedBy = reason;
    this.held = [];
    process.nextTick(() => this.emit('close'));
  }

  end(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.held = [];
    this.pipe.close(reason);
    process.nextTick(() => this.emit('close'));
  }
}

// ---- one registered link ----

/**
 * The hub side of one link connection `conn` (hubConn.js, role client) of connection `link`. → {onFrame(f), ready(),
 * closed(), sendAnnounces(), present(), dial(fp)}; the connection calls onFrame only while `conn` is its current one.
 * The roster (`peer`, `gone`) is a dial hint only: `peerOnline` fires when an end-to-end session becomes ready.
 */
export function createHubSide(core, conn, link) {
  const { lim, now } = core;
  const streams = new Map(); // s → HubStream
  let nextS = 1;
  let present = new Set(); // fps the hub reports registered on another link
  const fpBackoff = new Map(); // fp → {failures, nextAt}
  const dialing = new Map(); // fp → promise

  const up = () => conn.ready && !conn.closed;

  function newStream(s) {
    const st = new HubStream({
      data: (b, onFlushed) => conn.send({ t: 'data', s, b }, onFlushed),
      close: (reason) => {
        if (streams.get(s) === st) streams.delete(s);
        if (up()) conn.send({ t: 'close', s, reason });
      },
    });
    streams.set(s, st);
    return st;
  }

  // A roster entry: `fp` is on the hub. Its announce (when given) goes to the engines once it verifies as `fp`'s;
  // `fp` is dialed through the hubs at once only if it is a contact without a session.
  function peer(fp, rec) {
    if (core.isLocal(fp)) return;
    present.add(fp);
    fpBackoff.delete(fp);
    if (rec) {
      const d = decodeRecord(rec);
      if (d.ok && d.payload.type === 'announce' && d.payload.signer === fp) core.offerAnnounce(rec); else core.countDropped();
    }
    if (core.contacts().includes(fp) && !core.hasSession(fp)) void core.dialHubs(fp);
  }

  function onFrame(f) {
    if (f.t === 'incoming') {
      if (streams.has(f.s)) throw new FrameError('PROTOCOL', `stream ${f.s} is already open`);
      core.accept(newStream(f.s), { via: 'hub', link });
    } else if (f.t === 'data') {
      streams.get(f.s)?.receive(Buffer.from(f.b, 'base64url'));
    } else if (f.t === 'close') {
      const st = streams.get(f.s);
      if (!st) return;
      streams.delete(f.s);
      st.ended(f.reason);
    } else if (f.t === 'peer') {
      peer(f.fp, f.rec);
    } else if (f.t === 'gone') {
      present.delete(f.fp);
    }
  }

  // One stream dial to `fp`: only on an up link, while the roster shows `fp`, and past `fp`'s backoff here.
  // Resolves when the attempt ends.
  function dial(fp) {
    if (core.isLocal(fp) || core.hasSession(fp)) return Promise.resolve();
    const inflight = dialing.get(fp);
    if (inflight) return inflight;
    if (!up() || !present.has(fp) || !core.canDial()) return Promise.resolve();
    const bo = fpBackoff.get(fp);
    if (bo && now() < bo.nextAt) return Promise.resolve();
    const s = nextS;
    nextS += 2;
    const st = newStream(s);
    conn.send({ t: 'open', s, to: fp });
    const session = core.dial(st, fp, { via: 'hub', link });
    const done = session.established.then((ok) => {
      if (ok) { fpBackoff.delete(fp); return; }
      const n = (fpBackoff.get(fp)?.failures ?? 0) + 1;
      fpBackoff.set(fp, { failures: n, nextAt: now() + Math.min(lim.redialMinMs * 2 ** (n - 1), lim.redialMaxMs) });
      if (st.closedBy === 'ABSENT') present.delete(fp);
    }).finally(() => dialing.delete(fp));
    dialing.set(fp, done);
    return done;
  }

  // This endpoint's announces, given to the hub: on registration and whenever one changes.
  function sendAnnounces() {
    if (!up()) return;
    for (const bytes of core.announces()) conn.send({ t: 'announce', rec: Buffer.from(bytes).toString('base64url') });
  }

  return {
    onFrame,
    ready: sendAnnounces,
    sendAnnounces,
    present: () => [...present],
    // The link ended: every stream on it ends (its session closes), and the roster is forgotten.
    closed() {
      for (const st of streams.values()) st.ended('GONE');
      streams.clear();
      present = new Set();
    },
    dial,
  };
}
