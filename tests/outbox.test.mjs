import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OUTBOX_RETRY_MS, createEngine } from '../src/engine.js';
import { decodeRecord, encodeCard, encodeRecord } from '../src/records.js';
import { createStore } from '../src/store.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { loadIdentity } from '../src/identity.js';
import { TCP_REDIAL_MAX_MS, TCP_REDIAL_MIN_MS } from '../src/transport/tcp.js';
import { captureLog, fakeClock, makeInstall, makeNetwork, silentLog, syncAll, tmpDir, tree } from './helpers.mjs';
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
  assert.equal(a.engine.state().transport.outboxError.code, 'SHARE_UNAVAILABLE');
  assert.equal(fs.existsSync(shareDir), false, 'nothing recreated the share on the local disk');
  await tick(clock, a); // still unmounted: still waiting
  assert.equal(outboxOf(a), 1);
  assert.equal(fs.existsSync(shareDir), false);
  mount();
  await tick(clock, a);
  assert.equal(outboxOf(a), 0);
  assert.equal(a.engine.state().transport.outboxError, null);
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
  fs.mkdirSync(path.join(shareDir, SHARE_ROOT), { recursive: true }); // the mount appears, holding the share's root
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

// Invariant (T3): over TCP the timer re-sends through `send`, so an unreachable recipient is dialed only as its
// address's redial backoff allows: the dial times follow the doubling schedule, each at the first retry tick at or
// after the backoff ends, never one dial per tick.
test('outbox retries over TCP follow the redial backoff, doubling up to its maximum', async (t) => {
  const clock = fakeClock();
  const dead = await countingListener();
  const alice = await tcpNode('alice', { schedule: clock.schedule, now: clock.now });
  t.after(async () => { await alice.close(); await dead.close(); });
  const bob = await loadIdentity(tmpDir());
  const card = encodeCard(encodeRecord(bob, { type: 'announce', signer: bob.fp, ts: Date.now(), name: 'bob', addr: [dead.addr] }).bytes);
  const t0 = clock.now();
  await alice.engine.importCard(card); // dials bob once, in the background
  await alice.engine.invite(bob.fp);
  assert.equal(outboxOf(alice), 1);
  const settled = () => waitFor(() => alice.transport.stats().connections === 0, 'the dial to settle');
  await waitFor(() => dead.count === 1, 'the first dial');
  await settled();
  const dials = [0];
  for (let i = 0; i < 40; i += 1) {
    const before = dead.count;
    await tick(clock, alice);
    await settled();
    if (dead.count > before) dials.push(clock.now() - t0);
    assert.ok(dead.count - before <= 1, 'at most one dial per tick');
  }
  // The schedule: after the k-th failure wait min(MIN·2^(k-1), MAX), then dial at the next retry tick.
  const expected = [0];
  for (let k = 1, at = 0; ; k += 1) {
    const ready = at + Math.min(TCP_REDIAL_MIN_MS * 2 ** (k - 1), TCP_REDIAL_MAX_MS);
    at = Math.ceil(ready / OUTBOX_RETRY_MS) * OUTBOX_RETRY_MS;
    if (at > 40 * OUTBOX_RETRY_MS) break;
    expected.push(at);
  }
  assert.deepEqual(dials, expected);
  assert.ok(dials.length < 20, `${dials.length} dials in 40 ticks`);
  assert.equal(outboxOf(alice), 1);
});

// Invariant (T1): a write a re-send cannot make (here SHARE_UNSAFE: its writer subdir became a link) keeps waiting,
// is shown with its code and logged once, not on every tick; fixing the share delivers it and clears the error.
test('a re-send refused SHARE_UNSAFE keeps the entry, surfaces the error once, and clears after a fix', async (t) => {
  const clock = fakeClock();
  const log = captureLog();
  const { shareDir, installs } = await makeNetwork(['alice', 'bob'], { schedule: clock.schedule, log });
  const [a, b] = installs;
  t.after(async () => { for (const x of installs) await x.close(); });
  const { id, inbox } = await a.engine.invite(b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(id, true);
  await syncAll(installs);
  const mount = unmount(shareDir);
  await a.engine.sendMessage(inbox, 'held');
  mount();
  const own = path.join(shareDir, SHARE_ROOT, 'inboxes', inbox, a.fp);
  const outside = tmpDir('code-inbox-outside-');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.rmSync(own, { recursive: true, force: true });
  fs.symlinkSync(outside, own);
  const unsafeLines = () => log.lines.filter((l) => l.includes('SHARE_UNSAFE')).length;
  for (let i = 0; i < 4; i += 1) await tick(clock, a);
  assert.equal(outboxOf(a), 1);
  assert.equal(a.engine.state().transport.outboxError.code, 'SHARE_UNSAFE');
  assert.equal(unsafeLines(), 1, 'logged once for four failing ticks');
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmSync(own);
  await tick(clock, a);
  assert.equal(outboxOf(a), 0);
  assert.equal(a.engine.state().transport.outboxError, null);
  await b.engine.sync();
  assert.deepEqual(b.engine.messages(inbox).map((m) => m.body), ['held']);
});

// Invariant (T2): an existing share dir without the share's root (an unmounted mount point is an empty directory)
// takes no write: it waits, SHARE_UNAVAILABLE, until the root appears.
test('a share dir without its root takes no write until the root appears', async (t) => {
  const clock = fakeClock();
  const shareDir = tmpDir('code-inbox-mountpoint-');
  const dataDir = tmpDir('code-inbox-data-');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ name: 'alice', transport: { kind: 'file-share', dir: shareDir }, notifyTarget: null }));
  const a = await makeInstall(null, { dataDir, schedule: clock.schedule });
  t.after(() => a.close());
  await a.engine.announce();
  assert.equal(outboxOf(a), 1);
  assert.equal(a.engine.state().transport.outboxError.code, 'SHARE_UNAVAILABLE');
  assert.deepEqual(fs.readdirSync(shareDir), [], 'nothing written under the mount point');
  fs.mkdirSync(path.join(shareDir, SHARE_ROOT), { recursive: true });
  await tick(clock, a);
  assert.equal(outboxOf(a), 0);
  assert.equal(Object.keys(tree(path.join(shareDir, SHARE_ROOT, 'directory', a.fp))).length, 1);
});

// Invariant (T2): saving a share creates its root, so a share saved by a human takes writes at once.
test('saving a share creates its root', async (t) => {
  const shareDir = tmpDir('code-inbox-share-');
  const a = await makeInstall(shareDir, { name: 'alice' });
  t.after(() => a.close());
  assert.ok(fs.statSync(path.join(shareDir, SHARE_ROOT)).isDirectory());
  assert.equal(outboxOf(a), 0);
});

// Invariant (T6): the share/data dir overlap is re-checked at write time: a share that appears after boot as a link
// to a place containing the data dir is never written through. A fresh action is refused; a queued write waits.
test('a share that appears as a link above the data dir is refused SHARE_UNSAFE at write time', async (t) => {
  const clock = fakeClock();
  const base = tmpDir('code-inbox-base-');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir);
  const shareDir = path.join(tmpDir('code-inbox-mnt-'), 'share');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ name: 'alice', transport: { kind: 'file-share', dir: shareDir }, notifyTarget: null }));
  const a = await makeInstall(null, { dataDir, schedule: clock.schedule });
  t.after(() => a.close());
  await a.engine.announce(); // queued: the share is not there
  fs.mkdirSync(path.join(base, SHARE_ROOT), { recursive: true });
  fs.symlinkSync(base, shareDir);
  await tick(clock, a);
  assert.equal(outboxOf(a), 1);
  assert.equal(a.engine.state().transport.outboxError.code, 'SHARE_UNSAFE');
  await assert.rejects(a.engine.announce(), { code: 'SHARE_UNSAFE' });
  assert.deepEqual(fs.readdirSync(path.join(base, SHARE_ROOT)), [], 'nothing written next to the data dir');
});

// An engine over a stub transport whose send is `send`: the outbox's reaction to each kind of throw.
async function stubEngine(t, send, log) {
  const dataDir = tmpDir('code-inbox-data-');
  const store = createStore(dataDir, { log: silentLog });
  await store.load();
  const identity = await loadIdentity(dataDir);
  const transport = { capabilities: { directory: true, push: false }, addresses: () => [], start: async () => {}, setInterest() {}, send, sync: async () => {}, stop: async () => {} };
  const engine = createEngine({ store, identity, log, schedule: fakeClock().schedule, makeTransport: () => transport });
  t.after(() => engine.stop());
  await engine.boot();
  await engine.setTcp({ port: 0 }); // any config: the stub ignores it
  await engine.setName('alice');
  return engine;
}

// Invariant (T5): a write nobody is named for is kept when its send fails retryably (a system error) and dropped,
// with a log line, when it fails otherwise.
test('an owed write with no recipient is kept on a system error and dropped, logged, on any other', async (t) => {
  const log = captureLog();
  const io = await stubEngine(t, async () => { throw Object.assign(new Error('disk trouble'), { code: 'EIO' }); }, log);
  await io.announce();
  assert.equal(io.state().diagnostics.outbox, 1);
  assert.equal(io.state().transport.outboxError.code, 'EIO');
  const bug = await stubEngine(t, async () => { throw new Error('a bug'); }, log);
  await bug.announce();
  assert.equal(bug.state().diagnostics.outbox, 0);
  assert.equal(bug.state().transport.outboxError, null, 'a dropped write leaves no standing error');
  assert.ok(log.lines.some((l) => l.includes('dropped') && l.includes('a bug')), log.lines.join('\n'));
});

// Invariant (V1): after a save, a share root replaced by a link (`code-inbox/v1` or `code-inbox` itself) takes no
// write: a fresh action is refused SHARE_UNSAFE, a queued write stays owed with the error shown, and nothing lands
// at the link's target.
for (const [what, component] of [['the v1 root', SHARE_ROOT], ['code-inbox', SHARE_ROOT.split(path.sep)[0]]]) {
  test(`a share whose ${what} is replaced by a link after saving is never written through`, async (t) => {
    const clock = fakeClock();
    const { shareDir, installs } = await makeNetwork(['alice', 'bob'], { schedule: clock.schedule });
    const [a, b] = installs;
    t.after(async () => { for (const x of installs) await x.close(); });
    const { id, inbox } = await a.engine.invite(b.fp);
    await syncAll(installs);
    await b.engine.respondInvite(id, true);
    await syncAll(installs);
    const mount = unmount(shareDir);
    await a.engine.sendMessage(inbox, 'queued');
    mount();
    const target = tmpDir('code-inbox-target-');
    if (component === SHARE_ROOT) fs.mkdirSync(path.join(target, 'mirror'));
    const linked = path.join(shareDir, component);
    fs.renameSync(linked, `${linked}.real`);
    fs.symlinkSync(target, linked);
    await tick(clock, a);
    assert.equal(outboxOf(a), 1);
    assert.equal(a.engine.state().transport.outboxError.code, 'SHARE_UNSAFE');
    await assert.rejects(a.engine.sendMessage(inbox, 'fresh'), { code: 'SHARE_UNSAFE' });
    assert.deepEqual(Object.keys(tree(target)), [], 'nothing written at the link target');
    assert.ok(!fs.readdirSync(target).some((n) => n !== 'mirror'));
  });
}
