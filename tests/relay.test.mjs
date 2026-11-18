import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadIdentity } from '../src/identity.js';
import { decodeRecord, encodeRecord, newNonce, personalInboxId, routeFor } from '../src/records.js';
import { FILES } from '../src/store.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { routeKey } from '../src/transport/index.js';
import { makeNetwork, syncAll, tmpDir } from './helpers.mjs';
import { netNode } from './netHelpers.mjs';
import { freePort, rawPeer, settle, waitFor } from './tcpHelpers.mjs';

// The owner of a shared inbox relays its members' records (docs/transport.md → Owner relay): it serves every record
// it accepted on an inbox it owns, pushes a member's message on to the other connected members, and is the only
// writer another signer's record is taken from. Real loopback sockets; engines run with an hour-long maintain
// interval, so every sync is driven by the test (or, for the live push, by nothing). A "star" is an owner that
// listens and members that connect only to it. Each test closes every node it opened.

const SHORT = { redialMinMs: 20, redialMaxMs: 40 };
const newIdentity = () => loadIdentity(tmpDir('code-inbox-id-'));
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const decoded = (i) => decodeRecord(i.bytes);
const bodies = (node, inbox) => node.engine.messages(inbox).map((m) => m.body);
// Resolves `promise`, or fails after `ms`: every wait on a socket is bounded.
const bounded = (promise, what, ms = 3000) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref(); }),
]);

// netNode, closed after the test (a node closed earlier, e.g. for a restart, closes again harmlessly).
const opener = (t) => async (name, opts) => {
  const n = await netNode(name, opts);
  t.after(() => n.close());
  return n;
};

// An owner that listens (`ownerOpts`) and `names` members that connect only to it (each with `memberOpts(name)`
// added), every member admitted to one shared inbox. → {owner, members, all, id, route}.
async function star(t, names, { ownerOpts = {}, memberOpts = () => ({}) } = {}) {
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
async function restart(t, node, opts = {}) {
  await node.close();
  return opener(t)(node.name, { dataDir: node.dataDir, ...opts });
}

// Ingests `bytes` with `writer` on `route` straight into `node`'s engine and asserts it was refused ROUTE_MISMATCH.
async function refusedRouteMismatch(node, { route, writer, bytes }, what) {
  const before = node.engine.state().diagnostics.rejected;
  await node.engine.ingest({ route, writer, bytes });
  const diag = node.engine.state().diagnostics;
  assert.equal(diag.rejected, before + 1, what);
  assert.deepEqual([diag.recent[0].reason, diag.recent[0].id], ['ROUTE_MISMATCH', decodeRecord(bytes).id], what);
}

// A msg of `identity`'s on shared inbox `inbox`, signed but never sent.
const unsentMsg = (identity, inbox, body, epoch, prev = null) => encodeRecord(identity, { type: 'msg', signer: identity.fp, ts: Date.now(), inbox, body, epoch, prev }).bytes;

// Records every `send` the engine makes through `node`'s transport: the record id and the recipients.
function spySends(node) {
  const calls = [];
  const send = node.transport.send;
  node.transport.send = (bytes, opts) => { calls.push({ id: decodeRecord(bytes).id, to: [...opts.to].sort() }); return send(bytes, opts); };
  return calls;
}

// Invariant (store-and-forward through the owner): a member that was offline when a message was sent gets it from the
// owner later, while its author is offline too; it never needs a session with the author.
test('a member offline when a message was sent receives it from the owner while the author is offline', async (t) => {
  const { owner, members: [m1, m2], id } = await star(t, ['m1', 'm2']);
  await m2.close();
  await m1.engine.sendMessage(id, 'while m2 was out');
  await settle([owner, m1]);
  assert.deepEqual(bodies(owner, id), ['while m2 was out']);
  await m1.close();
  const back = await restart(t, m2);
  await settle([owner, back]);
  assert.deepEqual(bodies(back, id), ['while m2 was out']);
  const inboxOffers = back.offered.filter((i) => i.route.kind === 'inbox');
  assert.ok(inboxOffers.length > 0);
  assert.ok(inboxOffers.every((i) => i.writer === owner.fp), 'every inbox record came from the owner');
});

// Invariant (D6): when the owner accepts a member's message, it pushes it at once to every other connected member;
// no sync or pull is needed.
test('the owner pushes a member\'s message to every connected member at once', async (t) => {
  const { owner, members: [m1, m2, m3], id } = await star(t, ['m1', 'm2', 'm3']);
  await m1.engine.sendMessage(id, 'live');
  await waitFor(() => bodies(m2, id).includes('live') && bodies(m3, id).includes('live'), 'the relayed message');
  for (const m of [m2, m3]) {
    const offer = m.offered.find((i) => i.route.kind === 'inbox' && decoded(i).payload.body === 'live');
    assert.equal(offer.writer, owner.fp, m.name);
  }
});

// Invariant (rule 1, D4): a record signed by someone other than its writer is taken only from the inbox's owner, and
// only as a msg on that shared inbox; every other writer of a third-party record is refused ROUTE_MISMATCH, over the
// wire and in the engine.
test('only the owner relays: any other writer of a third-party record is refused ROUTE_MISMATCH', async (t) => {
  const { owner, members: [m1, m2, m3], id, route } = await star(t, ['m1', 'm2', 'm3'], { memberOpts: (name) => (name === 'm2' ? { listen: { port: 0 } } : {}) });
  const epoch = 3; // the three member records
  const relayed = unsentMsg(m1.identity, id, 'relayed', epoch);

  // (a) A stranger pushes a genuine message of m1's on the inbox route to m2.
  const stranger = await newIdentity();
  const raw = await rawPeer(m2.port(), stranger, m2.fp);
  t.after(() => raw.destroy());
  raw.send({ t: 'rec', from: stranger.fp, to: m2.fp, route, rec: b64(relayed) });
  await waitFor(() => m2.engine.state().diagnostics.recent.some((r) => r.reason === 'ROUTE_MISMATCH' && r.id === decodeRecord(relayed).id), 'ROUTE_MISMATCH');
  assert.ok(!bodies(m2, id).includes('relayed'));

  // (b) In the engine: a co-member, the owner of another shared inbox, and the owner on a mailbox or a personal inbox.
  await refusedRouteMismatch(m2, { route, writer: m3.fp, bytes: relayed }, 'a co-member');
  const other = await opener(t)('other', { listen: null });
  const { id: side } = await other.engine.createSharedInbox('side');
  const sideCreate = (await other.store.load()).accepted.find((e) => decodeRecord(e.bytes).payload.type === 'inbox-create').bytes;
  await m2.engine.ingest({ route: { kind: 'directory' }, writer: other.fp, bytes: sideCreate });
  await refusedRouteMismatch(m2, { route, writer: other.fp, bytes: relayed }, 'the owner of another shared inbox');
  await other.engine.sendMessage(side, 'side note');
  const sideMsg = (await other.store.load()).accepted.find((e) => decodeRecord(e.bytes).payload.type === 'msg').bytes;
  await refusedRouteMismatch(m2, { route: { kind: 'inbox', id: side }, writer: owner.fp, bytes: sideMsg }, 'the owner, on an inbox it does not own');
  const nonce = newNonce();
  const personalId = personalInboxId(m1.fp, m2.fp, nonce);
  const invite = encodeRecord(m1.identity, { type: 'invite', signer: m1.fp, ts: Date.now(), to: m2.fp, kind: 'personal', inbox: personalId, nonce }).bytes;
  await refusedRouteMismatch(m2, { route: { kind: 'mailbox', fp: m2.fp }, writer: owner.fp, bytes: invite }, 'the owner, on a mailbox');
  const personalMsg = encodeRecord(m1.identity, { type: 'msg', signer: m1.fp, ts: Date.now(), inbox: personalId, body: 'personal' }).bytes;
  await refusedRouteMismatch(m2, { route: { kind: 'inbox', id: personalId }, writer: owner.fp, bytes: personalMsg }, 'the owner, on a personal inbox');
  assert.ok(!bodies(m2, id).includes('relayed'));

  // (c) The same bytes from the owner are accepted.
  await m2.engine.ingest({ route, writer: owner.fp, bytes: relayed });
  assert.ok(bodies(m2, id).includes('relayed'));
  assert.deepEqual(routeFor(decodeRecord(relayed).payload), route);
});

// Invariant (D1, D5): a member serves only the records it signed; the owner serves every record it accepted on its
// shared inbox, whoever signed it, except the reader's own.
test('a member serves only its own records; only the owner serves co-members\'', async (t) => {
  const { owner, members: [m1, m2], id, route } = await star(t, ['m1', 'm2']);
  await m1.engine.sendMessage(id, 'from m1');
  await m2.engine.sendMessage(id, 'from m2');
  await owner.engine.sendMessage(id, 'from owner');
  await settle([owner, m1, m2]);
  for (const n of [owner, m1, m2]) assert.deepEqual(bodies(n, id).sort(), ['from m1', 'from m2', 'from owner'], n.name);
  const signers = (node, reader) => {
    const r = node.view.serve(reader.fp, route, 0, Infinity);
    assert.equal(r.status, 'ok');
    return r.recs.map((x) => decodeRecord(x.bytes).payload);
  };
  const fromM2 = signers(m2, m1);
  assert.ok(fromM2.length > 0);
  assert.ok(fromM2.every((p) => p.signer === m2.fp), 'a member serves only its own records');
  const toM2 = signers(owner, m2);
  assert.deepEqual([...new Set(toM2.map((p) => p.signer))].sort(), [owner.fp, m1.fp].sort(), 'the owner serves co-members\' records, never the reader\'s');
  assert.ok(toM2.some((p) => p.body === 'from m1'));
  const toM1 = signers(owner, m1);
  assert.deepEqual([...new Set(toM1.map((p) => p.signer))].sort(), [owner.fp, m2.fp].sort());
});

// Invariant (rule 2): the owner serves and pushes members' records only to current members: a non-member's pull is
// denied with no head, and a removed member gets neither pushes nor pulls of later messages.
test('the owner serves and pushes members\' records only to current members', async (t) => {
  const denied = [];
  const spy = (view) => ({ ...view, serve: (reader, r, ...a) => { const out = view.serve(reader, r, ...a); if (out.status === 'denied') denied.push([reader, routeKey(r)]); return out; } });
  const { owner, members: [m1, m2, m3], id, route } = await star(t, ['m1', 'm2', 'm3'], { ownerOpts: { wrapView: spy } });

  const stranger = await newIdentity();
  const raw = await rawPeer(owner.port(), stranger, owner.fp);
  t.after(() => raw.destroy());
  raw.send({ t: 'pull', id: 1, from: stranger.fp, to: owner.fp, routes: [{ route, since: 0 }] });
  const answer = await bounded(raw.nextOf('recs'), 'the recs answer');
  assert.deepEqual(answer.routes, [{ route, status: 'denied' }]);

  await owner.engine.removeMember(id, m3.fp);
  await settle([owner, m1, m2, m3]);
  const mark = m3.offered.length;
  denied.length = 0;
  await m1.engine.sendMessage(id, 'after the removal');
  await waitFor(() => bodies(m2, id).includes('after the removal'), 'the push to m2');
  await settle([owner, m1, m2, m3]);
  const msgId = m1.engine.messages(id).at(-1).id;
  assert.ok(!Object.values(m3.engine.verdicts(id)).flat().includes(msgId), 'm3 never holds it');
  assert.deepEqual(m3.offered.slice(mark).filter((i) => i.writer === owner.fp && i.route.kind === 'inbox'), [], 'nothing reaches m3 from the owner after the removal');
  assert.ok(denied.some(([reader, key]) => reader === m3.fp && key === routeKey(route)), 'm3\'s pulls are denied');
});

// Invariant (rule 5): a record that arrives both from its author and through the owner is accepted once; the owner
// never offers it back to its author, and a further round offers nothing new.
test('a record arriving both direct and through the owner is accepted once and never echoed', async (t) => {
  const open = opener(t);
  const owner = await open('owner');
  const m1 = await open('m1', { connections: [owner.addr()] });
  const m2 = await open('m2', { listen: null, connections: [owner.addr(), m1.addr()] });
  const all = [owner, m1, m2];
  for (const m of [m1, m2]) await m.engine.importCard(owner.card());
  await settle(all);
  const { id } = await owner.engine.createSharedInbox('team');
  for (const m of [m1, m2]) await owner.engine.inviteMember(id, m.fp);
  await settle(all);
  for (const m of [m1, m2]) await m.engine.respondInvite(m.engine.state().invites.incoming[0].id, true);
  await settle(all, 3);
  assert.equal(m2.sessionsWith(m1.fp).length, 1, 'm2 has a session with m1');

  await m1.engine.sendMessage(id, 'twice');
  const msgId = m1.engine.messages(id).at(-1).id;
  const offersOf = (n) => n.offered.filter((i) => decoded(i).id === msgId);
  // Pushes move no cursor, so the next pulls may offer it again: what matters is who offered it.
  await waitFor(() => new Set(offersOf(m2).map((i) => i.writer)).size === 2, 'both arrivals at m2');
  await settle(all);
  assert.deepEqual([...new Set(offersOf(m2).map((i) => i.writer))].sort(), [m1.fp, owner.fp].sort());
  assert.equal((await m2.store.load()).accepted.filter((e) => e.id === msgId).length, 1);
  assert.deepEqual(bodies(m2, id), ['twice']);
  assert.equal(m2.engine.state().diagnostics.rejected, 0);
  assert.deepEqual(offersOf(m1), [], 'never echoed to its author');
  const marks = all.map((n) => n.offered.length);
  await settle(all);
  all.forEach((n, i) => assert.deepEqual(n.offered.slice(marks[i]).filter((x) => x.route.kind === 'inbox'), [], `${n.name}: nothing new`));
});

// Invariant (D10): a member that joins later gets the inbox's whole history from the owner, every signer's, a removed
// member's kept messages included, with every author offline; it ends with the owner's verdicts.
test('a new member receives the inbox\'s full history from the owner, a removed member\'s kept messages included, with every author offline', async (t) => {
  const { owner, members: [m1, m2], id } = await star(t, ['m1', 'm2']);
  await m1.engine.sendMessage(id, 'm1 first');
  await m1.engine.sendMessage(id, 'm1 second');
  await settle([owner, m1, m2]);
  await owner.engine.removeMember(id, m1.fp);
  await settle([owner, m1, m2]);
  await m2.engine.sendMessage(id, 'm2 after');
  await settle([owner, m2]);
  await m1.close();
  await m2.close();

  const m4 = await opener(t)('m4', { listen: null, connections: [owner.addr()] });
  await m4.engine.importCard(owner.card());
  await settle([owner, m4]);
  await owner.engine.inviteMember(id, m4.fp);
  await settle([owner, m4]);
  await m4.engine.respondInvite(m4.engine.state().invites.incoming[0].id, true);
  await settle([owner, m4], 3);
  assert.deepEqual(bodies(owner, id), ['m1 first', 'm1 second', 'm2 after']);
  assert.deepEqual(bodies(m4, id), bodies(owner, id));
  assert.deepEqual(m4.engine.verdicts(id), owner.engine.verdicts(id));
});

// Invariant (D1, D3): a member's pull cursor on (owner, inbox) is the owner's acceptance seq over everything it serves
// there, kept in pull-cursors.json: a member restart pulls nothing again, a message missed while offline is served
// exactly once, and an owner restart rebuilds the same served log.
test('pull cursors follow the owner\'s sequence across member and owner restarts', async (t) => {
  let served = 0;
  let m2fp = null;
  let key = null;
  const count = (view) => ({ ...view, serve: (reader, r, ...a) => { const out = view.serve(reader, r, ...a); if (reader === m2fp && routeKey(r) === key) served += out.recs?.length ?? 0; return out; } });
  const ownerOpts = { listen: { port: await freePort() }, wrapView: count };
  const { owner, members: [m1, m2], id, route } = await star(t, ['m1', 'm2'], { ownerOpts, memberOpts: () => ({ limits: SHORT }) });
  m2fp = m2.fp;
  key = routeKey(route);
  await m1.engine.sendMessage(id, 'one');
  await settle([owner, m1, m2]);
  const ownerLast = (await owner.store.load()).accepted.filter((e) => routeKey(e.route) === key).at(-1);
  assert.equal(decodeRecord(ownerLast.bytes).payload.signer, m1.fp, 'the owner\'s last record on the route is m1\'s');
  const cursors = JSON.parse(fs.readFileSync(path.join(m2.dataDir, FILES.pullCursors), 'utf8'));
  assert.equal(cursors[owner.fp][key], ownerLast.seq);

  // A member restart pulls nothing again.
  let back = await restart(t, m2, { limits: SHORT });
  served = 0;
  await back.engine.sync();
  assert.equal(served, 0);

  // A message sent while m2 is offline is served to it exactly once.
  await back.close();
  await m1.engine.sendMessage(id, 'two');
  await settle([owner, m1]);
  back = await restart(t, back, { limits: SHORT });
  await back.engine.sync();
  await waitFor(() => bodies(back, id).includes('two'), 'the missed message');
  assert.equal(served, 1);

  // An owner restart serves from the same sequence.
  served = 0;
  const owner2 = await restart(t, owner, ownerOpts);
  await waitFor(() => back.sessionsWith(owner2.fp).length > 0, 'm2 back on the owner');
  await back.engine.sync();
  assert.equal(served, 0);
  const m5 = await opener(t)('m5', { listen: null, connections: [owner2.addr()] });
  await m5.engine.importCard(owner2.card());
  await settle([owner2, m5]);
  await owner2.engine.inviteMember(id, m5.fp);
  await settle([owner2, m5]);
  await m5.engine.respondInvite(m5.engine.state().invites.incoming[0].id, true);
  await settle([owner2, m5], 3);
  assert.deepEqual(bodies(m5, id), ['one', 'two']);
});

// Invariant (D7): in network mode a member's shared message must reach only the owner: while the owner is offline the
// outbox keeps it for the owner alone, and it empties once the owner is back, though the co-member never met it.
test('a member\'s message waits in its outbox for the owner only', async (t) => {
  const ownerOpts = { listen: { port: await freePort() } };
  const { owner, members: [m1, m2], id } = await star(t, ['m1', 'm2'], { ownerOpts, memberOpts: () => ({ limits: SHORT }) });
  await owner.close();
  await waitFor(() => m1.sessionsWith(owner.fp).length === 0 && m2.sessionsWith(owner.fp).length === 0, 'the sessions with the owner to close');
  await m1.engine.sendMessage(id, 'queued');
  const { outbox } = await m1.store.load();
  assert.deepEqual(outbox.map((e) => e.to), [[owner.fp]]);
  assert.equal(m1.engine.state().diagnostics.outbox, 1);
  const owner2 = await restart(t, owner, ownerOpts);
  await waitFor(() => m1.engine.state().diagnostics.outbox === 0, 'the outbox flush to the owner');
  await waitFor(() => m2.sessionsWith(owner2.fp).length > 0, 'm2 back on the owner');
  await settle([owner2, m1, m2]);
  assert.deepEqual(bodies(m2, id), ['queued']);
  assert.ok(m2.offered.every((i) => i.writer !== m1.fp), 'm2 never had a session with m1');
});

// Invariant (D9, rule 6): the file share does not relay: the owner's writer subdir holds only records it signed, and
// members still read each other from their own subdirs.
test('the file share relays nothing: the owner writes only its own records', async () => {
  const { shareDir, installs } = await makeNetwork(['owner', 'm1', 'm2']);
  const [owner, m1, m2] = installs;
  const { id } = await owner.engine.createSharedInbox('team');
  for (const m of [m1, m2]) await owner.engine.inviteMember(id, m.fp);
  await syncAll(installs);
  for (const m of [m1, m2]) await m.engine.respondInvite(m.engine.state().invites.incoming[0].id, true);
  await syncAll(installs, 3);
  await m1.engine.sendMessage(id, 'from m1');
  await syncAll(installs);
  assert.deepEqual(m2.engine.messages(id).map((m) => m.body), ['from m1']);
  const ownerDir = path.join(shareDir, SHARE_ROOT, 'inboxes', id, owner.fp);
  const files = fs.readdirSync(ownerDir);
  assert.ok(files.length > 0);
  for (const f of files) assert.equal(decodeRecord(fs.readFileSync(path.join(ownerDir, f))).payload.signer, owner.fp, f);
  for (const x of installs) await x.close();
});

// Invariant (rule 1, producer side): only the owner relays. A member that accepts a co-member's message sends it on
// to nobody, so no install is offered a third-party record from a non-owner and nothing is refused anywhere.
test('a member that accepts a co-member\'s message relays nothing: only the owner relays', async (t) => {
  const { owner, members: [m1, m2, m3], all, id } = await star(t, ['m1', 'm2', 'm3']);
  const sends = new Map([m2, m3].map((m) => [m.fp, spySends(m)]));
  await m1.engine.sendMessage(id, 'from m1');
  const msgId = m1.engine.messages(id).at(-1).id;
  await waitFor(() => bodies(m2, id).includes('from m1') && bodies(m3, id).includes('from m1'), 'the owner\'s relay');
  await settle(all);
  for (const m of [m2, m3]) assert.deepEqual(sends.get(m.fp).filter((c) => c.id === msgId), [], `${m.name} sends m1's message to nobody`);
  const fromMembers = (n) => n.offered.filter((i) => decoded(i).id === msgId && i.writer !== m1.fp && i.writer !== owner.fp);
  for (const n of all) assert.deepEqual(fromMembers(n), [], `${n.name} is offered it only by its author or the owner`);
  for (const n of all) assert.equal(n.engine.state().diagnostics.rejected, 0, n.name);
});

// Invariant (D6): the owner never relays its own messages: its message is sent once, to every member, by the send
// that publishes it, and no second send follows.
test('the owner sends its own message once per member and never relays it', async (t) => {
  const { owner, members: [m1, m2], id } = await star(t, ['m1', 'm2']);
  const sends = spySends(owner);
  await owner.engine.sendMessage(id, 'from the owner');
  const msgId = owner.engine.messages(id).at(-1).id;
  assert.deepEqual(sends.filter((c) => c.id === msgId), [{ id: msgId, to: [m1.fp, m2.fp].sort() }]);
  await waitFor(() => bodies(m1, id).includes('from the owner') && bodies(m2, id).includes('from the owner'), 'the owner\'s message');
  for (const m of [m1, m2]) assert.equal(m.offered.filter((i) => decoded(i).id === msgId).length, 1, `${m.name} is offered it once`);
});

// Invariant (D7): the outbox keep-set narrows only a member's message to the owner; the owner's own message keeps
// every member it could not reach, as for any other write.
test('the owner\'s own message keeps an offline member in its outbox', async (t) => {
  const { owner, members: [m1, m2], id } = await star(t, ['m1', 'm2']);
  await m2.close();
  await waitFor(() => owner.sessionsWith(m2.fp).length === 0, 'the owner\'s session with m2 to close');
  await owner.engine.sendMessage(id, 'for everyone');
  const { outbox } = await owner.store.load();
  assert.deepEqual(outbox.map((e) => e.to), [[m2.fp]]);
  assert.equal(owner.engine.state().diagnostics.outbox, 1);
  await waitFor(() => bodies(m1, id).includes('for everyone'), 'the message at m1');
});

// Invariant (D6): a co-member's message the owner accepts by draining pending (its prev arrived after it) is relayed
// like one accepted on arrival: pushed live, with no sync or pull.
test('a member\'s message that pended at the owner is pushed on once it settles', async (t) => {
  const { owner, members: [m1, m2], id, route } = await star(t, ['m1', 'm2']);
  const epoch = 2; // the two member records
  const first = unsentMsg(m1.identity, id, 'first', epoch);
  const second = unsentMsg(m1.identity, id, 'second', epoch, decodeRecord(first).id);
  await owner.engine.ingest({ route, writer: m1.fp, bytes: second });
  assert.equal(owner.engine.state().diagnostics.pending, 1, 'the second waits for its prev');
  await owner.engine.ingest({ route, writer: m1.fp, bytes: first });
  assert.equal(owner.engine.state().diagnostics.pending, 0);
  await waitFor(() => bodies(m2, id).includes('second'), 'the drained message at m2');
  assert.deepEqual(bodies(m2, id), ['first', 'second']);
  const offer = m2.offered.find((i) => decoded(i).id === decodeRecord(second).id);
  assert.equal(offer.writer, owner.fp);
});
