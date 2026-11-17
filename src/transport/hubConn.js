import { FrameError, HUB_FRAME_MAX, TCP_HELLO_FRAME_MAX, createDecoder, encodeFrame, parseHubFrame } from './frames.js';
import { makeProofs, newHandshakeNonce, verifyProofs } from './handshake.js';

// One hub-link connection, either side (docs/protocol.md → Hub link wire format): the hello exchange, `register` /
// `ok`, phase frame limits, deadlines, keepalive, the write-buffer cap and `bye`. Every frame is handled
// synchronously: neither side awaits inbound work, so there is no inbound queue and the socket is never paused.
// The client proves its identities with role `hub` and bound `''`; the hub verifies and signs nothing.

/**
 * @param {object} o
 * @param {import('node:net').Socket} o.socket
 * @param {'hub'|'client'} o.role
 * @param {{fp, publicRaw, signProof}[]} [o.signers]   client: every identity to register
 * @param {{handshakeMs, frameMs, idleMs, pingMs, writeBufferMax}} o.limits   writeBufferMax: unflushed link bytes
 * @param {(conn, fps: string[]) => void} [o.onRegistered]  hub: a registration verified, before `ok` is sent
 * @param {(conn) => void} [o.onReady]
 * @param {(conn, frame) => void} o.onFrame             every ready-phase frame but ping/pong/bye; may throw FrameError
 * @param {(conn) => void} o.onClose                    once, ready or not
 */
export function createHubConn({ socket, role, signers = [], limits, schedule, onRegistered = () => {}, onReady = () => {}, onFrame, onClose }) {
  const decoder = createDecoder({ maxFrame: TCP_HELLO_FRAME_MAX });
  const myNonce = newHandshakeNonce();
  let phase = 'hello';
  const timers = { handshake: schedule(() => destroy(), limits.handshakeMs), frame: null, idle: null, ping: null };
  let settle;

  const conn = {
    role,
    fps: [], // the hub: what the client proved; the client: what it registered
    ready: false,
    closed: false,
    bye: null, // the reason of a `bye` received
    error: null, // the socket error that ended it
    // Resolves true once ready, false if the link ends first.
    established: new Promise((r) => { settle = r; }),
    send,
    close,
    destroy,
  };

  // `frame`: an object, or bytes already encoded. `onFlushed` runs once the bytes leave the process (or the socket
  // dies). Over `writeBufferMax` unflushed bytes the link is destroyed.
  function send(frame, onFlushed) {
    if (conn.closed || socket.destroyed) return false;
    socket.write(Buffer.isBuffer(frame) ? frame : encodeFrame(frame), onFlushed);
    if (socket.writableLength > limits.writeBufferMax) { destroy(); return false; }
    return true;
  }

  function cancel(name) { if (timers[name]) { timers[name](); timers[name] = null; } }

  function teardown() {
    if (conn.closed) return;
    conn.closed = true;
    for (const name of Object.keys(timers)) cancel(name);
    settle(false);
    onClose(conn);
  }

  function close(reason) {
    if (conn.closed) return;
    if (!socket.destroyed) socket.write(encodeFrame({ t: 'bye', reason }));
    teardown();
    socket.destroySoon();
  }

  function destroy() {
    teardown();
    socket.destroy();
  }

  function armIdle() {
    cancel('idle');
    timers.idle = schedule(() => close('LIMIT'), limits.idleMs);
  }

  function becomeReady() {
    phase = 'ready';
    conn.ready = true;
    decoder.setMax(HUB_FRAME_MAX);
    cancel('handshake');
    armIdle();
    const ping = () => { send({ t: 'ping' }); timers.ping = schedule(ping, limits.pingMs); };
    timers.ping = schedule(ping, limits.pingMs);
    settle(true);
    onReady(conn);
  }

  function handshake(f) {
    if (phase === 'hello') {
      const peerNonce = f.nonce;
      if (role === 'client') {
        send({ t: 'register', ids: makeProofs(signers, 'hub', myNonce, peerNonce, '') });
        phase = 'ok';
      } else {
        conn.peerNonce = peerNonce;
        phase = 'register';
      }
    } else if (phase === 'register') {
      const fps = verifyProofs(f.ids, 'hub', conn.peerNonce, myNonce, '');
      if (!fps) { close('PROOF'); return; }
      conn.fps = fps;
      onRegistered(conn, fps);
      if (conn.closed) return;
      send({ t: 'ok' });
      becomeReady();
    } else if (phase === 'ok') {
      conn.fps = signers.map((s) => s.fp);
      becomeReady();
    }
  }

  function handle(f) {
    if (f.t === 'bye') { conn.bye = f.reason; destroy(); return; }
    if (!conn.ready) { handshake(f); return; }
    if (f.t === 'ping') { send({ t: 'pong' }); return; }
    if (f.t === 'pong') return;
    onFrame(conn, f);
  }

  socket.on('data', (chunk) => {
    if (conn.closed) return;
    if (conn.ready) armIdle();
    decoder.push(chunk);
    try {
      let completed = false;
      for (let obj; !conn.closed && (obj = decoder.next()) !== null;) {
        completed = true;
        handle(parseHubFrame(obj, role, phase));
      }
      if (conn.ready && !conn.closed) {
        if (completed || decoder.pending() === 0) cancel('frame');
        if (decoder.pending() > 0 && !timers.frame) timers.frame = schedule(() => close('LIMIT'), limits.frameMs);
      }
    } catch (err) {
      if (err instanceof FrameError) close(err.code); else destroy();
    }
  });
  // Stream data is small request/response pairs inside: Nagle plus delayed ACKs would add tens of ms to each.
  socket.setNoDelay(true);
  socket.on('error', (err) => { conn.error = err; destroy(); });
  socket.on('close', () => teardown());
  send({ t: 'hello', v: 1, nonce: myNonce });
  return conn;
}
