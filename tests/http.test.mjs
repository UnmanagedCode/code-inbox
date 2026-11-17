import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { BODY_MAX_BYTES } from '../src/records.js';
import { CSP } from '../src/http.js';
import { PAGE_HEADERS, conductorRow, fakeCc, listen, makeInstall, makeNetwork, mcpCall, request, syncAll, tmpDir } from './helpers.mjs';

const hasSecurityHeaders = (r) => {
  assert.equal(r.headers['content-security-policy'], CSP, `CSP on ${r.status}`);
  assert.equal(r.headers['x-content-type-options'], 'nosniff', `nosniff on ${r.status}`);
};

function raw(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
  });
}

// Invariant: every answer, whatever its status, carries the CSP and nosniff (errors and malformed requests included).
test('CSP and nosniff on every status', async () => {
  const x = await makeInstall(null);
  const seen = new Map();
  const note = (r) => { hasSecurityHeaders(r); seen.set(r.status, true); };
  note(await x.rest('GET', '/api/health'));
  note(await x.rest('GET', '/api/nope'));
  note(await x.rest('PUT', '/api/health'));
  note(await x.rest('GET', '/'));
  note(await x.rest('GET', '/pluginBridge.js'));
  note(await x.rest('POST', '/api/announce', {}, { 'content-type': 'text/plain' }));
  note(await x.rest('POST', '/api/announce', {}, { ...PAGE_HEADERS, 'sec-fetch-site': 'cross-site' }));
  note(await x.rest('POST', '/api/announce', {}));
  note(await x.rest('POST', '/api/identity', { name: 'bad name' }));
  note(await x.rest('POST', '/api/inboxes/x/messages', { body: 'x'.repeat(300 * 1024) }));
  note(await x.rest('GET', '/api/inboxes/x/messages'));
  assert.deepEqual([...seen.keys()].sort(), [200, 400, 403, 404, 405, 409, 413, 415, 503].sort());
  const port = x.server.address().port;
  const bad = await raw(port, 'GARBAGE\r\n\r\n');
  assert.match(bad, /^HTTP\/1\.1 400/);
  assert.ok(bad.includes(`Content-Security-Policy: ${CSP}`) && bad.includes('X-Content-Type-Options: nosniff'));
  await x.close();
});

// Invariant: a mutating route only takes a JSON body (a browser's "simple" cross-site POST cannot send one).
test('a mutating route refuses a non-JSON body with 415', async () => {
  const x = await makeInstall(tmpDir());
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const r = await x.rest('POST', '/api/inboxes', { name: 'team' }, type ? { 'content-type': type } : {});
    assert.equal(r.status, 415, String(type));
  }
  assert.deepEqual(x.engine.state().sharedInboxes, []);
  await x.close();
});

// Invariant: a mutating request from another site is refused; the page (same-origin) and server-side callers pass.
test('cross-site mutating requests are refused; same-origin and Origin-less ones pass', async () => {
  const x = await makeInstall(tmpDir());
  const json = { 'content-type': 'application/json' };
  for (const headers of [{ ...json, 'sec-fetch-site': 'cross-site' }, { ...json, 'sec-fetch-site': 'same-site' }, { ...json, origin: 'http://evil.example' }]) {
    const r = await x.rest('POST', '/api/identity', { name: 'mallory' }, headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.equal(x.engine.settings().name, null, 'nothing was changed');
  for (const headers of [{ ...json, 'sec-fetch-site': 'same-origin' }, { ...json, 'sec-fetch-site': 'none' }, json]) {
    const r = await x.rest('POST', '/api/identity', { name: 'alice' }, headers);
    assert.equal(r.status, 200, JSON.stringify(headers));
  }
  await x.close();
});

// Invariant: the host's own assets are cc's to serve; standalone they 404 and never fall through to the page.
test('host URLs answer 404 standalone', async () => {
  const x = await makeInstall(null);
  for (const p of ['/pluginBridge.js', '/pluginTheme.css', '/assets/../server.js', '/src/engine.js']) assert.equal((await x.rest('GET', p)).status, 404, p);
  await x.close();
});

// Invariant: an unbuilt UI answers 503 plain text; a built one serves its index.
test('an unbuilt UI answers 503; a built one serves index.html', async () => {
  const x = await makeInstall(null);
  const r = await x.rest('GET', '/');
  assert.equal(r.status, 503);
  assert.match(r.headers['content-type'], /^text\/plain/);
  await x.close();
  const dataDir = tmpDir();
  const { wire } = await import('../server.js');
  const dist = tmpDir();
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>');
  const app = await wire({ dataDir, distDir: dist, env: {}, log: { log() {}, warn() {}, error() {} } });
  const port = await listen(app.server);
  const ok = await request(port, { path: '/' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /^text\/html/);
  await app.close();
});

// Invariant: the page's routes drive every human operation end to end.
test('the REST routes drive the human operations', async () => {
  const cc = await fakeCc({ instances: [conductorRow('S1')] });
  const shareDir = tmpDir('code-inbox-share-');
  const a = await makeInstall(null, { env: cc.env });
  const b = await makeInstall(null);
  const c = await makeInstall(null);
  const all = [a, b, c];
  const ok = async (x, method, p, body) => { const r = await x.rest(method, p, body); assert.equal(r.status, 200, `${method} ${p}: ${r.text}`); return r.json; };
  for (const [x, name] of [[a, 'alice'], [b, 'bob'], [c, 'carol']]) {
    await ok(x, 'POST', '/api/share', { dir: shareDir });
    await ok(x, 'POST', '/api/identity', { name });
    await ok(x, 'POST', '/api/announce', {});
  }
  await syncAll(all);
  const st = await ok(a, 'GET', '/api/state');
  assert.deepEqual(st.directory.map((d) => d.name).sort(), ['bob', 'carol']);
  assert.equal(st.identity.fp, a.fp);
  // personal: invite → accept
  const inv = await ok(a, 'POST', '/api/invites', { to: b.fp });
  await syncAll(all);
  await ok(b, 'POST', `/api/invites/${inv.id}/respond`, { accept: true });
  await syncAll(all);
  assert.deepEqual((await ok(a, 'GET', '/api/state')).inboxes.map((i) => i.id), [inv.inbox]);
  // shared: create → invite bob → bob accepts; carol requests → admitted; carol removed
  const { id: team } = await ok(a, 'POST', '/api/inboxes', { name: 'team' });
  await syncAll(all);
  const sinv = await ok(a, 'POST', `/api/inboxes/${team}/invites`, { to: b.fp });
  await syncAll(all);
  await ok(b, 'POST', `/api/invites/${sinv.id}/respond`, { accept: true });
  await ok(c, 'POST', `/api/inboxes/${team}/join`, {});
  await syncAll(all);
  const [req] = (await ok(a, 'GET', '/api/state')).joinRequests.incoming;
  await ok(a, 'POST', `/api/join-requests/${req.id}/respond`, { accept: true });
  await syncAll(all);
  const members = (x) => x.engine.listInboxes().find((i) => i.id === team)?.members.map((m) => m.name).sort();
  assert.deepEqual(members(c), ['alice', 'bob', 'carol']);
  await ok(a, 'POST', `/api/inboxes/${team}/members/${c.fp}/remove`, {});
  await syncAll(all);
  assert.deepEqual(members(b), ['alice', 'bob']);
  // notifications: the session list and the target
  const sessions = await ok(a, 'GET', '/api/sessions');
  assert.deepEqual(sessions.sessions.map((s) => s.sessionId), ['S1']);
  await ok(a, 'POST', '/api/notify', { sessionId: 'S1' });
  assert.equal((await ok(a, 'GET', '/api/state')).notify.target.sessionId, 'S1');
  await ok(a, 'POST', '/api/notify', { sessionId: null });
  assert.equal((await ok(a, 'GET', '/api/state')).notify.target, null);
  for (const x of all) await x.close();
  cc.close();
});

// Invariant: a human's message goes through the same send path as an agent's and shows in the inbox's list.
test('POST api/inboxes/:id/messages sends, answers {id, inbox}, and the message is listed', async () => {
  const { installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  const r = await a.rest('POST', `/api/inboxes/${inbox}/messages`, { body: 'typed by a human' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['id', 'inbox']);
  assert.equal(r.json.inbox, inbox);
  const list = await a.rest('GET', `/api/inboxes/${inbox}/messages`);
  assert.deepEqual(list.json.messages.map((m) => [m.id, m.body, m.sender.name]), [[r.json.id, 'typed by a human', 'alice']]);
  for (const x of installs) await x.close();
});

// Invariant: the REST route and send_message refuse the same input with the same code (one send path, no drift);
// the route owns only the HTTP status.
test('the messages route and send_message refuse the same inputs with the same codes', async () => {
  const { installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const { id: foreign } = await a.engine.createSharedInbox('team');
  const { id: own } = await b.engine.createSharedInbox('mine');
  await syncAll(installs);
  const lonely = await makeInstall(null);
  const cases = [
    { what: 'a non-member inbox', x: b, inbox: foreign, body: 'hi', code: 'NOT_MEMBER', status: 409 },
    { what: 'an unknown inbox', x: b, inbox: 'f'.repeat(32), body: 'hi', code: 'INBOX_UNKNOWN', status: 404 },
    { what: 'no share', x: lonely, inbox: own, body: 'hi', code: 'SHARE_UNCONFIGURED', status: 409 },
    { what: 'an oversize body', x: b, inbox: own, body: 'x'.repeat(BODY_MAX_BYTES + 1), code: 'BODY_TOO_LARGE', status: 413 },
    { what: 'an oversize escaped body', x: b, inbox: own, body: '\u0001'.repeat(BODY_MAX_BYTES), code: 'BODY_TOO_LARGE', status: 413 },
  ];
  for (const c of cases) {
    const viaRest = await c.x.rest('POST', `/api/inboxes/${c.inbox}/messages`, { body: c.body });
    const viaTool = await mcpCall(assert, c.x.mcp, 'send_message', { inbox: c.inbox, body: c.body }, 'json');
    assert.equal(viaRest.json.code, c.code, `REST: ${c.what}`);
    assert.equal(viaTool.code, c.code, `MCP: ${c.what}`);
    assert.equal(viaRest.status, c.status, c.what);
  }
  for (const x of [...installs, lonely]) await x.close();
});

// Invariant: the guard covers the messages route too.
test('the messages route refuses non-JSON (415) and cross-site (403) requests', async () => {
  const { installs } = await makeNetwork(['alice']);
  const [a] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  assert.equal((await a.rest('POST', `/api/inboxes/${inbox}/messages`, { body: 'x' }, { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' })).status, 415);
  assert.equal((await a.rest('POST', `/api/inboxes/${inbox}/messages`, { body: 'x' }, { ...PAGE_HEADERS, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.deepEqual(a.engine.messages(inbox), []);
  await a.close();
});

// Invariant: a malformed percent-escape in a route parameter is the caller's error (400), never a server fault.
test('a malformed percent-escape in a route parameter answers 400', async () => {
  const x = await makeInstall(tmpDir());
  for (const [method, p] of [['GET', '/api/inboxes/%E0%A4%A/messages'], ['POST', '/api/invites/%ZZ/respond']]) {
    const r = await x.rest(method, p, method === 'POST' ? { accept: true } : undefined);
    assert.equal(r.status, 400, p);
    assert.equal(r.json.code, 'BAD_REQUEST');
    hasSecurityHeaders(r);
  }
  await x.close();
});

// Invariant: a share this install must not write to refuses the action on both surfaces (SHARE_UNSAFE), and the
// refused message is neither shown locally nor queued for a retry.
test('a symlinked writer subdir refuses the send with SHARE_UNSAFE on REST and MCP, admitting nothing', async () => {
  const { shareDir, installs } = await makeNetwork(['alice']);
  const [a] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  const outside = tmpDir('code-inbox-outside-');
  const parent = path.join(shareDir, 'code-inbox', 'v1', 'inboxes', inbox);
  fs.rmSync(path.join(parent, a.fp), { recursive: true, force: true });
  fs.mkdirSync(parent, { recursive: true });
  fs.symlinkSync(outside, path.join(parent, a.fp));
  const viaRest = await a.rest('POST', `/api/inboxes/${inbox}/messages`, { body: 'hi' });
  assert.equal(viaRest.status, 409);
  assert.equal(viaRest.json.code, 'SHARE_UNSAFE');
  const viaTool = await mcpCall(assert, a.mcp, 'send_message', { inbox, body: 'hi' }, 'json');
  assert.equal(viaTool.code, 'SHARE_UNSAFE');
  assert.deepEqual(a.engine.messages(inbox), []);
  assert.equal(a.engine.state().diagnostics.outbox, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
  await a.close();
});
