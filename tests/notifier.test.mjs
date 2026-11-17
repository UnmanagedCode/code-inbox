import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFY_DEBOUNCE_MS, NOTIFY_RETRY_MS } from '../src/notifier.js';
import { conductorRow, connectPersonal, fakeCc, fakeClock, makeInstall, syncAll, tmpDir } from './helpers.mjs';

// alice's install notifies conductor session S1 (via fakeCc, on a fake clock); bob sends her mail.
const SENTINEL = 'SENTINEL-BODY-7f3a do not leak me';

async function setup({ status = 'idle' } = {}) {
  const cc = await fakeCc({ instances: [conductorRow('S1', status), conductorRow('S2', 'idle', { conducted: true })] });
  const clock = fakeClock();
  const shareDir = tmpDir('code-inbox-share-');
  const a = await makeInstall(shareDir, { name: 'alice', env: cc.env, schedule: clock.schedule });
  const b = await makeInstall(shareDir, { name: 'bob' });
  await syncAll([a, b]);
  const inbox = await connectPersonal(a, b);
  // Fires due timers, then waits for the flush they started.
  const tick = async (ms = NOTIFY_DEBOUNCE_MS) => { clock.advance(ms); await a.notifier.settled(); };
  const fromBob = async (n = 1) => {
    for (let i = 0; i < n; i += 1) await b.engine.sendMessage(inbox, `${SENTINEL} #${i}`);
    await a.engine.sync();
  };
  return { cc, clock, shareDir, a, b, inbox, tick, fromBob, close: async () => { await a.close(); await b.close(); cc.close(); } };
}

// Invariant: assigning a target turns on cc's auto-start for this plugin (so the notifier runs from cc's boot).
test('assigning a target calls cc autostart with autoStart:true and stores the target', async () => {
  const s = await setup();
  const r = await s.a.rest('POST', '/api/notify', { sessionId: 'S1' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(s.cc.state.autostart, [{ id: 'code-inbox', autoStart: true }]);
  assert.equal(r.json.autoStart.ok, true);
  assert.equal(s.a.engine.settings().notifyTarget.sessionId, 'S1');
  await s.close();
});

// Invariant: only a top-level conductor can be the target.
test('a conducted or unknown session is refused as a target: SESSION_UNKNOWN', async () => {
  const s = await setup();
  for (const sessionId of ['S2', 'nope']) {
    const r = await s.a.rest('POST', '/api/notify', { sessionId });
    assert.equal(r.json.code, 'SESSION_UNKNOWN');
  }
  assert.deepEqual(s.cc.state.autostart, []);
  await s.close();
});

// Invariant: mail that existed when the target was assigned is never announced.
test('mail existing at assignment is not notified', async () => {
  const s = await setup();
  await s.fromBob(2);
  await s.a.notifier.setTarget({ sessionId: 'S1', label: 'main' });
  await s.tick();
  await s.tick(NOTIFY_RETRY_MS);
  assert.deepEqual(s.cc.state.prompts, []);
  await s.close();
});

// Invariant: a burst becomes one prompt with counts per inbox and sender, naming no body.
test('a burst is coalesced into one prompt with counts and never a body', async () => {
  const s = await setup();
  await s.a.notifier.setTarget({ sessionId: 'S1', label: 'main' });
  await s.fromBob(3);
  await s.tick();
  assert.equal(s.cc.state.prompts.length, 1);
  const [{ sessionId, text }] = s.cc.state.prompts;
  assert.equal(sessionId, 'S1');
  assert.match(text, /3 from bob \[[0-9a-f]{16}\]/);
  assert.ok(text.includes(s.inbox.slice(0, 8)));
  assert.match(text, /code-inbox__read_messages/);
  assert.equal(text.includes('SENTINEL'), false, 'no body in the prompt');
  await s.close();
});

// Invariant: this install's own messages never notify it.
test('own messages do not notify', async () => {
  const s = await setup();
  await s.a.notifier.setTarget({ sessionId: 'S1', label: 'main' });
  await s.a.engine.sendMessage(s.inbox, 'from alice herself');
  await s.tick();
  assert.deepEqual(s.cc.state.prompts, []);
  await s.close();
});

// Invariant: nothing is sent into a busy conductor; the notification waits and goes out once it is idle.
test('deferred while the target is busy, then delivered when idle', async () => {
  const s = await setup({ status: 'turn' });
  await s.a.notifier.setTarget({ sessionId: 'S1', label: 'main' });
  await s.fromBob(1);
  await s.tick();
  assert.deepEqual(s.cc.state.prompts, []);
  assert.match(s.a.notifier.view().lastError.reason, /turn/);
  s.cc.state.instances[0].status = 'idle';
  await s.tick(NOTIFY_RETRY_MS);
  assert.equal(s.cc.state.prompts.length, 1);
  assert.equal(s.a.notifier.view().owed, 0);
  await s.close();
});

// Invariant: a target that is not listed (exited, not resumed) keeps the notification pending; it is never resumed.
test('deferred while the target is not listed', async () => {
  const s = await setup();
  await s.a.notifier.setTarget({ sessionId: 'S1', label: 'main' });
  const rows = s.cc.state.instances;
  s.cc.state.instances = [];
  await s.fromBob(1);
  await s.tick();
  assert.deepEqual(s.cc.state.prompts, []);
  s.cc.state.instances = rows;
  await s.tick(NOTIFY_RETRY_MS);
  assert.equal(s.cc.state.prompts.length, 1);
  await s.close();
});

// Invariant: a refused send (SESSION_NOT_LIVE, a transient refusal) keeps the counts and is retried.
test('a refused send is retried with the same counts', async () => {
  const s = await setup();
  await s.a.notifier.setTarget({ sessionId: 'S1', label: 'main' });
  s.cc.state.sendPrompt = () => ({ status: 200, body: { ok: false, code: 'SESSION_NOT_LIVE', reason: 'not live' } });
  await s.fromBob(2);
  await s.tick();
  assert.equal(s.cc.state.prompts.length, 1, 'one refused attempt');
  assert.match(s.a.notifier.view().lastError.reason, /SESSION_NOT_LIVE/);
  s.cc.state.sendPrompt = null;
  await s.tick(NOTIFY_RETRY_MS);
  assert.equal(s.cc.state.prompts.length, 2);
  assert.match(s.cc.state.prompts[1].text, /2 from bob/);
  assert.equal(s.a.notifier.view().lastError, null);
  await s.close();
});

// Invariant: the watermark persists: a restart neither repeats a delivered notification nor loses an owed one.
test('a restart does not re-notify delivered mail and still delivers owed mail', async () => {
  const s = await setup();
  await s.a.notifier.setTarget({ sessionId: 'S1', label: 'main' });
  await s.fromBob(1);
  await s.tick();
  assert.equal(s.cc.state.prompts.length, 1);
  await s.a.close();
  const clock = fakeClock();
  const again = await makeInstall(null, { dataDir: s.a.dataDir, env: s.cc.env, schedule: clock.schedule });
  clock.advance(NOTIFY_DEBOUNCE_MS);
  await again.notifier.settled();
  assert.equal(s.cc.state.prompts.length, 1, 'nothing re-sent');
  // Owed when the backend stops (the target was busy): delivered by the next run.
  s.cc.state.instances[0].status = 'turn';
  await s.b.engine.sendMessage(s.inbox, 'before the second restart');
  await again.engine.sync();
  clock.advance(NOTIFY_DEBOUNCE_MS);
  await again.notifier.settled();
  assert.equal(s.cc.state.prompts.length, 1, 'deferred: the target is busy');
  await again.close();
  s.cc.state.instances[0].status = 'idle';
  const clock2 = fakeClock();
  const third = await makeInstall(null, { dataDir: s.a.dataDir, env: s.cc.env, schedule: clock2.schedule });
  clock2.advance(NOTIFY_DEBOUNCE_MS);
  await third.notifier.settled();
  assert.equal(s.cc.state.prompts.length, 2);
  assert.match(s.cc.state.prompts[1].text, /1 from bob/);
  await third.close();
  await s.b.close();
  s.cc.close();
});
