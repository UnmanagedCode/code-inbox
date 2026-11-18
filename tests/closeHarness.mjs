import assert from 'node:assert/strict';
import path from 'node:path';
import { createMcp } from '../src/mcp.js';
import { decodeRecord } from '../src/records.js';
import { createApp } from '../src/routes.js';
import { createStore } from '../src/store.js';
import { PAGE_HEADERS, listen, makeInstall, mcpCall, request, silentLog, syncAll, tmpDir } from './helpers.mjs';
import { opener } from './netHelpers.mjs';
import { freePort, settle as netSettle, waitFor } from './tcpHelpers.mjs';

// Multi-install worlds for the inbox-closing tests (tests/close.test.mjs): one test body runs on the file share and on
// the network. A world's nodes are whole installs, each with `name`, `fp`, `dataDir`, `engine`, `mcp`, `rest(method,
// path, body)`, `restart()` (from its data dir and stored settings) and `close()`; `up` says whether it runs. Network
// nodes also have `serve(reader, route, since)`.
//   'file-share': every install on one share; settle = scan rounds.
//   'network':    a star: node 0 listens on a fixed port (so it restarts on the same one), every other node connects
//                 only to it and imports its card; settle = maintain rounds.
// Everything is closed after the test.

export const KINDS = ['file-share', 'network'];
const SHORT = { redialMinMs: 20, redialMaxMs: 40 };

function stableNode(t, name, open) {
  const node = { name, up: false };
  const start = async (opts) => { Object.assign(node, await open(opts)); node.up = true; };
  node.close = async () => {
    if (!node.up) return;
    node.up = false;
    await node.closeNow();
  };
  node.restart = async () => { await node.close(); await start({ dataDir: node.dataDir }); };
  t.after(() => node.close());
  return { node, start };
}

async function fileShareNode(t, shareDir, name) {
  const { node, start } = stableNode(t, name, async ({ dataDir } = {}) => {
    const x = await makeInstall(dataDir ? null : shareDir, dataDir ? { dataDir } : { name });
    return { fp: x.fp, dataDir: x.dataDir, engine: x.engine, mcp: x.mcp, rest: x.rest, closeNow: x.close };
  });
  await start();
  return node;
}

async function networkNode(t, name, opts) {
  const open = opener(t);
  const { node, start } = stableNode(t, name, async (more = {}) => {
    const n = await open(name, { limits: SHORT, ...opts, ...more });
    const mcp = createMcp({ engine: n.engine });
    const server = createApp({ engine: n.engine, notifier: { view: () => null }, cc: {}, mcp, distDir: path.join(n.dataDir, 'no-dist'), log: silentLog });
    let port = null;
    return {
      fp: n.fp, dataDir: n.dataDir, engine: n.engine, mcp, card: n.card,
      // What this install serves `reader` on `route` past `since` (the engine view a transport pulls through).
      serve: (reader, route, since = 0) => n.view.serve(reader, route, since, Number.MAX_SAFE_INTEGER),
      async rest(method, p, body) {
        if (port === null) port = await listen(server);
        return request(port, { method, path: p, headers: PAGE_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
      },
      async closeNow() { await n.close(); await new Promise((r) => server.close(() => r())); },
    };
  });
  await start();
  return node;
}

// → {kind, nodes, settle(rounds), until(cond, what)}: `until` settles the running nodes until `cond` holds.
export async function world(t, kind, names) {
  const nodes = [];
  let settleUp;
  if (kind === 'file-share') {
    const shareDir = tmpDir('code-inbox-share-');
    for (const name of names) nodes.push(await fileShareNode(t, shareDir, name));
    settleUp = (rounds = 2) => syncAll(nodes.filter((n) => n.up), rounds);
  } else {
    const port = await freePort();
    const [first, ...rest] = names;
    nodes.push(await networkNode(t, first, { listen: { port } }));
    for (const name of rest) {
      const n = await networkNode(t, name, { listen: null, connections: [`127.0.0.1:${port}`] });
      await n.engine.importCard(nodes[0].card());
      nodes.push(n);
    }
    settleUp = (rounds = 2) => netSettle(nodes.filter((n) => n.up), rounds);
  }
  const w = {
    kind,
    nodes,
    settle: settleUp,
    until: (cond, what) => waitFor(async () => { await settleUp(1); return cond(); }, what),
  };
  await w.settle();
  return w;
}

// `owner` creates a shared inbox and invites `members`, who accept; resolves its id once every member is admitted.
export async function sharedInbox(w, owner, members, name = 'team') {
  const { id } = await owner.engine.createSharedInbox(name);
  await w.settle();
  for (const m of members) await owner.engine.inviteMember(id, m.fp);
  await w.settle();
  for (const m of members) await m.engine.respondInvite(m.engine.state().invites.incoming.find((i) => i.inbox === id).id, true);
  await w.settle(3);
  assert.equal(owner.engine.listInboxes().find((b) => b.id === id).members.length, members.length + 1, 'every member is admitted');
  return id;
}

// `a` invites `b` to a personal inbox and `b` accepts; resolves the inbox id.
export async function personalInbox(w, a, b) {
  const { id, inbox } = await a.engine.invite(b.fp);
  await w.settle();
  await b.engine.respondInvite(id, true);
  await w.settle();
  return inbox;
}

// Everything of `inbox` in a data dir, as sorted "<file> <type>" lines (cursors by key): accepted, pending and
// refused records, outbox entries, read cursors and pull cursors.
export async function holdings(dataDir, inbox) {
  const loaded = await createStore(dataDir, { log: silentLog }).load();
  const out = [];
  const of = (where, bytes) => {
    const d = decodeRecord(bytes);
    if (d.ok && d.payload.inbox === inbox) out.push(`${where} ${d.payload.type}`);
  };
  for (const e of loaded.accepted) of('accepted', e.bytes);
  for (const e of loaded.pending) of('pending', e.bytes);
  for (const e of loaded.outbox) of('outbox', e.bytes);
  for (const e of loaded.rejected) if (e.inbox === inbox) out.push(`rejected ${e.type}`);
  if (Object.hasOwn(loaded.cursors, inbox)) out.push('cursors');
  const pulls = await createStore(dataDir, { log: silentLog }).loadPullCursors();
  for (const routes of Object.values(pulls)) if (Object.hasOwn(routes, `inbox:${inbox}`)) out.push('pull-cursors');
  return out.sort();
}

// The agent tools and the page refuse `inbox` with `code`: read_messages, send_message and GET messages.
export async function refusedEverywhere(node, inbox, code) {
  for (const [tool, args] of [['read_messages', { inbox }], ['send_message', { inbox, body: 'x' }]]) {
    const r = await mcpCall(assert, node.mcp, tool, args, 'json');
    assert.equal(r.code, code, `${node.name}: ${tool}`);
  }
  const res = await node.rest('GET', `/api/inboxes/${inbox}/messages`);
  assert.equal(res.json?.code, code, `${node.name}: GET messages`);
}

// `node` holds nothing of `inbox` but `kept` (holdings lines): no inbox, directory row, invite, join request,
// message to notify of, pending record, or agent access (INBOX_UNKNOWN).
export async function assertGone(node, inbox, kept = []) {
  const s = node.engine.state();
  assert.ok(!node.engine.listInboxes().some((b) => b.id === inbox), `${node.name}: listed`);
  assert.ok(!s.sharedInboxes.some((b) => b.id === inbox), `${node.name}: a directory row`);
  for (const list of [s.invites.incoming, s.invites.outgoing, s.joinRequests.incoming, s.joinRequests.outgoing]) {
    assert.ok(!list.some((x) => x.inbox === inbox), `${node.name}: an invite or join request`);
  }
  assert.ok(!node.engine.unseenSince(0).some((m) => m.inbox === inbox), `${node.name}: mail to notify of`);
  assert.equal(s.diagnostics.pending, 0, `${node.name}: pending`);
  await refusedEverywhere(node, inbox, 'INBOX_UNKNOWN');
  assert.deepEqual(await holdings(node.dataDir, inbox), [...kept].sort(), `${node.name}: data dir`);
}

// The record lines of one type of `inbox` in `node`'s accepted log, decoded.
export async function acceptedOf(node, inbox, type) {
  const loaded = await createStore(node.dataDir, { log: silentLog }).load();
  return loaded.accepted.map((e) => ({ ...decodeRecord(e.bytes), bytes: e.bytes, route: e.route })).filter((d) => d.ok && d.payload.inbox === inbox && d.payload.type === type);
}

// The bodies of `inbox` that `node` reads, sorted.
export const bodies = (node, inbox) => node.engine.messages(inbox).map((m) => m.body).sort();
