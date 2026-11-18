import { parseHostPort } from './addr.js';
import { greet } from './greeting.js';
import { createHubConn } from './hubConn.js';
import { createHubSide } from './hubLink.js';

// One configured connection of a network endpoint (docs/transport.md → Connections): an address and nothing else.
// Each attempt connects, greets, and by the far end's hello becomes either a direct session with whoever proves
// there (peer mode: an untargeted dial, via 'direct') or a registered hub link carrying streams (hub mode,
// hubLink.js). It reconnects on its own timer, with backoff, independently of who the contacts are.

const KIND = { endpoint: 'peer', hub: 'hub' };

// Why a peer-mode handshake ended (tcpSession `end`), as the connection's error.
function sessionError(end) {
  const { by, reason } = end ?? {};
  if (reason === 'PROOF') {
    return by === 'peer'
      ? { code: 'CONNECTION_REFUSED', message: 'the far end refused this install\'s proof' }
      : { code: 'CONNECTION_REFUSED', message: 'the far end did not prove an identity this install accepts' };
  }
  if (reason === 'PROTOCOL' || reason === 'LIMIT') return { code: 'CONNECTION_PROTOCOL', message: `the handshake broke the protocol (${by === 'peer' ? 'the far end said' : 'this install said'} ${reason})` };
  if (reason === 'TIMEOUT') return { code: 'CONNECTION_TIMEOUT', message: 'the handshake did not complete in time' };
  if (by === 'socket' && reason !== 'CLOSED') return { code: reason, message: `the socket failed (${reason})` };
  return { code: 'CONNECTION_CLOSED', message: `the far end closed the connection during the handshake${by === 'peer' ? ` (${reason})` : ''}` };
}

/**
 * → (core) => Link. `connect({host, port})` opens the socket (net.connect unless injected).
 * status() → {address, kind: 'peer'|'hub'|null, state, remote: [fp], error: {code, message}|null}; state is
 * 'connecting' (an attempt in progress), 'up', 'waiting' (a reconnect timer), 'idle' (peer mode: another direct
 * session serves everyone it reached) or 'stopped' (hub mode: replaced by a duplicate registration).
 */
export function connectionLink({ address, connect }) {
  const { host, port } = parseHostPort(address);
  return (core) => {
    const { lim, now, schedule } = core;
    // Each session caps its own unflushed bytes (HubStream.writableLength); a hub link holds at most all of them.
    const linkLimits = { handshakeMs: lim.handshakeMs, frameMs: lim.frameMs, idleMs: lim.idleMs, pingMs: lim.pingMs, writeBufferMax: lim.maxConnections * lim.writeBufferMax };
    let kind = null; // detected from the far end's last hello
    let state = 'connecting';
    let error = null;
    let remote = []; // peer mode: the fps the last ready session proved
    let failures = 0;
    let nextAt = 0;
    let retry = null; // cancel of the reconnect timer
    let halted = false; // hub mode: replaced by a duplicate registration; no reconnect until open/identitiesChanged
    let current = null; // the attempt in progress or up: {socket, session, conn, side, regKey, settled, settle}
    const link = {};

    const cancelRetry = () => { if (retry) { retry(); retry = null; } };
    const regKey = () => [...core.fps()].sort().join(',');

    // Leaves the current attempt: what it says from now on is ignored.
    function leave() {
      const a = current;
      current = null;
      if (!a) return;
      a.settle();
      if (a.conn) a.conn.close('STOP');
      else if (a.session) a.session.close('STOP');
      else a.socket.destroy();
    }

    function rearm(delay) {
      cancelRetry();
      state = 'waiting';
      nextAt = now() + delay;
      retry = schedule(() => { retry = null; void attempt(); }, delay);
    }

    function failed(a, err) {
      if (a !== current) return;
      current = null;
      error = err;
      failures += 1;
      rearm(Math.min(lim.redialMinMs * 2 ** (failures - 1), lim.redialMaxMs));
      a.settle();
    }

    function succeeded(a) {
      state = 'up';
      failures = 0;
      error = null;
      a.settle();
    }

    // Starts an attempt; resolves once it is up or has failed.
    function attempt() {
      cancelRetry();
      if (!core.fps().length || halted) return Promise.resolve();
      // A peer session takes a session slot; a hub link takes none.
      if (kind !== 'hub' && !core.canDial()) { state = 'waiting'; return Promise.resolve(); }
      let settle;
      const a = { socket: null, session: null, conn: null, side: null, settled: new Promise((r) => { settle = r; }) };
      a.settle = settle;
      current = a;
      state = 'connecting';
      a.socket = connect({ host, port });
      greet({ socket: a.socket, schedule, handshakeMs: lim.handshakeMs }).then((g) => {
        if (a !== current) { a.socket.destroy(); return; }
        kind = KIND[g.kind];
        if (kind === 'peer') startPeer(a, g); else startHub(a, g);
      }, (err) => failed(a, { code: err.code ?? 'CONNECTION_FAILED', message: err.message }));
      return a.settled;
    }

    function startPeer(a, greeted) {
      if (!core.canDial()) {
        a.socket.destroy();
        failed(a, { code: 'CONNECTION_LIMIT', message: 'no session slot is free' });
        return;
      }
      const s = core.dial(a.socket, null, { via: 'direct', link, greeted });
      a.session = s;
      s.established.then((ok) => {
        if (a !== current) return;
        if (!ok) { failed(a, sessionError(s.end)); return; }
        remote = [...s.remote];
        succeeded(a);
      });
      s.whenClosed.then(() => {
        if (a !== current || !s.ready) return;
        current = null;
        // Idle, not reconnecting, while another direct session serves everyone this one reached (it lost the
        // duplicate rule, or the far end dialed back): maintain reconnects once one of them lacks a direct session.
        const lost = s.end?.by === 'self' && s.end.reason === 'DUPLICATE';
        if (lost || remote.every((fp) => core.hasDirectSession(fp))) { state = 'idle'; return; }
        rearm(lim.redialMinMs);
      });
    }

    function startHub(a, greeted) {
      let side = null;
      const c = createHubConn({
        socket: a.socket, role: 'client', greeted, signers: core.signers(), limits: linkLimits, schedule,
        onReady: () => {
          if (a !== current) return;
          succeeded(a);
          side.ready();
          core.syncAll();
        },
        onFrame: (_c, f) => { if (a === current) side.onFrame(f); },
        onClose: () => {
          side.closed();
          if (a !== current) return;
          current = null;
          hubClosed(a, c);
        },
      });
      side = createHubSide(core, c, link);
      a.conn = c;
      a.side = side;
      a.regKey = regKey();
    }

    function hubClosed(a, c) {
      if (c.bye === 'DUPLICATE') {
        error = { code: 'HUB_DUPLICATE', message: 'another endpoint registered this identity on the hub; this connection stopped reconnecting' };
        halted = true;
        state = 'stopped';
        a.settle();
        return;
      }
      if (!core.fps().length) { a.settle(); return; }
      if (c.ready && c.bye !== 'PROOF') {
        rearm(lim.redialMinMs);
        a.settle();
        return;
      }
      current = a; // failed() checks it
      failed(a, c.bye === 'PROOF' ? { code: 'HUB_REFUSED', message: 'the hub refused the registration proof' }
        : c.error ? { code: c.error.code ?? 'CONNECTION_FAILED', message: c.error.message }
          : c.bye ? { code: 'CONNECTION_PROTOCOL', message: `the hub said bye ${c.bye}` }
            : { code: 'CONNECTION_TIMEOUT', message: 'the hub did not answer the registration in time' });
    }

    const upHub = () => (kind === 'hub' && current?.side && state === 'up' ? current.side : null);

    Object.assign(link, {
      address,
      // Connects unless a hub link is already up or registering with exactly these identities. Resolves at once:
      // the far end may be down.
      async open() {
        halted = false;
        if (current?.conn && current.regKey === regKey()) return;
        leave();
        void attempt();
      },
      // The identities proven on the connection change: a peer session re-handshakes, a hub link re-registers,
      // whatever the state (stopped by a duplicate included: the detached identity may have been the duplicated one).
      identitiesChanged() {
        halted = false;
        leave();
        void attempt();
      },
      shutdown() {
        cancelRetry();
        leave();
      },
      // Maintain step 1: an attempt in progress is awaited; a waiting connection whose backoff has passed, or a
      // connection with no timer, reconnects. Never waits for a backoff timer.
      connect() {
        if (current) return current.settled;
        if (halted || !core.fps().length) return Promise.resolve();
        if (state === 'idle') return remote.some((fp) => !core.hasDirectSession(fp)) ? attempt() : Promise.resolve();
        if (retry && now() < nextAt) return Promise.resolve();
        return attempt();
      },
      dial: (fp) => upHub()?.dial(fp) ?? Promise.resolve(),
      announceChanged() { upHub()?.sendAnnounces(); },
      present: () => upHub()?.present() ?? [],
      status() {
        const fps = kind === 'hub'
          ? (current?.side ? core.readySessions().filter((s) => s.link === link).flatMap((s) => s.remote) : [])
          : (state === 'up' || state === 'idle' ? remote : []);
        return { address, kind, state, remote: [...new Set(fps)], error };
      },
    });
    return link;
  };
}
