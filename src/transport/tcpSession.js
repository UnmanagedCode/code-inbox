import { FrameError, HELLO_VERSION, TCP_FRAME_MAX, TCP_HELLO_FRAME_MAX, createDecoder, encodeFrame, parseFrame } from './frames.js';
import { boundFps, dialBound, makeProofs, newHandshakeNonce, verifyProofs } from './handshake.js';

// One TCP connection: the handshake state machine, phase limits, timeouts, request/response correlation and a
// bounded inbound queue (docs/transport.md → TCP). Inbound frames are processed one at a time, each awaited;
// `write` never waits on inbound processing, so a send made under the engine lock cannot deadlock against a
// `sink.record` waiting for that lock.

export const TCP_HANDSHAKE_MS = 10_000; // the whole handshake
export const TCP_FRAME_MS = 30_000; // one post-ready frame, from its first byte
export const TCP_IDLE_MS = 90_000; // nothing received → close
export const TCP_PING_MS = 30_000;
export const TCP_REQUEST_MS = 15_000;
export const TCP_INBOUND_QUEUE = 64; // frames queued before the socket is paused
export const TCP_WRITE_BUFFER_MAX = 4 * 1024 * 1024; // unflushed bytes before the socket is destroyed

export const SESSION_LIMITS = {
  handshakeMs: TCP_HANDSHAKE_MS,
  frameMs: TCP_FRAME_MS,
  idleMs: TCP_IDLE_MS,
  pingMs: TCP_PING_MS,
  requestMs: TCP_REQUEST_MS,
  inboundQueue: TCP_INBOUND_QUEUE,
  writeBufferMax: TCP_WRITE_BUFFER_MAX,
};

const RESPONSE_OF = { pull: 'recs' };

/**
 * @param {object} o
 * @param {import('node:net').Socket} o.socket
 * @param {'dial'|'accept'} o.role
 * @param {{fp, publicRaw, signProof}[]} o.signers   every identity attached to the endpoint
 * @param {string|null} [o.target]                    dial: the fingerprint this connection means to reach, or null for
 *                                                    whoever proves (a direct dial of an address)
 * @param {'direct'|'hub'} o.via                      how the byte pipe was obtained: ranks duplicates (endpoint.js)
 * @param {{myNonce, peerNonce, rest: Buffer}} [o.greeted]   dial: the hello exchange greeting.js already ran on a
 *                                                    paused socket; the session proves at once, then resumes it
 * @param {(fp: string) => boolean} o.isAttached
 * @param {(session) => void} o.onReady
 * @param {(session, frame) => Promise<void>} o.onFrame   rec / pull, `from` proven and `to` attached
 * @param {() => void} o.onDropped                    a frame addressed to an unattached identity
 * @param {(session) => void} o.onClose               once, when the session ends (ready or not)
 */
export function createSession({ socket, role, signers, target = null, via, greeted = null, isAttached, limits, schedule, onReady, onFrame, onDropped, onClose, log }) {
  const localFps = signers.map((s) => s.fp);
  const decoder = createDecoder({ maxFrame: TCP_HELLO_FRAME_MAX });
  const myNonce = greeted ? greeted.myNonce : newHandshakeNonce();
  let peerNonce = null;
  let phase = 'hello';
  const queue = [];
  let processing = false;
  let paused = false;
  const pending = new Map(); // request id → {t, from, to, resolve, reject, cancel}
  let nextId = 1;
  const timers = { handshake: schedule(() => { ending('deadline', 'TIMEOUT'); destroy(); }, limits.handshakeMs), frame: null, idle: null, ping: null };
  let settle;
  let settleClosed;

  const session = {
    role,
    target,
    via,
    localFps,
    remote: [],
    ready: false,
    closed: false,
    // Why the session ended, once it has: {by: 'self'|'peer'|'socket'|'deadline', reason} (reason: a bye reason,
    // TIMEOUT or a socket error code). A connection reads it to show why its attempt failed.
    end: null,
    // Resolves true once ready, false if the session ends first.
    established: new Promise((r) => { settle = r; }),
    // Resolves once the session has ended.
    whenClosed: new Promise((r) => { settleClosed = r; }),
    write: (frame) => session.ready && send(frame),
    request,
    close,
    destroy,
  };

  function send(frame) {
    if (session.closed || socket.destroyed) return false;
    socket.write(encodeFrame(frame));
    if (socket.writableLength > limits.writeBufferMax) { destroy(); return false; }
    return true;
  }

  function cancel(name) { if (timers[name]) { timers[name](); timers[name] = null; } }

  // The first cause recorded wins.
  function ending(by, reason) { if (!session.closed && !session.end) session.end = { by, reason }; }

  function teardown() {
    if (session.closed) return;
    ending('socket', 'CLOSED');
    session.closed = true;
    for (const name of Object.keys(timers)) cancel(name);
    queue.length = 0;
    for (const p of pending.values()) { p.cancel(); p.reject(new Error('the session closed')); }
    pending.clear();
    settle(false);
    onClose(session);
    settleClosed();
  }

  // A deliberate close: `bye {reason}`, then the socket is destroyed once that is flushed.
  function close(reason) {
    if (session.closed) return;
    ending('self', reason);
    if (!socket.destroyed) socket.write(encodeFrame({ t: 'bye', reason }));
    teardown();
    socket.destroySoon();
  }

  function destroy() {
    teardown();
    socket.destroy();
  }

  function request(frame) {
    if (!session.ready || session.closed) return Promise.reject(new Error('the session is not ready'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const stop = schedule(() => { pending.delete(id); reject(new Error(`no ${RESPONSE_OF[frame.t]} within ${limits.requestMs} ms`)); }, limits.requestMs);
      pending.set(id, { t: RESPONSE_OF[frame.t], from: frame.to, to: frame.from, resolve, reject, cancel: stop });
      if (!send({ ...frame, id })) { stop(); pending.delete(id); reject(new Error('the session could not take the request')); }
    });
  }

  function becomeReady() {
    phase = 'ready';
    session.ready = true;
    decoder.setMax(TCP_FRAME_MAX);
    cancel('handshake');
    armIdle();
    const ping = () => { send({ t: 'ping' }); timers.ping = schedule(ping, limits.pingMs); };
    timers.ping = schedule(ping, limits.pingMs);
    settle(true);
    onReady(session);
  }

  function armIdle() {
    cancel('idle');
    timers.idle = schedule(() => close('LIMIT'), limits.idleMs);
  }

  // Handshake frames are handled synchronously, so the phase (and the decoder's max) changes before the next
  // frame of the same chunk is decoded.
  // The dialer's proof, once it knows the acceptor's nonce.
  function prove() {
    send({ t: 'prove', target, ids: makeProofs(signers, 'dial', myNonce, peerNonce, dialBound(target)) });
    phase = 'prove-accept';
  }

  function handshake(f) {
    if (f.t === 'bye') { ending('peer', f.reason); destroy(); return; }
    const own = (fps) => fps.some((fp) => localFps.includes(fp));
    if (phase === 'hello') {
      peerNonce = f.nonce;
      if (role === 'dial') prove(); else phase = 'prove-dial';
    } else if (phase === 'prove-dial') {
      // The acceptor signs nothing until the dialer's proof verifies.
      // An untargeted dial (target null, bound '') is for whoever is here; a targeted one must name an fp served here.
      const fps = f.target === null || isAttached(f.target) ? verifyProofs(f.ids, 'dial', peerNonce, myNonce, dialBound(f.target)) : null;
      if (!fps || own(fps)) { close('PROOF'); return; }
      session.remote = fps;
      send({ t: 'prove', ids: makeProofs(signers, 'accept', myNonce, peerNonce, boundFps(fps)) });
      phase = 'ok';
    } else if (phase === 'prove-accept') {
      const fps = verifyProofs(f.ids, 'accept', peerNonce, myNonce, boundFps(localFps));
      // A targeted dialer insists on its target; an untargeted one takes whoever proves, never its own identities.
      if (!fps || own(fps) || (target !== null && !fps.includes(target))) { close('PROOF'); return; }
      session.remote = fps;
      send({ t: 'ok' });
      becomeReady();
    } else if (phase === 'ok') {
      becomeReady();
    }
  }

  async function handle(f) {
    if (f.t === 'ping') { send({ t: 'pong' }); return; }
    if (f.t === 'pong') return;
    if (f.t === 'bye') { ending('peer', f.reason); destroy(); return; }
    if (f.t === 'recs') {
      const p = pending.get(f.id);
      if (!p) return; // answered after its timeout
      if (p.t !== f.t || p.from !== f.from || p.to !== f.to) throw new FrameError('PROTOCOL', `a ${f.t} does not answer request ${f.id}`);
      pending.delete(f.id);
      p.cancel();
      p.resolve(f);
      return;
    }
    if (!session.remote.includes(f.from)) throw new FrameError('PROTOCOL', `${f.t} from an identity not proven on this session`);
    if (!isAttached(f.to)) { onDropped(); return; }
    await onFrame(session, f);
  }

  async function drain() {
    if (processing) return;
    processing = true;
    while (queue.length && !session.closed) {
      const f = queue.shift();
      if (paused && queue.length < limits.inboundQueue) { paused = false; socket.resume(); }
      try {
        await handle(f);
      } catch (err) {
        if (err instanceof FrameError) { close(err.code); break; }
        log.warn(`code-inbox: handling a ${f.t} frame failed: ${err.message}`);
      }
    }
    processing = false;
  }

  function onData(chunk) {
    if (session.closed) return;
    if (session.ready) armIdle();
    decoder.push(chunk);
    try {
      let completed = false;
      for (let obj; !session.closed && (obj = decoder.next()) !== null;) {
        completed = true;
        const f = parseFrame(obj, phase);
        if (!session.ready) { handshake(f); continue; }
        queue.push(f);
        if (queue.length >= limits.inboundQueue && !paused) { paused = true; socket.pause(); }
      }
      if (session.ready && !session.closed) {
        if (completed || decoder.pending() === 0) cancel('frame');
        if (decoder.pending() > 0 && !timers.frame) timers.frame = schedule(() => close('LIMIT'), limits.frameMs);
      }
    } catch (err) {
      if (err instanceof FrameError) close(err.code); else destroy();
      return;
    }
    void drain();
  }

  // Frames are small request/response pairs: Nagle plus delayed ACKs would add tens of ms to each.
  socket.setNoDelay(true);
  socket.on('data', onData);
  socket.on('error', (err) => { ending('socket', err?.code ?? 'ERROR'); destroy(); });
  socket.on('close', () => teardown());
  if (greeted) {
    // The hello exchange is done: prove now, then read what followed the far hello and let the paused socket flow.
    // Deferred, so the caller holds the session before any handshake callback runs. Attaching a `data` listener
    // does not resume a socket paused explicitly: resume() does.
    peerNonce = greeted.peerNonce;
    prove();
    queueMicrotask(() => {
      if (socket.destroyed) { destroy(); return; }
      if (greeted.rest.length) onData(greeted.rest);
      socket.resume();
    });
  } else send({ t: 'hello', v: HELLO_VERSION, nonce: myNonce, kind: 'endpoint' });
  return session;
}
