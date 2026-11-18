import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from '../src/engine.js';
import { loadIdentity } from '../src/identity.js';
import { decodeRecord, encodeRecord } from '../src/records.js';
import { FILES, createStore } from '../src/store.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { connectPersonal, makeInstall, makeNetwork, silentLog, syncAll } from './helpers.mjs';
import { holdings } from './closeHarness.mjs';

// Boot closes the crash windows between accepting a record and acting on it. Each test fakes the crash by writing
// the data dir as a crashed backend would have left it, then boots a fresh install from it.

const shareFiles = (shareDir, ...parts) => {
  const dir = path.join(shareDir, SHARE_ROOT, ...parts);
  return fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f)));
};
const unshare = (dataDir) => {
  const file = path.join(dataDir, FILES.settings);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), transport: null }));
};

// Invariant: a pending record whose dependency was accepted before a crash is accepted at boot, and a pending entry
// already accepted is dropped, with no transport involved.
test('boot drains pending records and drops ones already accepted', async () => {
  const { shareDir, installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const inbox = await connectPersonal(a, b);
  await a.close();
  await b.engine.sendMessage(inbox, 'sent while alice was down');
  const [msg] = shareFiles(shareDir, 'inboxes', inbox, b.fp);
  const [response] = shareFiles(shareDir, 'mailbox', a.fp, b.fp);
  await createStore(a.dataDir, { log: silentLog }).savePending([
    { route: { kind: 'inbox', id: inbox }, bytes: msg },
    { route: { kind: 'mailbox', fp: a.fp }, bytes: response }, // already accepted before the crash
  ]);
  unshare(a.dataDir); // no transport: only the boot drain can accept the message
  const again = await makeInstall(null, { dataDir: a.dataDir });
  assert.deepEqual(again.engine.messages(inbox).map((m) => m.body), ['sent while alice was down']);
  assert.equal(again.engine.state().diagnostics.pending, 0);
  await again.close();
  await b.close();
});

// Invariant: an acceptance of the owner's shared invite that was accepted but not yet acted on when the backend
// stopped is acted on at the next boot.
test('boot admits an invitee whose acceptance was accepted before a crash', async () => {
  const { shareDir, installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await syncAll(installs);
  const inv = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await a.close();
  await b.engine.respondInvite(inv.id, true);
  const bytes = shareFiles(shareDir, 'mailbox', a.fp, b.fp).find((f) => decodeRecord(f).payload.type === 'invite-response');
  const store = createStore(a.dataDir, { log: silentLog });
  await store.load();
  await store.appendAccepted({ id: decodeRecord(bytes).id, route: { kind: 'mailbox', fp: a.fp }, bytes });
  const again = await makeInstall(null, { dataDir: a.dataDir });
  assert.deepEqual(again.engine.listInboxes()[0].members.map((m) => m.name).sort(), ['alice', 'bob']);
  await syncAll([again, b]);
  assert.equal(b.engine.listInboxes().length, 1, 'bob sees himself admitted');
  await again.close();
  await b.close();
});

// ---- closing an inbox (docs/protocol.md → Closing an inbox) ----

const recordsOf = async (dataDir) => (await createStore(dataDir, { log: silentLog }).load()).accepted.map((e) => ({ ...decodeRecord(e.bytes), bytes: e.bytes, route: e.route, seq: e.seq }));

// alice owns a shared inbox that bob joined by invite; bob has sent `body`.
async function sharedPair(body) {
  const { shareDir, installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await syncAll(installs);
  const inv = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(inv.id, true);
  await syncAll(installs, 3);
  await b.engine.sendMessage(inbox, body);
  await syncAll(installs);
  return { shareDir, a, b, inbox };
}

// Invariant: a delete accepted before a crash interrupted its purge is purged at boot: nothing of the inbox is left
// (log, pending, outbox, read cursor) and the delete is on the purge list, marked dead.
test('boot finishes a delete purge interrupted after the delete was accepted', async () => {
  const { a, b, inbox } = await sharedPair('hello');
  await a.engine.sendMessage(inbox, 'read by bob');
  await syncAll([a, b]);
  await b.engine.readMessages(inbox, {});
  await b.close();
  await a.engine.deleteInbox(inbox);
  const del = (await recordsOf(a.dataDir)).find((d) => d.payload.type === 'inbox-delete');
  const bob = await loadIdentity(b.dataDir);
  const owed = (await recordsOf(b.dataDir)).find((d) => d.payload.type === 'msg' && d.payload.signer === bob.fp); // in the log and still owed
  const waiting = encodeRecord(bob, { type: 'msg', signer: bob.fp, ts: Date.now(), inbox, body: 'waiting', epoch: 99, prev: null });
  const store = createStore(b.dataDir, { log: silentLog });
  await store.load();
  await store.appendAccepted({ id: del.id, route: del.route, bytes: del.bytes });
  await store.savePending([{ route: { kind: 'inbox', id: inbox }, bytes: waiting.bytes }]);
  await store.saveOutbox([{ route: { kind: 'inbox', id: inbox }, to: [a.fp], bytes: owed.bytes }]);
  assert.ok((await holdings(b.dataDir, inbox)).includes('cursors'), 'the crashed dir holds a read cursor');
  unshare(b.dataDir);
  const again = await makeInstall(null, { dataDir: b.dataDir });
  assert.deepEqual(await holdings(b.dataDir, inbox), []);
  const { purged } = await createStore(b.dataDir, { log: silentLog }).load();
  assert.ok(purged.some((e) => e.id === del.id && e.dead), 'the delete is on the purge list, dead');
  assert.equal(again.engine.state().diagnostics.pending, 0);
  await again.close();
  await a.close();
});

// Invariant ("accepted before it"): boot finishes a leave purge a crash interrupted, keeping the create and the leave;
// a later rejoin's history, accepted after the leave, survives every boot untouched.
test('boot finishes an interrupted leave purge and leaves the history of a later rejoin untouched', async () => {
  const { a, b, inbox } = await sharedPair('one');
  await b.close();
  const bob = await loadIdentity(b.dataDir);
  const epoch = a.engine.listInboxes().find((x) => x.id === inbox).members.length - 1;
  const leave = encodeRecord(bob, { type: 'inbox-leave', signer: bob.fp, ts: Date.now(), to: a.fp, inbox, epoch });
  const store = createStore(b.dataDir, { log: silentLog });
  await store.load();
  await store.appendAccepted({ id: leave.id, route: { kind: 'mailbox', fp: a.fp }, bytes: leave.bytes });
  await store.saveOutbox([{ route: { kind: 'mailbox', fp: a.fp }, to: [a.fp], bytes: leave.bytes }]); // still owed to the share
  let back = await makeInstall(null, { dataDir: b.dataDir });
  assert.deepEqual((await holdings(b.dataDir, inbox)).filter((h) => h !== 'outbox inbox-leave'), ['accepted inbox-create', 'accepted inbox-leave']);
  const { purged } = await createStore(b.dataDir, { log: silentLog }).load();
  assert.ok(purged.every((e) => e.inbox === inbox && !e.dead));
  assert.ok(purged.length >= 2, 'the invite and its acceptance are on the purge list');
  await syncAll([a, back], 3);
  assert.ok(!a.engine.listInboxes().find((x) => x.id === inbox).members.some((m) => m.fp === b.fp), 'the owner removed bob');
  await back.engine.requestJoin(inbox);
  await syncAll([a, back]);
  await a.engine.respondJoin(a.engine.state().joinRequests.incoming[0].id, true);
  await syncAll([a, back], 3);
  await back.engine.sendMessage(inbox, 'two');
  await syncAll([a, back]);
  assert.deepEqual(back.engine.messages(inbox).map((m) => m.body), ['one', 'two']);
  await back.close();
  // State of the rejoin, not leftovers of the leave: a pending record and a refused id it holds now.
  const waiting = encodeRecord(bob, { type: 'msg', signer: bob.fp, ts: Date.now(), inbox, body: 'waiting', epoch: 99, prev: null });
  await store.savePending([{ route: { kind: 'inbox', id: inbox }, bytes: waiting.bytes }]);
  await store.appendRejected({ id: 'e'.repeat(32), reason: 'NOT_MEMBER', type: 'msg', inbox, signer: 'f'.repeat(64) });
  const before = await holdings(b.dataDir, inbox);
  assert.ok(before.includes('pending msg') && before.includes('rejected msg'));
  back = await makeInstall(null, { dataDir: b.dataDir });
  assert.deepEqual(back.engine.messages(inbox).map((m) => m.body), ['one', 'two'], 'the rejoin survives a boot');
  assert.deepEqual(await holdings(b.dataDir, inbox), before);
  await back.close();
  await a.close();
});

// Invariant (reconcileOwed): a leave the owner accepted before a crash, without writing the removal, gets its removal
// at the next boot, exactly once.
test('boot writes the removal owed for a leave accepted before a crash', async () => {
  const { a, b, inbox } = await sharedPair('hi');
  await a.close();
  await b.engine.leaveInbox(inbox);
  const leave = (await recordsOf(b.dataDir)).find((d) => d.payload.type === 'inbox-leave');
  const store = createStore(a.dataDir, { log: silentLog });
  await store.load();
  await store.appendAccepted({ id: leave.id, route: leave.route, bytes: leave.bytes });
  const again = await makeInstall(null, { dataDir: a.dataDir });
  const removals = (await recordsOf(a.dataDir)).filter((d) => d.payload.type === 'member' && d.payload.op === 'remove' && d.payload.member === b.fp);
  assert.equal(removals.length, 1);
  assert.ok(!again.engine.listInboxes().find((x) => x.id === inbox).members.some((m) => m.fp === b.fp));
  await again.close();
  await b.close();
});

// A store over `dataDir` that "crashes" right after the write `after` completes: every later write throws, as if the
// process had died there. Reads still work. `crashed()` says whether the write `after` was reached.
function crashingStore(dataDir, after) {
  const store = createStore(dataDir, { log: silentLog });
  const out = { ...store, crashed: () => dead };
  let dead = false;
  for (const [k, fn] of Object.entries(store)) {
    if (typeof fn !== 'function' || k.startsWith('load')) continue;
    out[k] = async (...args) => {
      if (dead) throw new Error(`crashed before ${k}`);
      const r = await fn(...args);
      if (k === after) dead = true;
      return r;
    };
  }
  return out;
}

// bob's data dir, as a member of alice's inbox, holding every kind of local state of it: accepted records, a pending
// record, a refused id, an owed outbox entry and a read cursor. bob is stopped and has no transport.
async function seededMember() {
  const { a, b, inbox } = await sharedPair('hello');
  await a.engine.sendMessage(inbox, 'read by bob');
  await syncAll([a, b]);
  await b.engine.readMessages(inbox, {});
  await b.close();
  const bob = await loadIdentity(b.dataDir);
  const owed = (await recordsOf(b.dataDir)).find((d) => d.payload.type === 'msg' && d.payload.signer === bob.fp);
  const waiting = encodeRecord(bob, { type: 'msg', signer: bob.fp, ts: Date.now(), inbox, body: 'waiting', epoch: 99, prev: null });
  const store = createStore(b.dataDir, { log: silentLog });
  await store.load();
  await store.savePending([{ route: { kind: 'inbox', id: inbox }, bytes: waiting.bytes }]);
  await store.saveOutbox([{ route: { kind: 'inbox', id: inbox }, to: [a.fp], bytes: owed.bytes }]);
  await store.appendRejected({ id: 'e'.repeat(32), reason: 'NOT_MEMBER', type: 'msg', inbox, signer: 'f'.repeat(64) });
  unshare(b.dataDir);
  const held = await holdings(b.dataDir, inbox);
  for (const h of ['cursors', 'outbox msg', 'pending msg', 'rejected msg']) assert.ok(held.includes(h), `seeded: ${h}`);
  return { a, b, bob, inbox };
}

// Invariant (recoverable crash points): a receiver's purge writes the closing's removal from accepted.ndjson last, so
// a crash after any earlier durable step leaves the closing in the log for boot to purge again, and a crash after the
// last step leaves nothing to do. Whatever step a crash follows, the next boot leaves nothing of the inbox.
for (const step of ['appendPurged', 'savePending', 'saveOutbox', 'saveCursors', 'dropRecords']) {
  test(`a delete purge that crashes after ${step} leaves nothing of the inbox after the next boot`, async () => {
    const { a, b, inbox } = await seededMember();
    await a.engine.deleteInbox(inbox);
    const del = (await recordsOf(a.dataDir)).find((d) => d.payload.type === 'inbox-delete');
    const store = crashingStore(b.dataDir, step);
    const engine = createEngine({ store, identity: await loadIdentity(b.dataDir), log: silentLog, makeTransport: () => { throw new Error('no transport'); } });
    await engine.boot();
    await engine.ingest({ route: del.route, writer: a.fp, bytes: del.bytes }).catch((err) => assert.match(err.message, /crashed before/));
    assert.ok(store.crashed(), `the purge reached ${step}`);
    await engine.stop();
    const again = await makeInstall(null, { dataDir: b.dataDir });
    assert.deepEqual(await holdings(b.dataDir, inbox), []);
    assert.equal(again.engine.state().diagnostics.pending, 0);
    const { purged } = await createStore(b.dataDir, { log: silentLog }).load();
    assert.ok(purged.some((e) => e.id === del.id && e.dead));
    await again.close();
    await a.close();
  });
}

// Invariant: boot cleans an own closing's leftovers of every kind, not only accepted records: a pending record, a
// refused id or an outbox entry of the inbox left beside a leave whose accepted records are already gone.
test('boot cleans pending, refused and outbox leftovers beside an own leave', async () => {
  const { a, b, inbox } = await sharedPair('one');
  await b.engine.leaveInbox(inbox);
  await b.close();
  const bob = await loadIdentity(b.dataDir);
  const orphan = encodeRecord(bob, { type: 'msg', signer: bob.fp, ts: Date.now(), inbox, body: 'never logged', epoch: 1, prev: null });
  const waiting = encodeRecord(bob, { type: 'msg', signer: bob.fp, ts: Date.now(), inbox, body: 'waiting', epoch: 99, prev: null });
  const store = createStore(b.dataDir, { log: silentLog });
  await store.load();
  await store.savePending([{ route: { kind: 'inbox', id: inbox }, bytes: waiting.bytes }]);
  await store.saveOutbox([{ route: { kind: 'inbox', id: inbox }, to: [a.fp], bytes: orphan.bytes }]);
  await store.appendRejected({ id: 'e'.repeat(32), reason: 'NOT_MEMBER', type: 'msg', inbox, signer: 'f'.repeat(64) });
  unshare(b.dataDir);
  const again = await makeInstall(null, { dataDir: b.dataDir });
  assert.deepEqual(await holdings(b.dataDir, inbox), ['accepted inbox-create', 'accepted inbox-leave']);
  assert.equal(again.engine.state().diagnostics.pending, 0);
  await again.close();
  await a.close();
});

// Invariant: the same for an own revoke: a pending record or an outbox entry of the revoked inbox is cleaned at boot.
test('boot cleans pending and outbox leftovers beside an own revoke', async () => {
  const { installs: [a, b] } = await makeNetwork(['alice', 'bob']);
  const inbox = await connectPersonal(a, b);
  await b.engine.deleteInbox(inbox);
  await b.close();
  const bob = await loadIdentity(b.dataDir);
  const orphan = encodeRecord(bob, { type: 'msg', signer: bob.fp, ts: Date.now(), inbox, body: 'never logged' });
  const waiting = encodeRecord(bob, { type: 'msg', signer: bob.fp, ts: Date.now(), inbox, body: 'waiting' });
  const store = createStore(b.dataDir, { log: silentLog });
  await store.load();
  await store.savePending([{ route: { kind: 'inbox', id: inbox }, bytes: waiting.bytes }]);
  await store.saveOutbox([{ route: { kind: 'inbox', id: inbox }, to: [a.fp], bytes: orphan.bytes }]);
  unshare(b.dataDir);
  const again = await makeInstall(null, { dataDir: b.dataDir });
  assert.deepEqual(await holdings(b.dataDir, inbox), ['accepted inbox-delete']);
  assert.equal(again.engine.state().diagnostics.pending, 0);
  await again.close();
  await a.close();
});
