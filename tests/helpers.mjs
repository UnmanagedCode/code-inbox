import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { wire } from '../server.js';

export function tmpDir(prefix = 'code-inbox-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const silentLog = { log() {}, warn() {}, error() {} };

// A log that keeps what it is told, for tests that assert a warning was logged.
export function captureLog() {
  const lines = [];
  const keep = (...a) => lines.push(a.map(String).join(' '));
  return { lines, log: keep, warn: keep, error: keep };
}

// Fake clock: `schedule` returns a cancel function; `advance` runs due timers in order. `now` is ms.
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    schedule(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Raw request with full control of the headers (fetch forbids some of them).
export function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// What the plugin's own page sends: JSON, same-origin.
export const PAGE_HEADERS = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };

const live = new Set();
process.once('exit', () => { for (const a of live) a.server.close(); });

// One whole install (store, identity, engine over the file share, notifier, MCP, HTTP app) with its own temp data
// dir. The share is polled (and TCP maintained) only when a test calls `engine.sync()` (or `syncAll`). `env` reaches cc.js (fakeCc's).
// With `name`, the share is set and the name announced. `rest(method, path, body)` calls the app as the page does.
export async function makeInstall(shareDir, { name, env = {}, schedule, dataDir = tmpDir('code-inbox-data-'), log = silentLog } = {}) {
  const app = await wire({ dataDir, distDir: path.join(dataDir, 'no-dist'), env, pollMs: 3_600_000, tcpSyncMs: 3_600_000, schedule, log });
  live.add(app);
  let port = null;
  const install = {
    ...app,
    dataDir,
    fp: app.identity.fp,
    name,
    async rest(method, p, body, headers = PAGE_HEADERS) {
      if (port === null) port = await listen(app.server);
      return request(port, { method, path: p, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async close() { live.delete(app); await app.close(); },
  };
  if (shareDir) await app.engine.setShare(shareDir);
  if (name) {
    await app.engine.setName(name);
    await app.engine.announce();
  }
  return install;
}

// Every install scans the share, twice round, so records written in one round are seen by all.
export async function syncAll(installs, rounds = 2) {
  for (let i = 0; i < rounds; i += 1) for (const x of installs) await x.engine.sync();
}

// `count` installs announced on one fresh share, all seeing each other.
export async function makeNetwork(names, opts = {}) {
  const shareDir = tmpDir('code-inbox-share-');
  const installs = [];
  for (const name of names) installs.push(await makeInstall(shareDir, { ...opts, name }));
  await syncAll(installs);
  return { shareDir, installs };
}

// a invites b to a personal inbox and b accepts; resolves the inbox id.
export async function connectPersonal(a, b, all = [a, b]) {
  const { id, inbox } = await a.engine.invite(b.fp);
  await syncAll(all);
  await b.engine.respondInvite(id, true);
  await syncAll(all);
  return inbox;
}

// Every file under `dir`, relative path → bytes.
export function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

// ---- a fake cc at the HTTP boundary (no live cc in any test) ----

// Serves the cc routes code-inbox calls: GET /api/instances (state.instances), GET /api/plugins, POST
// /mcp/tools/send_prompt and POST /api/plugins/:id/autostart. Every request lands in `state.hits` as
// "<METHOD> <path>"; send_prompt bodies in `state.prompts`, autostart bodies in `state.autostart`.
// `state.sendPrompt(body)` may answer send_prompt instead: {status, body}, or a promise of it (to hold the answer). `env` is what cc.js reads.
export async function fakeCc({ instances = [] } = {}) {
  const state = { instances, hits: [], prompts: [], autostart: [], sendPrompt: null, autoStart: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.hits.push(`${req.method} ${url.pathname}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const reply = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const json = () => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.method === 'POST' && !/^application\/json/.test(req.headers['content-type'] ?? '')) return reply({ error: 'unsupported media type' }, 415);
      if (req.method === 'GET' && url.pathname === '/api/instances') return reply(state.instances);
      if (req.method === 'GET' && url.pathname === '/api/plugins') return reply({ rows: [{ id: 'code-inbox', autoStart: state.autoStart, state: 'running' }], notices: [] });
      if (req.method === 'POST' && url.pathname === '/mcp/tools/send_prompt') {
        const body = json();
        state.prompts.push(body);
        const hooked = await state.sendPrompt?.(body);
        if (hooked) return reply(hooked.body, hooked.status);
        return reply({ sessionId: body.sessionId, status: 'turn' });
      }
      const auto = url.pathname.match(/^\/api\/plugins\/([^/]+)\/autostart$/);
      if (req.method === 'POST' && auto) {
        const body = json();
        state.autostart.push({ id: decodeURIComponent(auto[1]), ...body });
        state.autoStart = body.autoStart;
        return reply({ id: decodeURIComponent(auto[1]), autoStart: body.autoStart });
      }
      reply({ error: 'not found' }, 404);
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    state,
    env: { CONDUCTOR_URL: base, CONDUCTOR_MCP_URL: `${base}/mcp`, CONDUCTOR_PLUGIN_ID: 'code-inbox' },
    close() { for (const s of sockets) s.destroy(); server.close(); },
  };
}

// A conductor row as cc's GET /api/instances serves it.
export const conductorRow = (sessionId, status = 'idle', extra = {}) => ({ sessionId, project: '.conduct', conducted: false, status, displayLabel: `conductor ${sessionId}`, ...extra });

// ---- the MCP contract ----

// A plain-JS port of `checkSchema` and `validate` from code-conductor's `src/mcp/jsonSchemaSubset.ts`: the validator cc
// applies to a plugin tool's `outputSchema` (shape at manifest load, value on every typed reply). Tests never import
// cc's tree; re-sync when cc's subset changes.
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const isSchema = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const typeList = (t) => (t === undefined ? [] : Array.isArray(t) ? t : [t]);

export function checkSchema(schema, at = '#') {
  if (!isSchema(schema)) throw new Error(`${at}: a schema must be an object`);
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) throw new Error(`${at}: keyword '${k}' is outside the validated subset`);
  const types = typeList(schema.type);
  for (const t of types) if (typeof t !== 'string' || !TYPES.has(t)) throw new Error(`${at}: unknown type '${String(t)}'`);
  if (types.includes('object') && !('additionalProperties' in schema)) throw new Error(`${at}: an object schema must state additionalProperties`);
  if (schema.properties !== undefined) {
    if (!isSchema(schema.properties)) throw new Error(`${at}: properties must be an object`);
    for (const [k, s] of Object.entries(schema.properties)) checkSchema(s, `${at}/properties/${k}`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) throw new Error(`${at}: required must be an array`);
    for (const k of schema.required) if (!isSchema(schema.properties) || !(String(k) in schema.properties)) throw new Error(`${at}: required '${String(k)}' is not a property`);
  }
  const ap = schema.additionalProperties;
  if (ap !== undefined && typeof ap !== 'boolean') checkSchema(ap, `${at}/additionalProperties`);
  if (schema.items !== undefined) checkSchema(schema.items, `${at}/items`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error(`${at}: enum must be an array`);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new Error(`${at}: anyOf must be a non-empty array`);
    schema.anyOf.forEach((s, i) => checkSchema(s, `${at}/anyOf/${i}`));
  }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
const typeMatches = (t, v) => t === typeOf(v) || (t === 'number' && typeOf(v) === 'integer');

export function validate(schema, value, at = '$') {
  const errors = [];
  if (schema.type !== undefined) {
    const types = typeList(schema.type);
    if (!types.some((t) => typeMatches(t, value))) return [`${at}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (isSchema(value)) {
    const props = isSchema(schema.properties) ? schema.properties : {};
    for (const k of Array.isArray(schema.required) ? schema.required : []) if (!(String(k) in value)) errors.push(`${at}: missing required '${String(k)}'`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props && isSchema(props[k])) errors.push(...validate(props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property '${k}'`);
      else if (isSchema(schema.additionalProperties)) errors.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  if (Array.isArray(value) && isSchema(schema.items)) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`)));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => validate(s, value, at).length === 0)) errors.push(`${at}: matches no anyOf branch`);
  return errors;
}

export const MANIFEST = JSON.parse(fs.readFileSync(new URL('../conductor.plugin.json', import.meta.url), 'utf8'));
export const outputSchemaOf = (tool) => MANIFEST.mcp.tools.find((t) => t.name === tool).outputSchema;

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

// Calls a tool as cc does and asserts the reply shape cc's typed contract demands, so every call doubles as a
// contract check: json → exactly {structured}, valid against the manifest outputSchema; text → {text} prose;
// refusal → {error, code} with a machine code.
export async function mcpCall(assert, mcp, tool, args = {}, format) {
  const r = await mcp.handle({ tool, arguments: args, caller: { sessionId: 'test', project: 'test' }, ...(format === undefined ? {} : { format }) });
  if ('error' in r) {
    assert.deepEqual(Object.keys(r).sort(), ['code', 'error']);
    assert.match(r.code, CODE_RE);
    assert.equal(typeof r.error, 'string');
  } else if (format === 'json') {
    assert.deepEqual(Object.keys(r), ['structured']);
    const schema = outputSchemaOf(tool);
    checkSchema(schema);
    assert.deepEqual(validate(schema, JSON.parse(JSON.stringify(r.structured))), [], `${tool} json invalid`);
  } else {
    assert.deepEqual(Object.keys(r), ['text']);
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.length > 0);
  }
  return r;
}
