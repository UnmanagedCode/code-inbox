import { FrameError, TCP_FRAME_MAX, TCP_HELLO_FRAME_MAX, createDecoder, encodeFrame, parseFrame } from './frames.js';
import { boundFps, makeProofs, newHandshakeNonce, verifyProofs } from './handshake.js';

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

const RESPONSE_OF = { pull: 'recs', whois: 'cards' };

/**
 * @param {object} o
 * @param {import('node:net').Socket} o.socket
 * @param {'dial'|'accept'} o.role
 * @param {{fp, publicRaw, signProof}[]} o.signers   every identity attached to the endpoint
 * @param {string} [o.target]                         dial: the fingerprint this connection means to reach
 * @param {(fp: string) => boolean} o.isAttached
 * @param {(session) => void} o.onReady
 * @param {(session, frame) => Promise<void>} o.onFrame   rec / pull / whois, `from` proven and `to` attached
 * @param {() => void} o.onDropped                    a frame addressed to an unattached identity
 * @param {(session) => void} o.onClose               once, when the session ends (ready or not)
 */
export function createSession({ socket, role, signers, target = null, isAttached, limits, schedule, onReady, onFrame, onDropped, onClose, log }) {
  const localFps = signers.map((s) => s.fp);
  const decoder = createDecoder({ maxFrame: TCP_HELLO_FRAME_MAX });
  const myNonce = newHandshakeNonce();
  let peerNonce = null;
  let phase = 'hello';
  const queue = [];
  let processing = false;
  let paused = false;
  const pending = new Map(); // request id → {t, from, to, resolve, reject, cancel}
  let nextId = 1;
  const timers = { handshake: schedule(() => destroy(), limits.handshakeMs), frame: null, idle: null, ping: null };
  let settle;

  const session = {
    role,
    target,
    localFps,
    remote: [],
    ready: false,
    closed: false,
    // Resolves true once ready, false if the session ends first.
    established: new Promise((r) => { settle = r; }),
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

  function teardown() {
    if (session.closed) return;
    session.closed = true;
    for (const name of Object.keys(timers)) cancel(name);
    queue.length = 0;
    for (const p of pending.values()) { p.cancel(); p.reject(new Error('the session closed')); }
    pending.clear();
    settle(false);
    onClose(session);
  }

  // A deliberate close: `bye {reason}`, then the socket is destroyed once that is flushed.
  function close(reason) {
    if (session.closed) return;
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
  function handshake(f) {
    if (f.t === 'bye') { destroy(); return; }
    const own = (fps) => fps.some((fp) => localFps.includes(fp));
    if (phase === 'hello') {
      peerNonce = f.nonce;
      if (role === 'dial') {
        send({ t: 'prove', target, ids: makeProofs(signers, 'dial', myNonce, peerNonce, target) });
        phase = 'prove-accept';
      } else phase = 'prove-dial';
    } else if (phase === 'prove-dial') {
      // The acceptor signs nothing until the dialer's proof verifies.
      const fps = isAttached(f.target) ? verifyProofs(f.ids, 'dial', peerNonce, myNonce, f.target) : null;
      if (!fps || own(fps)) { close('PROOF'); return; }
      session.remote = fps;
      send({ t: 'prove', ids: makeProofs(signers, 'accept', myNonce, peerNonce, boundFps(fps)) });
      phase = 'ok';
    } else if (phase === 'prove-accept') {
      const fps = verifyProofs(f.ids, 'accept', peerNonce, myNonce, boundFps(localFps));
      if (!fps || own(fps) || !fps.includes(target)) { close('PROOF'); return; }
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
    if (f.t === 'bye') { destroy(); return; }
    if (f.t === 'recs' || f.t === 'cards') {
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

  socket.on('data', (chunk) => {
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
  });
  // Frames are small request/response pairs: Nagle plus delayed ACKs would add tens of ms to each.
  socket.setNoDelay(true);
  socket.on('error', () => destroy());
  socket.on('close', () => teardown());
  send({ t: 'hello', v: 1, nonce: myNonce });
  return session;
}
