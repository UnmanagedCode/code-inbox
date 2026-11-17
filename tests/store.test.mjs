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
