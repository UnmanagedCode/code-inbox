import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from '../src/engine.js';
import { loadIdentity } from '../src/identity.js';
import { encodeRecord, sharedInboxId as sharedId } from '../src/records.js';
import { createStore } from '../src/store.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { makeInstall, makeNetwork, silentLog, syncAll, tmpDir } from './helpers.mjs';

// The removal rule end to end: what a removed member signs is never accepted unless the owner held that exact
// message when it removed them, and every reader that ends with the same records holds the same valid and refused sets.

let planted = 0;
function plant(shareDir, inbox, fp, bytes) {
  const dir = path.join(shareDir, SHARE_ROOT, 'inboxes', inbox, fp);
  fs.mkdirSync(dir, { recursive: true });
  planted += 1;
  fs.writeFileSync(path.join(dir, `${String(Date.now()).padStart(13, '0')}-${crypto.randomBytes(16).toString('hex')}.rec`), bytes);
}

// A message signed as `id` outside its engine: what a member can pre-sign and hold back.
const sign = (id, inbox, body, epoch, prev) => encodeRecord(id, { type: 'msg', signer: id.fp, ts: Date.now(), inbox, body, epoch, prev });

// alice owns `team`; the others join by request, in order.
async function team(names) {
  const net = await makeNetwork(names);
  const [owner, ...rest] = net.installs;
  const { id: inbox } = await owner.engine.createSharedInbox('team');
  await syncAll(net.installs);
  for (const x of rest) await join(owner, x, inbox, net.installs);
  return { ...net, inbox };
}

async function join(owner, x, inbox, all) {
  await x.engine.requestJoin(inbox);
  await syncAll(all);
  await owner.engine.respondJoin(owner.engine.state().joinRequests.incoming.find((r) => r.from.fp === x.fp).id, true);
  await syncAll(all);
}

const settled = (v) => [...v.invalid, ...v.rejected].sort();
const bodiesOf = (x, inbox) => x.engine.messages(inbox).map((m) => m.body);

// Invariant: a member that points an accepted-looking message at a pre-signed one, or holds back a pre-signed chain,
// gets none of it accepted after its removal, on any reader, and nothing stays pending; a reader restart agrees.
test('pre-signed messages and chains are REMOVED on every reader after the removal, and stay so after a restart', async () => {
  const { shareDir, installs, inbox } = await team(['alice', 'bob', 'carol']);
  const [a, b, c] = installs;
  await b.engine.sendMessage(inbox, 'honest');
  await syncAll(installs);
  const bob = await loadIdentity(b.dataDir);
  const honest = a.engine.messages(inbox)[0].id;
  const single = sign(bob, inbox, 'pre-signed single', 2, honest);
  const pointer = sign(bob, inbox, 'points at the pre-signed one', 2, single.id);
  const p1 = sign(bob, inbox, 'chain 1', 2, honest);
  const p2 = sign(bob, inbox, 'chain 2', 2, p1.id);
  const p3 = sign(bob, inbox, 'chain 3', 2, p2.id);
  plant(shareDir, inbox, b.fp, pointer.bytes); // published before the removal; held pending (its prev is unseen)
  await syncAll(installs);
  assert.deepEqual(a.engine.verdicts(inbox).pending, [pointer.id]);
  await a.engine.removeMember(inbox, b.fp);
  await syncAll(installs);
  for (const r of [single, p1, p2, p3]) plant(shareDir, inbox, b.fp, r.bytes);
  await syncAll(installs);
  const refused = [single.id, pointer.id, p1.id, p2.id, p3.id].sort();
  for (const x of [a, c]) {
    const v = x.engine.verdicts(inbox);
    assert.deepEqual(v.valid, [honest], x.name);
    assert.deepEqual(v.pending, [], `${x.name}: nothing pending`);
    assert.deepEqual(settled(v), refused, `${x.name}: every pre-signed record refused`);
    assert.deepEqual(bodiesOf(x, inbox), ['honest']);
  }
  await c.close();
  const again = await makeInstall(null, { dataDir: c.dataDir });
  await again.engine.sync();
  assert.deepEqual(bodiesOf(again, inbox), ['honest'], 'after a restart');
  assert.deepEqual(again.engine.verdicts(inbox).pending, []);
  for (const x of [a, b, again]) await x.close();
});

// Invariant: the double-removal scenario converges: the owner, the member and a late joiner end with identical
// verdicts and nothing pending, and the member's re-added message chains onto its last valid one.
test('removal, stale write, re-add, second removal: owner, member and a late reader agree', async () => {
  const { shareDir, installs, inbox } = await team(['alice', 'bob']);
  const [a, b] = installs;
  await b.engine.sendMessage(inbox, 'A1');
  await syncAll(installs);
  await a.engine.removeMember(inbox, b.fp); // bob does not see it yet
  await b.engine.sendMessage(inbox, 'A2'); // stale: written as a member, after the removal
  await syncAll(installs);
  assert.deepEqual(bodiesOf(a, inbox), ['A1']);
  const inv = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(inv.id, true);
  await syncAll(installs);
  await b.engine.sendMessage(inbox, 'A3');
  // the old client's mistake, planted: A3' on top of the refused A2
  const bob = await loadIdentity(b.dataDir);
  const a2 = b.engine.verdicts(inbox).invalid[0];
  const a3old = sign(bob, inbox, "A3'", 3, a2);
  plant(shareDir, inbox, b.fp, a3old.bytes);
  await syncAll(installs);
  await a.engine.removeMember(inbox, b.fp);
  await syncAll(installs);
  const c = await makeInstall(shareDir, { name: 'carol' });
  await syncAll([...installs, c]);
  await join(a, c, inbox, [...installs, c]);
  const views = [a, b, c].map((x) => x.engine.verdicts(inbox));
  for (const v of views) {
    assert.deepEqual(v.pending, []);
    assert.deepEqual(v.valid, views[0].valid);
    assert.deepEqual(settled(v), settled(views[0]));
  }
  assert.deepEqual(bodiesOf(a, inbox), ['A1', 'A3']);
  assert.deepEqual(bodiesOf(c, inbox), ['A1', 'A3']);
  assert.ok(settled(views[0]).includes(a2) && settled(views[0]).includes(a3old.id), "A2 and A3' are refused");
  for (const x of [a, b, c]) await x.close();
});

// ---- the convergence property ----

// Every record file on the share as an Incoming, with its route and writer read from its path.
function shareRecords(shareDir) {
  const root = path.join(shareDir, SHARE_ROOT);
  return fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.rec')).map((rel) => {
    const parts = rel.split(path.sep);
    const writer = parts.at(-2);
    const route = parts[0] === 'directory' ? { kind: 'directory' } : parts[0] === 'mailbox' ? { kind: 'mailbox', fp: parts[1] } : { kind: 'inbox', id: parts[1] };
    return { route, writer, bytes: fs.readFileSync(path.join(root, rel)), rel };
  }).sort((x, y) => (x.rel < y.rel ? -1 : 1));
}

// A fresh install that only ingests what it is handed, in the order handed.
async function reader(records) {
  const dataDir = tmpDir('code-inbox-reader-');
  const store = createStore(dataDir, { log: silentLog });
  await store.load();
  const identity = await loadIdentity(dataDir);
  const engine = createEngine({ store, identity, log: silentLog, makeTransport: () => { throw new Error('a reader has no transport'); } });
  await engine.boot();
  for (const r of records) await engine.ingest(r);
  return { engine, dataDir };
}

function seeded(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6d2b79f5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32; };
}
function shuffle(list, seed) {
  const rnd = seeded(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

// Invariant: verdicts are a function of the record set alone: readers fed one record set covering membership
// changes, two removals, a re-add, chains, a fork, a stale write and a pre-signed link, in many seeded orders (and
// with the owner's or the member's dir scanned first), hold the same valid and refused sets as the owner, with nothing
// pending; a reader restarted from its data dir keeps them.
test('readers fed the same records in any order reach the same valid and refused sets with nothing pending', { timeout: 120_000 }, async () => {
  const { shareDir, installs, inbox } = await team(['alice', 'bob', 'dave']);
  const [a, b, d] = installs;
  const bob = await loadIdentity(b.dataDir);
  await b.engine.sendMessage(inbox, 'b1');
  await d.engine.sendMessage(inbox, 'd1');
  await syncAll(installs);
  const [b1] = a.engine.messages(inbox).filter((m) => m.body === 'b1').map((m) => m.id);
  // Epoch 2: bob is a member. A fork of b1, and a message pointing at a pre-signed one bob holds back.
  const fork = sign(bob, inbox, 'fork of b1', 2, b1);
  const held = sign(bob, inbox, 'held back', 2, b1);
  const pointer = sign(bob, inbox, 'points at the held one', 2, held.id);
  plant(shareDir, inbox, b.fp, fork.bytes);
  plant(shareDir, inbox, b.fp, pointer.bytes);
  await a.engine.sync(); // alice holds the fork before b2, so b2 is her last valid message from bob
  await d.engine.sync();
  await b.engine.sendMessage(inbox, 'b2');
  await syncAll(installs);
  await a.engine.removeMember(inbox, b.fp); // first removal
  await b.engine.sendMessage(inbox, 'stale');
  await syncAll(installs);
  plant(shareDir, inbox, b.fp, held.bytes);
  const inv = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(inv.id, true); // re-add
  await syncAll(installs);
  await b.engine.sendMessage(inbox, 'b3');
  await d.engine.sendMessage(inbox, 'd2');
  await syncAll(installs);
  await a.engine.removeMember(inbox, b.fp); // second removal
  await syncAll(installs);

  const records = shareRecords(shareDir);
  const owner = a.engine.verdicts(inbox);
  assert.deepEqual(bodiesOf(a, inbox).sort(), ['b1', 'b2', 'b3', 'd1', 'd2'].sort());
  assert.deepEqual(owner.pending, []);
  assert.equal(settled(owner).length, 4, 'the fork, the held message, the pointer and the stale write are refused');
  for (const r of [fork, held, pointer]) assert.ok(settled(owner).includes(r.id));
  const byWriter = (first) => [...records].sort((x, y) => (x.writer === first) - (y.writer === first) || (x.rel < y.rel ? -1 : 1)).reverse();
  const orders = [
    ['share order', records],
    ['reversed', [...records].reverse()],
    ["owner's dir first", byWriter(a.fp)],
    ["member's dir first", byWriter(b.fp)],
    ...Array.from({ length: 12 }, (_, i) => [`seed ${i + 1}`, shuffle(records, i + 1)]),
  ];
  for (const [label, order] of orders) {
    const r = await reader(order);
    const v = r.engine.verdicts(inbox);
    assert.deepEqual(v.pending, [], `${label}: nothing pending`);
    assert.deepEqual(v.valid, owner.valid, `${label}: the same valid messages as the owner`);
    assert.deepEqual(settled(v), settled(owner), `${label}: the same refused messages as the owner`);
    if (label === 'seed 1') {
      await r.engine.stop();
      const store = createStore(r.dataDir, { log: silentLog });
      await store.load();
      const restarted = createEngine({ store, identity: await loadIdentity(r.dataDir), log: silentLog, makeTransport: () => { throw new Error('no transport'); } });
      await restarted.boot();
      assert.deepEqual(restarted.verdicts(inbox), v, 'a restarted reader keeps its verdicts');
    }
  }
  for (const x of installs) await x.close();
});

// Invariant: a cached kept-chain walk that crossed a pending record does not outlive that record's refusal: the
// running reader's verdicts equal those of the same data dir booted afresh.
test('a refusal of a link a cached walk crossed invalidates the walk; verdicts match a fresh boot', async () => {
  const owner = await loadIdentity(tmpDir());
  const carol = await loadIdentity(tmpDir());
  const nonce = crypto.randomBytes(16).toString('hex');
  const create = encodeRecord(owner, { type: 'inbox-create', signer: owner.fp, ts: 1, inbox: sharedId(owner.fp, nonce), nonce, name: 'team' });
  const inbox = create.payload.inbox;
  let ts = 10;
  const member = (fields) => encodeRecord(owner, { type: 'member', signer: owner.fp, ts: ts++, inbox, member: carol.fp, ...fields });
  const msgOf = (body, epoch, prev) => encodeRecord(carol, { type: 'msg', signer: carol.fp, ts: ts++, inbox, body, epoch, prev });
  const add1 = member({ seq: 1, op: 'add' });
  const P = msgOf('P', 1, null);
  const H = msgOf('H', 2, P.id);
  const add2 = member({ seq: 2, op: 'add' });
  let remove2;
  do remove2 = member({ seq: 2, op: 'remove', keepHead: P.id }); while (remove2.id > add2.id); // the tie resolves to the remove
  const remove3 = member({ seq: 3, op: 'remove', keepHead: H.id });
  const at = (r, route, writer) => ({ route, writer, bytes: r.bytes });
  const onInbox = { kind: 'inbox', id: inbox };

  const dataDir = tmpDir('code-inbox-reader-');
  const boot = async () => {
    const store = createStore(dataDir, { log: silentLog });
    await store.load();
    const engine = createEngine({ store, identity: await loadIdentity(dataDir), log: silentLog, makeTransport: () => { throw new Error('a reader has no transport'); } });
    await engine.boot();
    return engine;
  };
  const engine = await boot();
  for (const x of [at(create, { kind: 'directory' }, owner.fp), at(add1, onInbox, owner.fp), at(P, onInbox, carol.fp), at(remove3, onInbox, owner.fp), at(H, onInbox, carol.fp)]) await engine.ingest(x);
  assert.deepEqual(engine.verdicts(inbox).pending, [H.id], 'H waits for epoch 2');
  assert.deepEqual(engine.verdicts(inbox).valid, [P.id], 'the seq-3 walk through the pending H reaches P, and is cached');
  await engine.ingest(at(remove2, onInbox, owner.fp)); // epoch 2 removes carol: H is refused NOT_MEMBER
  await engine.ingest(at(add2, onInbox, owner.fp));
  const running = engine.verdicts(inbox);
  assert.deepEqual(running.rejected, [H.id]);
  await engine.stop();
  const fresh = (await boot()).verdicts(inbox);
  assert.deepEqual(running, fresh, 'the running reader agrees with a fresh boot of its data dir');
  assert.deepEqual(fresh.valid, [], 'P is off the seq-3 chain once H is refused');
});
