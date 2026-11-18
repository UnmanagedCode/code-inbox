import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  addPending, addRejected, admissionDue, buildIndex, addRecord, classify, inboxVerdicts, currentMembers, directory, dropOnArrival, inboxesOf, invalidMessages, isValidMessage, leaveDue, mayRelay, membersAt,
  messagesOf, nameRefusal, sharedOwner, withoutRecords,
} from '../src/state.js';
import { createDirectory } from '../src/directory.js';

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
// The in-memory announce map the name rules run over (src/directory.js).
const announce = (signer, name, ts) => rec({ type: 'announce', signer, name, ...(ts ? { ts } : {}) });
const announces = (...recs) => { const d = createDirectory(); for (const r of recs) d.note({ ...r, bytes: Buffer.from(r.id) }); return d.entries(); };
const create = (owner = A) => rec({ type: 'inbox-create', signer: owner, inbox: INBOX, nonce: 'd'.repeat(32), name: 'team' });
const member = (s, op, who, extra = {}, id) => rec({ type: 'member', signer: A, inbox: INBOX, seq: s, op, member: who, ...extra }, id);
const msg = (signer, extra = {}) => rec({ type: 'msg', signer, inbox: INBOX, body: 'hi', ...extra });
const verdict = (index, r) => classify(index, r).verdict;

// ---- names ----

// Invariant: a pinned name belongs to its key forever here; another key announcing it is never shown.
test('a name pinned to one key and announced by another is hidden: NAME_TAKEN', () => {
  const { identities, newPins } = directory(announces(announce(A, 'alice'), announce(M, 'alice')), { alice: A });
  assert.equal(identities.get(A).shown, true);
  assert.equal(identities.get(M).shown, false);
  assert.equal(identities.get(M).reason, 'NAME_TAKEN');
  assert.deepEqual(newPins, {});
});

// Invariant: two keys claiming an unpinned name show neither (a backdated ts cannot win the race).
test('an unpinned name with two claimants hides both: NAME_CONFLICT', () => {
  const { identities, newPins } = directory(announces(announce(A, 'alice'), announce(M, 'alice', 1)), {});
  assert.equal(identities.get(A).reason, 'NAME_CONFLICT');
  assert.equal(identities.get(M).reason, 'NAME_CONFLICT');
  assert.equal(identities.get(A).shown || identities.get(M).shown, false);
  assert.deepEqual(newPins, {});
});

// Invariant: a sole claimant is shown and pinned on first show.
test('a sole claimant is shown and returned as a new pin', () => {
  const { identities, newPins } = directory(announces(announce(A, 'alice')), {});
  assert.equal(identities.get(A).shown, true);
  assert.deepEqual(newPins, { alice: A });
});

// Invariant: an identity's current name is its latest announce by ts (record id breaking ties).
test("an identity's latest announce is its current name", () => {
  assert.equal(directory(announces(announce(A, 'alice', 5), announce(A, 'alicia', 9), announce(A, 'old', 1)), {}).identities.get(A).name, 'alicia');
});

// Invariant: this install cannot take a name pinned to, or claimed by, another key.
test('nameRefusal refuses a name pinned to or claimed by another key', () => {
  const index = announces(announce(B, 'bob'));
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
  assert.equal(verdict(index, msg(B, { epoch: 1, prev: null })), 'accept');
  assert.deepEqual(classify(index, msg(C, { epoch: 1, prev: null })), { verdict: 'reject', reason: 'NOT_MEMBER' }, 'C joined at 2');
  assert.deepEqual(classify(index, msg(B, { epoch: 3, prev: null })), { verdict: 'pending', reason: 'EPOCH_UNSEEN' });
  assert.deepEqual(classify(index, msg(B)), { verdict: 'reject', reason: 'BAD_EPOCH' }, 'a shared message cites an epoch');
});

// Invariant: only the owner writes member records.
test('a member record by anyone but the owner is rejected: NOT_OWNER', () => {
  const index = buildIndex([create()]);
  const forged = rec({ type: 'member', signer: M, inbox: INBOX, seq: 1, op: 'add', member: M });
  assert.deepEqual(classify(index, forged), { verdict: 'reject', reason: 'NOT_OWNER' });
});

// ---- prev chains and removal ----

// Invariant: validity is prefix-closed along prev: a message waits for its prev, and is refused for good once its
// prev is refused, invalid, or not the sender's own message in that inbox.
test('a shared message is valid only on top of its sender\'s valid prev', () => {
  const index = buildIndex([create(), member(1, 'add', B), member(2, 'add', C)]);
  const m1 = msg(B, { epoch: 1, prev: null });
  const m2 = msg(B, { epoch: 1, prev: m1.id });
  assert.deepEqual(classify(index, m2), { verdict: 'pending', reason: 'PREV_UNSEEN' });
  addPending(index, m1);
  assert.deepEqual(classify(index, m2), { verdict: 'pending', reason: 'PREV_UNSEEN' }, 'a pending prev is not yet valid');
  addRecord(index, m1);
  assert.equal(verdict(index, m2), 'accept');
  const byOther = msg(C, { epoch: 2, prev: m1.id });
  assert.deepEqual(classify(index, byOther), { verdict: 'reject', reason: 'BAD_PREV' });
  const refused = msg(B, { epoch: 1, prev: null });
  addRejected(index, refused.id, { reason: 'X', type: 'msg', inbox: INBOX, signer: B });
  assert.deepEqual(classify(index, msg(B, { epoch: 1, prev: refused.id })), { verdict: 'reject', reason: 'PREV_REJECTED' });
});

// Invariant: after a removal, the member's messages are valid only on the chain back from keepHead; a later
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

// Invariant: a message the owner did not hold when it removed the member is invalid everywhere, even if a reader
// accepted it before the removal arrived; so is everything built on it.
test('a message past the removal keepHead, and its descendants, are invalidated even if accepted earlier', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const m1 = msg(B, { epoch: 1, prev: null });
  const m2 = msg(B, { epoch: 1, prev: m1.id });
  const late = msg(B, { epoch: 1, prev: m2.id });
  const later = msg(B, { epoch: 1, prev: late.id });
  for (const m of [m1, m2, late, later]) addRecord(index, m);
  assert.equal(messagesOf(index, INBOX).length, 4);
  addRecord(index, member(2, 'remove', B, { keepHead: m2.id }));
  assert.deepEqual(messagesOf(index, INBOX).map((m) => m.id), [m1.id, m2.id]);
  assert.deepEqual(invalidMessages(index).map((x) => x.id).sort(), [late.id, later.id].sort());
});

// Invariant: a member that never wrote keeps nothing.
test('a removal with keepHead null keeps none of the member\'s messages', () => {
  const index = buildIndex([create(), member(1, 'add', B), member(2, 'remove', B, { keepHead: null })]);
  assert.deepEqual(classify(index, msg(B, { epoch: 1, prev: null })), { verdict: 'reject', reason: 'REMOVED' });
});

// Invariant: the kept chain is walked from the owner's keepHead through pending records too, so an ancestor of
// keepHead is accepted whenever it arrives, and an off-chain message waits only while a link is unseen, then is
// refused for good.
test('the kept chain is walked through pending records; off-chain messages end REMOVED once the walk completes', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const m1 = msg(B, { epoch: 1, prev: null });
  const head = msg(B, { epoch: 1, prev: m1.id });
  const fork = msg(B, { epoch: 1, prev: null });
  addRecord(index, member(2, 'remove', B, { keepHead: head.id }));
  assert.deepEqual(classify(index, fork), { verdict: 'pending', reason: 'CHAIN_UNSEEN' }, 'keepHead unseen: undecided');
  addPending(index, head); // the head waits for m1, its prev
  assert.equal(classify(index, m1).verdict, 'accept', 'reached from keepHead through the pending head');
  addRecord(index, m1);
  assert.deepEqual(classify(index, fork), { verdict: 'reject', reason: 'REMOVED' }, 'the walk reached null without it');
});

// Invariant: a removed member cannot get a pre-signed message accepted by having an earlier message point at it:
// that message stays pending at the owner (its prev is unseen), so it is never the owner's, nor on its kept chain.
test('a pre-signed link and what builds on it are refused after the removal', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const m1 = msg(B, { epoch: 1, prev: null });
  addRecord(index, m1);
  const presigned = msg(B, { epoch: 1, prev: m1.id });
  const pointer = msg(B, { epoch: 1, prev: presigned.id });
  assert.deepEqual(classify(index, pointer), { verdict: 'pending', reason: 'PREV_UNSEEN' }, 'the owner cannot accept it');
  addPending(index, pointer);
  addRecord(index, member(2, 'remove', B, { keepHead: m1.id }));
  assert.deepEqual(classify(index, presigned), { verdict: 'reject', reason: 'REMOVED' });
  addRejected(index, presigned.id, { reason: 'REMOVED', type: 'msg', inbox: INBOX, signer: B });
  assert.deepEqual(classify(index, pointer), { verdict: 'reject', reason: 'PREV_REJECTED' });
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

// Invariant: chain length is not an availability limit: one sender's 20k-message chain, judged message by message
// as it arrives and again in full after a removal clears the settled verdicts, ends all valid with nothing pending.
test('a 20k-message chain from one sender is valid end to end, before and after a removal', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const N = 20_000;
  let prev = null;
  for (let i = 0; i < N; i += 1) {
    const m = msg(B, { epoch: 1, prev });
    const c = classify(index, m);
    if (c.verdict !== 'accept') assert.fail(`message ${i}: ${JSON.stringify(c)}`);
    addRecord(index, m);
    prev = m.id;
  }
  addRecord(index, member(2, 'remove', B, { keepHead: prev }));
  const v = inboxVerdicts(index, INBOX);
  assert.equal(v.valid.length, N);
  assert.deepEqual([v.invalid, v.pending, v.rejected], [[], [], []]);
});

// Invariant: a re-added member writes again by citing the new epoch, on top of its last valid message.
test('a re-added member is valid again at the new epoch', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const a1 = msg(B, { epoch: 1, prev: null });
  addRecord(index, a1);
  addRecord(index, member(2, 'remove', B, { keepHead: a1.id }));
  addRecord(index, member(3, 'add', B));
  assert.equal(verdict(index, msg(B, { epoch: 3, prev: a1.id })), 'accept');
  assert.deepEqual(classify(index, msg(B, { epoch: 1, prev: a1.id })), { verdict: 'reject', reason: 'REMOVED' });
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
  assert.equal(verdict(empty, msg(B, { epoch: 0, prev: null })), 'pending');
  assert.equal(verdict(empty, member(1, 'add', B)), 'pending');
  assert.equal(verdict(empty, rec({ type: 'join-request', signer: B, to: A, inbox: INBOX })), 'pending');
  assert.equal(verdict(empty, rec({ type: 'invite-response', signer: B, to: A, invite: 'f'.repeat(32), inbox: INBOX, accept: true })), 'pending');
});

// Invariant: a join request goes to the inbox's owner only.
test('a join request to anyone but the owner is rejected: NOT_OWNER', () => {
  const index = buildIndex([create()]);
  assert.deepEqual(classify(index, rec({ type: 'join-request', signer: B, to: C, inbox: INBOX })), { verdict: 'reject', reason: 'NOT_OWNER' });
});

// ---- the owner relay ----

// Invariant (rule 1, D4): a record signed by someone other than its writer is admitted only when it is a msg on a
// shared inbox's route and the writer is that inbox's owner by this index; nobody else relays, and nothing else.
test('mayRelay admits only a msg on a shared inbox from that inbox\'s owner', () => {
  const OTHER = 'b'.repeat(32);
  const PERSONAL = 'a'.repeat(32);
  const index = buildIndex([
    create(), member(1, 'add', B), member(2, 'add', C),
    rec({ type: 'inbox-create', signer: M, inbox: OTHER, nonce: 'd'.repeat(32), name: 'other' }),
    rec({ type: 'invite', signer: A, to: B, kind: 'personal', inbox: PERSONAL, nonce: 'e'.repeat(32) }),
  ]);
  const shared = { kind: 'inbox', id: INBOX };
  const fromB = { type: 'msg', signer: B, inbox: INBOX, body: 'hi', epoch: 2, prev: null };
  assert.equal(sharedOwner(index, INBOX), A);
  assert.equal(sharedOwner(index, PERSONAL), null, 'a personal inbox has no owner');
  assert.equal(sharedOwner(index, 'f'.repeat(32)), null, 'an unknown inbox has no owner');
  assert.equal(mayRelay(index, A, shared, fromB), true, 'the owner relays a member\'s msg');
  assert.equal(mayRelay(index, C, shared, fromB), false, 'a co-member does not');
  assert.equal(mayRelay(index, M, shared, fromB), false, 'the owner of another shared inbox does not');
  assert.equal(mayRelay(index, A, shared, { type: 'member', signer: B, inbox: INBOX, seq: 3, op: 'add', member: M }), false, 'only msgs');
  assert.equal(mayRelay(index, A, { kind: 'mailbox', fp: A }, { type: 'invite-response', signer: B, to: A }), false, 'not a mailbox');
  assert.equal(mayRelay(index, A, { kind: 'directory' }, { type: 'inbox-create', signer: B }), false, 'not the directory');
  assert.equal(mayRelay(index, A, { kind: 'inbox', id: PERSONAL }, { type: 'msg', signer: B, inbox: PERSONAL, body: 'hi' }), false, 'not a personal inbox');
  const unknown = 'f'.repeat(32);
  assert.equal(mayRelay(index, A, { kind: 'inbox', id: unknown }, { ...fromB, inbox: unknown }), false, 'not an inbox unknown here');
});

// ---- closing an inbox ----

const sharedDel = (signer = A, inbox = INBOX) => rec({ type: 'inbox-delete', signer, kind: 'shared', inbox, nonce: 'd'.repeat(32) });
const personalDel = (signer, to, invite, inbox = INBOX) => rec({ type: 'inbox-delete', signer, kind: 'personal', inbox, nonce: 'e'.repeat(32), to, invite });
const leave = (signer, epoch, extra = {}) => rec({ type: 'inbox-leave', signer, to: A, inbox: INBOX, epoch, ...extra });
const noPurge = () => ({ ids: new Map(), dead: new Set() });

// Invariant: an inbox-delete certifies itself (records.js recomputes its id), so the fold accepts it whatever is
// known: it never waits for the inbox's create or invite.
test('an inbox-delete is accepted with nothing known: it never pends', () => {
  const empty = buildIndex([]);
  assert.equal(verdict(empty, sharedDel()), 'accept');
  assert.equal(verdict(empty, personalDel(B, A, 'f'.repeat(32))), 'accept');
});

// Invariant: an inbox-leave waits for the inbox and its epoch, goes to the inbox's owner only, and comes only from a
// member at the epoch it cites.
test('inbox-leave: INBOX_UNSEEN and EPOCH_UNSEEN pend; NOT_OWNER and NOT_MEMBER reject; a member at its epoch is accepted', () => {
  assert.deepEqual(classify(buildIndex([]), leave(B, 1)), { verdict: 'pending', reason: 'INBOX_UNSEEN' });
  const index = buildIndex([create(), member(1, 'add', B)]);
  assert.deepEqual(classify(index, leave(B, 1, { to: C })), { verdict: 'reject', reason: 'NOT_OWNER' });
  assert.deepEqual(classify(index, leave(B, 2)), { verdict: 'pending', reason: 'EPOCH_UNSEEN' });
  assert.deepEqual(classify(index, leave(C, 1)), { verdict: 'reject', reason: 'NOT_MEMBER' });
  assert.deepEqual(classify(index, leave(B, 0)), { verdict: 'reject', reason: 'NOT_MEMBER' }, 'not yet a member at epoch 0');
  assert.deepEqual(classify(index, leave(B, 1)), { verdict: 'accept' });
});

// Invariant (the newer member record wins): the owner owes a leaver's removal only while the leaver is a current
// member and no member record naming it is newer (by member seq) than the epoch the leave cites: a removal written
// first, or a re-admission written before a stale leave arrived, settles it. Records naming others never do.
test('leaveDue: due while a member; not after a removal; not after a re-add newer than the leave\'s epoch; still due when newer member records name others', () => {
  const index = buildIndex([create(), member(1, 'add', B)]);
  const l = leave(B, 1);
  addRecord(index, l);
  assert.equal(leaveDue(index, l), true, 'a current member');
  addRecord(index, member(2, 'add', C));
  addRecord(index, member(3, 'remove', C, { keepHead: null }));
  assert.equal(leaveDue(index, l), true, 'newer records name someone else');
  addRecord(index, member(4, 'remove', B, { keepHead: null }));
  assert.equal(leaveDue(index, l), false, 'removed already');
  addRecord(index, member(5, 'add', B));
  assert.equal(leaveDue(index, l), false, 're-added after the leave\'s epoch: a stale leave');
  const fresh = leave(B, 5);
  addRecord(index, fresh);
  assert.equal(leaveDue(index, fresh), true, 'a leave citing the re-admission epoch');
});

// Invariant (leaveDue compares member seq with the leave's epoch, never acceptance order): a re-admission the owner
// accepted before a stale leave arrived (a lower acceptance seq than the leave's) still wins, because its member seq
// is above the epoch the leave cites; a leave citing the re-admission epoch is due.
test('leaveDue: a re-admission accepted before the stale leave still wins by its member seq', () => {
  const index = buildIndex([create(), member(1, 'add', B), member(2, 'remove', B, { keepHead: null }), member(3, 'add', B)]);
  const stale = leave(B, 1);
  addRecord(index, stale);
  assert.ok(stale.seq > Math.max(...index.members.get(INBOX).map((m) => m.seq)), 'the leave is accepted after every member record');
  assert.equal(leaveDue(index, stale), false);
  const current = leave(B, 3);
  addRecord(index, current);
  assert.equal(leaveDue(index, current), true);
});

// Invariant: a record is dropped on arrival exactly when it was purged here (by id), belongs to a dead shared inbox
// (a purged create or the owner's own kept delete), answers a purged invite or join request, or revokes a personal
// invite already purged here (the other party's simultaneous revoke); nothing else is.
test('dropOnArrival: a purged id, a dead shared inbox (purged create or the owner\'s own delete), an answer to a purged invite or request, a revoke citing a purged invite; nothing else', () => {
  const OTHER = 'b'.repeat(32);
  const PERSONAL = 'a'.repeat(32);
  const inv = rec({ type: 'invite', signer: A, to: B, kind: 'shared', inbox: OTHER, nonce: '1'.repeat(32) });
  const req = rec({ type: 'join-request', signer: B, to: A, inbox: OTHER });
  const purged = { ids: new Map([[inv.id, OTHER], [req.id, OTHER]]), dead: new Set([INBOX]) };
  const empty = buildIndex([]);
  assert.equal(dropOnArrival(empty, purged, inv), 'PURGED');
  assert.equal(dropOnArrival(empty, purged, msg(B, { epoch: 1, prev: null })), 'DEAD_INBOX', 'a msg of a dead inbox');
  assert.equal(dropOnArrival(empty, purged, rec({ type: 'join-request', signer: C, to: A, inbox: INBOX })), 'DEAD_INBOX', 'a join request for a dead inbox');
  const resp = rec({ type: 'invite-response', signer: B, to: A, invite: inv.id, inbox: OTHER, accept: true });
  assert.equal(dropOnArrival(empty, purged, resp), 'PURGED_DEPENDENCY');
  const jresp = rec({ type: 'join-response', signer: A, to: B, request: req.id, inbox: OTHER, accept: false });
  assert.equal(dropOnArrival(empty, purged, jresp), 'PURGED_DEPENDENCY');
  const PI = 'e'.repeat(32);
  const revoked = { ids: new Map([[PI, PERSONAL]]), dead: new Set() };
  assert.equal(dropOnArrival(empty, revoked, personalDel(B, A, PI, PERSONAL)), 'PURGED_DEPENDENCY', 'a revoke citing a purged personal invite');
  assert.equal(dropOnArrival(empty, noPurge(), personalDel(B, A, PI, PERSONAL)), null, 'a revoke citing a live invite');
  // The owner's own kept delete marks its inbox dead with nothing on the purge list.
  const owner = buildIndex([sharedDel(A, OTHER)]);
  assert.equal(dropOnArrival(owner, noPurge(), rec({ type: 'invite-response', signer: B, to: A, invite: 'f'.repeat(32), inbox: OTHER, accept: true })), 'DEAD_INBOX');
  // Nothing else: another inbox, a live answer, and a personal inbox whose revoke is kept.
  assert.equal(dropOnArrival(empty, purged, rec({ type: 'msg', signer: B, inbox: OTHER, body: 'x', epoch: 1, prev: null })), null, 'another inbox');
  assert.equal(dropOnArrival(empty, purged, rec({ type: 'invite-response', signer: B, to: A, invite: 'f'.repeat(32), inbox: OTHER, accept: true })), null, 'an answer to a live invite');
  const revoker = buildIndex([personalDel(A, B, 'f'.repeat(32), PERSONAL)]);
  assert.equal(dropOnArrival(revoker, noPurge(), rec({ type: 'msg', signer: B, inbox: PERSONAL, body: 'x' })), null, 'a personal revoke marks nothing dead');
});

// Every map of an index as plain sorted data (record ids for records), to compare two indexes.
function shape(index) {
  const idOf = (v) => (Array.isArray(v) ? v.map(idOf).sort() : v && typeof v === 'object' && 'id' in v ? v.id : v);
  const out = {};
  for (const [k, v] of Object.entries(index)) {
    if (k === 'maxSeq') continue;
    if (v instanceof Map) out[k] = [...v].map(([key, val]) => [key, k === 'rejected' ? val : idOf(val)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    else if (v instanceof Set) out[k] = [...v].sort();
    else out[k] = v;
  }
  return out;
}

// Invariant: removing records gives exactly the index the remaining records build (every map and view, pending and
// refused ids included), with every cache empty, and never lowers the acceptance head.
test('withoutRecords equals an index built from the remaining records', () => {
  const OTHER = 'b'.repeat(32);
  const otherCreate = rec({ type: 'inbox-create', signer: B, inbox: OTHER, nonce: '2'.repeat(32), name: 'other' });
  const c = create();
  const inv = rec({ type: 'invite', signer: A, to: B, kind: 'shared', inbox: INBOX, nonce: 'd'.repeat(32) });
  const resp = rec({ type: 'invite-response', signer: B, to: A, invite: inv.id, inbox: INBOX, accept: true });
  const add = member(1, 'add', B);
  const req = rec({ type: 'join-request', signer: C, to: A, inbox: INBOX });
  const m1 = msg(B, { epoch: 1, prev: null });
  const o1 = rec({ type: 'msg', signer: B, inbox: OTHER, body: 'kept', epoch: 0, prev: null });
  const l = leave(B, 1);
  const all = [otherCreate, c, inv, resp, add, req, m1, o1, l];
  const pend = rec({ type: 'msg', signer: B, inbox: INBOX, body: 'later', epoch: 9, prev: null });
  const pendOther = rec({ type: 'msg', signer: B, inbox: OTHER, body: 'later', epoch: 9, prev: null });
  const index = buildIndex(all);
  for (const p of [pend, pendOther]) addPending(index, p);
  addRejected(index, 'r'.repeat(32), { reason: 'NOT_MEMBER', type: 'msg', inbox: INBOX, signer: C });
  addRejected(index, 's'.repeat(32), { reason: 'NOT_MEMBER', type: 'msg', inbox: OTHER, signer: C });
  assert.ok(isValidMessage(index, m1) && isValidMessage(index, o1), 'caches filled');
  const head = index.maxSeq;
  const gone = new Set([c.id, inv.id, resp.id, add.id, req.id, m1.id, l.id, pend.id, 'r'.repeat(32)]);
  const after = withoutRecords(index, gone);
  const expected = buildIndex([otherCreate, o1]);
  addPending(expected, pendOther);
  addRejected(expected, 's'.repeat(32), { reason: 'NOT_MEMBER', type: 'msg', inbox: OTHER, signer: C });
  assert.deepEqual(shape(after), shape(expected));
  assert.equal(after.verdicts.size + after.chains.size, 0, 'no cache survives');
  assert.ok(after.maxSeq >= head, 'the acceptance head never moves back');
  assert.deepEqual(inboxesOf(after, B).map((b) => b.id), [OTHER]);
  assert.equal(currentMembers(after, INBOX), null);
  assert.equal(index.byId.has(c.id), true, 'the input index is left alone');
});
