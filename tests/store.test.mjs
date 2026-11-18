import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FILES, createStore } from '../src/store.js';
import { captureLog, tmpDir } from './helpers.mjs';

// Invariant: acceptance seqs are dense, increasing and survive a reload.
test('appendAccepted assigns increasing seqs that continue after a reload', async () => {
  const dataDir = tmpDir();
  const store = createStore(dataDir);
  await store.load();
  const route = { kind: 'directory' };
  assert.equal(await store.appendAccepted({ id: 'a'.repeat(32), route, bytes: Buffer.from('one') }), 1);
  assert.equal(await store.appendAccepted({ id: 'b'.repeat(32), route, bytes: Buffer.from('two') }), 2);
  const again = createStore(dataDir);
  const loaded = await again.load();
  assert.deepEqual(loaded.accepted.map((e) => [e.seq, e.bytes.toString()]), [[1, 'one'], [2, 'two']]);
  assert.equal(await again.appendAccepted({ id: 'c'.repeat(32), route, bytes: Buffer.from('three') }), 3);
});

// Invariant: a torn last line (a crash mid-append) loses only that record, and says so in the log.
test('a torn last line of accepted.ndjson is skipped and logged', async () => {
  const dataDir = tmpDir();
  const store = createStore(dataDir);
  await store.load();
  await store.appendAccepted({ id: 'a'.repeat(32), route: { kind: 'directory' }, bytes: Buffer.from('one') });
  fs.appendFileSync(path.join(dataDir, FILES.accepted), '{"seq":2,"id":"bbb');
  const log = captureLog();
  const loaded = await createStore(dataDir, { log }).load();
  assert.deepEqual(loaded.accepted.map((e) => e.seq), [1]);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /accepted\.ndjson line 2/);
});

// Invariant: the data dir is private to its owner.
test('load creates the data dir 0700', async () => {
  const dataDir = path.join(tmpDir(), 'data');
  await createStore(dataDir).load();
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
});

// Invariant: a data dir written before the transport setting existed boots into the current settings shape, once.
test('settings with shareDir migrate to transport once and the migration is idempotent', async () => {
  const file = (d) => path.join(d, FILES.settings);
  const dataDir = tmpDir();
  fs.writeFileSync(file(dataDir), JSON.stringify({ name: 'alice', shareDir: '/srv/share', notifyTarget: null }));
  const loaded = await createStore(dataDir).load();
  assert.deepEqual(loaded.settings, { name: 'alice', announced: null, transport: { kind: 'file-share', dir: '/srv/share' }, notifyTarget: null });
  const onDisk = fs.readFileSync(file(dataDir), 'utf8');
  assert.deepEqual({ announced: null, ...JSON.parse(onDisk) }, loaded.settings);
  const mtime = fs.statSync(file(dataDir)).mtimeMs;
  assert.deepEqual((await createStore(dataDir).load()).settings, loaded.settings);
  assert.equal(fs.readFileSync(file(dataDir), 'utf8'), onDisk);
  assert.equal(fs.statSync(file(dataDir)).mtimeMs, mtime);

  const none = tmpDir();
  fs.writeFileSync(file(none), JSON.stringify({ name: null, shareDir: null, notifyTarget: null }));
  assert.deepEqual((await createStore(none).load()).settings, { name: null, announced: null, transport: null, notifyTarget: null });
  assert.equal('shareDir' in JSON.parse(fs.readFileSync(file(none), 'utf8')), false);
});

// Invariant (T7): a damaged outbox.json can never steer a send: entries with an invalid route or a recipient that is
// not a fingerprint are dropped, each logged.
test('outbox entries with an invalid route or recipient are dropped on load', async () => {
  const dataDir = tmpDir();
  await createStore(dataDir).load();
  const fp = 'a'.repeat(64);
  const bytes = Buffer.from('x').toString('base64');
  fs.writeFileSync(path.join(dataDir, FILES.outbox), JSON.stringify([
    { route: { kind: 'mailbox', fp }, to: [fp], bytes },
    { route: { kind: 'inbox', id: '../../escape' }, to: [], bytes },
    { route: { kind: 'directory' }, to: ['not a fingerprint'], bytes },
    { route: { kind: 'directory' }, to: [] },
    'junk',
  ]));
  const log = captureLog();
  const loaded = await createStore(dataDir, { log }).load();
  assert.deepEqual(loaded.outbox.map((e) => e.route), [{ kind: 'mailbox', fp }]);
  assert.equal(log.lines.filter((l) => l.includes('outbox.json')).length, 4);
});

// Invariant (A1 D14): identities.json keeps, per fp, an announce that fp signed and whether a human imported its card;
// an entry whose bytes do not decode as that fp's announce is dropped on load and logged, the rest kept.
test('identities.json entries that do not verify are dropped on load', async () => {
  const { loadIdentity } = await import('../src/identity.js');
  const { encodeRecord } = await import('../src/records.js');
  const [alice, bob] = [await loadIdentity(tmpDir()), await loadIdentity(tmpDir())];
  const ann = (id, extra = {}) => encodeRecord(id, { type: 'announce', signer: id.fp, ts: 1, name: 'n', ...extra }).bytes.toString('base64url');
  const msg = encodeRecord(alice, { type: 'join-request', signer: alice.fp, ts: 1, to: bob.fp, inbox: 'a'.repeat(32) });
  const dataDir = tmpDir();
  const store = createStore(dataDir);
  await store.load();
  const good = { announce: ann(alice), imported: true };
  await store.saveIdentities({ [alice.fp]: good });
  assert.deepEqual((await createStore(dataDir).load()).identities, { [alice.fp]: good });
  fs.writeFileSync(path.join(dataDir, FILES.identities), JSON.stringify({
    [alice.fp]: good,
    [bob.fp]: { announce: ann(alice), imported: true }, // signed by someone else
    ['c'.repeat(64)]: { announce: 'not base64url!', imported: false },
    [`${bob.fp}x`]: { announce: ann(bob), imported: false }, // not a fingerprint
    ['d'.repeat(64)]: { announce: msg.bytes.toString('base64url'), imported: false }, // not an announce
    ['e'.repeat(64)]: { announce: ann(alice), imported: 'yes' },
  }));
  const log = captureLog();
  assert.deepEqual((await createStore(dataDir, { log }).load()).identities, { [alice.fp]: good });
  assert.equal(log.lines.filter((l) => l.includes('identities.json')).length, 5);
  assert.equal(FILES.contacts, undefined);
});

// Invariant: an acceptance seq is never reused. dropRecords rewrites accepted.ndjson and rejected.ndjson without the
// ids, and the next seq, after a reload too, stays above every seq ever assigned even when the newest line was dropped.
test('dropRecords rewrites accepted and rejected without the ids, and the next seq after a reload stays above the old maximum even when the newest line was dropped', async () => {
  const dataDir = tmpDir();
  const store = createStore(dataDir);
  await store.load();
  const route = { kind: 'directory' };
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(32));
  for (const id of [a, b, c]) await store.appendAccepted({ id, route, bytes: Buffer.from(id) });
  await store.appendRejected({ id: 'd'.repeat(32), reason: 'NOT_MEMBER', type: 'msg', inbox: null, signer: 'e'.repeat(64) });
  await store.appendRejected({ id: 'f'.repeat(32), reason: 'NOT_MEMBER', type: 'msg', inbox: null, signer: 'e'.repeat(64) });
  await store.dropRecords(new Set([b, c, 'd'.repeat(32)]));
  const loaded = await createStore(dataDir).load();
  assert.deepEqual(loaded.accepted.map((e) => [e.seq, e.id]), [[1, a]]);
  assert.deepEqual(loaded.rejected.map((e) => e.id), ['f'.repeat(32)]);
  assert.equal(loaded.lastSeq, 3, 'load reports the highest seq ever assigned');
  assert.equal(await store.appendAccepted({ id: 'g'.repeat(32), route, bytes: Buffer.from('g') }), 4, 'the same store');
  await store.dropRecords(new Set(['g'.repeat(32)]));
  const again = createStore(dataDir);
  await again.load();
  assert.equal(await again.appendAccepted({ id: 'h'.repeat(32), route, bytes: Buffer.from('h') }), 5, 'after a reload');
});

// Invariant: the purge list survives a restart; a torn last line (a crash mid-append) loses only that entry.
test('appendPurged round-trips through load; a torn last line is skipped', async () => {
  const dataDir = tmpDir();
  const store = createStore(dataDir);
  assert.deepEqual((await store.load()).purged, []);
  const entries = [{ id: 'a'.repeat(32), inbox: 'c'.repeat(32), dead: true }, { id: 'b'.repeat(32), inbox: 'c'.repeat(32), dead: false }];
  await store.appendPurged(entries.slice(0, 1));
  await store.appendPurged(entries.slice(1));
  fs.appendFileSync(path.join(dataDir, FILES.purged), '{"id":"ddd');
  const log = captureLog();
  const loaded = await createStore(dataDir, { log }).load();
  assert.deepEqual(loaded.purged, entries);
  assert.equal(log.lines.length, 1);
});
