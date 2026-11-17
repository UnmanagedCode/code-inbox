import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OUTBOX_RETRY_MS } from '../src/engine.js';
import { decodeRecord, encodeCard, encodeRecord } from '../src/records.js';
import { createStore } from '../src/store.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { loadIdentity } from '../src/identity.js';
import { fakeClock, makeInstall, makeNetwork, silentLog, syncAll, tmpDir, tree } from './helpers.mjs';
import { countingListener, tcpNode, waitFor } from './tcpHelpers.mjs';

// The outbox keeps every write a transport could not take, and the engine re-sends it on its own: after a transport
// starts, and on the OUTBOX_RETRY_MS timer while anything waits. Clocks are fake: a retry tick is clock.advance.
// No test calls engine.sync() before the retry it asserts, so the timer alone must deliver.

// Takes the share "off its mount" (the configured dir no longer exists) and puts it back.
function unmount(shareDir) {
  const away = `${shareDir}.away`;
  fs.renameSync(shareDir, away);
  return () => fs.renameSync(away, shareDir);
}

const outboxOf = (x) => x.engine.state().diagnostics.outbox;
// One retry tick, then waits for the flush it started: a no-op action takes the engine lock behind it.
const tick = async (clock, x) => {
  clock.advance(OUTBOX_RETRY_MS);
  await x.engine.setName(x.engine.settings().name);
};

test('a send while the share is unmounted stays in the outbox, creates nothing, and is delivered on the next retry', async (t) => {
  const clock = fakeClock();
  const { shareDir, installs } = await makeNetwork(['alice', 'bob'], { schedule: clock.schedule });
  const [a, b] = installs;
  t.after(async () => { for (const x of installs) await x.close(); });
  const { id, inbox } = await a.engine.invite(b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(id, true);
  await syncAll(installs);
  const mount = unmount(shareDir);
  // The action succeeds; its write waits.
  assert.ok((await a.engine.sendMessage(inbox, 'while unmounted')).id);
  assert.equal(outboxOf(a), 1);
  assert.equal(a.engine.state().transport.unavailable, true);
  assert.equal(fs.existsSync(shareDir), false, 'nothing recreated the share on the local disk');
  await tick(clock, a); // still unmounted: still waiting
  assert.equal(outboxOf(a), 1);
  assert.equal(fs.existsSync(shareDir), false);
  mount();
  await tick(clock, a);
  assert.equal(outboxOf(a), 0);
  assert.equal(a.engine.state().transport.unavailable, false);
  await b.engine.sync();
  assert.deepEqual(b.engine.messages(inbox).map((m) => m.body), ['while unmounted']);
});

test('an announce addressed to nobody, written while the share is missing, reaches the share once it appears', async (t) => {
  const clock = fakeClock();
  const shareDir = path.join(tmpDir('code-inbox-mount-'), 'share');
  const dataDir = tmpDir('code-inbox-data-');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ name: 'alice', transport: { kind: 'file-share', dir: shareDir }, notifyTarget: null }));
  const a = await makeInstall(null, { dataDir, schedule: clock.schedule });
  t.after(() => a.close());
  await a.engine.announce(); // no identity known: `to` is []
  assert.equal(outboxOf(a), 1, 'the write is owed though nobody is named');
  assert.equal(fs.existsSync(shareDir), false);
  fs.mkdirSync(shareDir);
  await tick(clock, a);
  assert.equal(outboxOf(a), 0);
  const files = Object.keys(tree(path.join(shareDir, SHARE_ROOT)));
  assert.deepEqual(files.map((f) => f.split(path.sep).slice(0, 2).join('/')), [`directory/${a.fp}`]);
  const b = await makeInstall(shareDir, { name: 'bob' });
  t.after(() => b.close());
  await b.engine.sync();
  assert.deepEqual(b.engine.state().directory.map((d) => d.name), ['alice']);
});

test('an admission owed at boot while the share is missing completes once it appears', async (t) => {
  const clock = fakeClock();
  const { shareDir, installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  t.after(async () => { await b.close(); });
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await syncAll(installs);
  const inv = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await a.close();
  await b.engine.respondInvite(inv.id, true);
  // alice's backend accepted the acceptance and stopped before admitting bob; the share is down when she boots.
  const response = (await createStore(b.dataDir, { log: silentLog }).load()).accepted.find((e) => decodeRecord(e.bytes).payload.type === 'invite-response');
  const store = createStore(a.dataDir, { log: silentLog });
  await store.load();
  await store.appendAccepted({ id: response.id, route: response.route, bytes: response.bytes });
  const mount = unmount(shareDir);
  const again = await makeInstall(null, { dataDir: a.dataDir, schedule: clock.schedule });
  t.after(() => again.close());
  assert.equal(again.engine.state().transport.configured, true);
  assert.equal(outboxOf(again), 1, 'the admission is written locally and its delivery waits');
  mount();
  await tick(clock, again);
  assert.equal(outboxOf(again), 0);
  await b.engine.sync();
  assert.equal(b.engine.listInboxes().length, 1, 'bob sees himself admitted');
});

test('a file-share send that failed with a filesystem error leaves the outbox on a retry', async (t) => {
  const clock = fakeClock();
  const { shareDir, installs } = await makeNetwork(['alice', 'bob'], { schedule: clock.schedule });
  const [a, b] = installs;
  t.after(async () => { for (const x of installs) await x.close(); });
  const { id, inbox } = await a.engine.invite(b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(id, true);
  await syncAll(installs);
  // A file where the inbox's directory should be: the send throws (ENOTDIR / EEXIST), which used to sit in the
  // outbox until someone called engine.sync().
  const blocker = path.join(shareDir, SHARE_ROOT, 'inboxes', inbox);
  fs.rmSync(blocker, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, '');
  await a.engine.sendMessage(inbox, 'after a failure');
  assert.equal(outboxOf(a), 1);
  fs.rmSync(blocker);
  await tick(clock, a);
  assert.equal(outboxOf(a), 0);
  await b.engine.sync();
  assert.deepEqual(b.engine.messages(inbox).map((m) => m.body), ['after a failure']);
});

test('the retry timer is armed only while the outbox holds anything, and stops with the engine', async (t) => {
  const clock = fakeClock();
  const { shareDir, installs } = await makeNetwork(['alice'], { schedule: clock.schedule });
  const [a] = installs;
  const engineTimers = () => clock.pending();
  const idle = engineTimers();
  const mount = unmount(shareDir);
  await a.engine.announce();
  assert.equal(engineTimers(), idle + 1);
  mount();
  await tick(clock, a);
  assert.equal(outboxOf(a), 0);
  assert.equal(engineTimers(), idle);
  const again = unmount(shareDir);
  await a.engine.announce();
  assert.equal(engineTimers(), idle + 1);
  await a.close();
  again();
  assert.equal(clock.pending() <= idle, true, 'stopping cleared the retry timer');
});

// Over TCP the timer re-sends through `send`, so a recipient that is unreachable is dialed only as its address's
// backoff allows: many retry ticks in a row add no dials.
test('outbox retries over TCP do not storm an unreachable recipient with dials', async (t) => {
  const clock = fakeClock();
  const dead = await countingListener();
  const alice = await tcpNode('alice', { schedule: clock.schedule });
  t.after(async () => { await alice.close(); await dead.close(); });
  const bob = await loadIdentity(tmpDir());
  const card = encodeCard(encodeRecord(bob, { type: 'announce', signer: bob.fp, ts: Date.now(), name: 'bob', addr: [dead.addr] }).bytes);
  await alice.engine.importCard(card);
  await alice.engine.invite(bob.fp);
  assert.equal(outboxOf(alice), 1);
  await waitFor(() => dead.count >= 1, 'the first dial');
  const first = dead.count;
  for (let i = 0; i < 20; i += 1) {
    clock.advance(OUTBOX_RETRY_MS);
    await alice.engine.setName('alice'); // queues behind the retry flush (both take the engine lock)
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(dead.count <= first + 1, `${dead.count - first} dials after 20 retry ticks`);
  assert.equal(outboxOf(alice), 1);
});
