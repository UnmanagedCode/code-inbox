import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { loadIdentity } from '../src/identity.js';
import { createStore } from '../src/store.js';
import { assertTransport, routeKey } from '../src/transport/index.js';
import { createFileShare } from '../src/transport/fileShare.js';
import { silentLog, tmpDir } from './helpers.mjs';

// One contract, run against every Transport implementation: it proves the engine works through the interface
// alone. Each implementation provides `network()` → {makeTransport(identity, shareDir), settle()}.

// An in-memory push transport: records reach online peers' sinks immediately; a send to an offline peer comes back
// `pending`, and when the peer comes online every other transport's sink hears peerOnline(fp). Directory records
// go to every online peer (it stands in for a directory-capable push transport).
function memoryHub() {
  const nodes = new Map(); // fp → {sink, online, interest:Set<routeKey>}
  const deliver = (node, route, writer, bytes) => (node.online && node.sink && (route.kind === 'directory' || node.interest.has(routeKey(route)))
    ? node.sink.record({ route, writer, bytes }) : null);
  return {
    setOnline(fp, online) {
      nodes.get(fp).online = online;
      if (online) for (const [other, n] of nodes) if (other !== fp && n.online) n.sink.peerOnline(fp);
    },
    makeTransport(identity) {
      const node = { sink: null, online: true, interest: new Set() };
      nodes.set(identity.fp, node);
      return {
        capabilities: { directory: true, push: true },
        addresses: () => [`mem://${identity.fp.slice(0, 8)}`],
        async start(sink) { node.sink = sink; },
        setInterest(routes) { node.interest = new Set(routes.map(routeKey)); },
        async send(bytes, { route, to }) {
          const delivered = [];
          const pending = [];
          const targets = route.kind === 'directory' ? [...nodes.keys()].filter((fp) => fp !== identity.fp) : to;
          for (const fp of targets) {
            const n = nodes.get(fp);
            if (n?.online) { await deliver(n, route, identity.fp, bytes); delivered.push(fp); } else pending.push(fp);
          }
          return { delivered: delivered.filter((fp) => to.includes(fp)), pending: pending.filter((fp) => to.includes(fp)) };
        },
        async sync() {},
        async stop() { node.online = false; },
      };
    },
  };
}

const IMPLEMENTATIONS = {
  fileShare: () => ({ makeTransport: (identity, shareDir) => createFileShare({ shareDir, selfFp: identity.fp, pollMs: 3_600_000, log: silentLog }), push: false }),
  memoryPush: () => { const hub = memoryHub(); return { makeTransport: (identity) => hub.makeTransport(identity), push: true, hub }; },
};

async function network(impl, names) {
  const net = IMPLEMENTATIONS[impl]();
  const shareDir = tmpDir('code-inbox-share-');
  const nodes = [];
  for (const name of names) {
    const dataDir = tmpDir('code-inbox-data-');
    const store = createStore(dataDir, { log: silentLog });
    await store.load();
    const identity = await loadIdentity(dataDir);
    const node = { name, fp: identity.fp, store, transport: null };
    node.engine = createEngine({ store, identity, log: silentLog, makeTransport: () => { node.transport = net.makeTransport(identity, shareDir); return node.transport; } });
    await node.engine.boot();
    await node.engine.setShare(shareDir);
    await node.engine.setName(name);
    nodes.push(node);
  }
  const settle = async () => { for (let i = 0; i < 2; i += 1) for (const n of nodes) await n.engine.sync(); };
  for (const n of nodes) await n.engine.announce();
  await settle();
  return { ...net, nodes, settle, close: async () => { for (const n of nodes) await n.engine.stop(); } };
}

for (const impl of Object.keys(IMPLEMENTATIONS)) {
  // Invariant: every implementation has the Transport shape the engine relies on.
  test(`${impl}: has the Transport shape`, () => {
    const t = IMPLEMENTATIONS[impl]().makeTransport({ fp: 'f'.repeat(64) }, tmpDir());
    assert.equal(assertTransport(t), t);
    assert.ok(Array.isArray(t.addresses()));
  });

  // Invariant: announces travel on the directory route to every install.
  test(`${impl}: announces reach every install`, async () => {
    const net = await network(impl, ['alice', 'bob']);
    const [a, b] = net.nodes;
    assert.deepEqual(a.engine.state().directory.map((d) => d.name), ['bob']);
    assert.deepEqual(b.engine.state().directory.map((d) => d.name), ['alice']);
    await net.close();
  });

  // Invariant: the invite → accept → message flow works through the interface alone (mailbox and inbox routes).
  test(`${impl}: invite, accept and messages work through the interface alone`, async () => {
    const net = await network(impl, ['alice', 'bob']);
    const [a, b] = net.nodes;
    const { id, inbox } = await a.engine.invite(b.fp);
    await net.settle();
    await b.engine.respondInvite(id, true);
    await net.settle();
    await a.engine.sendMessage(inbox, 'over the interface');
    await net.settle();
    assert.deepEqual(b.engine.messages(inbox).map((m) => m.body), ['over the interface']);
    await net.close();
  });

  // Invariant: a replayed record (the same bytes delivered again) is deduplicated by record id.
  test(`${impl}: a record delivered twice is accepted once`, async () => {
    const net = await network(impl, ['alice', 'bob']);
    const [a, b] = net.nodes;
    const { id, inbox } = await a.engine.invite(b.fp);
    await net.settle();
    await b.engine.respondInvite(id, true);
    await net.settle();
    await a.engine.sendMessage(inbox, 'once');
    await net.settle();
    const last = (await a.store.load()).accepted.at(-1);
    await a.transport.send(last.bytes, { route: last.route, to: [b.fp] });
    await net.settle();
    assert.deepEqual(b.engine.messages(inbox).map((m) => m.body), ['once']);
    assert.equal(b.engine.state().diagnostics.rejected, 0);
    await net.close();
  });
}

// Invariant: with a push transport, a send to an offline recipient is kept in the outbox and re-sent when the
// transport reports the peer online.
test('memoryPush: an offline recipient gets the record from the outbox on peerOnline', async () => {
  const net = await network('memoryPush', ['alice', 'bob']);
  const [a, b] = net.nodes;
  const { id, inbox } = await a.engine.invite(b.fp);
  await b.engine.respondInvite(id, true);
  net.hub.setOnline(b.fp, false);
  await a.engine.sendMessage(inbox, 'while you were out');
  assert.equal(a.engine.state().diagnostics.outbox, 1);
  assert.deepEqual(b.engine.messages(inbox), []);
  net.hub.setOnline(b.fp, true);
  await a.engine.sync(); // waits behind the outbox flush peerOnline queued
  assert.deepEqual(b.engine.messages(inbox).map((m) => m.body), ['while you were out']);
  assert.equal(a.engine.state().diagnostics.outbox, 0);
  await net.close();
});
