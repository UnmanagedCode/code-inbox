import { CodedError } from '../errors.js';
import { FrameError, HELLO_VERSION, TCP_HELLO_FRAME_MAX, createDecoder, encodeFrame, parseGreeting } from './frames.js';
import { newHandshakeNonce } from './handshake.js';

// The first hello exchange of an outbound connection (docs/protocol.md → The greeting): it sends this install's
// `hello` (kind `endpoint`) and reads the far end's, whose `kind` says whether a peer's listener or a hub answered.
// The caller then builds an endpoint session (dial role) or a hub-link client on the same socket, passing the
// result as `greeted`.

const fail = (code, message) => new CodedError(code, message);

/**
 * → Promise<{kind: 'endpoint'|'hub', myNonce, peerNonce, rest: Buffer}>. Before it resolves the socket is paused and
 * the greeting's listeners are removed (a no-op `error` listener stays, so nothing is unhandled until the next reader
 * attaches): `rest` holds the bytes after the hello, and the next reader must push them, then resume the socket.
 * Rejects CONNECTION_PROTOCOL (not a v2 hello, or a `bye`), CONNECTION_TIMEOUT (nothing within `handshakeMs`) or the
 * socket's own error; the socket is destroyed then.
 */
export function greet({ socket, schedule, handshakeMs }) {
  return new Promise((resolve, reject) => {
    const decoder = createDecoder({ maxFrame: TCP_HELLO_FRAME_MAX });
    const myNonce = newHandshakeNonce();
    let done = false;
    const noop = () => {};

    function finish() {
      done = true;
      cancel();
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.on('error', noop);
    }

    function refuse(err, bye) {
      if (done) return;
      finish();
      if (bye && !socket.destroyed) {
        socket.write(encodeFrame({ t: 'bye', reason: bye }));
        socket.destroySoon();
      } else socket.destroy();
      reject(err);
    }

    function onData(chunk) {
      if (done) return;
      decoder.push(chunk);
      let obj;
      try {
        obj = decoder.next();
        if (obj === null) return;
        const f = parseGreeting(obj);
        finish();
        socket.pause();
        resolve({ kind: f.kind, myNonce, peerNonce: f.nonce, rest: Buffer.from(decoder.rest()) });
      } catch (err) {
        if (!(err instanceof FrameError)) throw err;
        const isBye = obj?.t === 'bye';
        refuse(fail('CONNECTION_PROTOCOL', isBye ? `the far end said bye ${String(obj.reason).slice(0, 20)} before any hello` : `the far end does not speak a v${HELLO_VERSION} hello: ${err.message}`), isBye ? null : err.code);
      }
    }

    function onError(err) { refuse(err, null); }

    function onClose() { refuse(fail('CONNECTION_PROTOCOL', 'the far end closed the connection before any hello'), null); }

    const cancel = schedule(() => refuse(fail('CONNECTION_TIMEOUT', `no hello within ${handshakeMs} ms`), null), handshakeMs);
    // Frames are small request/response pairs: Nagle plus delayed ACKs would add tens of ms to each.
    socket.setNoDelay(true);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.write(encodeFrame({ t: 'hello', v: HELLO_VERSION, nonce: myNonce, kind: 'endpoint' }));
  });
}
