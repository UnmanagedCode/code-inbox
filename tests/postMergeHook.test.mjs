import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.mjs';

const HOOK = new URL('../.code-conductor/post-worktree-merge.sh', import.meta.url).pathname;
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const git = (cwd, ...args) => {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// A temp repo with one base commit and a fake `npm` that logs `$PWD argv` to a file and exits with FAKE_NPM_EXIT.
function fixture() {
  const root = fs.realpathSync(tmpDir());
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'frontend/src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.mkdirSync(bin);
  const log = path.join(root, 'npm.log');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "$PWD $*" >> "$FAKE_NPM_LOG"\nexit "${FAKE_NPM_EXIT:-0}"\n', { mode: 0o755 });
  for (const f of ['package.json', 'frontend/src/x.tsx', 'src/engine.js']) fs.writeFileSync(path.join(repo, f), '1\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const pre = git(repo, 'rev-parse', 'HEAD');
  return {
    repo, log, pre,
    change(file) {
      fs.writeFileSync(path.join(repo, file), `${Math.random()}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', `change ${file}`);
      return git(repo, 'rev-parse', 'HEAD');
    },
    run(post, { cwd = repo, exit = 0 } = {}) {
      return spawnSync('bash', [HOOK], {
        cwd, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_LOG: log, FAKE_NPM_EXIT: String(exit), CC_PRE_MERGE_SHA: this.pre, CC_POST_MERGE_SHA: post },
      });
    },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

// Invariant: a merge that changes the UI sources rebuilds dist (the stale-dist blank page), once, in the target.
test('a merge changing frontend/ runs `npm run prepare` once in the target', () => {
  const f = fixture();
  const r = f.run(f.change('frontend/src/x.tsx'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), [`${f.repo} run prepare`]);
  assert.match(r.stdout.trim().split('\n').at(-1), /rebuilt \(npm run prepare\)/);
});

// Invariant: a dependency change installs (which also builds), never a second build.
test('a merge changing package.json runs `npm install` and nothing else', () => {
  const f = fixture();
  const r = f.run(f.change('package.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), [`${f.repo} install`]);
});

// Invariant: a merge that cannot change the built UI costs no build.
test('a merge touching only backend code does not build', () => {
  const f = fixture();
  const r = f.run(f.change('src/engine.js'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), []);
});

// Invariant: a task merging into a linked worktree never builds there; only the main checkout serves the UI.
test('a linked-worktree target is skipped', () => {
  const f = fixture();
  const post = f.change('frontend/src/x.tsx');
  const linked = path.join(path.dirname(f.repo), 'linked');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'feature', linked, post);
  const r = f.run(post, { cwd: linked });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), []);
});

// Invariant: a failed build is loud and last in the output (cc's merge toast quotes only the last lines).
test('a failing build exits non-zero and ends with BUILD FAILED', () => {
  const f = fixture();
  const r = f.run(f.change('frontend/src/x.tsx'), { exit: 1 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.trim().split('\n').at(-1), /BUILD FAILED/);
});
