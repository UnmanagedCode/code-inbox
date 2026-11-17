import net from 'node:net';
import { CodedError } from '../errors.js';
import { decodeRecord } from '../records.js';
import { TCP_BATCH_BYTES, TCP_MAX_IDENTITIES, TCP_PULL_ROUTES_MAX, TCP_WHOIS_MAX } from './frames.js';
import { routeKey } from './index.js';
import { SESSION_LIMITS, createSession } from './tcpSession.js';

// The direct TCP transport (docs/transport.md → TCP). Peers are addressed by fingerprint; one endpoint (a listener
// plus its pool of sessions) serves every identity attached to it, and one session between two endpoints carries
// all of their identities. A peer pushes and serves only records it signed itself (the writer is the proven
// `from`); a pull resumes from a per-(peer, route) cursor.

export const TCP_DEFAULT_PORT = 47821;
export const TCP_SYNC_MS = 30_000; // maintain: whois, dial, pull
export const TCP_MAX_CONNECTIONS = 64;
export const TCP_MAX_HANDSHAKING = 16;
export const TCP_REDIAL_MIN_MS = 1000;
export const TCP_REDIAL_MAX_MS = 5 * 60_000;

const DEFAULT_LIMITS = {
  ...SESSION_LIMITS,
  maxConnections: TCP_MAX_CONNECTIONS,
  maxHandshaking: TCP_MAX_HANDSHAKING,
  redialMinMs: TCP_REDIAL_MIN_MS,
  redialMaxMs: TCP_REDIAL_MAX_MS,
};

// ---- addresses and config ----

const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ADDR_RE = /^tcp:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;
const isHost = (h) => typeof h === 'string' && (net.isIP(h) !== 0 || HOSTNAME_RE.test(h));

// The unspecified addresses, compared as parsed addresses: `::0`, `0:0:0:0:0:0:0:0` and `::ffff:0.0.0.0` are `::`
// or `0.0.0.0` too.
const UNSPECIFIED = new net.BlockList();
UNSPECIFIED.addAddress('0.0.0.0', 'ipv4');
UNSPECIFIED.addAddress('::', 'ipv6');

// Whether `host` is an IP literal for "every interface" (listening on it is not one address peers can dial).
export function isWildcardHost(host) {
  const family = net.isIP(host);
  return family !== 0 && UNSPECIFIED.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

export const formatTcpAddr = (host, port) => `tcp://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;

// {host, port} of a `tcp://host:port` address (host unbracketed), or null.
export function parseTcpAddr(s) {
  const m = typeof s === 'string' ? ADDR_RE.exec(s) : null;
  if (!m) return null;
  const bracketed = m[1].startsWith('[');
  const host = bracketed ? m[1].slice(1, -1) : m[1];
  const port = Number(m[2]);
  if (bracketed ? !net.isIPv6(host) : !(net.isIPv4(host) || HOSTNAME_RE.test(host))) return null;
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

// Normalizes the TCP settings a human saves, or refuses TCP_INVALID. host: an IP literal or hostname (default
// 127.0.0.1); port: 0–65535 (default TCP_DEFAULT_PORT; 0 = ephemeral); advertise: the host that goes into
// announce.addr, defaulting to host and required when host is a wildcard.
export function validateTcpConfig(input) {
  const refuse = (why) => { throw new CodedError('TCP_INVALID', why); };
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) refuse('the TCP settings must be an object');
  const given = (v) => v !== undefined && v !== null && v !== '';
  const { host: h, port: p, advertise: a } = input ?? {};
  const host = given(h) ? h : '127.0.0.1';
  if (!isHost(host)) refuse('host must be an IP address or a hostname');
  const port = given(p) ? p : TCP_DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) refuse('port must be an integer 0–65535');
  if (isWildcardHost(host) && !given(a)) refuse(`listening on ${host} needs an advertised host`);
  const advertise = given(a) ? a : host;
  if (!isHost(advertise) || isWildcardHost(advertise)) refuse('advertise must be a reachable IP address or hostname');
  return { host, port, advertise };
}

const defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const minFp = (fps) => [...fps].sort()[0];

/**
 * One listener and its pool. `attach(binding)` → a Transport for one identity:
 * binding = {identity: proofSigner(...), view, cursors: {load(), save(obj)}}.
 */
export function createTcpEndpoint({ host = '127.0.0.1', port = TCP_DEFAULT_PORT, advertise = host, limits = {}, now = Date.now, schedule = defaultSchedule, syncMs = TCP_SYNC_MS, log = console }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const bindings = new Map(); // fp → binding (started, not stopped)
  const sessions = new Set();
  const pool = new Map(); // remote fp → ready session
  const dialing = new Map(); // addr → promise
  const backoff = new Map(); // addr → {failures, nextAt}
  const hints = new Map(); // fp → [tcp addr] from verified whois replies: dial hints only
  const counters = { handshakeFailures: 0, dropped: 0 };
  let server = null;
  let listening = null;
  let boundPort = null;
  let order = 0;

  const handshaking = () => [...sessions].filter((s) => !s.ready).length;

  // ---- sessions ----

  function newSession(socket, role, target) {
    const s = createSession({
      socket, role, target, limits: lim, schedule, log,
      signers: [...bindings.values()].map((b) => b.signer),
      isAttached: (fp) => bindings.has(fp),
      onReady,
      onFrame,
      onDropped: () => { counters.dropped += 1; },
      onClose: onClosed,
    });
    s.order = ++order;
    sessions.add(s);
    return s;
  }

  // The session both sides keep: the one whose dialer's smallest proven fp sorts lowest; on a tie, the older.
  const dialerKey = (s) => minFp(s.role === 'dial' ? s.localFps : s.remote);
  const keeps = (a, b) => {
    const ka = dialerKey(a);
    const kb = dialerKey(b);
    return ka !== kb ? (ka < kb ? a : b) : (a.order < b.order ? a : b);
  };

  function onReady(s) {
    for (const fp of s.remote) {
      const old = pool.get(fp);
      if (!old || old === s) continue;
      const loser = keeps(old, s) === s ? old : s;
      // Only the loser's dialer closes it, so both ends agree without a further message.
      if (loser.role === 'dial') loser.close('DUPLICATE');
      if (loser === s) return;
      for (const f of old.remote) if (pool.get(f) === old) pool.delete(f);
    }
    for (const fp of s.remote) pool.set(fp, s);
    for (const b of bindings.values()) {
      for (const fp of s.remote) {
        try { b.sink?.peerOnline(fp); } catch (err) { log.warn(`code-inbox: peerOnline failed: ${err.message}`); }
        void queue(b, () => pullFrom(b, s, fp, [...b.interest.values()]));
      }
    }
  }

  function onClosed(s) {
    sessions.delete(s);
    if (!s.ready) counters.handshakeFailures += 1;
    for (const fp of s.remote) {
      if (pool.get(fp) !== s) continue;
      pool.delete(fp);
      const other = [...sessions].find((x) => x.ready && !x.closed && x.remote.includes(fp));
      if (other) pool.set(fp, other);
    }
  }

  async function onFrame(s, f) {
    const b = bindings.get(f.to);
    if (f.t === 'rec') {
      if (!b.sink || !b.interest.has(routeKey(f.route))) { counters.dropped += 1; return; }
      await b.sink.record({ route: f.route, writer: f.from, bytes: f.rec });
    } else if (f.t === 'pull') {
      let budget = TCP_BATCH_BYTES;
      const routes = f.routes.map(({ route, since }) => {
        const r = b.view.serve(f.from, route, since, Math.max(0, budget));
        if (r.status !== 'ok') return { route, status: 'denied' };
        for (const x of r.recs) budget -= x.bytes.length;
        return { route, status: 'ok', recs: r.recs.map((x) => ({ seq: x.seq, rec: Buffer.from(x.bytes).toString('base64url') })), more: r.more, head: r.head };
      });
      s.write({ t: 'recs', id: f.id, from: f.to, to: f.from, routes });
    } else if (f.t === 'whois') {
      // Only announces of identities the requester shares an inbox with: no oracle for this install's contacts.
      const recs = f.fps.map((fp) => b.view.announceFor(f.from, fp)).filter(Boolean).map((x) => Buffer.from(x).toString('base64url'));
      s.write({ t: 'cards', id: f.id, from: f.to, to: f.from, recs });
    }
  }

  function onConnection(socket) {
    if (!bindings.size || sessions.size >= lim.maxConnections || handshaking() >= lim.maxHandshaking) { socket.destroy(); return; }
    newSession(socket, 'accept');
  }

  // A listener that fails after it is up is closed (its port freed) and forgotten; peers already connected keep
  // their sessions, and the next start() listens again.
  function forget(srv) {
    if (server !== srv) return;
    server = null;
    listening = null;
    boundPort = null;
  }

  function listen() {
    if (listening) return listening;
    const srv = net.createServer(onConnection);
    server = srv;
    listening = new Promise((resolve, reject) => {
      const failed = (err) => { forget(srv); reject(err); };
      srv.once('error', failed);
      srv.listen(port, host, () => {
        srv.off('error', failed);
        srv.on('error', (err) => {
          log.warn(`code-inbox: the TCP listener failed and was closed: ${err.message}`);
          forget(srv);
          srv.close();
        });
        boundPort = srv.address().port;
        resolve();
      });
    });
    return listening;
  }

  // Closes the listener synchronously (so the port is free at once) and every socket. Never awaits a sink call.
  function shutdown() {
    if (server) server.close();
    server = null;
    listening = null;
    boundPort = null;
    for (const s of [...sessions]) s.close('STOP');
  }

  const closeSessions = () => { for (const s of [...sessions]) s.close('STOP'); };

  // ---- dialing ----

  const addrsFor = (b, fp) => [...new Set([...b.view.addrsOf(fp), ...(hints.get(fp) ?? [])])].filter((a) => parseTcpAddr(a));

  function dialAddr(addr, target) {
    const inflight = dialing.get(addr);
    if (inflight) return inflight;
    const bo = backoff.get(addr);
    if (bo && now() < bo.nextAt) return Promise.resolve();
    if (!bindings.size || sessions.size >= lim.maxConnections) return Promise.resolve();
    const { host: h, port: p } = parseTcpAddr(addr);
    const s = newSession(net.connect({ host: h, port: p }), 'dial', target);
    const done = s.established.then((ok) => {
      if (ok) { backoff.delete(addr); return; }
      const failures = (backoff.get(addr)?.failures ?? 0) + 1;
      backoff.set(addr, { failures, nextAt: now() + Math.min(lim.redialMinMs * 2 ** (failures - 1), lim.redialMaxMs) });
    }).finally(() => dialing.delete(addr));
    dialing.set(addr, done);
    return done;
  }

  async function dialFp(b, fp) {
    for (const addr of addrsFor(b, fp)) {
      if (pool.has(fp) || bindings.has(fp) || !bindings.size) return;
      await dialAddr(addr, fp);
    }
  }

  // ---- pulling ----

  const cursorOf = (b, fp, key) => b.cursorData[fp]?.[key] ?? 0;
  const setCursor = (b, fp, key, seq) => { b.cursorData = { ...b.cursorData, [fp]: { ...b.cursorData[fp], [key]: seq } }; };

  // Pulls `routes` from `fp` on `s`, records signed by `fp` past this binding's cursor, until no route has more.
  // Only routes `fp` could serve by this install's own state are named (view.mayPull), so a peer learns no route
  // key it has no part in. A cursor moves only once its batch has been offered; a denied route keeps its cursor.
  async function pullFrom(b, s, fp, routes) {
    let todo = routes.filter((r) => b.view.mayPull(fp, r));
    while (todo.length && b.sink && !s.closed) {
      const chunk = todo.slice(0, TCP_PULL_ROUTES_MAX);
      const rest = todo.slice(TCP_PULL_ROUTES_MAX);
      const asked = new Map(chunk.map((r) => [routeKey(r), cursorOf(b, fp, routeKey(r))]));
      const resp = await s.request({ t: 'pull', from: b.fp, to: fp, routes: chunk.map((r) => ({ route: r, since: asked.get(routeKey(r)) })) });
      const answered = new Set();
      for (const r of resp.routes) {
        const key = routeKey(r.route);
        const since = asked.get(key);
        let last = since;
        const ordered = r.status !== 'ok' || r.recs.every((x) => { const okSeq = x.seq > last && x.seq <= r.head; last = x.seq; return okSeq; });
        if (since === undefined || answered.has(key) || (r.status === 'ok' && r.head >= since && !ordered)) { s.close('PROTOCOL'); return; }
        answered.add(key);
      }
      const again = [];
      let progressed = false;
      let changed = false;
      for (const r of resp.routes) {
        if (r.status === 'denied') continue;
        const key = routeKey(r.route);
        const since = asked.get(key);
        if (r.head < since) { setCursor(b, fp, key, 0); changed = true; progressed = true; again.push(r.route); continue; }
        for (const x of r.recs) {
          if (!b.sink) return;
          await b.sink.record({ route: r.route, writer: fp, bytes: x.rec });
        }
        if (r.recs.length) { setCursor(b, fp, key, r.recs.at(-1).seq); changed = true; progressed = true; }
        if (r.more) again.push(r.route);
      }
      if (changed) await b.cursors.save(b.cursorData);
      // A server answering `more` without a record makes no progress: stop rather than spin.
      todo = progressed ? [...again, ...rest] : rest;
    }
  }

  const readySessions = () => [...new Set(pool.values())];

  async function pullAll(b, routes) {
    await Promise.allSettled(readySessions().flatMap((s) => s.remote.map((fp) => queueFree(() => pullFrom(b, s, fp, routes)))));
  }
  const queueFree = (fn) => fn().catch((err) => log.warn(`code-inbox: a TCP pull failed: ${err.message}`));

  // Dial hints: an announce of a contact fetched from a connected peer, used only for its tcp:// addresses and
  // only if it verifies and is signed by the fingerprint asked about. Never ingested.
  async function whois(b, fps) {
    const asked = fps.slice(0, TCP_WHOIS_MAX);
    await Promise.allSettled(readySessions().map(async (s) => {
      const resp = await s.request({ t: 'whois', from: b.fp, to: s.remote[0], fps: asked });
      for (const bytes of resp.recs) {
        const d = decodeRecord(bytes);
        if (!d.ok || d.payload.type !== 'announce' || !asked.includes(d.payload.signer)) continue;
        hints.set(d.payload.signer, d.payload.addr.filter((a) => parseTcpAddr(a)));
      }
    }));
  }

  async function maintain(b) {
    if (!b.sink) return;
    const missing = b.view.contacts().filter((fp) => !bindings.has(fp) && !pool.has(fp));
    const unknown = missing.filter((fp) => addrsFor(b, fp).length === 0);
    if (unknown.length) await whois(b, unknown);
    await Promise.allSettled(missing.map((fp) => dialFp(b, fp)));
    await pullAll(b, [...b.interest.values()]);
  }

  // Per binding, pulls and maintain runs never overlap: each queues behind the last.
  function queue(b, fn) {
    b.chain = b.chain.then(() => (b.sink ? fn() : undefined)).catch((err) => log.warn(`code-inbox: TCP sync failed: ${err.message}`));
    return b.chain;
  }

  // ---- bindings ----

  function attach({ identity, view, cursors }) {
    const b = { fp: identity.fp, signer: identity, view, cursors, sink: null, interest: new Map(), chain: Promise.resolve(), cursorData: {}, timer: null, stopped: false };

    function loop() {
      b.timer = null;
      queue(b, () => maintain(b)).finally(() => { if (!b.stopped) b.timer = schedule(loop, syncMs); });
    }

    function detach() {
      b.stopped = true;
      b.sink = null;
      if (b.timer) { b.timer(); b.timer = null; }
      if (bindings.get(b.fp) !== b) return;
      bindings.delete(b.fp);
      if (bindings.size) closeSessions(); else shutdown();
    }

    /** @type {import('./index.js').Transport} */
    const transport = {
      capabilities: { directory: false, push: true },
      addresses: () => (boundPort === null ? [] : [formatTcpAddr(advertise, boundPort)]),
      stats,
      async start(sink) {
        if (bindings.size >= TCP_MAX_IDENTITIES) throw new Error(`an endpoint serves at most ${TCP_MAX_IDENTITIES} identities`);
        if (bindings.has(b.fp)) throw new Error(`identity ${b.fp.slice(0, 16)} is already attached to this endpoint`);
        // The identities a session proved change: existing sessions re-handshake when next needed.
        closeSessions();
        bindings.set(b.fp, b);
        b.sink = sink;
        try {
          await listen();
          b.cursorData = await cursors.load();
        } catch (err) {
          detach();
          throw err;
        }
        if (!b.stopped) loop();
      },
      // Newly added routes are pulled from every session at once (scheduled, never awaited: this runs under the
      // engine lock).
      setInterest(routes) {
        const next = new Map(routes.map((r) => [routeKey(r), r]));
        const added = [...next].filter(([k]) => !b.interest.has(k)).map(([, r]) => r);
        b.interest = next;
        if (added.length && b.sink) void queue(b, () => pullAll(b, added));
      },
      // Delivered: the frame was written to a ready session under its write-buffer cap. Recipients without one
      // are pending, and those in the dial set are dialed in the background.
      async send(bytes, { route, to }) {
        const delivered = [];
        const pendingTo = [];
        const rec = Buffer.from(bytes).toString('base64url');
        for (const fp of to) {
          const s = pool.get(fp);
          if (s && b.sink && s.write({ t: 'rec', from: b.fp, to: fp, route, rec })) delivered.push(fp); else pendingTo.push(fp);
        }
        if (pendingTo.length && b.sink) {
          const dialable = new Set(b.view.contacts());
          if (route.kind === 'mailbox') dialable.add(route.fp);
          for (const fp of pendingTo) if (dialable.has(fp) && !bindings.has(fp)) void dialFp(b, fp).catch(() => {});
        }
        return { delivered, pending: pendingTo };
      },
      sync: () => queue(b, () => maintain(b)),
      // Synchronous up to its return: the listener is closed before anything is awaited, so the port is free for
      // a transport started right after; pending sink calls are never awaited (the engine lock may hold them).
      stop() {
        detach();
        return Promise.resolve();
      },
    };
    return transport;
  }

  function stats() {
    return {
      listening: server && boundPort !== null ? { host, port: boundPort } : null,
      connections: sessions.size,
      handshaking: handshaking(),
      sessions: [...sessions].filter((s) => s.ready && !s.closed).map((s) => ({ role: s.role, remote: [...s.remote] })),
      handshakeFailures: counters.handshakeFailures,
      dropped: counters.dropped,
    };
  }

  return { attach, stats, close: shutdown };
}

// One install, one endpoint: what production uses.
export function createTcp({ identity, view, cursors, ...opts }) {
  return createTcpEndpoint(opts).attach({ identity, view, cursors });
}
