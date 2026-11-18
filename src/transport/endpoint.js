import { TCP_BATCH_BYTES, TCP_MAX_IDENTITIES, TCP_PULL_ROUTES_MAX } from './frames.js';
import { routeKey } from './index.js';
import { SESSION_LIMITS, createSession } from './tcpSession.js';

// The network endpoint core (docs/transport.md → Network endpoint). Peers are addressed by fingerprint; one endpoint
// serves every identity attached to it, and one session between two endpoints carries all of their identities, over
// whatever route it formed on: a direct TCP connection (the listener, or a configured connection that reached a
// peer) or a stream through a hub (a configured connection that reached a hub). The writer of every record is the
// proven `from`: a peer pushes and serves what its view serves (its own records, and on a shared inbox it owns its
// members' records too); a pull resumes from a per-(peer, route) cursor over the peer's acceptance seqs. How byte
// pipes are obtained is the links': `makeLinks(core)` → the listener and one link per configured connection.

export const TCP_SYNC_MS = 30_000; // maintain: connect, dial, pull
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
 * @property {boolean} [listener]                  the listener link (at most one, first)
 * @property {() => Promise<void>} open            every binding start; a rejection fails start()
 * @property {() => void} identitiesChanged        a binding detached and others remain
 * @property {() => void} shutdown                 the last binding detached, or close(); synchronous
 * @property {() => Promise<void>} connect         maintain step 1: (re)connect if due, await an attempt in progress
 * @property {(fp: string) => Promise<void>} dial  one hub stream dial (maintain, send, a roster `peer`); never rejects
 * @property {() => void} announceChanged          a binding's announce changed: a hub link sends it again
 * @property {() => string[]} present              the fps a hub reports registered (a hub link's roster), else []
 * @property {() => object} status                 the listener: {listening}; a connection: its row in stats()
 */

/**
 * `attach(binding)` → a Transport for one identity: binding = {identity: proofSigner(...), view, cursors: {load(),
 * save(obj)}}. `makeLinks(core)` → Link[] (the listener first, then the connections in configured order); `core`
 * is the narrow handle below.
 */
export function createEndpoint({ makeLinks, limits = {}, now = Date.now, schedule = defaultSchedule, syncMs = TCP_SYNC_MS, log = console }) {
  const lim = { ...ENDPOINT_LIMITS, ...limits };
  const bindings = new Map(); // fp → binding (started, not stopped)
  const sessions = new Set();
  const pool = new Map(); // remote fp → ready session
  const counters = { handshakeFailures: 0, dropped: 0 };
  let order = 0;

  const handshaking = () => [...sessions].filter((s) => !s.ready).length;
  const readySessions = () => [...new Set(pool.values())];

  // ---- sessions ----

  // `via`: 'direct' (a TCP connection: accepted, or a connection's peer dial) or 'hub' (a hub stream); `link`: the
  // link that obtained the pipe.
  function newSession(socket, role, target, { via, link = null, greeted = null }) {
    const s = createSession({
      socket, role, target, via, greeted, limits: lim, schedule, log,
      signers: [...bindings.values()].map((b) => b.signer),
      isAttached: (fp) => bindings.has(fp),
      onReady,
      onFrame,
      onDropped: () => { counters.dropped += 1; },
      onClose: onClosed,
    });
    s.order = ++order;
    s.link = link;
    sessions.add(s);
    return s;
  }

  // The session both sides keep: a direct one over a hub one; then the one whose dialer's smallest proven fp sorts
  // lowest; on a tie, the older. Both ends classify a session's route the same way (a TCP socket at both ends, or a
  // hub stream at both ends), so they agree without a further message.
  const dialerKey = (s) => minFp(s.role === 'dial' ? s.localFps : s.remote);
  const keeps = (a, b) => {
    if (a.via !== b.via) return a.via === 'direct' ? a : b;
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
    for (const b of bindings.values()) pushAnnounce(b, s);
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
      const others = [...sessions].filter((x) => x.ready && !x.closed && x.remote.includes(fp));
      if (others.length) pool.set(fp, others.reduce(keeps));
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
    }
  }

  const closeSessions = () => { for (const s of [...sessions]) s.close('STOP'); };

  // A binding's announce, pushed to every remote fp of a session: how a peer learns who this install is.
  function pushAnnounce(b, s) {
    if (!b.announce || !b.sink) return;
    const rec = Buffer.from(b.announce).toString('base64url');
    for (const fp of s.remote) s.write({ t: 'rec', from: b.fp, to: fp, route: { kind: 'directory' }, rec });
  }

  // ---- pulling ----

  const cursorOf = (b, fp, key) => b.cursorData[fp]?.[key] ?? 0;
  // A route outside the interest keeps no cursor: a pull still in flight when it left cannot bring one back.
  const setCursor = (b, fp, key, seq) => {
    if (!b.interest.has(key)) return;
    b.cursorData = { ...b.cursorData, [fp]: { ...b.cursorData[fp], [key]: seq } };
  };
  // Drops every cursor of a route outside the interest; resolves whether any went.
  function pruneCursors(b) {
    let changed = false;
    const next = {};
    for (const [fp, routes] of Object.entries(b.cursorData)) {
      const kept = Object.fromEntries(Object.entries(routes).filter(([key]) => b.interest.has(key)));
      if (Object.keys(kept).length !== Object.keys(routes).length) changed = true;
      next[fp] = kept;
    }
    if (changed) b.cursorData = next;
    return changed;
  }

  // Pulls `routes` from `fp` on `s`: the records `fp` serves there (view.serve on its side) past this binding's
  // cursor, until no route has more. Each is offered with writer `fp`.
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

  // Through the hub-mode connections in configured order, until `fp` has a session; a hub dials only an fp its
  // roster shows present and it is not backing off for. Never rejects.
  async function dialHubs(fp) {
    for (const l of links) {
      if (pool.has(fp) || bindings.has(fp) || !bindings.size) return;
      await l.dial(fp).catch((err) => log.warn(`code-inbox: a dial failed: ${err.message}`));
    }
  }

  // Direct first: due connections come up (and are awaited) before contacts still missing are dialed through hubs.
  // Only contacts: a stranger is never dialed by maintain.
  async function maintain(b) {
    if (!b.sink) return;
    await Promise.allSettled(links.map((l) => l.connect()));
    const missing = b.view.contacts().filter((fp) => !bindings.has(fp) && !pool.has(fp));
    await Promise.allSettled(missing.map(dialHubs));
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
    hasDirectSession: (fp) => pool.get(fp)?.via === 'direct',
    readySessions,
    canDial: () => bindings.size > 0 && sessions.size < lim.maxConnections,
    dialHubs,
    // The bindings' current announces: what a hub link gives the hub.
    announces: () => [...bindings.values()].map((b) => b.announce).filter(Boolean),
    // A hub-relayed announce (already decoded and checked by the link), for every binding's engine.
    offerAnnounce(bytes) {
      for (const b of bindings.values()) {
        try { b.sink?.announce(bytes); } catch (err) { log.warn(`code-inbox: offering an announce failed: ${err.message}`); }
      }
    },
    countDropped() { counters.dropped += 1; },
    // An inbound byte pipe: destroyed at once beyond the caps (or with nothing attached), else an `accept` session.
    accept(socket, { via, link = null }) {
      if (!bindings.size || sessions.size >= lim.maxConnections || handshaking() >= lim.maxHandshaking) { socket.destroy(); return null; }
      return newSession(socket, 'accept', null, { via, link });
    },
    // An outbound byte pipe: `target` is the fingerprint to reach, or null for whoever proves (a direct dial).
    dial: (socket, target, opts) => newSession(socket, 'dial', target, opts),
    syncAll() { for (const b of bindings.values()) void queue(b, () => maintain(b)); },
  };
  const links = makeLinks(core);

  // ---- bindings ----

  function shutdown() {
    closeSessions();
    for (const l of links) l.shutdown();
  }

  function attach({ identity, view, cursors }) {
    const b = { fp: identity.fp, signer: identity, view, cursors, sink: null, announce: null, interest: new Map(), chain: Promise.resolve(), cursorData: {}, timer: null, stopped: false };

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
      if (bindings.size) { closeSessions(); for (const l of links) l.identitiesChanged(); } else shutdown();
    }

    /** @type {import('./index.js').Transport} */
    const transport = {
      capabilities: { directory: false, push: true, pull: true },
      stats,
      // This identity's signed announce (bytes, or null): pushed on every ready session now and on every one that
      // becomes ready, and given to every hub.
      setAnnounce(bytes) {
        b.announce = bytes ? Buffer.from(bytes) : null;
        for (const s of readySessions()) pushAnnounce(b, s);
        for (const l of links) l.announceChanged();
      },
      async start(sink) {
        if (bindings.size >= TCP_MAX_IDENTITIES) throw new Error(`an endpoint serves at most ${TCP_MAX_IDENTITIES} identities`);
        if (bindings.has(b.fp)) throw new Error(`identity ${b.fp.slice(0, 16)} is already attached to this endpoint`);
        // The identities a session proved change: existing sessions re-handshake when next needed.
        closeSessions();
        bindings.set(b.fp, b);
        b.sink = sink;
        try {
          // Cursors first: a connection opened here may be ready (and pulling) before anything else is awaited.
          b.cursorData = await cursors.load();
          if (pruneCursors(b)) await cursors.save(b.cursorData);
          for (const l of links) await l.open();
        } catch (err) {
          detach();
          throw err;
        }
        if (!b.stopped) loop();
      },
      // Newly added routes are pulled from every session at once; a route that left loses its cursors, so it is
      // pulled from the start if it returns (both scheduled, never awaited: this runs under the engine lock).
      setInterest(routes) {
        const next = new Map(routes.map((r) => [routeKey(r), r]));
        const added = [...next].filter(([k]) => !b.interest.has(k)).map(([, r]) => r);
        b.interest = next;
        if (pruneCursors(b)) void queue(b, () => b.cursors.save(b.cursorData));
        if (added.length && b.sink) void queue(b, () => pullAll(b, added));
      },
      // Delivered: the frame was written to a ready session under its write-buffer cap. Recipients without one
      // are pending, and those in the dial set are dialed through the hubs in the background (not awaited: this runs
      // under the engine lock).
      async send(bytes, { route, to }) {
        const delivered = [];
        const pendingTo = [];
        const rec = Buffer.from(bytes).toString('base64url');
        for (const fp of to) {
          const s = pool.get(fp);
          if (s && b.sink && s.write({ t: 'rec', from: b.fp, to: fp, route, rec })) delivered.push(fp); else pendingTo.push(fp);
        }
        if (pendingTo.length && b.sink) {
          for (const fp of pendingTo) if (!bindings.has(fp)) void dialHubs(fp);
        }
        return { delivered, pending: pendingTo };
      },
      sync: () => queue(b, () => maintain(b)),
      // Synchronous up to its return: every link lets go of its port, socket, session or timer before anything is
      // awaited, so a transport started right after can take the port; pending sink calls are never awaited (the
      // engine lock may hold them).
      stop() {
        detach();
        return Promise.resolve();
      },
    };
    return transport;
  }

  // fp → [{via, address}]: where each identity can be reached now. Ready sessions (address: the connection's, null for
  // one accepted on the listener) and each hub's roster (via 'hub', address: that connection's).
  function presence() {
    const out = {};
    const add = (fp, at) => {
      if (bindings.has(fp)) return;
      const list = (out[fp] ??= []);
      if (!list.some((x) => x.via === at.via && x.address === at.address)) list.push(at);
    };
    for (const s of sessions) if (s.ready && !s.closed) for (const fp of s.remote) add(fp, { via: s.via, address: s.link?.address ?? null });
    for (const l of links) for (const fp of l.present()) add(fp, { via: 'hub', address: l.address });
    return out;
  }

  function stats() {
    const listener = links.find((l) => l.listener);
    return {
      presence: presence(),
      listening: listener ? listener.status().listening : null,
      connections: links.filter((l) => !l.listener).map((l) => l.status()),
      sessionCount: sessions.size,
      handshaking: handshaking(),
      // address: the connection the session formed on (null: accepted on the listener).
      sessions: [...sessions].filter((s) => s.ready && !s.closed).map((s) => ({ role: s.role, via: s.via, address: s.link?.address ?? null, remote: [...s.remote] })),
      handshakeFailures: counters.handshakeFailures,
      dropped: counters.dropped,
    };
  }

  return { attach, stats, close: shutdown };
}
