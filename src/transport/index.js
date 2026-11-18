import { FP_RE, ID_RE } from '../records.js';

// The transport interface the engine talks through (docs/transport.md). A transport moves opaque record bytes
// along routes; it is never trusted: the engine verifies, binds and authorizes every record it hands over.
//
/** @typedef {{kind:'directory'} | {kind:'mailbox', fp:string} | {kind:'inbox', id:string}} Route */
/** @typedef {{route: Route, writer: string, bytes: Uint8Array}} Incoming
 *  `writer` is the fingerprint the transport attributes the record to: on the file share the writer subdir, in
 *  network mode the frame's `from`, an identity the remote proved on that session (direct or through a hub). */
/** @typedef {{record(i: Incoming): Promise<{retry: boolean}>, announce(bytes: Uint8Array): void, peerOnline(fp: string): void}} Sink
 *  `record` resolves {retry:true} when the bytes may still be incomplete and should be offered again. `announce`
 *  takes a hub-relayed announce, which no proven session carried: the engine accepts it as an announce only, writer =
 *  its own signer, into memory only. */
/**
 * @typedef {object} Transport
 * @property {{directory: boolean, push: boolean, pull: boolean}} capabilities  `pull`: peers pull from each other's
 *                                                         served logs (view.serve), so a record a send misses still arrives
 * @property {(sink: Sink) => Promise<void>} start
 * @property {(routes: Route[]) => void} setInterest       the routes this install wants delivered. A route that leaves
 *                                                         the interest loses its delivery position: if it returns, the
 *                                                         transport delivers it from the start. A transport never
 *                                                         learns why a route left and never decodes a payload
 * @property {(bytes: Uint8Array|null) => void} setAnnounce   this install's current signed announce: a network
 *                                                         transport presents it to every peer and hub
 * @property {(bytes: Uint8Array, opts: {route: Route, to: string[]}) => Promise<{delivered: string[], pending: string[]}>} send
 * @property {() => Promise<void>} sync                    pull now / ask online peers to catch up
 * @property {() => Promise<void>} stop
 * @property {() => object} [stats]                       network mode only: listener, connections, sessions
 *                                                         (diagnostics; the engine reads it for display only)
 */

export const TRANSPORT_METHODS = ['start', 'setInterest', 'setAnnounce', 'send', 'sync', 'stop'];

// Throws unless `t` has the Transport shape: the engine calls this on every transport it is given.
export function assertTransport(t) {
  if (!t || typeof t !== 'object') throw new Error('a transport must be an object');
  for (const m of TRANSPORT_METHODS) if (typeof t[m] !== 'function') throw new Error(`a transport lacks ${m}()`);
  const c = t.capabilities;
  if (!c || typeof c.directory !== 'boolean' || typeof c.push !== 'boolean' || typeof c.pull !== 'boolean') throw new Error('a transport must declare capabilities {directory, push, pull}');
  return t;
}

export const routeKey = (r) => (r.kind === 'directory' ? 'directory' : r.kind === 'mailbox' ? `mailbox:${r.fp}` : `inbox:${r.id}`);
export const sameRoute = (a, b) => routeKey(a) === routeKey(b);

export function isRoute(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.kind === 'directory') return Object.keys(r).length === 1;
  if (r.kind === 'mailbox') return Object.keys(r).length === 2 && FP_RE.test(r.fp ?? '');
  if (r.kind === 'inbox') return Object.keys(r).length === 2 && ID_RE.test(r.id ?? '');
  return false;
}
