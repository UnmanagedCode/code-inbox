import assert from 'node:assert/strict';
import net from 'node:net';
import { transportFactory } from '../server.js';
import { createEngine } from '../src/engine.js';
import { loadIdentity } from '../src/identity.js';
import { createStore } from '../src/store.js';
import { TCP_FRAME_MAX, createDecoder } from '../src/transport/frames.js';
import { proofSigner } from '../src/transport/handshake.js';
import { createNetworkEndpoint } from '../src/transport/network.js';
import { silentLog, tmpDir } from './helpers.mjs';
import { settle } from './tcpHelpers.mjs';

// Helpers for network-mode tests: whole engines over the network endpoint (a listener and connections), and a TCP
// relay standing between a connection and a listener. Real loopback sockets on ephemeral ports; everything closed by
// the test.

/**
 * A whole engine in network mode with its own data dir. `listen` (default {port: 0}; null: no listener) and
 * `connections` (["host:port"]) are saved with setNetwork unless `configure` is false or the data dir's settings
 * already configure a transport (a restart reuses them). `endpoint` attaches the engine to a shared endpoint instead;
 * `limits`, `connect` or `createServer` build its own endpoint with them (else server.js's transportFactory, as in
 * production). `schedule` and `now` reach the engine's outbox timer and the endpoint; `lookup` replaces DNS for
 * network settings; `wrapView(view)` lets a test spy on what the transport asks of the engine. `node.offered` keeps
 * every record the transport offers, `node.online` every peerOnline. With `name`, the name is set and announced.
 */
export async function netNode(name, {
  dataDir = tmpDir('code-inbox-net-'), listen = { port: 0 }, connections = [], endpoint, limits, connect, createServer, schedule, now, lookup,
  wrapView = (v) => v, configure = true,
} = {}) {
  const store = createStore(dataDir, { log: silentLog });
  await store.load();
  const identity = await loadIdentity(dataDir);
  const cursors = { load: store.loadPullCursors, save: store.savePullCursors };
  const base = transportFactory({ identity, store, tcpSyncMs: 3_600_000, now, schedule, log: silentLog });
  const custom = limits || connect || createServer;
  const own = (config) => createNetworkEndpoint({
    listen: config.listen, connections: config.connections, limits, syncMs: 3_600_000, log: silentLog,
    ...(connect ? { connect } : {}), ...(createServer ? { createServer } : {}), ...(now ? { now } : {}), ...(schedule ? { schedule } : {}),
  });
  const node = { name, dataDir, fp: identity.fp, identity, store, transport: null, view: null, offered: [], online: [] };
  node.engine = createEngine({
    store, identity, log: silentLog, ...(schedule ? { schedule } : {}), ...(lookup ? { lookup } : {}),
    makeTransport: (config, view) => {
      node.view = wrapView(view);
      const signer = proofSigner(identity);
      const t = endpoint ? endpoint.attach({ identity: signer, view: node.view, cursors })
        : config.kind === 'network' && custom ? own(config).attach({ identity: signer, view: node.view, cursors })
          : base(config, node.view);
      const start = t.start;
      t.start = (sink) => start({
        ...sink,
        record: (i) => { node.offered.push(i); return sink.record(i); },
        peerOnline: (fp) => { node.online.push(fp); sink.peerOnline(fp); },
      });
      node.transport = t;
      return t;
    },
  });
  await node.engine.boot();
  if (configure && !node.engine.state().transport.configured && !node.engine.settings().transport) await node.engine.setNetwork({ listen, connections });
  if (name && !node.engine.settings().name) {
    await node.engine.setName(name);
    if (node.engine.state().transport.configured) await node.engine.announce();
  }
  node.card = () => node.engine.state().transport.card;
  // The bound listener as a connection address.
  node.addr = () => `127.0.0.1:${node.transport.stats().listening.port}`;
  node.port = () => node.transport.stats().listening.port;
  // The status row of one connection (stats()), by address.
  node.status = (address) => node.transport.stats().connections.find((c) => c.address === address);
  node.sessionsWith = (fp) => node.transport.stats().sessions.filter((s) => s.remote.includes(fp));
  node.close = () => node.engine.stop();
  return node;
}

/**
 * A TCP relay on 127.0.0.1:`port` (default ephemeral) that forwards every connection to `targetPort`: a port forward.
 * `conns` records, per relayed connection, {toTarget, fromTarget}: the frames each side sent (decoded JSON, in
 * order). `close()` stops listening and cuts every relayed connection. → {port, addr, conns, close()}.
 */
export async function relay(t, targetPort, { port: listenPort = 0 } = {}) {
  const conns = [];
  const sockets = new Set();
  const srv = net.createServer((inbound) => {
    const outbound = net.connect({ host: '127.0.0.1', port: targetPort });
    for (const s of [inbound, outbound]) { sockets.add(s); s.on('error', () => {}); s.setNoDelay(true); }
    const conn = { toTarget: [], fromTarget: [] };
    const copy = (from, to, frames) => {
      const decoder = createDecoder({ maxFrame: TCP_FRAME_MAX });
      from.on('data', (chunk) => {
        to.write(chunk);
        decoder.push(chunk);
        try { for (let f; (f = decoder.next()) !== null;) frames.push(f); } catch { /* the endpoints judge it */ }
      });
      from.on('close', () => to.destroy());
    };
    copy(inbound, outbound, conn.toTarget);
    copy(outbound, inbound, conn.fromTarget);
    conns.push(conn);
  });
  await new Promise((r) => srv.listen(listenPort, '127.0.0.1', r));
  const { port } = srv.address();
  const r = {
    port,
    addr: `127.0.0.1:${port}`,
    conns,
    close: () => new Promise((done) => { for (const s of sockets) s.destroy(); srv.close(() => done()); }),
  };
  t.after(() => r.close());
  return r;
}

// netNode, closed after the test (a node closed earlier, e.g. for a restart, closes again harmlessly).
export const opener = (t) => async (name, opts) => {
  const n = await netNode(name, opts);
  t.after(() => n.close());
  return n;
};

// An owner that listens (`ownerOpts`) and `names` members that connect only to it (each with `memberOpts(name)`
// added), every member admitted to one shared inbox. → {owner, members, all, id, route}.
export async function star(t, names, { ownerOpts = {}, memberOpts = () => ({}) } = {}) {
  const open = opener(t);
  const owner = await open('owner', ownerOpts);
  const members = [];
  for (const name of names) members.push(await open(name, { listen: null, connections: [owner.addr()], ...memberOpts(name) }));
  const all = [owner, ...members];
  for (const m of members) await m.engine.importCard(owner.card());
  await settle(all);
  const { id } = await owner.engine.createSharedInbox('team');
  for (const m of members) await owner.engine.inviteMember(id, m.fp);
  await settle(all);
  for (const m of members) await m.engine.respondInvite(m.engine.state().invites.incoming[0].id, true);
  await settle(all, 3);
  const team = owner.engine.listInboxes().find((b) => b.id === id);
  assert.equal(team.members.length, names.length + 1, 'every member is admitted');
  return { owner, members, all, id, route: { kind: 'inbox', id } };
}

// Restarts `node` from its data dir (its stored network settings), with `opts`.
export async function restart(t, node, opts = {}) {
  await node.close();
  return opener(t)(node.name, { dataDir: node.dataDir, ...opts });
}
