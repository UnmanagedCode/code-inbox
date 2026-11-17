// Spawns the real `node server.js` with a scrubbed env: no PROJECTS_ROOT, a temp data dir, PORT=0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { request, tmpDir } from './helpers.mjs';

const root = new URL('..', import.meta.url).pathname;
const live = new Set();
process.once('exit', () => { for (const c of live) c.kill('SIGKILL'); });

function run(env) {
  const scrubbed = { PATH: process.env.PATH, ...env };
  const proc = spawn(process.execPath, ['server.js'], { cwd: root, env: scrubbed, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(proc);
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.once('close', (code) => { live.delete(proc); resolve(code); }));
  return { proc, out: () => out, exited };
}

async function waitFor(fn, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Invariant: with only cc's child env (and no PROJECTS_ROOT) the backend boots, listens on loopback and answers health.
test('the backend boots from a scrubbed env and answers health', async () => {
  const dataDir = path.join(tmpDir(), 'data');
  const b = run({ CONDUCTOR_PLUGIN_DATA_DIR: dataDir, PORT: '0' });
  try {
    const m = await waitFor(() => /listening on 127\.0\.0\.1:(\d+)/.exec(b.out()));
    const r = await request(Number(m[1]), { path: '/api/health' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  } finally {
    b.proc.kill('SIGTERM');
  }
  assert.equal(await b.exited, 0, 'SIGTERM shuts down cleanly');
});

// Invariant: without its data dir (where the private key lives) the backend refuses to start.
test('the backend exits non-zero without a data dir, or with a relative one', async () => {
  for (const env of [{ PORT: '0' }, { PORT: '0', CONDUCTOR_PLUGIN_DATA_DIR: 'relative/data' }]) {
    const b = run(env);
    assert.notEqual(await b.exited, 0, JSON.stringify(env));
    assert.match(b.out(), /CONDUCTOR_PLUGIN_DATA_DIR/);
  }
});
