import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeRecord, encodeCard, encodeRecord } from '../src/records.js';
import { FILES } from '../src/store.js';
import { routeKey } from '../src/transport/index.js';
import { loadIdentity } from '../src/identity.js';
import { makeNetwork, syncAll, tmpDir, tree } from './helpers.mjs';
import { startHub } from './hubHelpers.mjs';
import { netNode } from './netHelpers.mjs';
import { personal, settle, waitFor } from './tcpHelpers.mjs';

// The in-memory directory (A1 D14, D15): announces arrive on every route but are never written to the record log or
// the data dir; what persists is identities.json (card imports and every fp the log names) and pins for those only.

const closeAll = (t, ...things) => t.after(async () => { for (const x of things) await x.close(); });
// The payload types in a data dir's record log.
const loggedTypes = (dataDir) => {
  const file = path.join(dataDir, FILES.accepted);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => decodeRecord(Buffer.from(JSON.parse(l).bytes, 'base64')).payload.type);
};
const names = (node) => node.engine.state().directory.map((d) => d.name).sort();
// Whether any file of the data dir holds `bytes` (raw, base64 or base64url) or the text `text`.
function dataDirHolds(dataDir, { bytes, text }) {
  const needles = [];
  if (bytes) needles.push(Buffer.from(bytes), Buffer.from(Buffer.from(bytes).toString('base64')), Buffer.from(Buffer.from(bytes).toString('base64url')));
  if (text) needles.push(Buffer.from(text));
  return Object.entries(tree(dataDir)).filter(([, content]) => needles.some((n) => content.includes(n))).map(([f]) => f);
}

// Invariant: an announce is never logged nor written to the data dir, whichever route brought it; a stranger's name is
// not pinned either.
test('announces are never written to the record log or the data dir, over a direct session, a hub or the file share', async (t) => {
  const hub = await startHub(t);
  const alice = await netNode('alice', { connections: [hub.addr] });
  const direct = await netNode('directstranger', { listen: null, connections: [alice.addr()] });
  const onHub = await netNode('hubstranger', { listen: null, connections: [hub.addr] });
  closeAll(t, alice, direct, onHub);
  await waitFor(() => names(alice).join() === 'directstranger,hubstranger', 'both strangers shown');
  await settle([alice, direct, onHub]);
  assert.deepEqual(loggedTypes(alice.dataDir), []);
  for (const s of [direct, onHub]) {
    const own = Buffer.from(decodeRecordBytes(s.card()));
    assert.deepEqual(dataDirHolds(alice.dataDir, { bytes: own }), [], `${s.name}'s announce`);
    assert.deepEqual(dataDirHolds(alice.dataDir, { text: s.name }), [], `${s.name}'s name`);
    assert.deepEqual(dataDirHolds(alice.dataDir, { text: s.fp }), [], `${s.name}'s fingerprint`);
  }
  const pins = JSON.parse(fs.readFileSync(path.join(alice.dataDir, FILES.pins), 'utf8'));
  assert.deepEqual(Object.keys(pins), ['alice']);

  const { installs } = await makeNetwork(['carol', 'dave']);
  closeAll(t, ...installs);
  await syncAll(installs);
  const [carol, dave] = installs;
  assert.deepEqual(carol.engine.state().directory.map((d) => d.name), ['dave']);
  assert.ok(!loggedTypes(carol.dataDir).includes('announce'));
  assert.deepEqual(dataDirHolds(carol.dataDir, { text: dave.fp }), []);
});

// The name in `node`'s persisted identity for `fp` (identities.json), or null.
function keptName(node, fp) {
  const file = path.join(node.dataDir, FILES.identities);
  if (!fs.existsSync(file)) return null;
  const e = JSON.parse(fs.readFileSync(file, 'utf8'))[fp];
  return e ? decodeRecord(Buffer.from(e.announce, 'base64url')).payload.name : null;
}

const decodeRecordBytes = (card) => Buffer.from(card.slice('code-inbox-card:v2:'.length), 'base64url');

// Invariant: identities the install keeps (counterparties, card imports) keep their names across a restart; a
// stranger's name is gone after one.
test('contacts\' and counterparties\' names survive a restart; a stranger\'s does not', async (t) => {
  const hub = await startHub(t);
  let alice = await netNode('alice', { listen: null, connections: [hub.addr] });
  const bob = await netNode('bob', { listen: null, connections: [hub.addr] });
  const carol = await netNode('carol', { listen: null, connections: [hub.addr] });
  const dave = await netNode('dave', { listen: null, connections: [hub.addr] });
  t.after(async () => { for (const n of [alice, bob, carol, dave]) await n.close(); });
  await waitFor(() => names(alice).join() === 'bob,carol,dave', 'the roster');
  await personal(alice, bob); // bob: a counterparty
  await alice.engine.importCard(carol.card()); // carol: a card import
  const kept = JSON.parse(fs.readFileSync(path.join(alice.dataDir, FILES.identities), 'utf8'));
  assert.deepEqual(Object.keys(kept).sort(), [bob.fp, carol.fp].sort());
  assert.deepEqual([kept[bob.fp].imported, kept[carol.fp].imported], [false, true]);
  const pins = JSON.parse(fs.readFileSync(path.join(alice.dataDir, FILES.pins), 'utf8'));
  assert.deepEqual(Object.keys(pins).sort(), ['alice', 'bob', 'carol']);
  for (const n of [bob, carol, dave]) await n.close();
  await alice.close();
  alice = await netNode('alice', { dataDir: alice.dataDir });
  assert.deepEqual(names(alice), ['bob', 'carol']);
  assert.equal(alice.engine.state().identity.announcedName, 'alice');
  assert.deepEqual(alice.engine.state().inboxes[0].members.map((m) => m.name).sort(), ['alice', 'bob']);
});

// Invariant: a newer verified announce of a kept identity replaces the persisted one.
test('a newer verified announce updates the persisted identity', async (t) => {
  const alice = await netNode('alice');
  let bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
  t.after(async () => { await alice.close(); await bob.close(); });
  await waitFor(() => names(alice).join() === 'bob', 'bob shown');
  await personal(alice, bob);
  assert.equal(keptName(alice, bob.fp), 'bob');
  await bob.engine.setName('robert');
  await bob.engine.announce();
  // The memory directory changes first; identities.json follows once the engine has written it.
  await waitFor(() => keptName(alice, bob.fp) === 'robert', 'the persisted identity to update');
  assert.deepEqual(names(alice), ['robert']);
});

// Invariant: an imported card persists as that contact's identity, and makes it a contact.
test('an imported card persists as that contact\'s identity', async (t) => {
  let alice = await netNode('alice', { listen: null });
  t.after(() => alice.close());
  const bob = await loadIdentity(tmpDir());
  const bytes = encodeRecord(bob, { type: 'announce', signer: bob.fp, ts: 5, name: 'bob' }).bytes;
  await alice.engine.importCard(encodeCard(bytes));
  const kept = JSON.parse(fs.readFileSync(path.join(alice.dataDir, FILES.identities), 'utf8'));
  assert.deepEqual(kept, { [bob.fp]: { announce: Buffer.from(bytes).toString('base64url'), imported: true } });
  await alice.close();
  alice = await netNode('alice', { dataDir: alice.dataDir });
  assert.deepEqual(alice.engine.state().directory.map((d) => [d.name, d.contact]), [['bob', true]]);
  assert.deepEqual(alice.view.contacts(), [bob.fp]);
});

// Invariant (D15): the directory route serves inbox-create records only, and a shared invite still settles from the
// pull of that route.
test('the directory route serves inbox-create records only, and a shared invite still settles from that pull', async (t) => {
  const served = [];
  const spy = (view) => ({ ...view, serve: (reader, route, ...a) => { const r = view.serve(reader, route, ...a); if (r.status === 'ok') served.push([routeKey(route), ...r.recs.map((x) => decodeRecord(x.bytes).payload.type)]); return r; } });
  const alice = await netNode('alice', { wrapView: spy });
  const bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
  closeAll(t, alice, bob);
  await waitFor(() => names(alice).join() === 'bob', 'bob shown');
  const { id: team } = await alice.engine.createSharedInbox('team');
  const inv = await alice.engine.inviteMember(team, bob.fp);
  await settle([alice, bob]);
  const types = served.filter(([key]) => key === 'directory').flatMap(([, ...ts]) => ts);
  assert.deepEqual([...new Set(types)], ['inbox-create']);
  assert.equal(bob.engine.state().invites.incoming[0].inboxName, 'team');
  await bob.engine.respondInvite(inv.id, true);
  await settle([alice, bob], 3);
  assert.ok(bob.engine.listInboxes().some((b) => b.id === team));
});

// Invariant: an install's own announce is not stored but re-signed at boot from settings.announced, and presented to
// every new session and hub.
test('an install\'s own announce is re-signed at boot and presented to every new session and hub', async (t) => {
  const hub = await startHub(t);
  let alice = await netNode('alice', { connections: [hub.addr] });
  const card = alice.card();
  assert.equal(JSON.parse(fs.readFileSync(path.join(alice.dataDir, FILES.settings), 'utf8')).announced, 'alice');
  assert.deepEqual(dataDirHolds(alice.dataDir, { bytes: decodeRecordBytes(card) }), []);
  await alice.close();
  await new Promise((r) => setTimeout(r, 5));
  alice = await netNode('alice', { dataDir: alice.dataDir });
  const bob = await netNode('bob', { listen: null, connections: [alice.addr()] });
  const carol = await netNode('carol', { listen: null, connections: [hub.addr] });
  t.after(async () => { for (const n of [alice, bob, carol]) await n.close(); });
  assert.notEqual(alice.card(), card);
  assert.equal(decodeRecord(decodeRecordBytes(alice.card())).payload.name, 'alice');
  await waitFor(() => names(bob).join() === 'alice' && names(carol).join() === 'alice', 'alice through her listener and the hub');
});

// Invariant: on the file share, announce files fill the memory directory, never the log.
test('on the file share, announce files fill the memory directory and never the log', async (t) => {
  const { shareDir, installs } = await makeNetwork(['alice', 'bob']);
  closeAll(t, ...installs);
  const [alice, bob] = installs;
  assert.deepEqual(alice.engine.state().directory.map((d) => d.name), ['bob']);
  const files = Object.keys(tree(shareDir)).filter((f) => f.includes(`directory${path.sep}${bob.fp}`));
  assert.equal(files.length, 1);
  for (const x of installs) assert.ok(!loggedTypes(x.dataDir).includes('announce'));
});
