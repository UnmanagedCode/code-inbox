import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Invariant: a user install pulls no runtime dependency, so cc's installer never meets an install script.
// (Dev tools only build and test the UI; their own transitive scripts never reach a user install.)
test('package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies));
  for (const k of ['optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'peerDependencies']) assert.ok(!pkg[k] || Object.keys(pkg[k]).length === 0, k);
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts?.[hook], undefined, hook);
});
