import net from 'node:net';
import { CodedError } from '../errors.js';
import { ADDRESS_MAX_CHARS, TCP_LOOKUP_MS, formatHostPort, isHost, isWildcardHost, lookupAll, parseHostPort } from './addr.js';
import { connectionLink } from './connection.js';
import { createEndpoint } from './endpoint.js';
import { listenerLink } from './listener.js';

// Network mode (docs/transport.md → Network endpoint): the endpoint core with an optional listener and any number
// of user-configured connections. A connection is an address and nothing else; the far end may be a peer's
// listener or a hub, told apart by its hello.

export const TCP_DEFAULT_PORT = 47821;
export const CONNECTIONS_MAX = 32;

const refuse = (why) => { throw new CodedError('NETWORK_INVALID', why); };
const given = (v) => v !== undefined && v !== null && v !== '';

// Normalizes the network settings a human saves, or refuses NETWORK_INVALID. Pure.
//   listen: null (no listener) or {host, port}: host an IP literal or hostname, default 127.0.0.1, a wildcard
//           allowed; port 0–65535, default TCP_DEFAULT_PORT (0 = ephemeral). Absent = null.
//   connections: at most CONNECTIONS_MAX `host:port` strings (port 1–65535, at most ADDRESS_MAX_CHARS, host not a
//           wildcard literal), distinct once normalized (formatHostPort). Absent = [].
export function validateNetworkConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('the network settings must be an object');
  const { listen: l, connections: c } = input;
  let listen = null;
  if (l !== undefined && l !== null) {
    if (typeof l !== 'object' || Array.isArray(l)) refuse('listen must be null or an object {host, port}');
    const host = given(l.host) ? l.host : '127.0.0.1';
    if (!isHost(host)) refuse('the listen host must be an IP address or a hostname');
    const port = given(l.port) ? l.port : TCP_DEFAULT_PORT;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) refuse('the listen port must be an integer 0–65535');
    listen = { host, port };
  }
  const list = c === undefined || c === null ? [] : c;
  if (!Array.isArray(list) || list.length > CONNECTIONS_MAX) refuse(`connections must be an array of at most ${CONNECTIONS_MAX} addresses`);
  const connections = list.map((a) => {
    if (typeof a !== 'string' || a.length > ADDRESS_MAX_CHARS) refuse(`a connection must be a host:port string of at most ${ADDRESS_MAX_CHARS} characters`);
    const hp = parseHostPort(a.trim());
    if (!hp) refuse(`${JSON.stringify(a.slice(0, 80))} is not host:port with a port 1–65535`);
    if (isWildcardHost(hp.host)) refuse(`${hp.host} is every interface, not an address to connect to`);
    return formatHostPort(hp.host, hp.port);
  });
  const dup = connections.find((a, i) => connections.indexOf(a) !== i);
  if (dup) refuse(`${dup} is listed twice`);
  return { listen, connections };
}

// validateNetworkConfig, then DNS for every non-literal host: a listen host must resolve within `lookupMs`
// (TCP_LOOKUP_MS), on a save and at boot. A connection host that resolves to a wildcard is refused; one that does
// not resolve (or not in time) is refused only with `mustResolve` (a save): at boot it may be unreachable for now,
// and the connection keeps retrying. Refuses NETWORK_INVALID; resolves the normalized config. Runs outside the
// engine lock. `lookup(name)` → [{address, family}] is dns.lookup with {all: true} unless injected (tests).
export async function resolveNetworkConfig(input, { lookup, lookupMs = TCP_LOOKUP_MS, mustResolve = true } = {}) {
  const cfg = validateNetworkConfig(input);
  const resolve = async (name, what, required) => {
    if (net.isIP(name) !== 0) return null;
    try {
      return await lookupAll(name, { lookup, lookupMs });
    } catch (err) {
      if (!required) return null;
      return refuse(err.timedOut ? `${what} ${name}: the lookup timed out (${err.message})` : `${what} ${name} does not resolve (${err.code ?? err.message})`);
    }
  };
  if (cfg.listen) await resolve(cfg.listen.host, 'the listen host', true);
  await Promise.all(cfg.connections.map(async (a) => {
    const { host } = parseHostPort(a);
    const addrs = await resolve(host, 'the connection host', mustResolve);
    const wild = addrs?.find((x) => isWildcardHost(x.address));
    if (wild) refuse(`the connection host ${host} resolves to ${wild.address}, every interface: name an address`);
  }));
  return cfg;
}

/**
 * The endpoint for one network config: the listener (when `listen` is set) and one link per connection, in order.
 * `connect(opts)` opens a connection's socket (net.connect) and `createServer` builds the listener
 * (net.createServer); tests inject them. → {attach(binding), stats(), close()}.
 */
export function createNetworkEndpoint({ listen = null, connections = [], connect = net.connect, createServer = net.createServer, ...opts }) {
  const makeLinks = (core) => [
    ...(listen ? [listenerLink({ host: listen.host ?? '127.0.0.1', port: listen.port ?? TCP_DEFAULT_PORT, createServer })(core)] : []),
    ...connections.map((address) => connectionLink({ address, connect })(core)),
  ];
  return createEndpoint({ ...opts, makeLinks });
}

// One install, one endpoint: what production uses.
export function createNetwork({ identity, view, cursors, ...opts }) {
  return createNetworkEndpoint(opts).attach({ identity, view, cursors });
}
