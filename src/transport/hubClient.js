import { EventEmitter } from 'node:events';
import net from 'node:net';
import { CodedError } from '../errors.js';
import { ADDR_MAX_CHARS } from '../records.js';
import { TCP_LOOKUP_MS, formatAddr, isWildcardHost, lookupAll, parseAddr } from './addr.js';
import { createEndpoint } from './endpoint.js';
import { FrameError, HUB_CHUNK_BYTES, HUB_WATCH_MAX } from './frames.js';
import { createHubConn } from './hubConn.js';
import { TCP_WRITE_BUFFER_MAX } from './tcpSession.js';

// The hub client (docs/transport.md → Hub): the endpoint core (endpoint.js) with a hub link. One outgoing
// connection to a hub carries every session as a stream; each stream runs the unchanged endpoint handshake
// (tcpSession.js), so the writer is the `from` the remote endpoint proved, never the hub's word. Hub presence is a
// dial hint only: `peerOnline` fires when an end-to-end session becomes ready.

export const HUB_STREAM_BUFFER_MAX = TCP_WRITE_BUFFER_MAX; // inbound bytes a paused stream holds before it is closed

// ---- addresses and config ----

export const formatHubAddr = (host, port) => formatAddr('hub', host, port);
export const parseHubAddr = (s) => parseAddr('hub', s);

// Normalizes the hub settings a human saves, or refuses HUB_INVALID: url = `hub://<host>:<port>`, host a hostname,
// an IPv4 address or `[IPv6]` but not a wildcard, port 1–65535, at most ADDR_MAX_CHARS (it goes into announce.addr).
export function validateHubConfig(input) {
  const refuse = (why) => { throw new CodedError('HUB_INVALID', why); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('the hub settings must be an object');
  const { url } = input;
  if (typeof url !== 'string' || url.length > ADDR_MAX_CHARS) refuse(`the hub address must be a string of at most ${ADDR_MAX_CHARS} characters`);
  const a = parseHubAddr(url);
  if (!a) refuse('the hub address must be hub://host:port, with a port 1–65535');
  if (isWildcardHost(a.host)) refuse(`${a.host} is every interface, not a hub to dial: name an address`);
  return { url: formatHubAddr(a.host, a.port) };
}

// validateHubConfig, then a non-literal host is looked up: any wildcard answer is refused HUB_INVALID. No answer, or
// none within `lookupMs`, is refused only with `mustResolve` (a save); at boot the hub may be unreachable for now.
export async function resolveHubConfig(input, { lookup, lookupMs = TCP_LOOKUP_MS, mustResolve = true } = {}) {
  const cfg = validateHubConfig(input);
  const { host } = parseHubAddr(cfg.url);
  if (net.isIP(host) !== 0) return cfg;
  let addrs;
  try {
    addrs = await lookupAll(host, { lookup, lookupMs });
  } catch (err) {
    if (mustResolve) throw new CodedError('HUB_INVALID', err.timedOut ? `the hub host ${host}: the lookup timed out (${err.message})` : `the hub host ${host} does not resolve (${err.code ?? err.message})`);
    return cfg;
  }
  const wild = addrs.find((x) => isWildcardHost(x.address));
  if (wild) throw new CodedError('HUB_INVALID', `the hub host ${host} resolves to ${wild.address}, every interface: name an address`);
  return cfg;
}

// ---- streams ----

// The socket-like byte pipe one tunneled session runs on: the subset of net.Socket that tcpSession.js uses. `pipe`
// = {data(b64, onFlushed) → bool, close(reason)} on the stream's own link connection. `writableLength` counts only
// this stream's bytes not yet flushed to the link socket, so a session's back-pressure limit sees its own writes, not
// those of the other sessions sharing the link. A paused stream holds inbound chunks and never pauses the link; over
// HUB_STREAM_BUFFER_MAX held bytes it is closed LIMIT (pulls recover).
class HubStream extends EventEmitter {
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

// ---- the hub link ----

function hubLink({ url, connect }) {
  const { host, port } = parseHubAddr(url);
  return (core) => {
    const { lim, now, schedule, log } = core;
    // Each session caps its own unflushed bytes (HubStream.writableLength); the link holds at most all of them.
    const linkLimits = { handshakeMs: lim.handshakeMs, frameMs: lim.frameMs, idleMs: lim.idleMs, pingMs: lim.pingMs, writeBufferMax: lim.maxConnections * lim.writeBufferMax };
    let conn = null; // the current link connection: connecting or registered
    let error = null;
    let halted = false; // replaced by a duplicate registration: no reconnect until a binding starts or detaches
    let failures = 0;
    let retry = null; // cancel of the scheduled reconnect
    let present = new Set();
    const wanted = new Set(); // pending recipients that are not contacts (e.g. an invitee)
    const fpBackoff = new Map(); // fp → {failures, nextAt}
    const dialing = new Map(); // fp → promise
    let watch = { key: null, id: 0, fps: new Set(), answered: Promise.resolve(), done: () => {} };
    let truncated = false;

    const up = () => !!conn && conn.ready && !conn.closed;
    const cancelRetry = () => { if (retry) { retry(); retry = null; } };

    function newStream(c, s) {
      const st = new HubStream({
        data: (b, onFlushed) => c.send({ t: 'data', s, b }, onFlushed),
        close: (reason) => {
          if (c.streams.get(s) === st) c.streams.delete(s);
          if (c.ready && !c.closed) c.send({ t: 'close', s, reason });
        },
      });
      c.streams.set(s, st);
      return st;
    }

    function connectNow() {
      cancelRetry();
      const fps = core.fps();
      if (!fps.length || halted) return;
      const c = createHubConn({ socket: connect({ host, port }), role: 'client', signers: core.signers(), limits: linkLimits, schedule, onReady, onFrame, onClose });
      c.streams = new Map();
      c.nextS = 1;
      c.regKey = [...fps].sort().join(',');
      conn = c;
    }

    // Leaves the current connection: what it says from now on is ignored.
    function leave() {
      const old = conn;
      conn = null;
      if (old) old.close('STOP');
    }

    function onReady(c) {
      if (c !== conn) return;
      failures = 0;
      error = null;
      void refreshWatch();
      core.syncAll();
    }

    function onClose(c) {
      for (const st of c.streams.values()) st.ended('GONE');
      c.streams.clear();
      if (c !== conn) return;
      conn = null;
      present = new Set();
      watch.done();
      watch = { key: null, id: watch.id, fps: new Set(), answered: Promise.resolve(), done: () => {} };
      if (c.bye === 'DUPLICATE') {
        error = { code: 'HUB_DUPLICATE', message: 'another endpoint registered this identity on the hub; this one stopped reconnecting' };
        halted = true;
        return;
      }
      if (c.bye === 'PROOF') error = { code: 'HUB_REFUSED', message: 'the hub refused the registration proof' };
      else if (c.error) error = { code: c.error.code ?? 'HUB_UNREACHABLE', message: c.error.message };
      if (!core.fps().length) return;
      const delay = Math.min(lim.redialMinMs * 2 ** failures, lim.redialMaxMs);
      failures += 1;
      retry = schedule(() => { retry = null; connectNow(); }, delay);
    }

    function onFrame(c, f) {
      if (c !== conn) return;
      if (f.t === 'incoming') {
        if (c.streams.has(f.s)) throw new FrameError('PROTOCOL', `stream ${f.s} is already open`);
        core.accept(newStream(c, f.s));
      } else if (f.t === 'data') {
        c.streams.get(f.s)?.receive(Buffer.from(f.b, 'base64url'));
      } else if (f.t === 'close') {
        const st = c.streams.get(f.s);
        if (!st) return;
        c.streams.delete(f.s);
        st.ended(f.reason);
      } else if (f.t === 'present') {
        if (f.id !== watch.id) return;
        const before = present;
        present = new Set(f.fps);
        for (const fp of present) if (!before.has(fp)) online(fp);
        watch.done();
      } else if (f.t === 'presence') {
        if (!f.online) { present.delete(f.fp); return; }
        present.add(f.fp);
        online(f.fp);
      }
    }

    // The hub says `fp` registered: a hint to dial it now, if it is in the dial set. The handshake decides.
    function online(fp) {
      fpBackoff.delete(fp);
      if (wanted.has(fp) || core.contacts().includes(fp)) void dialFp(fp);
    }

    // The watch set: every binding's contacts plus `wanted`, minus local fps. An fp leaves `wanted` once a session
    // to it is ready.
    function watchSet() {
      for (const fp of wanted) if (core.hasSession(fp)) wanted.delete(fp);
      const fps = [...new Set([...core.contacts(), ...wanted])].filter((fp) => !core.isLocal(fp)).sort();
      if (fps.length > HUB_WATCH_MAX && !truncated) {
        truncated = true;
        log.warn(`code-inbox: ${fps.length} identities to watch on the hub; only the first ${HUB_WATCH_MAX} are watched`);
      }
      return fps.slice(0, HUB_WATCH_MAX);
    }

    // Sends the watch set if it changed; resolves once the hub answers it (or after `requestMs`).
    function refreshWatch() {
      if (!up()) return Promise.resolve();
      const fps = watchSet();
      const key = fps.join(',');
      if (key === watch.key) return watch.answered;
      watch.done();
      let resolve;
      const answered = new Promise((r) => { resolve = r; });
      const cancel = schedule(() => resolve(), lim.requestMs);
      watch = { key, id: watch.id + 1, fps: new Set(fps), answered, done: () => { cancel(); resolve(); } };
      conn.send({ t: 'watch', id: watch.id, fps });
      return answered;
    }

    function dialFp(fp) {
      if (core.isLocal(fp) || core.hasSession(fp)) return Promise.resolve();
      const inflight = dialing.get(fp);
      if (inflight) return inflight;
      if (!up()) { wanted.add(fp); return Promise.resolve(); }
      const bo = fpBackoff.get(fp);
      if (bo && now() < bo.nextAt) return Promise.resolve();
      if (!watch.fps.has(fp)) {
        // Not scheduled-and-awaited: send() runs under the engine lock.
        wanted.add(fp);
        void refreshWatch();
      } else if (!present.has(fp)) return Promise.resolve();
      if (!core.canDial()) return Promise.resolve();
      const c = conn;
      const s = c.nextS;
      c.nextS += 2;
      const st = newStream(c, s);
      c.send({ t: 'open', s, to: fp });
      const session = core.dial(st, fp);
      const done = session.established.then((ok) => {
        if (ok) { fpBackoff.delete(fp); wanted.delete(fp); return; }
        const n = (fpBackoff.get(fp)?.failures ?? 0) + 1;
        fpBackoff.set(fp, { failures: n, nextAt: now() + Math.min(lim.redialMinMs * 2 ** (n - 1), lim.redialMaxMs) });
        if (st.closedBy === 'ABSENT') present.delete(fp);
      }).finally(() => dialing.delete(fp));
      dialing.set(fp, done);
      return done;
    }

    return {
      addresses: () => [url],
      // Connects unless already up or connecting with exactly these identities. Resolves at once: the hub may be down.
      async open() {
        halted = false;
        if (conn && conn.regKey === [...core.fps()].sort().join(',')) return;
        leave();
        connectNow();
      },
      // Re-registers the identities that remain, whatever the link's state: up, backing off, or stopped by a duplicate
      // (the detached identity may have been the duplicated one).
      identitiesChanged() {
        halted = false;
        leave();
        connectNow();
      },
      shutdown() {
        cancelRetry();
        leave();
        present = new Set();
        wanted.clear();
      },
      // Waits for a connect in progress (never a backoff timer), then refreshes the watch and waits for its answer.
      async discover() {
        if (conn && !conn.ready) await conn.established;
        await refreshWatch();
      },
      dial: (_b, fp) => dialFp(fp),
      stats: () => ({ hub: { url, connected: up(), error } }),
    };
  };
}

/** `connect(opts)` opens the link socket (net.connect); tests inject one to reach it. */
export function createHubEndpoint({ url, connect = net.connect, ...opts }) {
  if (!parseHubAddr(url)) throw new Error(`not a hub address: ${String(url).slice(0, 80)}`);
  return createEndpoint({ ...opts, makeLink: hubLink({ url, connect }) });
}

// One install, one endpoint: what production uses.
export function createHubClient({ identity, view, cursors, ...opts }) {
  return createHubEndpoint(opts).attach({ identity, view, cursors });
}
