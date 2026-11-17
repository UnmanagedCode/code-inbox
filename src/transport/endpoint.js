import { TCP_BATCH_BYTES, TCP_MAX_IDENTITIES, TCP_PULL_ROUTES_MAX } from './frames.js';
import { routeKey } from './index.js';
import { SESSION_LIMITS, createSession } from './tcpSession.js';

// The network endpoint core shared by direct TCP and the hub client (docs/transport.md → Network endpoint). Peers
// are addressed by fingerprint; one endpoint serves every identity attached to it, and one session between two
// endpoints carries all of their identities. A peer pushes and serves only records it signed itself (the writer is
// the proven `from`); a pull resumes from a per-(peer, route) cursor. How a session's byte pipe is obtained (a
// listener and dials, or streams through a hub) is the link's: `makeLink(core)` → the hooks below.

export const TCP_SYNC_MS = 30_000; // maintain: discover, dial, pull
export const TCP_MAX_CONNECTIONS = 64;
export const TCP_MAX_HANDSHAKING = 16;
export const TCP_REDIAL_MIN_MS = 1000;
export const TCP_REDIAL_MAX_MS = 5 * 60_000;

export const ENDPOINT_LIMITS = {
  ...SESSION_LIMITS,
  maxConnections: TCP_MAX_CONNECTIONS,
  maxHandshaking: TCP_MAX_HANDSHAKING,
  redialMinMs: TCP_REDIAL_MIN_MS,
  redialMaxMs: TCP_REDIAL_MAX_MS,
};

export const defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const minFp = (fps) => [...fps].sort()[0];

/**
 * @typedef {object} Link
 * @property {() => string[]} addresses                       announce.addr
 * @property {() => Promise<void>} open                        every binding start; a rejection fails start()
 * @property {() => void} identitiesChanged                    a binding detached and others remain
 * @property {() => void} shutdown                             the last binding detached, or close(); synchronous
 * @property {(b, missing: string[]) => Promise<void>} discover   maintain step 1, for contacts without a session
 * @property {(b, fp: string) => Promise<void>} dial           resolves when the attempt ends; never rejects
 * @property {() => object} stats                              merged into the endpoint's stats()
 */

/**
 * `attach(binding)` → a Transport for one identity: binding = {identity: proofSigner(...), view, cursors: {load(),
 * save(obj)}}. `makeLink(core)` → Link; `core` is the narrow handle below.
 */
export function createEndpoint({ makeLink, limits = {}, now = Date.now, schedule = defaultSchedule, syncMs = TCP_SYNC_MS, log = console }) {
  const lim = { ...ENDPOINT_LIMITS, ...limits };
  const bindings = new Map(); // fp → binding (started, not stopped)
  const sessions = new Set();
  const pool = new Map(); // remote fp → ready session
  const counters = { handshakeFailures: 0, dropped: 0 };
  let order = 0;

  const handshaking = () => [...sessions].filter((s) => !s.ready).length;
  const readySessions = () => [...new Set(pool.values())];

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

  const closeSessions = () => { for (const s of [...sessions]) s.close('STOP'); };

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

  async function pullAll(b, routes) {
    await Promise.allSettled(readySessions().flatMap((s) => s.remote.map((fp) => queueFree(() => pullFrom(b, s, fp, routes)))));
  }
  const queueFree = (fn) => fn().catch((err) => log.warn(`code-inbox: a pull failed: ${err.message}`));

  async function maintain(b) {
    if (!b.sink) return;
    const missing = b.view.contacts().filter((fp) => !bindings.has(fp) && !pool.has(fp));
    await link.discover(b, missing);
    await Promise.allSettled(missing.map((fp) => link.dial(b, fp)));
    await pullAll(b, [...b.interest.values()]);
  }

  // Per binding, pulls and maintain runs never overlap: each queues behind the last.
  function queue(b, fn) {
    b.chain = b.chain.then(() => (b.sink ? fn() : undefined)).catch((err) => log.warn(`code-inbox: sync failed: ${err.message}`));
    return b.chain;
  }

  // ---- the link's handle ----

  const core = {
    lim,
    now,
    schedule,
    log,
    signers: () => [...bindings.values()].map((b) => b.signer),
    fps: () => [...bindings.keys()],
    isLocal: (fp) => bindings.has(fp),
    contacts: () => [...new Set([...bindings.values()].flatMap((b) => b.view.contacts()))],
    hasSession: (fp) => pool.has(fp),
    readySessions,
    canDial: () => bindings.size > 0 && sessions.size < lim.maxConnections,
    // An inbound byte pipe: destroyed at once beyond the caps (or with nothing attached), else an `accept` session.
    accept(socket) {
      if (!bindings.size || sessions.size >= lim.maxConnections || handshaking() >= lim.maxHandshaking) { socket.destroy(); return null; }
      return newSession(socket, 'accept');
    },
    dial: (socket, target) => newSession(socket, 'dial', target),
    syncAll() { for (const b of bindings.values()) void queue(b, () => maintain(b)); },
  };
  const link = makeLink(core);

  // ---- bindings ----

  function shutdown() {
    closeSessions();
    link.shutdown();
  }

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
      if (bindings.size) { closeSessions(); link.identitiesChanged(); } else shutdown();
    }

    /** @type {import('./index.js').Transport} */
    const transport = {
      capabilities: { directory: false, push: true },
      addresses: () => link.addresses(),
      stats,
      async start(sink) {
        if (bindings.size >= TCP_MAX_IDENTITIES) throw new Error(`an endpoint serves at most ${TCP_MAX_IDENTITIES} identities`);
        if (bindings.has(b.fp)) throw new Error(`identity ${b.fp.slice(0, 16)} is already attached to this endpoint`);
        // The identities a session proved change: existing sessions re-handshake when next needed.
        closeSessions();
        bindings.set(b.fp, b);
        b.sink = sink;
        try {
          await link.open();
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
          for (const fp of pendingTo) if (dialable.has(fp) && !bindings.has(fp)) void link.dial(b, fp).catch(() => {});
        }
        return { delivered, pending: pendingTo };
      },
      sync: () => queue(b, () => maintain(b)),
      // Synchronous up to its return: the link lets go of its port or socket before anything is awaited, so a
      // transport started right after can take it; pending sink calls are never awaited (the engine lock may
      // hold them).
      stop() {
        detach();
        return Promise.resolve();
      },
    };
    return transport;
  }

  function stats() {
    return {
      ...link.stats(),
      connections: sessions.size,
      handshaking: handshaking(),
      sessions: [...sessions].filter((s) => s.ready && !s.closed).map((s) => ({ role: s.role, remote: [...s.remote] })),
      handshakeFailures: counters.handshakeFailures,
      dropped: counters.dropped,
    };
  }

  return { attach, stats, close: shutdown };
}
