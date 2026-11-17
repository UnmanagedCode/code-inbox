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
// dir. The share is polled only when a test calls `engine.sync()` (or `syncAll`). `env` reaches cc.js (fakeCc's).
// With `name`, the share is set and the name announced. `rest(method, path, body)` calls the app as the page does.
export async function makeInstall(shareDir, { name, env = {}, schedule, dataDir = tmpDir('code-inbox-data-') } = {}) {
  const app = await wire({ dataDir, distDir: path.join(dataDir, 'no-dist'), env, pollMs: 3_600_000, schedule, log: silentLog });
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
