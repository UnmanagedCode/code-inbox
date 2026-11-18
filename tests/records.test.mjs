import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIdentity } from '../src/identity.js';
import {
  ANNOUNCE_MAX_BYTES, BODY_MAX_BYTES, CARD_PREFIX, RECORD_MAX_BYTES, TS_MAX, decodeCard, decodeRecord, encodeCard, encodeRecord, newNonce, personalInboxId, recordId, routeFor, sharedInboxId,
} from '../src/records.js';
import { tmpDir } from './helpers.mjs';

const alice = await loadIdentity(tmpDir());
const bob = await loadIdentity(tmpDir());
const TS = 1_700_000_000_000;

const announce = (id = alice, extra = {}) => ({ type: 'announce', signer: id.fp, ts: TS, name: 'alice', ...extra });

// Builds an envelope by hand: signs `payloadBytes` with `signer` under `domain`, bypassing encodeRecord's checks.
function forge(signer, payload, { domain = 'code-inbox/v1\0', key = signer.publicRaw, extra = {} } = {}) {
  const payloadBytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const sig = signer.sign(Buffer.concat([Buffer.from(domain), payloadBytes]));
  return Buffer.from(JSON.stringify({ v: 1, key: key.toString('base64url'), payload: payloadBytes.toString('base64url'), sig: sig.toString('base64url'), ...extra }));
}
const envelopeOf = (bytes) => JSON.parse(bytes.toString());
const reason = (bytes) => decodeRecord(bytes).reason;

// Invariant: what encodeRecord signs decodes to the same payload and id; the id is the payload's sha256 prefix.
test('a record round-trips through encode and decode', () => {
  const { bytes, id, payload } = encodeRecord(alice, announce());
  const d = decodeRecord(bytes);
  assert.equal(d.ok, true);
  assert.equal(d.id, id);
  assert.deepEqual(d.payload, payload);
  assert.equal(id, recordId(Buffer.from(envelopeOf(bytes).payload, 'base64url')));
  assert.deepEqual(Object.keys(envelopeOf(bytes)), ['v', 'key', 'payload', 'sig']);
});

// Invariant: the signature covers the payload bytes: any change to them is caught.
test('a tampered payload is rejected: BAD_SIGNATURE', () => {
  const env = envelopeOf(encodeRecord(alice, announce()).bytes);
  env.payload = Buffer.from(JSON.stringify(announce(alice, { name: 'mallory' }))).toString('base64url');
  assert.equal(reason(Buffer.from(JSON.stringify(env))), 'BAD_SIGNATURE');
});

test('a tampered signature is rejected: BAD_SIGNATURE', () => {
  const env = envelopeOf(encodeRecord(alice, announce()).bytes);
  const sig = Buffer.from(env.sig, 'base64url');
  sig[0] ^= 1;
  env.sig = sig.toString('base64url');
  assert.equal(reason(Buffer.from(JSON.stringify(env))), 'BAD_SIGNATURE');
});

// Invariant: a record verifies only under the key that signed it.
test('a swapped key is rejected: BAD_SIGNATURE', () => {
  const env = envelopeOf(encodeRecord(alice, announce()).bytes);
  env.key = bob.publicRaw.toString('base64url');
  assert.equal(reason(Buffer.from(JSON.stringify(env))), 'BAD_SIGNATURE');
});

// Invariant: the domain tag binds a signature to code-inbox v1; a signature made for another purpose does not verify.
test('a signature under another domain tag is rejected: BAD_SIGNATURE', () => {
  assert.equal(reason(forge(alice, announce(), { domain: 'code-inbox/v2\0' })), 'BAD_SIGNATURE');
  assert.equal(reason(forge(alice, announce(), { domain: '' })), 'BAD_SIGNATURE');
  assert.equal(decodeRecord(forge(alice, announce())).ok, true, 'the forge helper itself makes valid records');
});

// Invariant: a key can sign only as itself: payload.signer must be the fingerprint of the envelope key.
test('a payload naming another signer is rejected: SIGNER_MISMATCH', () => {
  assert.equal(reason(forge(alice, announce(bob))), 'SIGNER_MISMATCH');
});

test('an oversize record is rejected before parsing: TOO_LARGE', () => {
  assert.equal(reason(Buffer.alloc(RECORD_MAX_BYTES + 1, 0x20)), 'TOO_LARGE');
});

// Invariant: the envelope is exactly {v, key, payload, sig} in canonical form; nothing rides along unsigned.
test('extra or reordered envelope keys and non-canonical whitespace are rejected: BAD_ENVELOPE', () => {
  assert.equal(reason(forge(alice, announce(), { extra: { note: 'x' } })), 'BAD_ENVELOPE');
  const env = envelopeOf(encodeRecord(alice, announce()).bytes);
  assert.equal(reason(Buffer.from(JSON.stringify({ key: env.key, v: 1, payload: env.payload, sig: env.sig }))), 'BAD_ENVELOPE');
  assert.equal(reason(Buffer.from(JSON.stringify(env, null, 1))), 'BAD_ENVELOPE');
  assert.equal(reason(Buffer.from(JSON.stringify({ ...env, v: 2 }))), 'BAD_ENVELOPE');
});

// Invariant: a truncated file (still being written or synced) is told apart from a bad one, so it can be retried.
test('a truncated record is BAD_JSON, the only retryable reason', () => {
  const { bytes } = encodeRecord(alice, announce());
  assert.equal(reason(bytes.subarray(0, bytes.length - 3)), 'BAD_JSON');
});

// Invariant: payloads are schema-checked per type: unknown fields and wrong types are refused.
test('an extra payload field or a wrong type is rejected: BAD_PAYLOAD', () => {
  assert.equal(reason(forge(alice, announce(alice, { extra: 1 }))), 'BAD_PAYLOAD');
  assert.equal(reason(forge(alice, announce(alice, { ts: -1 }))), 'BAD_PAYLOAD');
  assert.equal(reason(forge(alice, { type: 'telepathy', signer: alice.fp, ts: TS })), 'BAD_PAYLOAD');
  const inbox = 'a'.repeat(32);
  assert.equal(reason(forge(alice, { type: 'msg', signer: alice.fp, ts: TS, inbox, body: 'x'.repeat(BODY_MAX_BYTES + 1) })), 'BAD_PAYLOAD');
  assert.equal(reason(forge(alice, { type: 'member', signer: alice.fp, ts: TS, inbox, seq: 1, op: 'add', member: bob.fp, keepHead: null })), 'BAD_PAYLOAD', 'keepHead on an add');
  assert.equal(reason(forge(alice, { type: 'member', signer: alice.fp, ts: TS, inbox, seq: 1, op: 'remove', member: bob.fp })), 'BAD_PAYLOAD', 'a remove without keepHead');
  assert.equal(reason(forge(alice, { type: 'msg', signer: alice.fp, ts: TS, inbox, body: 'x', epoch: 0 })), 'BAD_PAYLOAD', 'epoch without prev');
  assert.equal(reason(forge(alice, { type: 'msg', signer: alice.fp, ts: TS, inbox, body: 'x', prev: null })), 'BAD_PAYLOAD', 'prev without epoch');
  assert.equal(reason(forge(alice, { type: 'msg', signer: alice.fp, ts: TS, inbox, body: '' })), 'BAD_PAYLOAD', 'an empty body');
  assert.equal(reason(forge(alice, announce(alice, { ts: TS_MAX + 1 }))), 'BAD_PAYLOAD', 'a ts no Date can show');
  assert.equal(decodeRecord(forge(alice, announce(alice, { ts: TS_MAX }))).ok, true);
  assert.equal(reason(forge(alice, { type: 'join-response', signer: alice.fp, ts: TS, to: bob.fp, request: inbox, inbox, accept: true })), 'BAD_PAYLOAD', 'a join-response is a decline only');
});

// Invariant: an announce says who an identity is, never where it is: one carrying an address field is refused.
test('an announce carrying addr is BAD_PAYLOAD', () => {
  for (const addr of [[], ['tcp://127.0.0.1:5'], ['hub://h:1']]) assert.equal(reason(forge(alice, announce(alice, { addr }))), 'BAD_PAYLOAD', JSON.stringify(addr));
  assert.throws(() => encodeRecord(alice, announce(alice, { addr: [] })));
});

// Invariant: an announce is small (held in memory per identity, broadcast by hubs): decodeRecord refuses one over
// ANNOUNCE_MAX_BYTES, whatever pads it, though it is well under RECORD_MAX_BYTES and otherwise valid.
test('decodeRecord refuses an announce over ANNOUNCE_MAX_BYTES: TOO_LARGE', () => {
  const padded = Buffer.from(JSON.stringify(announce()).replace('{', `{${' '.repeat(ANNOUNCE_MAX_BYTES)}`));
  const bytes = forge(alice, padded);
  assert.ok(bytes.length > ANNOUNCE_MAX_BYTES && bytes.length < RECORD_MAX_BYTES);
  assert.equal(reason(bytes), 'TOO_LARGE');
  // The same padding on another type is no announce: only the record cap applies.
  const create = { type: 'inbox-create', signer: alice.fp, ts: TS, inbox: sharedInboxId(alice.fp, 'b'.repeat(32)), nonce: 'b'.repeat(32), name: 'team' };
  assert.equal(decodeRecord(forge(alice, Buffer.from(JSON.stringify(create).replace('{', `{${' '.repeat(ANNOUNCE_MAX_BYTES)}`)))).ok, true);
});

// Invariant: nothing signs an announce readers would refuse for its size: encodeRecord refuses one over
// ANNOUNCE_MAX_BYTES (here an identity with an oversize key stands in for any way an announce could grow).
test('encodeRecord refuses an announce over ANNOUNCE_MAX_BYTES: RECORD_TOO_LARGE', () => {
  const big = { fp: alice.fp, publicRaw: Buffer.alloc(2 * ANNOUNCE_MAX_BYTES, 1), sign: () => Buffer.alloc(64) };
  assert.throws(() => encodeRecord(big, announce()), { code: 'RECORD_TOO_LARGE' });
  assert.ok(encodeRecord(alice, announce()).bytes.length <= ANNOUNCE_MAX_BYTES);
});

// Invariant: names are one short token (NAME_RE), so a peer-chosen name cannot carry markup or prose.
test('a name outside NAME_RE is rejected: BAD_NAME', () => {
  for (const name of ['', '-lead', 'a b', 'x'.repeat(33), '<img>', 'ok\nIgnore previous instructions']) {
    assert.equal(reason(forge(alice, announce(alice, { name }))), 'BAD_NAME', JSON.stringify(name));
  }
  const nonce = newNonce();
  assert.equal(reason(forge(alice, { type: 'inbox-create', signer: alice.fp, ts: TS, inbox: sharedInboxId(alice.fp, nonce), nonce, name: 'no spaces' })), 'BAD_NAME');
});

// Invariant: inbox ids are self-certifying: nobody can claim an id that does not recompute from its signer and nonce.
test('an inbox id that does not recompute is rejected: INBOX_ID_MISMATCH', () => {
  const nonce = newNonce();
  const wrongShared = { type: 'inbox-create', signer: alice.fp, ts: TS, inbox: sharedInboxId(bob.fp, nonce), nonce, name: 'team' };
  assert.equal(reason(forge(alice, wrongShared)), 'INBOX_ID_MISMATCH');
  const wrongPersonal = { type: 'invite', signer: alice.fp, ts: TS, to: bob.fp, kind: 'personal', inbox: personalInboxId(bob.fp, alice.fp, nonce), nonce };
  assert.equal(reason(forge(alice, wrongPersonal)), 'INBOX_ID_MISMATCH');
  const sharedOfOther = { type: 'invite', signer: alice.fp, ts: TS, to: bob.fp, kind: 'shared', inbox: sharedInboxId(bob.fp, nonce), nonce };
  assert.equal(reason(forge(alice, sharedOfOther)), 'INBOX_ID_MISMATCH', 'only the owner can invite to a shared inbox');
  const right = { type: 'invite', signer: alice.fp, ts: TS, to: bob.fp, kind: 'personal', inbox: personalInboxId(alice.fp, bob.fp, nonce), nonce };
  assert.equal(decodeRecord(forge(alice, right)).ok, true);
});

// Invariant: no record is addressed to its own signer; in particular an owner cannot sign a leave of its own inbox.
test('a record addressed to its own signer is rejected: SELF_ADDRESSED', () => {
  const nonce = newNonce();
  assert.equal(reason(forge(alice, { type: 'invite', signer: alice.fp, ts: TS, to: alice.fp, kind: 'personal', inbox: personalInboxId(alice.fp, alice.fp, nonce), nonce })), 'SELF_ADDRESSED');
  assert.equal(reason(forge(alice, { type: 'inbox-leave', signer: alice.fp, ts: TS, to: alice.fp, inbox: sharedInboxId(alice.fp, nonce), epoch: 0 })), 'SELF_ADDRESSED', 'the owner leaving its own inbox');
});

// ---- closing an inbox ----

const sharedDelete = (signer, nonce, extra = {}) => ({ type: 'inbox-delete', signer: signer.fp, ts: TS, kind: 'shared', inbox: sharedInboxId(signer.fp, nonce), nonce, ...extra });
const personalDelete = (signer, inviter, invitee, nonce, extra = {}) => ({
  type: 'inbox-delete', signer: signer.fp, ts: TS, kind: 'personal', inbox: personalInboxId(inviter.fp, invitee.fp, nonce), nonce,
  to: (signer === inviter ? invitee : inviter).fp, invite: 'f'.repeat(32), ...extra,
});

// Invariant (schema pairing): `to` and `invite` ride on an inbox-delete exactly when it is personal; an inbox-leave
// carries `to`, `inbox` and a non-negative `epoch` and nothing else. Every valid one round-trips.
test('inbox-delete carries to and invite exactly when personal; inbox-leave round-trips', () => {
  const nonce = newNonce();
  for (const payload of [sharedDelete(alice, nonce), personalDelete(alice, alice, bob, nonce), { type: 'inbox-leave', signer: bob.fp, ts: TS, to: alice.fp, inbox: sharedInboxId(alice.fp, nonce), epoch: 3 }]) {
    const { bytes, id } = encodeRecord(payload.signer === alice.fp ? alice : bob, payload);
    const d = decodeRecord(bytes);
    assert.equal(d.ok, true, payload.type);
    assert.equal(d.id, id);
    assert.deepEqual(d.payload, payload);
  }
  assert.equal(reason(forge(alice, sharedDelete(alice, nonce, { to: bob.fp }))), 'BAD_PAYLOAD', 'a shared delete with to');
  assert.equal(reason(forge(alice, sharedDelete(alice, nonce, { invite: 'f'.repeat(32) }))), 'BAD_PAYLOAD', 'a shared delete with invite');
  const { to, ...noTo } = personalDelete(alice, alice, bob, nonce);
  assert.equal(reason(forge(alice, noTo)), 'BAD_PAYLOAD', 'a personal delete without to');
  const { invite, ...noInvite } = personalDelete(alice, alice, bob, nonce);
  assert.equal(reason(forge(alice, noInvite)), 'BAD_PAYLOAD', 'a personal delete without invite');
  assert.equal(reason(forge(alice, sharedDelete(alice, nonce, { kind: 'other' }))), 'BAD_PAYLOAD', 'an unknown kind');
  const leave = { type: 'inbox-leave', signer: bob.fp, ts: TS, to: alice.fp, inbox: sharedInboxId(alice.fp, nonce), epoch: 0 };
  assert.equal(decodeRecord(forge(bob, leave)).ok, true, 'epoch 0');
  assert.equal(reason(forge(bob, { ...leave, epoch: -1 })), 'BAD_PAYLOAD', 'a negative epoch');
  const { epoch, ...noEpoch } = leave;
  assert.equal(reason(forge(bob, noEpoch)), 'BAD_PAYLOAD', 'a leave without epoch');
  assert.equal(reason(forge(bob, { ...leave, nonce })), 'BAD_PAYLOAD', 'an extra field');
});

// Invariant (self-certification): an inbox-delete recomputes its inbox id from its own fields: a shared one only for
// the owner (signer + nonce), a personal one only for either party (inviter, invitee, nonce in either order).
test('an inbox-delete that does not recompute is INBOX_ID_MISMATCH: shared from a non-owner key, personal from a non-party; either party\'s personal delete recomputes', async () => {
  const carol = await loadIdentity(tmpDir());
  const nonce = newNonce();
  const owned = sharedInboxId(alice.fp, nonce);
  assert.equal(reason(forge(bob, { type: 'inbox-delete', signer: bob.fp, ts: TS, kind: 'shared', inbox: owned, nonce })), 'INBOX_ID_MISMATCH', 'a non-owner deleting a shared inbox');
  assert.equal(reason(forge(alice, sharedDelete(alice, nonce, { nonce: newNonce() }))), 'INBOX_ID_MISMATCH', 'the owner with another nonce');
  assert.equal(decodeRecord(forge(alice, sharedDelete(alice, nonce))).ok, true, 'the owner');
  assert.equal(decodeRecord(forge(alice, personalDelete(alice, alice, bob, nonce))).ok, true, 'the inviter revokes');
  assert.equal(decodeRecord(forge(bob, personalDelete(bob, alice, bob, nonce))).ok, true, 'the invitee revokes');
  const pid = personalInboxId(alice.fp, bob.fp, nonce);
  const byCarol = { type: 'inbox-delete', signer: carol.fp, ts: TS, kind: 'personal', inbox: pid, nonce, to: alice.fp, invite: 'f'.repeat(32) };
  assert.equal(reason(forge(carol, byCarol)), 'INBOX_ID_MISMATCH', 'a non-party revoking');
  assert.equal(reason(forge(alice, personalDelete(alice, alice, bob, nonce, { to: carol.fp }))), 'INBOX_ID_MISMATCH', 'a party naming a non-party as the other party');
});

// Invariant: every type travels on exactly one route, the one the engine binds incoming records to.
test('routeFor maps each record type to its route', () => {
  const inbox = 'b'.repeat(32);
  assert.deepEqual(routeFor({ type: 'announce' }), { kind: 'directory' });
  assert.deepEqual(routeFor({ type: 'inbox-create', inbox }), { kind: 'directory' });
  for (const type of ['invite', 'invite-response', 'join-request', 'join-response']) assert.deepEqual(routeFor({ type, to: bob.fp, inbox }), { kind: 'mailbox', fp: bob.fp });
  for (const type of ['member', 'msg']) assert.deepEqual(routeFor({ type, inbox }), { kind: 'inbox', id: inbox });
  assert.deepEqual(routeFor({ type: 'inbox-delete', kind: 'shared', inbox }), { kind: 'directory' });
  assert.deepEqual(routeFor({ type: 'inbox-delete', kind: 'personal', inbox, to: bob.fp }), { kind: 'mailbox', fp: bob.fp });
  assert.deepEqual(routeFor({ type: 'inbox-leave', inbox, to: bob.fp }), { kind: 'mailbox', fp: bob.fp });
});

// Invariant: encodeRecord refuses to sign what decodeRecord would reject, so this install never emits a bad record.
test('encodeRecord refuses an invalid payload or another signer', () => {
  assert.throws(() => encodeRecord(alice, announce(alice, { name: 'bad name' })));
  assert.throws(() => encodeRecord(alice, announce(bob)));
});

// Invariant: a type naming an Object.prototype member is an unknown type, not a crash: decoding is total.
test('a type naming a prototype member is BAD_PAYLOAD, never an exception', () => {
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const r = decodeRecord(forge(alice, { type, signer: alice.fp, ts: TS }));
    assert.equal(r.reason, 'BAD_PAYLOAD', type);
  }
});

// Invariant: nothing can sign a record readers would reject for its size.
test('encodeRecord refuses a record over RECORD_MAX_BYTES: RECORD_TOO_LARGE', () => {
  const inbox = 'a'.repeat(32);
  const body = '\u0001'.repeat(BODY_MAX_BYTES); // within BODY_MAX_BYTES, but six bytes each once escaped
  assert.throws(() => encodeRecord(alice, { type: 'msg', signer: alice.fp, ts: TS, inbox, body }), { code: 'RECORD_TOO_LARGE' });
});

// Invariant: a contact card carries exactly a record's bytes, and nothing else parses as one.
test('a contact card round-trips and refuses a wrong prefix, non-canonical base64url, or oversize text', () => {
  const { bytes } = encodeRecord(alice, announce());
  const card = encodeCard(bytes);
  assert.ok(card.startsWith(CARD_PREFIX));
  assert.equal(CARD_PREFIX, 'code-inbox-card:v2:');
  assert.deepEqual(decodeCard(`  ${card}\n`), bytes);
  const body = card.slice(CARD_PREFIX.length);
  assert.equal(decodeCard(`code-inbox-card:v1:${body}`), null);
  assert.equal(decodeCard(body), null);
  assert.equal(decodeCard(`${CARD_PREFIX}${body}=`), null);
  assert.equal(decodeCard(`${CARD_PREFIX}AB`), null); // decodes, but re-encodes as AA: not canonical
  assert.equal(decodeCard(`${CARD_PREFIX}${body.replace(/^./, '+')}`), null);
  assert.equal(decodeCard(`${CARD_PREFIX}${Buffer.alloc(RECORD_MAX_BYTES + 1, 1).toString('base64url')}`), null);
  assert.equal(decodeCard(CARD_PREFIX), null);
  assert.equal(decodeCard(42), null);
});
