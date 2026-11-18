import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIdentity } from '../src/identity.js';
import { decodeRecord, encodeRecord, routeFor } from '../src/records.js';
import { createStore } from '../src/store.js';
import { makeNetwork, silentLog, syncAll } from './helpers.mjs';
import { KINDS, acceptedOf, assertGone, bodies, holdings, personalInbox, refusedEverywhere, sharedInbox, world } from './closeHarness.mjs';

// Closing an inbox (docs/protocol.md → Closing an inbox): the owner's Delete, a member's Leave, a party's Revoke.
// The engine rules first, on single installs fed through engine.ingest; then multi-install flows, each body run on
// the file share and on the network (tests/closeHarness.mjs).

// The records `x` accepted, decoded, with their stored bytes and route.
async function log(x) {
  const loaded = await createStore(x.dataDir, { log: silentLog }).load();
  return loaded.accepted.map((e) => ({ ...decodeRecord(e.bytes), bytes: e.bytes, route: e.route }));
}
const lastOf = async (x, type) => (await log(x)).filter((d) => d.payload.type === type).at(-1);
const feed = (x, d) => x.engine.ingest({ route: routeFor(d.payload), writer: d.payload.signer, bytes: d.bytes });
const removalsOf = async (owner, inbox, fp) => (await acceptedOf(owner, inbox, 'member')).filter((d) => d.payload.op === 'remove' && d.payload.member === fp);

// ---- engine rules (single installs; the share is never scanned, so every record arrives through ingest) ----

// Invariant (the interest rule): the engine admits a record only on a route in its current interest. An inbox-route
// record offered to an install with no part in that inbox leaves nothing accepted, pending or refused; once an invite
// puts the inbox in its interest, the same bytes are admitted.
test('the engine admits records only on routes in its interest', async () => {
  const { installs: [a, b] } = await makeNetwork(['alice', 'bob']);
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await a.engine.sendMessage(inbox, 'early');
  const msg = await lastOf(a, 'msg');
  await feed(b, await lastOf(a, 'inbox-create'));
  await feed(b, msg);
  const empty = { valid: [], invalid: [], pending: [], rejected: [] };
  assert.deepEqual(b.engine.verdicts(inbox), empty, 'nothing accepted, pending or refused');
  assert.equal(b.engine.state().diagnostics.rejected, 0, 'and nothing counted');
  await a.engine.inviteMember(inbox, b.fp);
  await feed(b, await lastOf(a, 'invite'));
  await feed(b, msg);
  assert.deepEqual(b.engine.verdicts(inbox).valid, [msg.id]);
  await a.close();
  await b.close();
});

// Invariant (the cited invite): a revoke names its personal invite, which goes on the receiver's purge list, so the
// invite is dropped by id when it arrives after the revoke.
test('a revoke received before its invite drops the invite when it arrives', async () => {
  const { installs: [a, b] } = await makeNetwork(['alice', 'bob']);
  const { inbox } = await a.engine.invite(b.fp);
  const invite = await lastOf(a, 'invite');
  const alice = await loadIdentity(a.dataDir);
  const revoke = encodeRecord(alice, {
    type: 'inbox-delete', signer: alice.fp, ts: Date.now(), kind: 'personal', inbox, nonce: invite.payload.nonce, to: b.fp, invite: invite.id,
  });
  await feed(b, { ...revoke, payload: revoke.payload });
  await feed(b, invite);
  assert.deepEqual(b.engine.state().invites.incoming, []);
  assert.equal(b.engine.state().diagnostics.pending, 0);
  assert.equal(b.engine.state().diagnostics.rejected, 0);
  await a.close();
  await b.close();
});

// Invariant (PURGED_DEPENDENCY): an answer to an invite this install purged is dropped, never left pending.
test('a late answer to a revoked personal invite is dropped', async () => {
  const { installs: [a, b] } = await makeNetwork(['alice', 'bob']);
  const { id, inbox } = await a.engine.invite(b.fp);
  await b.engine.sync();
  await b.engine.respondInvite(id, true);
  const answer = await lastOf(b, 'invite-response');
  await b.engine.deleteInbox(inbox);
  await feed(a, await lastOf(b, 'inbox-delete'));
  await feed(a, answer);
  const s = a.engine.state();
  assert.deepEqual([s.invites.outgoing, s.inboxes, s.diagnostics.pending, s.diagnostics.rejected], [[], [], 0, 0]);
  await a.close();
  await b.close();
});

// Invariant (leaveDue): a stale leave loses to a newer member record: a re-admission the owner wrote before the leave
// arrived keeps the member in.
test('a stale leave loses to a newer member record', async () => {
  const { installs } = await makeNetwork(['owner', 'member']);
  const [owner, m] = installs;
  const { id: inbox } = await owner.engine.createSharedInbox('team');
  await syncAll(installs);
  await m.engine.requestJoin(inbox);
  await syncAll(installs);
  await owner.engine.respondJoin(owner.engine.state().joinRequests.incoming[0].id, true);
  await syncAll(installs);
  await m.engine.leaveInbox(inbox);
  await m.engine.requestJoin(inbox);
  await feed(owner, await lastOf(m, 'join-request'));
  await owner.engine.respondJoin(owner.engine.state().joinRequests.incoming[0].id, true);
  await feed(owner, await lastOf(m, 'inbox-leave'));
  assert.ok(owner.engine.listInboxes().find((b) => b.id === inbox).members.some((x) => x.fp === m.fp), 'still a member');
  assert.deepEqual(await removalsOf(owner, inbox, m.fp), []);
  await owner.close();
  await m.close();
});

// Invariant (leaveDue): a leave that arrives after the owner removed the member is accepted and writes nothing.
test('a leave after the owner\'s removal writes no second removal', async () => {
  const { installs } = await makeNetwork(['owner', 'member']);
  const [owner, m] = installs;
  const { id: inbox } = await owner.engine.createSharedInbox('team');
  await syncAll(installs);
  await m.engine.requestJoin(inbox);
  await syncAll(installs);
  await owner.engine.respondJoin(owner.engine.state().joinRequests.incoming[0].id, true);
  await syncAll(installs);
  await owner.engine.removeMember(inbox, m.fp);
  await m.engine.leaveInbox(inbox);
  const leave = await lastOf(m, 'inbox-leave');
  await feed(owner, leave);
  assert.ok((await log(owner)).some((d) => d.id === leave.id), 'the leave is accepted');
  assert.equal((await removalsOf(owner, inbox, m.fp)).length, 1);
  await owner.close();
  await m.close();
});

// Invariant (the purge reaches refused ids): a record of the inbox this install refused is gone after the purge,
// from rejected.ndjson and from the index.
test('a refused record of the inbox is purged from rejected.ndjson and the index', async () => {
  const { installs } = await makeNetwork(['owner', 'member', 'stranger']);
  const [owner, m, stranger] = installs;
  const { id: inbox } = await owner.engine.createSharedInbox('team');
  await syncAll(installs);
  await m.engine.requestJoin(inbox);
  await syncAll(installs);
  await owner.engine.respondJoin(owner.engine.state().joinRequests.incoming[0].id, true);
  await syncAll(installs);
  const outsider = await loadIdentity(stranger.dataDir);
  const refused = encodeRecord(outsider, { type: 'msg', signer: outsider.fp, ts: Date.now(), inbox, body: 'not a member', epoch: 1, prev: null });
  await m.engine.ingest({ route: { kind: 'inbox', id: inbox }, writer: outsider.fp, bytes: refused.bytes });
  assert.deepEqual(m.engine.verdicts(inbox).rejected, [refused.id], 'refused NOT_MEMBER');
  assert.ok((await holdings(m.dataDir, inbox)).includes('rejected msg'));
  await owner.engine.deleteInbox(inbox);
  await syncAll(installs);
  assert.deepEqual(m.engine.verdicts(inbox).rejected, [], 'gone from the index');
  assert.deepEqual(await holdings(m.dataDir, inbox), [], 'gone from rejected.ndjson');
  for (const x of installs) await x.close();
});

// Invariant (the served log follows the purge): an install stops serving a closed inbox's records on every route: a
// leaver no longer serves its messages on the inbox route, and the owner no longer serves the deleted inbox's create
// on the directory route or its invite on the invitee's mailbox.
test('network: a purging install stops serving the inbox\'s records', async (t) => {
  const w = await world(t, 'network', ['owner', 'm1', 'invitee']);
  const [owner, m1, invitee] = w.nodes;
  const id = await sharedInbox(w, owner, [m1]);
  await m1.engine.sendMessage(id, 'served');
  await owner.engine.inviteMember(id, invitee.fp);
  await w.settle();
  const types = (recs) => recs.map((r) => decodeRecord(r.bytes).payload).filter((p) => p.inbox === id).map((p) => p.type).sort();
  const inboxRoute = { kind: 'inbox', id };
  const directory = { kind: 'directory' };
  const mailbox = { kind: 'mailbox', fp: invitee.fp };
  assert.deepEqual(types(m1.serve(owner.fp, inboxRoute).recs), ['msg']);
  assert.deepEqual(types(owner.serve(invitee.fp, directory).recs), ['inbox-create']);
  assert.deepEqual(types(owner.serve(invitee.fp, mailbox).recs), ['invite']);
  await m1.engine.leaveInbox(id);
  await w.settle(3);
  assert.deepEqual(types(m1.serve(owner.fp, inboxRoute).recs ?? []), [], 'the leaver serves none of its messages');
  await owner.engine.deleteInbox(id);
  await w.settle();
  assert.deepEqual(types(owner.serve(invitee.fp, directory).recs), ['inbox-delete'], 'the directory serves only the kept delete');
  assert.deepEqual(types(owner.serve(invitee.fp, mailbox).recs), [], 'the invite is no longer served');
});

// ---- multi-install flows, on every transport ----

for (const kind of KINDS) {
  // M1. Invariant (purge completeness): the owner's Delete removes the inbox from every install that knew it:
  // members, an invitee with an open invite, a requester with an open request and a non-member. Agents and the page
  // get INBOX_UNKNOWN, no directory row (so no Request to join) remains, and each data dir holds nothing of it but the
  // owner's own delete. A new inbox of the same name is unaffected.
  test(`${kind}: M1 the owner's delete removes the inbox from every install`, async (t) => {
    const w = await world(t, kind, ['owner', 'm1', 'm2', 'invitee', 'requester', 'outsider']);
    const [owner, m1, m2, invitee, requester, outsider] = w.nodes;
    const id = await sharedInbox(w, owner, [m1, m2]);
    await m1.engine.sendMessage(id, 'before');
    await owner.engine.inviteMember(id, invitee.fp);
    await requester.engine.requestJoin(id);
    await w.settle();
    assert.deepEqual(bodies(m2, id), ['before']);
    assert.ok(invitee.engine.state().invites.incoming.some((i) => i.inbox === id));
    assert.ok(owner.engine.state().joinRequests.incoming.some((r) => r.inbox === id));
    assert.ok(outsider.engine.state().sharedInboxes.some((s) => s.id === id));
    await owner.engine.deleteInbox(id);
    await w.settle(3);
    for (const n of w.nodes) await assertGone(n, id, n === owner ? ['accepted inbox-delete'] : []);
    const { id: again } = await owner.engine.createSharedInbox('team');
    await w.settle();
    assert.notEqual(again, id);
    for (const n of [m1, m2, outsider]) assert.ok(n.engine.state().sharedInboxes.some((s) => s.id === again && s.name === 'team'), n.name);
  });

  // M2. Invariant (offline delivery): a member offline at the delete drops the inbox once it is back; the owner's
  // outbox empties.
  test(`${kind}: M2 a member offline at the delete drops the inbox once back`, async (t) => {
    const w = await world(t, kind, ['owner', 'm1', 'm2']);
    const [owner, m1, m2] = w.nodes;
    const id = await sharedInbox(w, owner, [m1, m2]);
    await m2.close();
    await owner.engine.deleteInbox(id);
    await w.settle();
    await m2.restart();
    await w.until(() => !m2.engine.state().sharedInboxes.some((s) => s.id === id) && owner.engine.state().diagnostics.outbox === 0, 'the delete to reach m2');
    for (const n of [m1, m2]) await assertGone(n, id);
    await assertGone(owner, id, ['accepted inbox-delete']);
  });

  // M3. Invariant (no resurrection, never pending): a member's message sent before it learns of the delete is
  // dropped by the owner, never relayed to a co-member, refused nowhere, and never comes back after restarts.
  test(`${kind}: M3 a message sent before its sender learns of the delete is dropped`, async (t) => {
    const w = await world(t, kind, ['owner', 'm1', 'm2']);
    const [owner, m1, m2] = w.nodes;
    const id = await sharedInbox(w, owner, [m1, m2]);
    if (kind === 'file-share') {
      // m1 does not scan until it has written.
      await owner.engine.deleteInbox(id);
      await owner.engine.sync();
      await m2.engine.sync();
      await m1.engine.sendMessage(id, 'too late');
    } else {
      // m1 is offline at the delete and writes while the owner is down, so neither has heard of the other.
      await m1.close();
      await owner.engine.deleteInbox(id);
      await owner.close();
      await m1.restart();
      await m1.engine.sendMessage(id, 'too late');
      await owner.restart();
    }
    const rejected = [owner, m2].map((n) => n.engine.state().diagnostics.rejected);
    await w.until(() => !m1.engine.listInboxes().some((b) => b.id === id) && w.nodes.every((n) => n.engine.state().diagnostics.outbox === 0), 'm1 to drop the inbox');
    assert.deepEqual([owner, m2].map((n) => n.engine.state().diagnostics.rejected), rejected, 'nothing refused');
    for (const n of w.nodes) await n.restart();
    await w.settle(3);
    for (const n of w.nodes) {
      assert.equal(n.engine.state().diagnostics.pending, 0, n.name);
      assert.equal(n.engine.state().diagnostics.rejected, 0, n.name);
      assert.deepEqual(await holdings(n.dataDir, id), n === owner ? ['accepted inbox-delete'] : [], n.name);
    }
  });

  // M4. Invariant (leave semantics and purge scope): a member's Leave makes the owner write exactly one removal,
  // keeping the leaver's last valid message; co-members keep its messages without it as a member. The leaver keeps
  // only the inbox-create (its directory row offers Request to join again) and its own leave; agents get NOT_MEMBER.
  test(`${kind}: M4 a member leaves`, async (t) => {
    const w = await world(t, kind, ['owner', 'm1', 'm2']);
    const [owner, m1, m2] = w.nodes;
    const id = await sharedInbox(w, owner, [m1, m2]);
    await m1.engine.sendMessage(id, 'one');
    await m1.engine.sendMessage(id, 'two');
    await w.settle();
    const last = owner.engine.messages(id).filter((m) => m.sender.fp === m1.fp).at(-1).id;
    await m1.engine.leaveInbox(id);
    await w.settle(3);
    const removals = await removalsOf(owner, id, m1.fp);
    assert.equal(removals.length, 1);
    assert.equal(removals[0].payload.keepHead, last);
    for (const n of [owner, m2]) {
      assert.deepEqual(n.engine.listInboxes().find((b) => b.id === id).members.map((x) => x.fp).sort(), [owner.fp, m2.fp].sort(), n.name);
      assert.deepEqual(bodies(n, id), ['one', 'two'], n.name);
    }
    assert.ok(!m1.engine.listInboxes().some((b) => b.id === id));
    await refusedEverywhere(m1, id, 'NOT_MEMBER');
    const row = m1.engine.state().sharedInboxes.find((s) => s.id === id);
    assert.deepEqual([row.isMember, row.isOwner, row.requestPending], [false, false, false], 'the row offers Request to join');
    assert.deepEqual(await holdings(m1.dataDir, id), ['accepted inbox-create', 'accepted inbox-leave']);
    assert.equal(m1.engine.state().diagnostics.pending, 0);
  });

  // M5. Invariant (the leave is owed): a leave written while the owner is down reaches it once it is back (the
  // outbox, or the share), and the owner then writes the removal.
  test(`${kind}: M5 a leave while the owner is offline`, async (t) => {
    const w = await world(t, kind, ['owner', 'm1', 'm2']);
    const [owner, m1, m2] = w.nodes;
    const id = await sharedInbox(w, owner, [m1, m2]);
    await owner.close();
    await m1.engine.leaveInbox(id);
    await owner.restart();
    const gone = (n) => !n.engine.listInboxes().find((b) => b.id === id).members.some((x) => x.fp === m1.fp);
    await w.until(() => gone(owner) && gone(m2), 'the removal');
    assert.equal((await removalsOf(owner, id, m1.fp)).length, 1);
    assert.equal(m1.engine.state().diagnostics.outbox, 0);
  });

  // M6. Invariant (the delivery-position contract; the create is kept): a leaver that asks to join again is
  // delivered the inbox from the start and sends and receives again. On the file share it reads its own earlier
  // messages again; on the network the owner never serves a reader its own records, so it does not.
  test(`${kind}: M6 leave, then rejoin by request`, async (t) => {
    const w = await world(t, kind, ['owner', 'm1', 'm2']);
    const [owner, m1, m2] = w.nodes;
    const id = await sharedInbox(w, owner, [m1, m2]);
    await m1.engine.sendMessage(id, 'mine');
    await m2.engine.sendMessage(id, 'theirs');
    await w.settle();
    await m1.engine.leaveInbox(id);
    await w.settle(3);
    await m1.engine.requestJoin(id);
    await w.settle();
    await owner.engine.respondJoin(owner.engine.state().joinRequests.incoming.find((r) => r.inbox === id).id, true);
    await w.until(() => m1.engine.listInboxes().some((b) => b.id === id) && bodies(m1, id).includes('theirs'), 'the rejoin');
    assert.deepEqual(bodies(m1, id), kind === 'file-share' ? ['mine', 'theirs'] : ['theirs']);
    await m1.engine.sendMessage(id, 'back');
    await m2.engine.sendMessage(id, 'welcome');
    await w.until(() => bodies(m2, id).includes('back') && bodies(m1, id).includes('welcome'), 'messages both ways');
  });

  // M7. Invariant (the purge list across a restart; admission unchanged): after a leave and a restart, no old
  // invite or answer comes back; a fresh owner invite admits the leaver with the history as in M6.
  test(`${kind}: M7 leave, restart, rejoin by a fresh invite`, async (t) => {
    const w = await world(t, kind, ['owner', 'm1', 'm2']);
    const [owner, m1, m2] = w.nodes;
    const id = await sharedInbox(w, owner, [m1, m2]);
    await m1.engine.sendMessage(id, 'mine');
    await m2.engine.sendMessage(id, 'theirs');
    await w.settle();
    await m1.engine.leaveInbox(id);
    await w.settle(3);
    await m1.restart();
    await w.settle(3);
    const s = m1.engine.state();
    assert.deepEqual([s.invites.incoming, s.invites.outgoing, s.diagnostics.pending], [[], [], 0], 'no stale invite or answer');
    assert.ok(!m1.engine.listInboxes().some((b) => b.id === id));
    await owner.engine.inviteMember(id, m1.fp);
    await w.settle();
    await m1.engine.respondInvite(m1.engine.state().invites.incoming.find((i) => i.inbox === id).id, true);
    await w.until(() => m1.engine.listInboxes().some((b) => b.id === id) && bodies(m1, id).includes('theirs'), 'the readmission');
    assert.deepEqual(bodies(m1, id), kind === 'file-share' ? ['mine', 'theirs'] : ['theirs']);
  });

  // M8. Invariant (Revoke unregisters): a party's revoke removes the personal inbox from both installs; agents get
  // INBOX_UNKNOWN; a fresh invite in either direction succeeds (INVITE_EXISTS no longer sees the old one), with a new
  // inbox id that carries messages; restarts bring no revoked inbox back.
  test(`${kind}: M8 a personal revoke, then fresh invites both ways`, async (t) => {
    const w = await world(t, kind, ['a', 'b']);
    const [a, b] = w.nodes;
    const old = await personalInbox(w, a, b);
    await a.engine.sendMessage(old, 'old');
    await w.settle();
    await b.engine.deleteInbox(old);
    await w.settle();
    await assertGone(a, old);
    await assertGone(b, old, ['accepted inbox-delete']);
    const first = await personalInbox(w, a, b);
    assert.notEqual(first, old);
    await a.engine.sendMessage(first, 'first');
    await w.settle();
    assert.deepEqual(bodies(b, first), ['first']);
    await a.engine.deleteInbox(first);
    await w.settle();
    const second = await personalInbox(w, b, a);
    assert.ok(![old, first].includes(second));
    await b.engine.sendMessage(second, 'second');
    await w.settle();
    assert.deepEqual(bodies(a, second), ['second']);
    for (const n of w.nodes) await n.restart();
    await w.settle(3);
    for (const n of w.nodes) {
      assert.deepEqual(n.engine.listInboxes().map((x) => x.id), [second], n.name);
      assert.deepEqual(n.engine.state().invites.incoming, [], n.name);
      assert.equal(n.engine.state().diagnostics.pending, 0, n.name);
    }
  });

  // M9. Invariant (offline delivery): a party offline at the revoke drops the inbox once it is back.
  test(`${kind}: M9 a revoke while the other party is offline`, async (t) => {
    const w = await world(t, kind, ['a', 'b']);
    const [a, b] = w.nodes;
    const inbox = await personalInbox(w, a, b);
    await b.close();
    await a.engine.deleteInbox(inbox);
    await b.restart();
    await w.until(() => !b.engine.listInboxes().some((x) => x.id === inbox) && a.engine.state().diagnostics.outbox === 0, 'the revoke to reach b');
    await assertGone(b, inbox);
    await assertGone(a, inbox, ['accepted inbox-delete']);
  });

  // M10. Invariant (race rule): a message in flight during a revoke is dropped on arrival, nothing waits, and the
  // sender's outbox empties.
  test(`${kind}: M10 a message in flight during a revoke is dropped`, async (t) => {
    const w = await world(t, kind, ['a', 'b']);
    const [a, b] = w.nodes;
    const inbox = await personalInbox(w, a, b);
    if (kind === 'file-share') {
      await a.engine.sendMessage(inbox, 'late');
      await b.engine.deleteInbox(inbox);
    } else {
      await b.close();
      await a.engine.sendMessage(inbox, 'late');
      await a.close();
      await b.restart();
      await b.engine.deleteInbox(inbox);
      await a.restart();
    }
    await w.until(() => !a.engine.listInboxes().some((x) => x.id === inbox) && w.nodes.every((n) => n.engine.state().diagnostics.outbox === 0), 'the revoke to settle');
    await w.settle();
    await assertGone(a, inbox);
    await assertGone(b, inbox, ['accepted inbox-delete']);
  });

  // M11. Invariant (race rule): both parties revoking at once each keep only their own revoke and drop the other's.
  test(`${kind}: M11 both parties revoke at once`, async (t) => {
    const w = await world(t, kind, ['a', 'b']);
    const [a, b] = w.nodes;
    const inbox = await personalInbox(w, a, b);
    if (kind === 'file-share') {
      await a.engine.deleteInbox(inbox);
      await b.engine.deleteInbox(inbox);
    } else {
      await b.close();
      await a.engine.deleteInbox(inbox);
      await a.close();
      await b.restart();
      await b.engine.deleteInbox(inbox);
      await a.restart();
    }
    await w.until(() => w.nodes.every((n) => n.engine.state().diagnostics.outbox === 0), 'both revokes delivered');
    await w.settle();
    for (const n of w.nodes) await assertGone(n, inbox, ['accepted inbox-delete']);
  });

  // M12. Invariant (the dead-id drop): records for a deleted shared inbox that reach an install after the delete
  // (an owner's invite read after it, a join request written before the requester saw it) are dropped, never pending.
  test(`${kind}: M12 records arriving after a shared delete are dropped, never pending`, async (t) => {
    const w = await world(t, kind, ['owner', 'invitee', 'requester']);
    const [owner, invitee, requester] = w.nodes;
    const { id } = await owner.engine.createSharedInbox('team');
    await w.settle();
    assert.ok(requester.engine.state().sharedInboxes.some((s) => s.id === id));
    if (kind === 'file-share') {
      // The invitee scans the directory route (the delete) before its mailbox (the invite).
      await owner.engine.inviteMember(id, invitee.fp);
      await owner.engine.deleteInbox(id);
      await requester.engine.requestJoin(id);
    } else {
      // A late frame: the invite reaches the invitee after the delete did.
      const invite = (await owner.engine.inviteMember(id, invitee.fp)).id;
      const bytes = (await acceptedOf(owner, id, 'invite')).find((d) => d.id === invite).bytes;
      await owner.engine.deleteInbox(id);
      // The requester is named by no record of the inbox, so nothing pushes it the delete: it asks before it pulls.
      await requester.engine.requestJoin(id);
      await w.until(() => !invitee.engine.state().sharedInboxes.some((s) => s.id === id), 'the delete to reach the invitee');
      await invitee.engine.ingest({ route: { kind: 'mailbox', fp: invitee.fp }, writer: owner.fp, bytes });
    }
    await w.settle(3);
    for (const n of w.nodes) await assertGone(n, id, n === owner ? ['accepted inbox-delete'] : []);
  });
}
