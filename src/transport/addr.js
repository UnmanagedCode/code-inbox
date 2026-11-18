import dns from 'node:dns/promises';
import net from 'node:net';

// Host and `host:port` address rules shared by the network endpoint and the hub. Pure, apart from `lookupAll` (DNS).

export const TCP_LOOKUP_MS = 5000; // a host's DNS lookup when network settings are checked
export const ADDRESS_MAX_CHARS = 256; // one configured connection address

export const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const isHost = (h) => typeof h === 'string' && (net.isIP(h) !== 0 || HOSTNAME_RE.test(h));

// The unspecified addresses, compared as parsed addresses: `::0`, `0:0:0:0:0:0:0:0` and `::ffff:0.0.0.0` are `::`
// or `0.0.0.0` too.
const UNSPECIFIED = new net.BlockList();
UNSPECIFIED.addAddress('0.0.0.0', 'ipv4');
UNSPECIFIED.addAddress('::', 'ipv6');

// Whether `host` is an IP literal for "every interface" (a listener may bind it; nothing can dial it).
export function isWildcardHost(host) {
  const family = net.isIP(host);
  return family !== 0 && UNSPECIFIED.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

// The one address form: `host:port`, an IPv6 host bracketed. Hosts are lowercased, so one address has one spelling.
export const formatHostPort = (host, port) => `${net.isIPv6(host) ? `[${host.toLowerCase()}]` : host.toLowerCase()}:${port}`;

// {host, port} of a `host:port` address (host unbracketed; port 1–65535), or null.
export function parseHostPort(s) {
  const m = typeof s === 'string' ? /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(s) : null;
  if (!m) return null;
  const bracketed = m[1].startsWith('[');
  const host = bracketed ? m[1].slice(1, -1) : m[1];
  const port = Number(m[2]);
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
