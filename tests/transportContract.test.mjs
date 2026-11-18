import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { loadIdentity } from '../src/identity.js';
import { createStore } from '../src/store.js';
import { assertTransport, routeKey } from '../src/transport/index.js';
import { createFileShare } from '../src/transport/fileShare.js';
import { createHub } from '../src/hub/hub.js';
import { proofSigner } from '../src/transport/handshake.js';
import { createNetwork } from '../src/transport/network.js';
import { silentLog, tmpDir } from './helpers.mjs';

// One contract, run against every Transport implementation: it proves the engine works through the interface
// alone. Each implementation provides makeTransport(identity, shareDir, view, store, config) and configure(engine,
// shareDir, i, nodes) (node i, after nodes 0..i-1), and optionally setup() / teardown() around a network (a loopback
// hub). A transport without a directory (`directory: false`) bootstraps the way humans do: every node after the first
// imports node 0's contact card (identity only); routes come from the network settings:
//   direct: node 0 listens; every later node has a connection to node 0's listener;
//   hub:    every node has one connection to a loopback hub;
//   mixed:  node 0 listens and connects to the hub; every later node connects to node 0's listener and the hub.

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
        async start(sink) { node.sink = sink; },
        setAnnounce() {},
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

const useShare = (engine, shareDir) => engine.setShare(shareDir);
const networkTransport = (identity, _shareDir, view, store, config) => createNetwork({
  listen: config.listen ?? null, connections: config.connections ?? [], identity: proofSigner(identity), view,
  cursors: { load: store.loadPeerCursors, save: store.savePeerCursors }, syncMs: 3_600_000, log: silentLog,
});
const listenerOf = (node) => `127.0.0.1:${node.transport.stats().listening.port}`;
// A loopback hub around the network, for the implementations that use one.
const withHub = (configure) => () => {
  const at = { hub: null, addr: null };
  return {
    async setup() {
      at.hub = createHub({ port: 0 });
      at.addr = `127.0.0.1:${(await at.hub.listen()).port}`;
    },
    teardown: () => at.hub.close(),
    makeTransport: networkTransport,
    configure: (engine, _shareDir, i, nodes) => configure(engine, i, nodes, at.addr),
  };
};
const IMPLEMENTATIONS = {
  fileShare: () => ({ makeTransport: (identity, shareDir, _view, store) => createFileShare({ shareDir, dataDir: store.dataDir, selfFp: identity.fp, pollMs: 3_600_000, log: silentLog }), configure: useShare }),
  memoryPush: () => { const hub = memoryHub(); return { makeTransport: (identity) => hub.makeTransport(identity), configure: useShare, hub }; },
  direct: () => ({
    makeTransport: networkTransport,
    configure: (engine, _shareDir, i, nodes) => engine.setNetwork(i === 0 ? { listen: { port: 0 } } : { listen: null, connections: [listenerOf(nodes[0])] }),
  }),
  hub: withHub((engine, _i, _nodes, hub) => engine.setNetwork({ listen: null, connections: [hub] })),
  mixed: withHub((engine, i, nodes, hub) => engine.setNetwork(i === 0 ? { listen: { port: 0 }, connections: [hub] } : { listen: null, connections: [listenerOf(nodes[0]), hub] })),
};

async function network(impl, names) {
  const net = IMPLEMENTATIONS[impl]();
  await net.setup?.();
  const shareDir = tmpDir('code-inbox-share-');
  const nodes = [];
  for (const name of names) {
    const dataDir = tmpDir('code-inbox-data-');
    const store = createStore(dataDir, { log: silentLog });
    await store.load();
    const identity = await loadIdentity(dataDir);
    const node = { name, fp: identity.fp, store, transport: null };
    node.engine = createEngine({
      store, identity, log: silentLog,
      makeTransport: (config, view) => { node.transport = net.makeTransport(identity, shareDir, view, store, config); return node.transport; },
    });
    await node.engine.boot();
    await net.configure(node.engine, shareDir, nodes.length, nodes);
    await node.engine.setName(name);
    nodes.push(node);
  }
  const settle = async () => { for (let i = 0; i < 2; i += 1) for (const n of nodes) await n.engine.sync(); };
  for (const n of nodes) await n.engine.announce();
  if (!nodes[0].transport.capabilities.directory) {
    const card = nodes[0].engine.state().transport.card;
    for (const n of nodes.slice(1)) await n.engine.importCard(card);
  }
  await settle();
  return { ...net, nodes, settle, close: async () => { for (const n of nodes) await n.engine.stop(); net.teardown?.(); } };
}

for (const impl of Object.keys(IMPLEMENTATIONS)) {
  // Invariant: every implementation has the Transport shape the engine relies on.
  test(`${impl}: has the Transport shape`, async () => {
    const dataDir = tmpDir();
    const store = createStore(dataDir, { log: silentLog });
    const t = IMPLEMENTATIONS[impl]().makeTransport(await loadIdentity(dataDir), tmpDir(), {}, store, { listen: { port: 0 } });
    assert.equal(assertTransport(t), t);
  });

  // Invariant: announces travel on the directory route to every install.
  test(`${impl}: announces reach every install`, async () => {
    const net = await network(impl, ['alice', 'bob']);
    const [a, b] = net.nodes;
    assert.deepEqual(a.engine.state().directory.map((d) => d.name), ['bob']);
    assert.deepEqual(b.engine.state().directory.map((d) => d.name), ['alice']);
    // Mixed routes: every pooled session is the direct one.
    if (impl === 'mixed') for (const n of net.nodes) assert.deepEqual(n.transport.stats().sessions.map((x) => x.via), ['direct'], n.name);
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
