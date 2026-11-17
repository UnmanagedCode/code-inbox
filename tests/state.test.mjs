import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  admissionDue, buildIndex, addRecord, classify, currentMembers, directory, inboxesOf, invalidMessages, isValidMessage, membersAt, messagesOf, nameRefusal,
} from '../src/state.js';

// Pure fold tests: synthetic records (the fold trusts records.js for signatures and id recomputation).
const fp = (s) => crypto.createHash('sha256').update(s).digest('hex');
const A = fp('alice');
const B = fp('bob');
const C = fp('carol');
const M = fp('mallory');
const INBOX = 'c'.repeat(32);

let seq = 0;
// A record with a fresh seq; `id` defaults to a hash of the payload (pass one to control lowest-id ties).
const rec = (payload, id) => ({ seq: ++seq, id: id ?? fp(JSON.stringify(payload) + seq).slice(0, 32), payload: { ts: 1000 + seq, ...payload } });
const announce = (signer, name, ts) => rec({ type: 'announce', signer, name, addr: [], ...(ts ? { ts } : {}) });
const create = (owner = A) => rec({ type: 'inbox-create', signer: owner, inbox: INBOX, nonce: 'd'.repeat(32), name: 'team' });
const member = (s, op, who, extra = {}, id) => rec({ type: 'member', signer: A, inbox: INBOX, seq: s, op, member: who, ...extra }, id);
const msg = (signer, extra = {}) => rec({ type: 'msg', signer, inbox: INBOX, body: 'hi', ...extra });
const verdict = (index, r) => classify(index, r).verdict;

// ---- names ----

// Invariant: a pinned name belongs to its key forever here; another key announcing it is never shown.
test('a name pinned to one key and announced by another is hidden: NAME_TAKEN', () => {
  const index = buildIndex([announce(A, 'alice'), announce(M, 'alice')]);
  const { identities, newPins } = directory(index, { alice: A });
  assert.equal(identities.get(A).shown, true);
  assert.equal(identities.get(M).shown, false);
  assert.equal(identities.get(M).reason, 'NAME_TAKEN');
  assert.deepEqual(newPins, {});
});

// Invariant: two keys claiming an unpinned name show neither (a backdated ts cannot win the race).
test('an unpinned name with two claimants hides both: NAME_CONFLICT', () => {
  const index = buildIndex([announce(A, 'alice'), announce(M, 'alice', 1)]);
  const { identities, newPins } = directory(index, {});
  assert.equal(identities.get(A).reason, 'NAME_CONFLICT');
  assert.equal(identities.get(M).reason, 'NAME_CONFLICT');
  assert.equal(identities.get(A).shown || identities.get(M).shown, false);
  assert.deepEqual(newPins, {});
});

// Invariant: a sole claimant is shown and pinned on first show.
test('a sole claimant is shown and returned as a new pin', () => {
  const { identities, newPins } = directory(buildIndex([announce(A, 'alice')]), {});
  assert.equal(identities.get(A).shown, true);
  assert.deepEqual(newPins, { alice: A });
});

// Invariant: an identity's current name is its latest announce by ts (record id breaking ties).
test("an identity's latest announce is its current name", () => {
  const index = buildIndex([announce(A, 'alice', 5), announce(A, 'alicia', 9), announce(A, 'old', 1)]);
  assert.equal(directory(index, {}).identities.get(A).name, 'alicia');
});

// Invariant: this install cannot take a name pinned to, or claimed by, another key.
test('nameRefusal refuses a name pinned to or claimed by another key', () => {
  const index = buildIndex([announce(B, 'bob')]);
  assert.equal(nameRefusal(index, { alice: M }, A, 'alice'), 'NAME_TAKEN');
  assert.equal(nameRefusal(index, {}, A, 'bob'), 'NAME_CONFLICT');
  assert.equal(nameRefusal(index, { alice: A }, A, 'alice'), null);
});

// ---- personal inboxes ----

function personal() {
  const inv = rec({ type: 'invite', signer: A, to: B, kind: 'personal', inbox: INBOX, nonce: 'e'.repeat(32) });
  return { inv, index: buildIndex([inv]) };
}
const response = (inv, accept) => rec({ type: 'invite-response', signer: B, to: A, invite: inv.id, inbox: INBOX, accept });

// Invariant: a personal inbox exists, and takes messages, only once the invitee accepted.
test('a personal inbox is valid only after the invitee accepts', () => {
  const { inv, index } = personal();
  const m = msg(A);
  assert.equal(verdict(index, m), 'pending', 'held until the response is seen');
  assert.deepEqual(inboxesOf(index, A), []);
  addRecord(index, response(inv, true));
  assert.equal(verdict(index, m), 'accept');
  assert.deepEqual(inboxesOf(index, A).map((b) => b.id), [INBOX]);
  assert.deepEqual(inboxesOf(index, B).map((b) => b.id), [INBOX]);
  assert.deepEqual(inboxesOf(index, C), []);
});

test('a declined personal invite takes no messages: INVITE_DECLINED', () => {
  const { inv, index } = personal();
  addRecord(index, response(inv, false));
  assert.deepEqual(classify(index, msg(B)), { verdict: 'reject', reason: 'INVITE_DECLINED' });
  assert.deepEqual(inboxesOf(index, A), []);
});

// Invariant: only the two parties write to a personal inbox.
test("a non-party's message to a personal inbox is rejected: NOT_PARTY", () => {
  const { inv, index } = personal();
  addRecord(index, response(inv, true));
  assert.deepEqual(classify(index, msg(C)), { verdict: 'reject', reason: 'NOT_PARTY' });
});

// Invariant: only the invitee answers an invite, to its inviter, about its inbox.
test('a response by anyone but the invitee is rejected: RESPONSE_MISMATCH', () => {
  const { inv, index } = personal();
  const forged = rec({ type: 'invite-response', signer: C, to: A, invite: inv.id, inbox: INBOX, accept: true });
  assert.deepEqual(classify(index, forged), { verdict: 'reject', reason: 'RESPONSE_MISMATCH' });
});

// ---- shared inboxes ----

// Invariant: membership is a function of the epoch: the owner alone at 0, then member records applied in seq order.
test('shared membership follows the member records by epoch', () => {
  const index = buildIndex([create(), member(1, 'add', B), member(2, 'add', C)]);
  assert.deepEqual([...membersAt(index, INBOX, 0)], [A]);
  assert.deepEqual([...membersAt(index, INBOX, 1)].sort(), [A, B].sort());
  assert.deepEqual([...currentMembers(index, INBOX)].sort(), [A, B, C].sort());
  assert.equal(membersAt(index, INBOX, 3), null, 'an unseen epoch has no member set');
  assert.equal(verdict(index, msg(B, { epoch: 1 })), 'accept');
  assert.deepEqual(classify(index, msg(C, { epoch: 1 })), { verdict: 'reject', reason: 'NOT_MEMBER' }, 'C joined at 2');
  assert.deepEqual(classify(index, msg(B, { epoch: 3 })), { verdict: 'pending', reason: 'EPOCH_UNSEEN' });
  assert.deepEqual(classify(index, msg(B)), { verdict: 'reject', reason: 'BAD_EPOCH' }, 'a shared message cites an epoch');
});

// Invariant: only the owner writes member records.
test('a member record by anyone but the owner is rejected: NOT_OWNER', () => {
  const index = buildIndex([create()]);
  const forged = rec({ type: 'member', signer: M, inbox: INBOX, seq: 1, op: 'add', member: M });
  assert.deepEqual(classify(index, forged), { verdict: 'reject', reason: 'NOT_OWNER' });
});

// Invariant: after a removal, the member's messages are valid only on the prev chain back from keepHead; a later
// message (even citing a backdated epoch) and a fork are off it.
test("a removed member's later or forked message is rejected even with a backdated epoch: REMOVED", () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const first = msg(B, { epoch: 1, prev: null });
  addRecord(index, first);
  const head = msg(B, { epoch: 1, prev: first.id });
  addRecord(index, head);
  addRecord(index, member(2, 'remove', B, { keepHead: head.id }));
  assert.equal(isValidMessage(index, first), true, 'on the chain');
  assert.equal(isValidMessage(index, head), true, 'the head');
  assert.deepEqual(classify(index, msg(B, { epoch: 1, prev: head.id })), { verdict: 'reject', reason: 'REMOVED' }, 'after the head');
  assert.deepEqual(classify(index, msg(B, { epoch: 1, prev: first.id })), { verdict: 'reject', reason: 'REMOVED' }, 'a fork');
  assert.deepEqual(classify(index, msg(B, { epoch: 2, prev: head.id })), { verdict: 'reject', reason: 'NOT_MEMBER' });
});

// Invariant: a message the owner had not accepted when it removed the member (pre-signed, held back, or simply
// late) is invalid everywhere, even if it was accepted here first.
test('a message past the removal keepHead is invalidated everywhere, even if accepted earlier', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const m1 = msg(B, { epoch: 1, prev: null });
  const m2 = msg(B, { epoch: 1, prev: m1.id });
  const reserved = msg(B, { epoch: 1, prev: m2.id });
  for (const m of [m1, m2, reserved]) addRecord(index, m);
  assert.equal(messagesOf(index, INBOX).length, 3);
  addRecord(index, member(2, 'remove', B, { keepHead: m2.id }));
  assert.deepEqual(messagesOf(index, INBOX).map((m) => m.id), [m1.id, m2.id]);
  assert.deepEqual(invalidMessages(index).map((x) => [x.id, x.reason]), [[reserved.id, 'REMOVED']]);
});

// Invariant: a removal of a member that never wrote keeps nothing.
test('a removal with keepHead null keeps none of the member\'s messages', () => {
  const index = buildIndex([create(), member(1, 'add', B), member(2, 'remove', B, { keepHead: null })]);
  assert.deepEqual(classify(index, msg(B, { epoch: 1, prev: null })), { verdict: 'reject', reason: 'REMOVED' });
});

// Invariant: until every link back from keepHead is known, an off-chain message waits instead of being judged.
test('an incomplete chain holds messages pending until the head arrives', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const m1 = msg(B, { epoch: 1, prev: null });
  const head = msg(B, { epoch: 1, prev: m1.id });
  addRecord(index, member(2, 'remove', B, { keepHead: head.id }));
  assert.deepEqual(classify(index, m1), { verdict: 'pending', reason: 'CHAIN_UNSEEN' });
  addRecord(index, head);
  assert.equal(classify(index, m1).verdict, 'accept');
});

// Invariant: a removal's record size does not grow with the member's message count.
test('a removal after hundreds of messages keeps them all through one keepHead', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  let prev = null;
  const all = [];
  for (let i = 0; i < 500; i += 1) { const m = msg(B, { epoch: 1, prev }); addRecord(index, m); all.push(m.id); prev = m.id; }
  const removal = member(2, 'remove', B, { keepHead: prev });
  addRecord(index, removal);
  assert.equal(JSON.stringify(removal.payload).length < 400, true);
  assert.deepEqual(messagesOf(index, INBOX).map((m) => m.id), all);
});

// Invariant: a re-added member writes again by citing the new epoch.
test('a re-added member is valid again at the new epoch', () => {
  const index = buildIndex([create(), member(1, 'add', B), member(2, 'remove', B, { keepHead: null }), member(3, 'add', B)]);
  assert.equal(verdict(index, msg(B, { epoch: 3, prev: null })), 'accept');
  assert.deepEqual(classify(index, msg(B, { epoch: 1, prev: null })), { verdict: 'reject', reason: 'REMOVED' });
});

// Invariant: the owner admits after an accepted shared invite only on the invite's effective response, and only
// for an invite newer than the invitee's last member record: a replayed or re-signed acceptance re-admits nobody.
test('admissionDue: a replayed acceptance after a removal admits nobody; a fresh invite does', () => {
  const index = buildIndex([create()]);
  const invite = (nonce) => rec({ type: 'invite', signer: A, to: B, kind: 'shared', inbox: INBOX, nonce });
  const accepted = (inv) => rec({ type: 'invite-response', signer: B, to: A, invite: inv.id, inbox: INBOX, accept: true });
  const inv1 = invite('1'.repeat(32));
  addRecord(index, inv1);
  assert.equal(admissionDue(index, inv1), false, 'no response yet');
  addRecord(index, accepted(inv1));
  assert.equal(admissionDue(index, inv1), true);
  addRecord(index, member(1, 'add', B));
  addRecord(index, member(2, 'remove', B, { keepHead: null }));
  addRecord(index, accepted(inv1));
  assert.equal(admissionDue(index, inv1), false, 'a re-signed acceptance of the old invite');
  const inv2 = invite('2'.repeat(32));
  addRecord(index, inv2);
  addRecord(index, accepted(inv2));
  assert.equal(admissionDue(index, inv2), true, 'an honest re-invite');
});

test('admissionDue follows the effective (lowest-id) response', () => {
  const index = buildIndex([create()]);
  const inv = rec({ type: 'invite', signer: A, to: B, kind: 'shared', inbox: INBOX, nonce: '3'.repeat(32) });
  addRecord(index, inv);
  addRecord(index, rec({ type: 'invite-response', signer: B, to: A, invite: inv.id, inbox: INBOX, accept: false }, '0'.repeat(32)));
  addRecord(index, rec({ type: 'invite-response', signer: B, to: A, invite: inv.id, inbox: INBOX, accept: true }, 'f'.repeat(32)));
  assert.equal(admissionDue(index, inv), false);
});

// Invariant: two member records with one seq resolve the same way on every install: the lowest record id wins,
// whatever order they arrived in.
test('a duplicate member seq resolves to the lowest record id, in any arrival order', () => {
  const low = member(1, 'add', B, {}, '0'.repeat(32));
  const high = member(1, 'add', C, {}, 'f'.repeat(32));
  for (const order of [[low, high], [high, low]]) {
    const index = buildIndex([create(), ...order]);
    assert.deepEqual([...currentMembers(index, INBOX)].sort(), [A, B].sort());
  }
});

// Invariant: records arriving before what they depend on wait instead of being lost or rejected.
test('records that depend on an unseen record are pending', () => {
  const empty = buildIndex([]);
  assert.equal(verdict(empty, msg(B, { epoch: 0 })), 'pending');
  assert.equal(verdict(empty, member(1, 'add', B)), 'pending');
  assert.equal(verdict(empty, rec({ type: 'join-request', signer: B, to: A, inbox: INBOX })), 'pending');
  assert.equal(verdict(empty, rec({ type: 'invite-response', signer: B, to: A, invite: 'f'.repeat(32), inbox: INBOX, accept: true })), 'pending');
});

// Invariant: a join request goes to the inbox's owner only.
test('a join request to anyone but the owner is rejected: NOT_OWNER', () => {
  const index = buildIndex([create()]);
  assert.deepEqual(classify(index, rec({ type: 'join-request', signer: B, to: C, inbox: INBOX })), { verdict: 'reject', reason: 'NOT_OWNER' });
});
