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
  assert.deepEqual(loaded.settings, { name: 'alice', transport: { kind: 'file-share', dir: '/srv/share' }, notifyTarget: null });
  const onDisk = fs.readFileSync(file(dataDir), 'utf8');
  assert.deepEqual(JSON.parse(onDisk), loaded.settings);
  const mtime = fs.statSync(file(dataDir)).mtimeMs;
  assert.deepEqual((await createStore(dataDir).load()).settings, loaded.settings);
  assert.equal(fs.readFileSync(file(dataDir), 'utf8'), onDisk);
  assert.equal(fs.statSync(file(dataDir)).mtimeMs, mtime);

  const none = tmpDir();
  fs.writeFileSync(file(none), JSON.stringify({ name: null, shareDir: null, notifyTarget: null }));
  assert.deepEqual((await createStore(none).load()).settings, { name: null, transport: null, notifyTarget: null });
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
