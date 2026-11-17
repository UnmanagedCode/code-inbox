import net from 'node:net';
import { CodedError } from '../errors.js';
import { decodeRecord } from '../records.js';
import { TCP_LOOKUP_MS, formatAddr, isHost, isWildcardHost, lookupAll, parseAddr } from './addr.js';
import {
  TCP_MAX_CONNECTIONS, TCP_MAX_HANDSHAKING, TCP_REDIAL_MAX_MS, TCP_REDIAL_MIN_MS, TCP_SYNC_MS, createEndpoint,
} from './endpoint.js';
import { TCP_WHOIS_MAX } from './frames.js';

// The direct TCP transport (docs/transport.md → Direct TCP): the endpoint core (endpoint.js) with a TCP link, a
// listener plus per-address dials. Contacts without an address are found by whois hints from connected peers.

export { TCP_LOOKUP_MS, isWildcardHost, TCP_SYNC_MS, TCP_MAX_CONNECTIONS, TCP_MAX_HANDSHAKING, TCP_REDIAL_MIN_MS, TCP_REDIAL_MAX_MS };
export const TCP_DEFAULT_PORT = 47821;

// ---- addresses and config ----

export const formatTcpAddr = (host, port) => formatAddr('tcp', host, port);

// {host, port} of a `tcp://host:port` address (host unbracketed), or null.
export const parseTcpAddr = (s) => parseAddr('tcp', s);

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

// validateTcpConfig, then the wildcard rule on what a non-literal host and advertised host resolve to: a name such as
// `0`, `00.0.0.0` or `0x0.0.0.0` passes as a hostname but resolves to 0.0.0.0. A host that does not resolve is
// refused; an advertised host that does not resolve here is allowed (peers may resolve it where this install cannot).
// A lookup slower than `lookupMs` (TCP_LOOKUP_MS) is refused, for either name. Refuses TCP_INVALID; resolves the
// normalized config. `lookup(name)` → [{address, family}] is dns.lookup with {all: true} unless injected (tests).
export async function resolveTcpConfig(input, { lookup, lookupMs = TCP_LOOKUP_MS } = {}) {
  const cfg = validateTcpConfig(input);
  const refuse = (why) => { throw new CodedError('TCP_INVALID', why); };
  const resolved = async (name, what, mustResolve) => {
    if (net.isIP(name) !== 0) return;
    let addrs;
    try {
      addrs = await lookupAll(name, { lookup, lookupMs });
    } catch (err) {
      if (err.timedOut) refuse(`${what} ${name}: the lookup timed out (${err.message})`);
      if (mustResolve) refuse(`${what} ${name} does not resolve (${err.code ?? err.message})`);
      return;
    }
    const wild = addrs.find((a) => isWildcardHost(a.address));
    if (wild) refuse(`${what} ${name} resolves to ${wild.address}, every interface: name an address`);
  };
  await resolved(cfg.host, 'host', true);
  await resolved(cfg.advertise, 'advertised host', false);
  return cfg;
}

// ---- the TCP link ----

// A listener and per-address dials. `createServer` builds the listener (net.createServer); tests inject one.
function tcpLink({ host, port, advertise, createServer }) {
  return (core) => {
    const { lim, now, log } = core;
    const dialing = new Map(); // addr → promise
    const backoff = new Map(); // addr → {failures, nextAt}
    const hints = new Map(); // fp → [tcp addr] from verified whois replies: dial hints only
    let server = null;
    let listening = null;
    let boundPort = null;

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
      const srv = createServer((socket) => { core.accept(socket); });
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

    const addrsFor = (b, fp) => [...new Set([...b.view.addrsOf(fp), ...(hints.get(fp) ?? [])])].filter((a) => parseTcpAddr(a));

    function dialAddr(addr, target) {
      const inflight = dialing.get(addr);
      if (inflight) return inflight;
      const bo = backoff.get(addr);
      if (bo && now() < bo.nextAt) return Promise.resolve();
      if (!core.canDial()) return Promise.resolve();
      const { host: h, port: p } = parseTcpAddr(addr);
      const s = core.dial(net.connect({ host: h, port: p }), target);
      const done = s.established.then((ok) => {
        if (ok) { backoff.delete(addr); return; }
        const failures = (backoff.get(addr)?.failures ?? 0) + 1;
        backoff.set(addr, { failures, nextAt: now() + Math.min(lim.redialMinMs * 2 ** (failures - 1), lim.redialMaxMs) });
      }).finally(() => dialing.delete(addr));
      dialing.set(addr, done);
      return done;
    }

    // Dial hints: an announce of a contact fetched from a connected peer, used only for its tcp:// addresses and
    // only if it verifies and is signed by the fingerprint asked about. Never ingested.
    async function whois(b, fps) {
      const asked = fps.slice(0, TCP_WHOIS_MAX);
      await Promise.allSettled(core.readySessions().map(async (s) => {
        const resp = await s.request({ t: 'whois', from: b.fp, to: s.remote[0], fps: asked });
        for (const bytes of resp.recs) {
          const d = decodeRecord(bytes);
          if (!d.ok || d.payload.type !== 'announce' || !asked.includes(d.payload.signer)) continue;
          hints.set(d.payload.signer, d.payload.addr.filter((a) => parseTcpAddr(a)));
        }
      }));
    }

    return {
      addresses: () => (boundPort === null ? [] : [formatTcpAddr(advertise, boundPort)]),
      open: listen,
      identitiesChanged() {},
      // Closes the listener synchronously, so the port is free at once.
      shutdown() {
        if (server) server.close();
        server = null;
        listening = null;
        boundPort = null;
      },
      async discover(b, missing) {
        const unknown = missing.filter((fp) => addrsFor(b, fp).length === 0);
        if (unknown.length) await whois(b, unknown);
      },
      async dial(b, fp) {
        for (const addr of addrsFor(b, fp)) {
          if (core.hasSession(fp) || core.isLocal(fp) || !core.fps().length) return;
          await dialAddr(addr, fp);
        }
      },
      stats: () => ({ listening: server && boundPort !== null ? { host, port: boundPort } : null }),
    };
  };
}

/**
 * One listener and its pool. `attach(binding)` → a Transport for one identity:
 * binding = {identity: proofSigner(...), view, cursors: {load(), save(obj)}}.
 */
// `createServer` builds the listener (net.createServer); tests inject one to reach the server object.
export function createTcpEndpoint({ host = '127.0.0.1', port = TCP_DEFAULT_PORT, advertise = host, createServer = net.createServer, ...opts }) {
  return createEndpoint({ ...opts, makeLink: tcpLink({ host, port, advertise, createServer }) });
}

// One install, one endpoint: what production uses.
export function createTcp({ identity, view, cursors, ...opts }) {
  return createTcpEndpoint(opts).attach({ identity, view, cursors });
}
