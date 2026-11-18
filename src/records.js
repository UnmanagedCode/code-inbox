import crypto from 'node:crypto';
import { CodedError } from './errors.js';
import { fingerprint, verifySignature } from './identity.js';

// The wire format: the only module that knows how a record is laid out, signed and validated
// (docs/protocol.md → Records). Everything here is pure.

export const RECORD_MAX_BYTES = 32 * 1024;
// An announce's whole record: it is held in memory per identity and broadcast by hubs.
export const ANNOUNCE_MAX_BYTES = 1024;
export const BODY_MAX_BYTES = 16 * 1024;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const FP_RE = /^[0-9a-f]{64}$/;
// Record ids, inbox ids and nonces.
export const ID_RE = /^[0-9a-f]{32}$/;
// The largest ts a JavaScript Date can represent: a later one could not be displayed.
export const TS_MAX = 8_640_000_000_000_000;

const DOMAIN = Buffer.from('code-inbox/v1\0', 'utf8');
const ENVELOPE_KEYS = ['v', 'key', 'payload', 'sig'];
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

export const recordId = (payloadBytes) => sha256hex(payloadBytes).slice(0, 32);
export const personalInboxId = (inviterFp, inviteeFp, nonce) => sha256hex(`code-inbox/personal\0${inviterFp}\0${inviteeFp}\0${nonce}`).slice(0, 32);
export const sharedInboxId = (ownerFp, nonce) => sha256hex(`code-inbox/shared\0${ownerFp}\0${nonce}`).slice(0, 32);
export const newNonce = () => crypto.randomBytes(16).toString('hex');

// ---- routes: where a record travels (Route helpers: src/transport/index.js) ----

const DIRECTORY_TYPES = new Set(['announce', 'inbox-create']);
const MAILBOX_TYPES = new Set(['invite', 'invite-response', 'join-request', 'join-response', 'inbox-leave']);

// The route a payload must travel on: the binding the engine checks for every incoming record. A shared delete is
// public on the directory; a personal one goes to the other party's mailbox.
export function routeFor(payload) {
  if (DIRECTORY_TYPES.has(payload.type)) return { kind: 'directory' };
  if (payload.type === 'inbox-delete') return payload.kind === 'shared' ? { kind: 'directory' } : { kind: 'mailbox', fp: payload.to };
  if (MAILBOX_TYPES.has(payload.type)) return { kind: 'mailbox', fp: payload.to };
  return { kind: 'inbox', id: payload.inbox };
}

// ---- payload schema ----

const str = (re) => (v) => typeof v === 'string' && re.test(v);
const isFp = str(FP_RE);
const isId = str(ID_RE);
const isBool = (v) => typeof v === 'boolean';
const isInt = (min) => (v) => Number.isSafeInteger(v) && v >= min;
const oneOf = (...xs) => (v) => xs.includes(v);
const isIdOrNull = (v) => v === null || isId(v);
const isBody = (v) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= BODY_MAX_BYTES;
const isTs = (v) => isInt(0)(v) && v <= TS_MAX;
const NAME = Symbol('name');

// Per type: field → check (`NAME` marks a name, refused as BAD_NAME); `optional` lists fields that may be absent.
const SCHEMA = {
  // Who an identity is, never where: routes are the user's connections (docs/transport.md).
  announce: { fields: { name: NAME } },
  'inbox-create': { fields: { inbox: isId, nonce: isId, name: NAME } },
  invite: { fields: { to: isFp, kind: oneOf('personal', 'shared'), inbox: isId, nonce: isId } },
  'invite-response': { fields: { to: isFp, invite: isId, inbox: isId, accept: isBool } },
  'join-request': { fields: { to: isFp, inbox: isId } },
  'join-response': { fields: { to: isFp, request: isId, inbox: isId, accept: (v) => v === false } },
  // A remove carries keepHead: the last of the member's messages the owner accepted (null: none). docs/protocol.md → Removal.
  member: { fields: { inbox: isId, seq: isInt(1), op: oneOf('add', 'remove'), member: isFp, keepHead: isIdOrNull }, optional: ['keepHead'] },
  // A shared-inbox message carries epoch and prev (the same sender's previous message there, null for its first).
  msg: { fields: { inbox: isId, body: isBody, epoch: isInt(0), prev: isIdOrNull }, optional: ['epoch', 'prev'] },
  // Closes an inbox (docs/protocol.md → Closing an inbox): the owner's shared Delete, or either party's personal Revoke,
  // which names the other party (`to`) and the personal invite's record id (`invite`).
  'inbox-delete': { fields: { kind: oneOf('personal', 'shared'), inbox: isId, nonce: isId, to: isFp, invite: isId }, optional: ['to', 'invite'] },
  // A member leaving a shared inbox, to its owner; `epoch` is the leaver's current epoch.
  'inbox-leave': { fields: { to: isFp, inbox: isId, epoch: isInt(0) } },
};
export const RECORD_TYPES = Object.keys(SCHEMA);

const bad = (reason, detail) => ({ ok: false, reason, detail });

// Validates a parsed payload against its type's schema and the self-certifying rules that need no other record.
// Resolves {ok:true} or {ok:false, reason, detail}.
export function checkPayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return bad('BAD_PAYLOAD', 'payload is not an object');
  const spec = typeof p.type === 'string' && Object.hasOwn(SCHEMA, p.type) ? SCHEMA[p.type] : null;
  if (!spec) return bad('BAD_PAYLOAD', `unknown type ${JSON.stringify(p.type)?.slice(0, 40)}`);
  if (!isFp(p.signer)) return bad('BAD_PAYLOAD', 'signer is not a fingerprint');
  if (!isTs(p.ts)) return bad('BAD_PAYLOAD', 'ts is not an integer from 0 to TS_MAX');
  const allowed = new Set(['type', 'signer', 'ts', ...Object.keys(spec.fields)]);
  for (const k of Object.keys(p)) if (!allowed.has(k)) return bad('BAD_PAYLOAD', `unexpected field ${JSON.stringify(k).slice(0, 40)}`);
  for (const [k, check] of Object.entries(spec.fields)) {
    if (!(k in p)) {
      if (spec.optional?.includes(k)) continue;
      return bad('BAD_PAYLOAD', `${p.type} lacks ${k}`);
    }
    if (check === NAME) {
      if (!str(NAME_RE)(p[k])) return bad('BAD_NAME', `${k} does not match NAME_RE`);
    } else if (!check(p[k])) {
      return bad('BAD_PAYLOAD', `${p.type}.${k} is invalid`);
    }
  }
  if ('to' in p && p.to === p.signer) return bad('SELF_ADDRESSED', `${p.type} is addressed to its own signer`);
  if (p.type === 'member' && (p.op === 'remove') !== ('keepHead' in p)) return bad('BAD_PAYLOAD', 'keepHead belongs to a remove, and every remove has one');
  if (p.type === 'msg' && ('epoch' in p) !== ('prev' in p)) return bad('BAD_PAYLOAD', 'a shared message carries both epoch and prev; a personal one neither');
  if (p.type === 'inbox-create' && sharedInboxId(p.signer, p.nonce) !== p.inbox) return bad('INBOX_ID_MISMATCH', 'shared inbox id does not recompute');
  if (p.type === 'inbox-delete') {
    const personal = p.kind === 'personal';
    if (('to' in p) !== personal || ('invite' in p) !== personal) return bad('BAD_PAYLOAD', 'to and invite belong to a personal inbox-delete, and every personal one has both');
    const ok = personal ? personalInboxId(p.signer, p.to, p.nonce) === p.inbox || personalInboxId(p.to, p.signer, p.nonce) === p.inbox : sharedInboxId(p.signer, p.nonce) === p.inbox;
    if (!ok) return bad('INBOX_ID_MISMATCH', `${p.kind} inbox id does not recompute from the signer`);
  }
  if (p.type === 'invite') {
    const expected = p.kind === 'personal' ? personalInboxId(p.signer, p.to, p.nonce) : sharedInboxId(p.signer, p.nonce);
    if (expected !== p.inbox) return bad('INBOX_ID_MISMATCH', `${p.kind} inbox id does not recompute`);
  }
  return { ok: true };
}

// ---- envelope ----

function b64urlBytes(s) {
  if (typeof s !== 'string' || !B64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  return buf.toString('base64url') === s ? buf : null;
}

const signedBytes = (payloadBytes) => Buffer.concat([DOMAIN, payloadBytes]);

// Signs `payload` (validated first: an invalid one is a programming error and throws) as `identity`.
// Resolves {bytes, id, payload}: `bytes` is exactly what is stored and sent. A record over RECORD_MAX_BYTES, which
// every reader would reject, is refused RECORD_TOO_LARGE before it is signed into existence.
export function encodeRecord(identity, payload) {
  const check = checkPayload(payload);
  if (!check.ok) throw new Error(`cannot encode an invalid ${payload?.type} record: ${check.reason} (${check.detail})`);
  if (payload.signer !== identity.fp) throw new Error('the payload signer is not this identity');
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const envelope = {
    v: 1,
    key: identity.publicRaw.toString('base64url'),
    payload: payloadBytes.toString('base64url'),
    sig: identity.sign(signedBytes(payloadBytes)).toString('base64url'),
  };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  const max = payload.type === 'announce' ? ANNOUNCE_MAX_BYTES : RECORD_MAX_BYTES;
  if (bytes.length > max) throw new CodedError('RECORD_TOO_LARGE', `the ${payload.type} record would be ${bytes.length} bytes; readers accept at most ${max}`);
  return { bytes, id: recordId(payloadBytes), payload };
}

// Verifies stored bytes, in order: size cap, strict envelope shape, Ed25519 signature, fingerprint(key) === signer,
// payload schema. Resolves {ok:true, id, payload} or {ok:false, reason, detail}. `BAD_JSON` alone may be a file
// still being written; every other reason is final. Total: any bytes give a verdict, never an exception.
export function decodeRecord(bytes) {
  try {
    return decodeUnsafe(bytes);
  } catch (err) {
    return bad('BAD_PAYLOAD', `the record could not be decoded: ${String(err?.message ?? err).slice(0, 80)}`);
  }
}

function decodeUnsafe(bytes) {
  if (bytes.length > RECORD_MAX_BYTES) return bad('TOO_LARGE', `${bytes.length} bytes`);
  const text = Buffer.from(bytes).toString('utf8');
  let env;
  try { env = JSON.parse(text); } catch { return bad('BAD_JSON', 'the envelope does not parse'); }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return bad('BAD_ENVELOPE', 'the envelope is not an object');
  const keys = Object.keys(env);
  if (keys.length !== ENVELOPE_KEYS.length || !ENVELOPE_KEYS.every((k, i) => keys[i] === k)) return bad('BAD_ENVELOPE', 'the envelope keys are not exactly v, key, payload, sig');
  if (env.v !== 1) return bad('BAD_ENVELOPE', 'unknown envelope version');
  const key = b64urlBytes(env.key);
  const payloadBytes = b64urlBytes(env.payload);
  const sig = b64urlBytes(env.sig);
  if (!key || key.length !== 32) return bad('BAD_ENVELOPE', 'key is not a 32-byte base64url value');
  if (!payloadBytes) return bad('BAD_ENVELOPE', 'payload is not base64url');
  if (!sig || sig.length !== 64) return bad('BAD_ENVELOPE', 'sig is not a 64-byte base64url value');
  if (JSON.stringify(env) !== text) return bad('BAD_ENVELOPE', 'the envelope is not in its canonical form');
  if (!verifySignature(key, signedBytes(payloadBytes), sig)) return bad('BAD_SIGNATURE', 'the signature does not verify');
  const payloadText = payloadBytes.toString('utf8');
  if (!Buffer.from(payloadText, 'utf8').equals(payloadBytes)) return bad('BAD_PAYLOAD', 'payload is not UTF-8');
  let payload;
  try { payload = JSON.parse(payloadText); } catch { return bad('BAD_PAYLOAD', 'payload is not JSON'); }
  if (payload && typeof payload === 'object' && payload.signer !== fingerprint(key)) return bad('SIGNER_MISMATCH', 'signer is not the fingerprint of key');
  const check = checkPayload(payload);
  if (!check.ok) return check;
  if (payload.type === 'announce' && bytes.length > ANNOUNCE_MAX_BYTES) return bad('TOO_LARGE', `an announce of ${bytes.length} bytes`);
  return { ok: true, id: recordId(payloadBytes), payload };
}

// ---- contact cards ----

// A contact card is a signed announce, pasted between humans: CARD_PREFIX + base64url(record bytes).
export const CARD_PREFIX = 'code-inbox-card:v2:';

export const encodeCard = (bytes) => `${CARD_PREFIX}${Buffer.from(bytes).toString('base64url')}`;

// The record bytes a card carries, or null: the trimmed text must be CARD_PREFIX + canonical base64url of at most
// RECORD_MAX_BYTES. The bytes still go through decodeRecord.
export function decodeCard(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith(CARD_PREFIX)) return null;
  const body = t.slice(CARD_PREFIX.length);
  if (!body || body.length > Math.ceil((RECORD_MAX_BYTES * 4) / 3)) return null;
  const bytes = b64urlBytes(body);
  return bytes && bytes.length <= RECORD_MAX_BYTES ? bytes : null;
}
