import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MANIFEST, checkSchema, makeInstall, tmpDir } from './helpers.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Mirrors cc's manifest validation: a tool input property may only use these keys and may not nest a schema.
const ALLOWED_PROP_KEYS = new Set(['type', 'description', 'enum', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'default']);
const FORBIDDEN = ['$ref', 'oneOf', 'anyOf', 'allOf', 'not'];

test('manifest identity and version match package.json', () => {
  assert.equal(MANIFEST.id, 'code-inbox');
  assert.equal(MANIFEST.pluginApi, 1);
  assert.equal(MANIFEST.version, pkg.version);
});

// Invariant: cc accepts every input schema (flat, allowed keys only, coherent required names).
test('every tool input schema stays inside the flat subset', () => {
  for (const tool of MANIFEST.mcp.tools) {
    const schema = tool.inputSchema;
    assert.equal(schema.type, 'object', tool.name);
    for (const bad of FORBIDDEN) assert.equal(JSON.stringify(schema).includes(`"${bad}"`), false, `${tool.name} avoids ${bad}`);
    for (const [prop, def] of Object.entries(schema.properties)) {
      for (const key of Object.keys(def)) assert.ok(ALLOWED_PROP_KEYS.has(key), `${tool.name}.${prop} uses ${key}`);
      assert.equal('properties' in def, false, `${tool.name}.${prop} is not nested`);
    }
    for (const r of schema.required ?? []) assert.ok(r in schema.properties, `${tool.name} requires a declared ${r}`);
  }
});

// Invariant: every tool is typed (so it exists in json format and the REST alias) and its outputSchema fits cc's subset.
test('every tool declares an outputSchema within cc\'s validated subset', () => {
  for (const tool of MANIFEST.mcp.tools) {
    assert.ok(tool.outputSchema, `${tool.name} is typed`);
    checkSchema(tool.outputSchema);
  }
});

// Invariant: every agent of the install may use the inboxes.
test('every tool is offered to every session', () => {
  for (const tool of MANIFEST.mcp.tools) assert.equal(tool.audience ?? 'all', 'all', tool.name);
});

// Invariant: cc reaches the backend where the manifest says: the health path answers, and the MCP endpoint takes
// cc's server-side call (JSON, no Origin) and answers a tool.
test('the backend serves the health path and MCP endpoint the manifest names', async () => {
  const x = await makeInstall(tmpDir());
  const health = await x.rest('GET', MANIFEST.backend.healthPath);
  assert.equal(health.status, 200);
  const r = await x.rest('POST', MANIFEST.mcp.endpoint, { tool: 'list_inboxes', arguments: {}, caller: { sessionId: 's', project: 'p' }, format: 'json' }, { 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { structured: { inboxes: [] } });
  await x.close();
});

// Invariant: every user-facing title of the plugin is the manifest name (the nav label and the page's <title>).
test('every user-facing title equals the manifest name', () => {
  assert.equal(MANIFEST.frontend.navLabel, MANIFEST.name);
  const html = fs.readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  assert.equal(/<title>([^<]*)<\/title>/.exec(html)?.[1], MANIFEST.name);
});
