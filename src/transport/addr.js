import dns from 'node:dns/promises';
import net from 'node:net';

// Host and `scheme://host:port` address rules shared by the TCP transport, the hub client and the hub. Pure, apart
// from `lookupAll` (DNS).

export const TCP_LOOKUP_MS = 5000; // a host's DNS lookup when transport settings are checked

export const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const isHost = (h) => typeof h === 'string' && (net.isIP(h) !== 0 || HOSTNAME_RE.test(h));

// The unspecified addresses, compared as parsed addresses: `::0`, `0:0:0:0:0:0:0:0` and `::ffff:0.0.0.0` are `::`
// or `0.0.0.0` too.
const UNSPECIFIED = new net.BlockList();
UNSPECIFIED.addAddress('0.0.0.0', 'ipv4');
UNSPECIFIED.addAddress('::', 'ipv6');

// Whether `host` is an IP literal for "every interface" (listening on it is not one address peers can dial).
export function isWildcardHost(host) {
  const family = net.isIP(host);
  return family !== 0 && UNSPECIFIED.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

export const formatAddr = (scheme, host, port) => `${scheme}://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;

// {host, port} of a `<scheme>://host:port` address (host unbracketed; port 1–65535), or null.
export function parseAddr(scheme, s) {
  const m = typeof s === 'string' ? /^([a-z]+):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(s) : null;
  if (!m || m[1] !== scheme) return null;
  const bracketed = m[2].startsWith('[');
  const host = bracketed ? m[2].slice(1, -1) : m[2];
  const port = Number(m[3]);
  if (bracketed ? !net.isIPv6(host) : !(net.isIPv4(host) || HOSTNAME_RE.test(host))) return null;
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

const defaultLookup = (name) => dns.lookup(name, { all: true });

// Every address `name` resolves to ([{address, family}]), racing the lookup against `lookupMs`. Rejects with the
// lookup's own error, or with an error whose `timedOut` is true. `lookup(name)` is dns.lookup with {all: true}
// unless injected (tests).
export async function lookupAll(name, { lookup = defaultLookup, lookupMs = TCP_LOOKUP_MS } = {}) {
  let cancel;
  try {
    return await Promise.race([
      lookup(name),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(Object.assign(new Error(`no answer within ${lookupMs} ms`), { timedOut: true })), lookupMs);
        t.unref?.();
        cancel = () => clearTimeout(t);
      }),
    ]);
  } finally {
    cancel?.();
  }
}
