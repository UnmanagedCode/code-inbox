import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadIdentity } from '../src/identity.js';
import { tmpDir } from './helpers.mjs';
import { rawHubLink } from './hubHelpers.mjs';

// The hub's command-line entry, spawned as a real process with a scrubbed environment.

const HUB = fileURLToPath(new URL('../hub.js', import.meta.url));
const run = (args) => spawn(process.execPath, [HUB, ...args], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });

// Collects the child's output; `firstLine` resolves its first stdout line, `done` its exit.
function output(child) {
  let out = '';
  let err = '';
  let gotLine;
  const firstLine = new Promise((r) => { gotLine = r; });
  child.stdout.on('data', (c) => { out += c; if (out.includes('\n')) gotLine(out.split('\n')[0]); });
  child.stderr.on('data', (c) => { err += c; });
  const done = once(child, 'exit').then(([code]) => ({ code, out, err }));
  return { firstLine, done };
}

// Invariant: the hub runs standalone from host and port flags, serves registrations, and exits cleanly on SIGTERM.
test('the hub starts from host and port flags and stops on SIGTERM', async (t) => {
  const child = run(['--host', '127.0.0.1', '--port', '0']);
  t.after(() => child.kill('SIGKILL'));
  const { firstLine, done } = output(child);
  const line = await firstLine;
  const m = /^code-inbox hub listening on 127\.0\.0\.1:(\d+)$/.exec(line);
  assert.ok(m, line);
  const link = await rawHubLink(Number(m[1]), [await loadIdentity(tmpDir())]);
  t.after(() => link.destroy());
  assert.equal(link.frames.at(-1).t, 'ok');
  child.kill('SIGTERM');
  const { code, err } = await done;
  assert.equal(code, 0);
  assert.equal(err, '', 'no exposure warning on loopback');
  await link.whenClosed;
});

// Invariant: a bad or unknown flag is refused before anything listens: usage on stderr, a non-zero exit.
test('bad flags exit non-zero with usage', async () => {
  for (const args of [['--port', '70000'], ['--bogus'], ['--host', 'not a host']]) {
    const { code, out, err } = await output(run(args)).done;
    assert.equal(code, 2, args.join(' '));
    assert.match(err, /usage: node hub\.js/);
    assert.equal(out, '');
  }
});
