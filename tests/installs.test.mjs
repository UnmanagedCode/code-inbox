import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { encodeRecord } from '../src/records.js';
import { SHARE_ROOT } from '../src/transport/fileShare.js';
import { loadIdentity } from '../src/identity.js';
import { connectPersonal, makeInstall, makeNetwork, mcpCall, syncAll, tmpDir } from './helpers.mjs';

// Several whole installs (engine, MCP, REST) over one temp share. "Human" sends go through each install's REST app
// (POST api/inboxes/:id/messages), "agent" sends through the send_message tool.
const human = async (x, inbox, body) => {
  const r = await x.rest('POST', `/api/inboxes/${inbox}/messages`, { body });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const agent = async (x, inbox, body) => (await mcpCall(assert, x.mcp, 'send_message', { inbox, body }, 'json')).structured;
const agentRead = async (x, inbox, args = {}) => (await mcpCall(assert, x.mcp, 'read_messages', { inbox, after: 0, markRead: false, ...args }, 'json')).structured.messages;
const humanRead = async (x, inbox) => {
  const r = await x.rest('GET', `/api/inboxes/${inbox}/messages`);
  assert.equal(r.status, 200, r.text);
  return r.json.messages;
};
const bodies = (msgs) => msgs.map((m) => m.body);
const closeAll = async (xs) => { for (const x of xs) await x.close(); };

// Invariant: announcing publishes name + key; every install lists the others with their fingerprints.
test('announce → every install lists the others by name and fingerprint', async () => {
  const { installs } = await makeNetwork(['alice', 'bob', 'carol']);
  for (const x of installs) {
    const dir = x.engine.state().directory;
    const others = installs.filter((y) => y !== x);
    assert.deepEqual(dir.map((d) => [d.name, d.fp]).sort(), others.map((y) => [y.name, y.fp]).sort());
    for (const d of dir) assert.equal(d.fingerprint.replaceAll(' ', ''), d.fp.slice(0, 32));
  }
  await closeAll(installs);
});

// Invariant: a personal inbox exists for both parties once the invitee accepts, and for no one else.
test('personal invite → accept creates the inbox for both parties only', async () => {
  const { installs } = await makeNetwork(['alice', 'bob', 'carol']);
  const [a, b, c] = installs;
  const { id, inbox } = await a.engine.invite(b.fp);
  await syncAll(installs);
  assert.deepEqual(b.engine.state().invites.incoming.map((i) => [i.id, i.from.name]), [[id, 'alice']]);
  assert.deepEqual(a.engine.state().invites.outgoing.map((i) => i.id), [id]);
  await b.engine.respondInvite(id, true);
  await syncAll(installs);
  for (const x of [a, b]) assert.deepEqual(x.engine.listInboxes().map((i) => [i.id, i.kind]), [[inbox, 'personal']]);
  assert.equal(a.engine.listInboxes()[0].name, 'bob', "a personal inbox is named after the other party");
  assert.deepEqual(c.engine.listInboxes(), []);
  assert.deepEqual(b.engine.state().invites.incoming, []);
  await closeAll(installs);
});

// Invariant: a declined invite creates no inbox and nobody can write to it.
test('personal invite → decline creates no inbox; sends are refused', async () => {
  const { installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const { id, inbox } = await a.engine.invite(b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(id, false);
  await syncAll(installs);
  for (const x of installs) assert.deepEqual(x.engine.listInboxes(), []);
  const r = await mcpCall(assert, a.mcp, 'send_message', { inbox, body: 'hello?' }, 'json');
  assert.equal(r.code, 'NOT_MEMBER');
  await closeAll(installs);
});

// Invariant: human (REST) and agent (MCP) messages share one path: both parties see all of them, in both surfaces.
test('personal inbox: human and agent messages both ways reach the other party in both surfaces', async () => {
  const { installs } = await makeNetwork(['alice', 'bob', 'carol']);
  const [a, b] = installs;
  const inbox = await connectPersonal(a, b, installs);
  await human(a, inbox, 'alice (human)');
  await agent(a, inbox, 'alice (agent)');
  await human(b, inbox, 'bob (human)');
  await agent(b, inbox, 'bob (agent)');
  await syncAll(installs);
  const all = ['alice (human)', 'alice (agent)', 'bob (human)', 'bob (agent)'];
  for (const x of [a, b]) {
    assert.deepEqual(bodies(await agentRead(x, inbox)).sort(), [...all].sort());
    assert.deepEqual(bodies(await humanRead(x, inbox)).sort(), [...all].sort());
  }
  const fromA = (await agentRead(b, inbox)).filter((m) => m.sender.fp === a.fp);
  assert.deepEqual(fromA.map((m) => m.sender.name), ['alice', 'alice']);
  await closeAll(installs);
});

// Invariant: the unread read returns only others' messages past the cursor and advances it.
test('read_messages without after returns unread mail from others and advances the cursor', async () => {
  const { installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const inbox = await connectPersonal(a, b);
  await agent(a, inbox, 'one');
  await agent(b, inbox, 'mine');
  await syncAll(installs);
  assert.equal(b.engine.listInboxes()[0].unread, 1);
  const first = (await mcpCall(assert, b.mcp, 'read_messages', { inbox }, 'json')).structured;
  assert.deepEqual(bodies(first.messages), ['one']);
  assert.equal(b.engine.listInboxes()[0].unread, 0);
  const again = (await mcpCall(assert, b.mcp, 'read_messages', { inbox }, 'json')).structured;
  assert.deepEqual(again.messages, []);
  assert.equal(again.cursor, first.cursor);
  await agent(a, inbox, 'two');
  await syncAll(installs);
  assert.deepEqual(bodies((await mcpCall(assert, b.mcp, 'read_messages', { inbox, markRead: false }, 'json')).structured.messages), ['two']);
  assert.equal(b.engine.listInboxes()[0].unread, 1, 'markRead:false leaves the cursor');
  await closeAll(installs);
});

// Invariant: a shared inbox admits members by invite (accepted) and by join request (admitted); human and agent
// messages reach every member.
test('shared inbox by invite and by join request: every member sees human and agent messages', async () => {
  const { installs } = await makeNetwork(['alice', 'bob', 'carol', 'dave']);
  const [a, b, c, d] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await syncAll(installs);
  assert.deepEqual(b.engine.state().sharedInboxes.map((s) => [s.name, s.owner.name, s.isMember]), [['team', 'alice', false]]);
  const inv = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(inv.id, true);
  await syncAll(installs);
  await c.engine.requestJoin(inbox);
  await syncAll(installs);
  const [req] = a.engine.state().joinRequests.incoming;
  assert.equal(req.from.name, 'carol');
  await a.engine.respondJoin(req.id, true);
  await syncAll(installs);
  for (const x of [a, b, c]) assert.deepEqual(x.engine.listInboxes()[0].members.map((m) => m.name).sort(), ['alice', 'bob', 'carol']);
  assert.deepEqual(d.engine.listInboxes(), []);
  await human(a, inbox, 'a-human');
  await agent(b, inbox, 'b-agent');
  await human(c, inbox, 'c-human');
  await agent(c, inbox, 'c-agent');
  await syncAll(installs);
  for (const x of [a, b, c]) {
    assert.deepEqual(bodies(await agentRead(x, inbox)).sort(), ['a-human', 'b-agent', 'c-agent', 'c-human']);
    assert.deepEqual(bodies(await humanRead(x, inbox)).sort(), ['a-human', 'b-agent', 'c-agent', 'c-human']);
  }
  assert.equal((await mcpCall(assert, d.mcp, 'send_message', { inbox, body: 'let me in' }, 'json')).code, 'NOT_MEMBER');
  await closeAll(installs);
});

// Invariant: a declined join request admits nobody and clears from both sides' pending lists.
test('a declined join request admits nobody', async () => {
  const { installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await syncAll(installs);
  await b.engine.requestJoin(inbox);
  await syncAll(installs);
  await a.engine.respondJoin(a.engine.state().joinRequests.incoming[0].id, false);
  await syncAll(installs);
  assert.deepEqual(b.engine.listInboxes(), []);
  assert.deepEqual(a.engine.state().joinRequests.incoming, []);
  assert.deepEqual(b.engine.state().joinRequests.outgoing, []);
  await closeAll(installs);
});

async function sharedTeam(names = ['alice', 'bob', 'carol']) {
  const net = await makeNetwork(names);
  const [a, ...rest] = net.installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await syncAll(net.installs);
  for (const x of rest) {
    await x.engine.requestJoin(inbox);
    await syncAll(net.installs);
    await a.engine.respondJoin(a.engine.state().joinRequests.incoming[0].id, true);
    await syncAll(net.installs);
  }
  return { ...net, inbox };
}

// Invariant: a removed member leaves the inbox for everyone; its earlier messages stay (keepHead chain), its sends are refused.
test('the owner removes a member: it leaves, its earlier messages stay, its sends are refused', async () => {
  const { installs, inbox } = await sharedTeam();
  const [a, b, c] = installs;
  await agent(c, inbox, 'from carol, before');
  await syncAll(installs);
  await a.engine.removeMember(inbox, c.fp);
  await syncAll(installs);
  for (const x of [a, b]) {
    assert.deepEqual(x.engine.listInboxes()[0].members.map((m) => m.name).sort(), ['alice', 'bob']);
    assert.deepEqual(bodies(await agentRead(x, inbox)), ['from carol, before']);
  }
  assert.deepEqual(c.engine.listInboxes(), []);
  assert.equal((await mcpCall(assert, c.mcp, 'send_message', { inbox, body: 'still here?' }, 'json')).code, 'NOT_MEMBER');
  await closeAll(installs);
});

// ---- attacks planted straight into the share ----

function plant(shareDir, parts, bytes, n = 0) {
  const dir = path.join(shareDir, SHARE_ROOT, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${String(Date.now()).padStart(13, '0')}-${String(n).padStart(32, '0')}.rec`), bytes);
}
const filesUnder = (shareDir, ...parts) => {
  const dir = path.join(shareDir, SHARE_ROOT, ...parts);
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)));
};

// Invariant: forged, tampered, replayed, non-member and post-removal records are each rejected and counted on every
// reader, and valid traffic flows on unaffected.
test('planted attacks are rejected and counted; valid traffic is unaffected', async () => {
  const { shareDir, installs, inbox } = await sharedTeam(['alice', 'bob', 'carol']);
  const [a, b, c] = installs;
  const mallory = await loadIdentity(tmpDir());
  const personal = await connectPersonal(a, b, installs);
  await agent(a, personal, 'personal before');
  await agent(c, inbox, 'carol before');
  await syncAll(installs);
  await a.engine.removeMember(inbox, c.fp);
  await syncAll(installs);
  const base = new Map(installs.map((x) => [x, x.engine.state().diagnostics.rejected]));
  const epoch = 1; // member records: 1 admits bob, 2 admits carol, 3 removes carol

  // 1. mallory's msg claiming to be bob, in bob's subdir: signed by mallory's key → SIGNER_MISMATCH
  const asBob = { type: 'msg', signer: b.fp, ts: Date.now(), inbox, body: 'I am bob', epoch, prev: null };
  const forged = JSON.parse(encodeRecord(mallory, { ...asBob, signer: mallory.fp }).bytes);
  const pb = Buffer.from(JSON.stringify(asBob));
  forged.payload = pb.toString('base64url');
  forged.sig = mallory.sign(Buffer.concat([Buffer.from('code-inbox/v1\0'), pb])).toString('base64url');
  plant(shareDir, ['inboxes', inbox, b.fp], Buffer.from(JSON.stringify(forged)), 1);
  // 2. one of alice's real messages with a flipped byte in its body
  const [real] = filesUnder(shareDir, 'inboxes', personal, a.fp);
  const env = JSON.parse(real);
  const payload = Buffer.from(env.payload, 'base64url');
  payload[payload.indexOf('personal before')] = 'P'.charCodeAt(0);
  plant(shareDir, ['inboxes', personal, a.fp], Buffer.from(JSON.stringify({ ...env, payload: payload.toString('base64url') })), 2);
  // 3. a message of alice's copied from the personal inbox into the shared one
  plant(shareDir, ['inboxes', inbox, a.fp], real, 3);
  // 4. a non-member's (mallory's) correctly signed message, in its own subdir
  plant(shareDir, ['inboxes', inbox, mallory.fp], encodeRecord(mallory, { type: 'msg', signer: mallory.fp, ts: Date.now(), inbox, body: 'let me in', epoch: 2, prev: null }).bytes, 4);
  // 5. carol (removed at epoch 3) writes on, citing her old epoch and chaining onto her last kept message
  const carolId = await loadIdentity(c.dataDir);
  const carolLast = a.engine.messages(inbox).at(-1).id;
  plant(shareDir, ['inboxes', inbox, c.fp], encodeRecord(carolId, { type: 'msg', signer: c.fp, ts: Date.now(), inbox, body: 'carol after', epoch: 2, prev: carolLast }).bytes, 5);
  await syncAll(installs);

  const reasons = (x) => x.engine.state().diagnostics.recent.map((r) => r.reason);
  for (const x of [a, b]) {
    assert.equal(x.engine.state().diagnostics.rejected - base.get(x), 5, `${x.name} counted every attack`);
    assert.deepEqual(new Set(reasons(x).slice(0, 5)), new Set(['SIGNER_MISMATCH', 'BAD_SIGNATURE', 'ROUTE_MISMATCH', 'NOT_MEMBER', 'REMOVED']));
    assert.deepEqual(bodies(await agentRead(x, inbox)), ['carol before']);
    assert.deepEqual(bodies(await agentRead(x, personal)), ['personal before']);
  }
  await agent(b, inbox, 'bob after');
  await agent(b, personal, 'personal after');
  await syncAll(installs);
  assert.deepEqual(bodies(await agentRead(a, inbox)), ['carol before', 'bob after']);
  assert.deepEqual(bodies(await agentRead(a, personal)), ['personal before', 'personal after']);
  await closeAll(installs);
});

// Invariant: removal is a fixed-size record, so removing a member that wrote more messages than a keep list could
// hold is accepted by every reader, survives the owner's restart, and still keeps the member's earlier messages.
test('a removal after hundreds of messages is accepted everywhere and survives the owner\'s restart', { timeout: 60_000 }, async () => {
  const { shareDir, installs, inbox } = await sharedTeam(['alice', 'bob', 'carol']);
  const [a, b, c] = installs;
  const COUNT = 800;
  for (let i = 0; i < COUNT; i += 1) await c.engine.sendMessage(inbox, `carol ${i}`);
  await syncAll(installs);
  await a.engine.removeMember(inbox, c.fp);
  await syncAll(installs);
  const membersOf = (x) => x.engine.listInboxes().find((i) => i.id === inbox)?.members.map((m) => m.name).sort();
  for (const x of [a, b]) {
    assert.deepEqual(membersOf(x), ['alice', 'bob'], `${x.name} applied the removal`);
    assert.equal(x.engine.messages(inbox).length, COUNT, `${x.name} keeps carol's messages`);
    assert.equal(x.engine.state().diagnostics.rejected, 0);
  }
  assert.deepEqual(c.engine.listInboxes(), [], 'carol sees herself removed');
  await a.close();
  const restarted = await makeInstall(null, { dataDir: a.dataDir });
  assert.deepEqual(membersOf(restarted), ['alice', 'bob'], 'the removal survives the restart');
  assert.equal(restarted.engine.messages(inbox).length, COUNT);
  // carol writes on, chaining onto her last message: rejected by everyone.
  const carolId = await loadIdentity(c.dataDir);
  const last = restarted.engine.messages(inbox).at(-1).id;
  plant(shareDir, ['inboxes', inbox, c.fp], encodeRecord(carolId, { type: 'msg', signer: c.fp, ts: Date.now(), inbox, body: 'after removal', epoch: 2, prev: last }).bytes, 9);
  await syncAll([restarted, b]);
  for (const x of [restarted, b]) assert.equal(x.engine.messages(inbox).length, COUNT);
  await restarted.close();
  await b.close();
  await c.close();
});

// Invariant: a removed member cannot re-admit itself by re-signing an acceptance of the invite it was admitted by;
// an honest re-invite after the removal admits it again.
test('a replayed acceptance re-admits nobody; a fresh invite does', async () => {
  const { shareDir, installs } = await makeNetwork(['alice', 'bob']);
  const [a, b] = installs;
  const { id: inbox } = await a.engine.createSharedInbox('team');
  await syncAll(installs);
  const inv = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(inv.id, true);
  await syncAll(installs);
  assert.equal(a.engine.listInboxes()[0].members.length, 2, 'bob admitted');
  await a.engine.removeMember(inbox, b.fp);
  await syncAll(installs);
  const bobId = await loadIdentity(b.dataDir);
  const replay = encodeRecord(bobId, { type: 'invite-response', signer: b.fp, ts: Date.now() + 1, to: a.fp, invite: inv.id, inbox, accept: true });
  plant(shareDir, ['mailbox', a.fp, b.fp], replay.bytes, 7);
  await syncAll(installs);
  assert.deepEqual(a.engine.listInboxes()[0].members.map((m) => m.name), ['alice'], 'still removed');
  assert.deepEqual(b.engine.listInboxes(), []);
  const again = await a.engine.inviteMember(inbox, b.fp);
  await syncAll(installs);
  await b.engine.respondInvite(again.id, true);
  await syncAll(installs);
  assert.deepEqual(a.engine.listInboxes()[0].members.map((m) => m.name).sort(), ['alice', 'bob']);
  await closeAll(installs);
});
