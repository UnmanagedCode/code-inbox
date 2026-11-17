import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeRecord } from '../src/records.js';
import { FILES, createStore } from '../src/store.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { connectPersonal, makeInstall, makeNetwork, silentLog, syncAll } from './helpers.mjs';

// Boot closes the crash windows between accepting a record and acting on it. Each test fakes the crash by writing
// the data dir as a crashed backend would have left it, then boots a fresh install from it.

const shareFiles = (shareDir, ...parts) => {
  const dir = path.join(shareDir, SHARE_ROOT, ...parts);
  return fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f)));
};
const unshare = (dataDir) => {
  const file = path.join(dataDir, FILES.settings);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), shareDir: null }));
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
