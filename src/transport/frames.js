import { FP_RE, RECORD_MAX_BYTES } from '../records.js';
import { isRoute } from './index.js';

// The TCP wire format (docs/protocol.md → TCP wire format): a 4-byte unsigned big-endian length, then that many
// bytes of UTF-8 JSON, one object with a string field `t`. Every frame is checked against an exact schema for the
// phase it arrives in. Pure: no sockets here.

export const TCP_HELLO_FRAME_MAX = 8 * 1024; // every frame before the session is ready
export const TCP_FRAME_MAX = 1024 * 1024; // every frame after
export const TCP_BATCH_BYTES = 512 * 1024; // record bytes a server packs into one `recs`
export const TCP_MAX_IDENTITIES = 16; // ids in one `prove`; identities on one endpoint
export const TCP_PULL_ROUTES_MAX = 512; // routes in one `pull`
export const TCP_WHOIS_MAX = 64; // fps in one `whois`
export const BYE_REASONS = ['PROOF', 'PROTOCOL', 'DUPLICATE', 'LIMIT', 'STOP'];

// `code` is the `bye` reason the session closes with: LIMIT (a size limit) or PROTOCOL (anything else).
export class FrameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

// Reassembles frames from socket chunks. `next()` yields one parsed JSON object or null (incomplete); it throws
// FrameError LIMIT as soon as a header declares more than the current max, before the body is buffered, so
// `setMax` takes effect from the very next frame. `pending()` is the bytes of an incomplete frame held.
export function createDecoder({ maxFrame }) {
  let max = maxFrame;
  let buf = Buffer.alloc(0);
  return {
    setMax(n) { max = n; },
    pending: () => buf.length,
    push(chunk) { buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk); },
    next() {
      if (buf.length < 4) return null;
      const len = buf.readUInt32BE(0);
      if (len > max) throw new FrameError('LIMIT', `a frame of ${len} bytes exceeds ${max}`);
      if (len === 0) throw new FrameError('PROTOCOL', 'an empty frame');
      if (buf.length < 4 + len) return null;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let obj;
      try { obj = JSON.parse(body.toString('utf8')); } catch { throw new FrameError('PROTOCOL', 'a frame is not JSON'); }
      return obj;
    },
  };
}

// ---- schemas ----

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const NONCE_RE = /^[0-9a-f]{64}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isFp = (v) => typeof v === 'string' && FP_RE.test(v);
const isUint = (v) => Number.isSafeInteger(v) && v >= 0;
const exact = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const bad = (what) => { throw new FrameError('PROTOCOL', what); };

// Canonical base64url → bytes of a length in [min, max], or a PROTOCOL error.
function bytesOf(v, min, max, what) {
  if (typeof v !== 'string' || !B64URL_RE.test(v) || v.length > Math.ceil((max * 4) / 3)) bad(`${what} is not base64url`);
  const b = Buffer.from(v, 'base64url');
  if (b.toString('base64url') !== v) bad(`${what} is not canonical base64url`);
  if (b.length < min || b.length > max) bad(`${what} has ${b.length} bytes`);
  return b;
}
const recordBytes = (v) => bytesOf(v, 1, RECORD_MAX_BYTES, 'a record');

function list(v, min, max, what) {
  if (!Array.isArray(v) || v.length < min || v.length > max) bad(`${what} must be an array of ${min}–${max}`);
  return v;
}

function ids(v) {
  return list(v, 1, TCP_MAX_IDENTITIES, 'ids').map((x) => {
    if (!exact(x, ['key', 'sig'])) bad('an id is not exactly {key, sig}');
    return { key: bytesOf(x.key, 32, 32, 'key'), sig: bytesOf(x.sig, 64, 64, 'sig') };
  });
}

const route = (v) => (isRoute(v) ? v : bad('an invalid route'));
const fromTo = (f) => { if (!isFp(f.from) || !isFp(f.to)) bad('from/to must be fingerprints'); };
const reqId = (f) => { if (!isUint(f.id)) bad('id must be a non-negative integer'); };

// t → [keys, check(frame) → parsed frame]. `prove` differs by who sends it: the dialer names its target.
const SCHEMAS = {
  hello: [['t', 'v', 'nonce'], (f) => (f.v === 1 && typeof f.nonce === 'string' && NONCE_RE.test(f.nonce) ? f : bad('hello needs v 1 and a 64-hex nonce'))],
  'prove-dial': [['t', 'target', 'ids'], (f) => (isFp(f.target) ? { t: f.t, target: f.target, ids: ids(f.ids) } : bad('target must be a fingerprint'))],
  'prove-accept': [['t', 'ids'], (f) => ({ t: f.t, ids: ids(f.ids) })],
  ok: [['t'], (f) => f],
  rec: [['t', 'from', 'to', 'route', 'rec'], (f) => { fromTo(f); return { ...f, route: route(f.route), rec: recordBytes(f.rec) }; }],
  pull: [['t', 'id', 'from', 'to', 'routes'], (f) => {
    fromTo(f); reqId(f);
    const routes = list(f.routes, 1, TCP_PULL_ROUTES_MAX, 'routes').map((r) => {
      if (!exact(r, ['route', 'since']) || !isUint(r.since)) bad('a pulled route is not exactly {route, since}');
      return { route: route(r.route), since: r.since };
    });
    return { ...f, routes };
  }],
  recs: [['t', 'id', 'from', 'to', 'routes'], (f) => {
    fromTo(f); reqId(f);
    const routes = list(f.routes, 1, TCP_PULL_ROUTES_MAX, 'routes').map((r) => {
      // A denial carries nothing but the route: no head, so it says nothing of what the server holds.
      if (exact(r, ['route', 'status']) && r.status === 'denied') return { route: route(r.route), status: 'denied' };
      if (!exact(r, ['route', 'status', 'recs', 'more', 'head']) || r.status !== 'ok') bad('a served route is exactly {route, status:"denied"} or {route, status:"ok", recs, more, head}');
      if (!isUint(r.head) || typeof r.more !== 'boolean' || !Array.isArray(r.recs)) bad('a served route needs recs, more and head');
      const recs = r.recs.map((x) => {
        if (!exact(x, ['seq', 'rec']) || !Number.isSafeInteger(x.seq) || x.seq < 1) bad('a served record is not exactly {seq, rec}');
        return { seq: x.seq, rec: recordBytes(x.rec) };
      });
      return { route: route(r.route), status: r.status, recs, more: r.more, head: r.head };
    });
    return { ...f, routes };
  }],
  whois: [['t', 'id', 'from', 'to', 'fps'], (f) => {
    fromTo(f); reqId(f);
    if (!list(f.fps, 1, TCP_WHOIS_MAX, 'fps').every(isFp)) bad('fps must be fingerprints');
    return f;
  }],
  cards: [['t', 'id', 'from', 'to', 'recs'], (f) => { fromTo(f); reqId(f); return { ...f, recs: list(f.recs, 0, TCP_WHOIS_MAX, 'recs').map(recordBytes) }; }],
  ping: [['t'], (f) => f],
  pong: [['t'], (f) => f],
  bye: [['t', 'reason'], (f) => (BYE_REASONS.includes(f.reason) ? f : bad('unknown bye reason'))],
};

// The frame types each phase accepts. `prove-dial`: the acceptor waits for the dialer's proof; `prove-accept`:
// the dialer waits for the acceptor's.
export const PHASES = {
  hello: ['hello', 'bye'],
  'prove-dial': ['prove', 'bye'],
  'prove-accept': ['prove', 'bye'],
  ok: ['ok', 'bye'],
  ready: ['rec', 'pull', 'recs', 'whois', 'cards', 'ping', 'pong', 'bye'],
};

// Validates a decoded frame against its exact schema for `phase`. Resolves the frame with record, key and sig
// fields decoded to bytes; throws FrameError PROTOCOL for an unknown `t`, a frame the phase does not allow, or
// any schema failure.
export function parseFrame(obj, phase) {
  if (!isObj(obj) || typeof obj.t !== 'string') bad('a frame is not an object with a string t');
  if (!PHASES[phase]?.includes(obj.t)) bad(`a ${obj.t.slice(0, 20)} frame is not allowed in phase ${phase}`);
  const [keys, check] = SCHEMAS[obj.t === 'prove' ? phase : obj.t];
  if (!exact(obj, keys)) bad(`a ${obj.t} frame must have exactly ${keys.join(', ')}`);
  return check(obj);
}

// ---- the hub link (docs/protocol.md → Hub link wire format) ----

export const HUB_CHUNK_BYTES = 64 * 1024; // raw tunneled bytes a client puts in one `data` frame
export const HUB_DATA_MAX = Math.ceil((HUB_CHUNK_BYTES * 4) / 3); // base64url chars of one chunk
export const HUB_WATCH_MAX = 1024; // fps in one `watch` or `present`
export const HUB_FRAME_MAX = 128 * 1024; // every hub-link frame after `ok`: one `data` or a full `watch`
export const HUB_CLOSE_REASONS = ['ABSENT', 'GONE', 'CLOSED', 'LIMIT'];

const isStreamId = (v) => Number.isSafeInteger(v) && v > 0;
const streamId = (f, parity) => {
  if (!isStreamId(f.s) || (parity !== undefined && f.s % 2 !== parity)) bad(`s must be ${parity === 1 ? 'an odd' : parity === 0 ? 'an even' : 'a'} positive integer`);
};
const fpList = (v) => { if (!list(v, 0, HUB_WATCH_MAX, 'fps').every(isFp)) bad('fps must be fingerprints'); return v; };
const closeOf = (reasons) => [['t', 's', 'reason'], (f) => { streamId(f); return reasons.includes(f.reason) ? f : bad('unknown close reason'); }];

const HUB_SCHEMAS = {
  hello: SCHEMAS.hello,
  register: [['t', 'ids'], (f) => ({ t: f.t, ids: ids(f.ids) })],
  ok: SCHEMAS.ok,
  open: [['t', 's', 'to'], (f) => { streamId(f, 1); return isFp(f.to) ? f : bad('to must be a fingerprint'); }],
  incoming: [['t', 's'], (f) => { streamId(f, 0); return f; }],
  data: [['t', 's', 'b'], (f) => {
    streamId(f);
    if (typeof f.b !== 'string' || f.b.length < 1 || f.b.length > HUB_DATA_MAX || !B64URL_RE.test(f.b)) bad(`b must be 1–${HUB_DATA_MAX} base64url characters`);
    return f;
  }],
  watch: [['t', 'id', 'fps'], (f) => { if (!isUint(f.id)) bad('id must be a non-negative integer'); fpList(f.fps); return f; }],
  present: [['t', 'id', 'fps'], (f) => { if (!isUint(f.id)) bad('id must be a non-negative integer'); fpList(f.fps); return f; }],
  presence: [['t', 'fp', 'online'], (f) => (isFp(f.fp) && typeof f.online === 'boolean' ? f : bad('presence needs a fingerprint and a boolean online'))],
  ping: SCHEMAS.ping,
  pong: SCHEMAS.pong,
  bye: SCHEMAS.bye,
};

// role → phase → the frame types that side accepts. The hub waits for `register` after `hello`, the client for
// `ok`; a frame meant for the other direction is refused like an unknown one.
export const HUB_PHASES = {
  hub: {
    hello: ['hello', 'bye'],
    register: ['register', 'bye'],
    ready: ['open', 'data', 'close', 'watch', 'ping', 'pong', 'bye'],
  },
  client: {
    hello: ['hello', 'bye'],
    ok: ['ok', 'bye'],
    ready: ['incoming', 'data', 'close', 'present', 'presence', 'ping', 'pong', 'bye'],
  },
};

// A client closes a stream it is done with (CLOSED) or cannot buffer (LIMIT); ABSENT and GONE are the hub's word.
const CLOSE_BY = { hub: closeOf(['CLOSED', 'LIMIT']), client: closeOf(HUB_CLOSE_REASONS) };

// Validates a decoded hub-link frame received by `role` ('hub' | 'client') in `phase`, against its exact schema.
// Resolves the frame (`register` ids decoded to bytes); throws FrameError PROTOCOL otherwise.
export function parseHubFrame(obj, role, phase) {
  if (!isObj(obj) || typeof obj.t !== 'string') bad('a frame is not an object with a string t');
  if (!HUB_PHASES[role]?.[phase]?.includes(obj.t)) bad(`a ${obj.t.slice(0, 20)} frame is not allowed for the ${role} in phase ${phase}`);
  const [keys, check] = obj.t === 'close' ? CLOSE_BY[role] : HUB_SCHEMAS[obj.t];
  if (!exact(obj, keys)) bad(`a ${obj.t} frame must have exactly ${keys.join(', ')}`);
  return check(obj);
}
