import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { decodeRecord } from '../src/records.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { makeInstall, makeNetwork, syncAll } from './helpers.mjs';

const WRITERS = 4;
const PER_WRITER = 75;
const WRITER = new URL('./fixtures/writer.mjs', import.meta.url).pathname;

function runWriter(args) {
  return new Promise((resolve, reject) => {
    const child = fork(WRITER, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${err}`))));
  });
}

// Invariant: per-writer subdirs are the only concurrency mechanism needed: several processes writing one inbox at
// once lose, duplicate and corrupt nothing; every install sees every message exactly once.
test('concurrent writer processes: every install sees every message exactly once, none corrupt', { timeout: 120_000 }, async () => {
  const names = ['owner', ...Array.from({ length: WRITERS }, (_, i) => `w${i}`)];
  const { shareDir, installs } = await makeNetwork(names);
  const [owner, ...writers] = installs;
  const { id: inbox } = await owner.engine.createSharedInbox('busy');
  await syncAll(installs);
  for (const w of writers) {
    await w.engine.requestJoin(inbox);
    await syncAll(installs);
    await owner.engine.respondJoin(owner.engine.state().joinRequests.incoming[0].id, true);
  }
  await syncAll(installs);
  for (const w of writers) assert.equal(w.engine.listInboxes().length, 1, `${w.name} is a member`);
  // Hand each writer's data dir to its own process.
  const dirs = writers.map((w) => w.dataDir);
  for (const w of writers) await w.close();
  await Promise.all(dirs.map((d, i) => runWriter([d, inbox, String(PER_WRITER), `w${i}`])));

  const expected = Array.from({ length: WRITERS }, (_, i) => Array.from({ length: PER_WRITER }, (__, j) => `w${i}-${j}`)).flat().sort();
  const files = fs.readdirSync(path.join(shareDir, SHARE_ROOT, 'inboxes', inbox), { recursive: true }).filter((f) => f.endsWith('.rec'));
  for (const f of files) assert.equal(decodeRecord(fs.readFileSync(path.join(shareDir, SHARE_ROOT, 'inboxes', inbox, f))).ok, true, `${f} decodes`);
  const readers = [owner, ...await Promise.all(dirs.map((dataDir) => makeInstall(null, { dataDir })))];
  await syncAll(readers);
  for (const r of readers) {
    const msgs = r.engine.messages(inbox);
    assert.deepEqual(msgs.map((m) => m.body).sort(), expected, 'every message, once');
    assert.equal(new Set(msgs.map((m) => m.id)).size, msgs.length);
    assert.equal(r.engine.state().diagnostics.rejected, 0);
  }
  for (const r of readers) await r.close();
});
