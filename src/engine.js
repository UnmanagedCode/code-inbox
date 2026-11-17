import { EventEmitter } from 'node:events';
import { CodedError } from './errors.js';
import { formatFingerprint } from './identity.js';
import { withLock } from './mutex.js';
import { BODY_MAX_BYTES, FP_RE, ID_RE, NAME_RE, RECORD_MAX_BYTES, decodeRecord, encodeRecord, newNonce, personalInboxId, routeFor, sharedInboxId } from './records.js';
import {
  addRecord, classify, createIndex, currentEpoch, currentMembers, directory, inboxesOf, interestOf, invalidMessages,
  messagesOf, nameRefusal, pendingActions, personalInvite, responseOf, sharedCreate, sharedInboxes,
} from './state.js';
import { assertTransport, isRoute, routeKey, sameRoute } from './transport/index.js';
import { validateShareDir } from './transport/fileShare.js';

export const RECENT_REJECTS = 20;
export const READ_LIMIT_DEFAULT = 50;
export const READ_LIMIT_MAX = 200;
// How many scan rounds one sync() runs while the interest keeps growing (an accepted invite adds an inbox).
const SYNC_ROUNDS = 4;

const refuse = (code, message) => { throw new CodedError(code, message); };

// The install's protocol core: ingest (transport → verify → route binding → authorization → store) and every
// action a human or agent can take. Surfaces (REST, MCP) call these and only map results onto their wire shapes.
// `makeTransport(shareDir)` builds the transport for a configured share dir.
export function createEngine({ store, identity, makeTransport, now = Date.now, log = console }) {
  const self = identity.fp;
  const events = new EventEmitter();
  const locked = (fn) => withLock(`engine:${store.dataDir}`, fn);
  let index = createIndex();
  let settings;
  let pins = {};
  let cursors = {};
  let outbox = [];
  const pending = new Map(); // record id → {id, payload, route, bytes}
  const rejected = { count: 0, recent: [] };
  let transport = null;
  let interestKey = '';

  function noteReject(reason, detail, id) {
    rejected.count += 1;
    rejected.recent.unshift({ reason, detail: detail ?? null, id: id ?? null, at: now() });
    rejected.recent.length = Math.min(rejected.recent.length, RECENT_REJECTS);
  }

  // ---- derived views ----

  const dir = () => directory(index, pins);
  function person(fp, ids = dir().identities) {
    const ident = ids.get(fp);
    return { fp, name: ident?.shown ? ident.name : null };
  }

  async function persistNewPins() {
    const { newPins } = dir();
    if (Object.keys(newPins).length === 0) return;
    pins = { ...pins, ...newPins };
    await store.savePins(pins);
  }

  function refreshInterest() {
    if (!transport) return false;
    const routes = interestOf(index, self);
    const key = routes.map(routeKey).join(' ');
    if (key === interestKey) return false;
    interestKey = key;
    transport.setInterest(routes);
    return true;
  }

  // ---- ingest ----

  async function acceptRecord(rec, reactions) {
    const seq = await store.appendAccepted({ id: rec.id, route: rec.route, bytes: rec.bytes });
    const entry = { seq, id: rec.id, payload: rec.payload, route: rec.route };
    addRecord(index, entry);
    const p = rec.payload;
    if (p.type === 'msg') events.emit('message', { seq, id: rec.id, inbox: p.inbox, signer: p.signer });
    if (p.type === 'invite-response' && p.accept && p.to === self) reactions.push(rec);
  }

  // An accepted response to this install's shared invite admits the invitee (an admission is a member record).
  async function react(reactions) {
    for (const rec of reactions) {
      const inv = index.invites.get(rec.payload.invite);
      if (inv?.payload.kind !== 'shared' || inv.payload.signer !== self) continue;
      if (currentMembers(index, inv.payload.inbox)?.has(rec.payload.signer)) continue;
      await writeMember(inv.payload.inbox, 'add', rec.payload.signer);
    }
  }

  // Classifies a verified, route-bound record; accepted ones may unblock pending ones, so pending is drained after.
  async function admit(rec) {
    if (index.byId.has(rec.id) || pending.has(rec.id)) return;
    const c = classify(index, rec);
    if (c.verdict === 'reject') { noteReject(c.reason, rec.payload.type, rec.id); return; }
    if (c.verdict === 'pending') {
      pending.set(rec.id, rec);
      await store.savePending([...pending.values()]);
      return;
    }
    const reactions = [];
    await acceptRecord(rec, reactions);
    let changed = false;
    for (let progress = true; progress;) {
      progress = false;
      for (const [id, p] of pending) {
        const pc = classify(index, p);
        if (pc.verdict === 'pending') continue;
        pending.delete(id);
        changed = true;
        if (pc.verdict === 'reject') { noteReject(pc.reason, p.payload.type, id); continue; }
        await acceptRecord(p, reactions);
        progress = true;
      }
    }
    if (changed) await store.savePending([...pending.values()]);
    await persistNewPins();
    refreshInterest();
    await react(reactions);
  }

  // The transport's sink: `retry` only while the bytes may still be arriving.
  function ingest({ route, writer, bytes }) {
    return locked(async () => {
      const d = decodeRecord(bytes);
      if (!d.ok) {
        if (d.reason === 'BAD_JSON') return { retry: true };
        noteReject(d.reason, d.detail);
        return { retry: false };
      }
      if (!isRoute(route) || d.payload.signer !== writer || !sameRoute(routeFor(d.payload), route)) {
        noteReject('ROUTE_MISMATCH', `${d.payload.type} arrived on ${isRoute(route) ? routeKey(route) : 'an invalid route'}`, d.id);
        return { retry: false };
      }
      await admit({ id: d.id, payload: d.payload, route, bytes: Buffer.from(bytes) });
      return { retry: false };
    });
  }

  // ---- sending ----

  function recipientsOf(p) {
    if (p.type === 'announce' || p.type === 'inbox-create') return [...dir().identities.keys()].filter((fp) => fp !== self);
    if ('to' in p) return [p.to];
    const inv = personalInvite(index, p.inbox);
    const set = new Set(inv ? [inv.payload.signer, inv.payload.to] : currentMembers(index, p.inbox) ?? []);
    if (p.type === 'member') set.add(p.member);
    set.delete(self);
    return [...set];
  }

  async function saveOutbox() { await store.saveOutbox(outbox); }

  async function deliver(bytes, route, to) {
    let left;
    try {
      ({ pending: left } = await transport.send(bytes, { route, to }));
    } catch (err) {
      log.warn(`code-inbox: sending on ${routeKey(route)} failed, kept in the outbox: ${err.message}`);
      left = to;
    }
    if (left.length) { outbox.push({ route, to: left, bytes }); await saveOutbox(); }
  }

  // Re-sends outbox entries (only those addressed to `fp`, when given).
  async function flushOutbox(fp) {
    if (!transport || !outbox.length) return;
    const next = [];
    for (const e of outbox) {
      const targets = fp ? e.to.filter((t) => t === fp) : e.to;
      if (!targets.length) { next.push(e); continue; }
      let left;
      try { ({ pending: left } = await transport.send(e.bytes, { route: e.route, to: targets })); } catch { left = targets; }
      const remaining = e.to.filter((t) => !targets.includes(t) || left.includes(t));
      if (remaining.length) next.push({ ...e, to: remaining });
    }
    outbox = next;
    await saveOutbox();
  }

  // Signs, sends and ingests one record of this install's; resolves its record id.
  async function publish(fields) {
    const payload = { ...fields, signer: self, ts: now() };
    const { bytes, id } = encodeRecord(identity, payload);
    const route = routeFor(payload);
    await deliver(bytes, route, recipientsOf(payload));
    await admit({ id, payload, route, bytes });
    return id;
  }

  async function writeMember(inbox, op, member, keep) {
    const seqs = (index.members.get(inbox) ?? []).map((m) => m.payload.seq);
    const seq = Math.max(0, ...seqs) + 1;
    return publish({ type: 'member', inbox, seq, op, member, ...(keep ? { keep } : {}) });
  }

  // ---- guards ----

  const requireShare = () => { if (!transport) refuse('SHARE_UNCONFIGURED', 'no share dir is configured: a human sets it in the code-inbox page'); };
  const requireFp = (fp, what = 'to') => { if (typeof fp !== 'string' || !FP_RE.test(fp)) refuse('BAD_REQUEST', `${what} must be a 64-hex fingerprint`); };
  function requireKnownIdentity(fp) {
    requireFp(fp);
    if (fp === self) refuse('BAD_REQUEST', 'cannot address this install itself');
    if (!dir().identities.get(fp)?.shown) refuse('IDENTITY_UNKNOWN', `no identity ${fp.slice(0, 16)} is shown in the directory`);
  }
  function requireOwnedShared(inbox) {
    const c = typeof inbox === 'string' && ID_RE.test(inbox) ? sharedCreate(index, inbox) : null;
    if (!c) refuse('INBOX_UNKNOWN', `no shared inbox ${String(inbox).slice(0, 40)}`);
    if (c.payload.signer !== self) refuse('NOT_OWNER', 'only the inbox owner can do this');
    return c;
  }

  // The inbox `self` belongs to, or a refusal: INBOX_UNKNOWN when this install knows no such inbox, NOT_MEMBER when
  // it knows it but is not (or no longer) a party or member.
  function myInbox(inbox) {
    const known = typeof inbox === 'string' && ID_RE.test(inbox) && (personalInvite(index, inbox) || sharedCreate(index, inbox));
    if (!known) refuse('INBOX_UNKNOWN', `no inbox ${String(inbox).slice(0, 40)}`);
    const mine = inboxesOf(index, self).find((b) => b.id === inbox);
    if (!mine) refuse('NOT_MEMBER', 'this install is not a party or member of that inbox');
    return mine;
  }

  // ---- views ----

  function messageView(rec, ids) {
    const p = rec.payload;
    return { id: rec.id, seq: rec.seq, sender: person(p.signer, ids), ts: p.ts, body: p.body };
  }

  function inboxView(b, ids) {
    const cursor = cursors[b.id] ?? 0;
    const unread = messagesOf(index, b.id).filter((m) => m.seq > cursor && m.payload.signer !== self).length;
    return {
      id: b.id,
      kind: b.kind,
      name: b.kind === 'shared' ? b.name : person(b.peer, ids).name,
      owner: b.owner ? person(b.owner, ids) : null,
      members: b.members.map((fp) => person(fp, ids)),
      unread,
    };
  }

  const listInboxes = () => {
    const ids = dir().identities;
    return inboxesOf(index, self).map((b) => inboxView(b, ids));
  };

  return {
    events,
    fp: self,

    async boot() {
      const loaded = await store.load();
      settings = loaded.settings;
      pins = loaded.pins;
      cursors = loaded.cursors;
      outbox = loaded.outbox;
      index = createIndex();
      for (const e of loaded.accepted) {
        const d = decodeRecord(e.bytes);
        if (!d.ok) { log.warn(`code-inbox: accepted record seq ${e.seq} no longer decodes (${d.reason}): skipped`); continue; }
        addRecord(index, { seq: e.seq, id: d.id, payload: d.payload, route: e.route });
      }
      for (const e of loaded.pending) {
        const d = decodeRecord(e.bytes);
        if (d.ok) pending.set(d.id, { id: d.id, payload: d.payload, route: e.route, bytes: e.bytes });
      }
      await persistNewPins();
      if (settings.shareDir) await startTransport(settings.shareDir);
    },

    async stop() {
      if (transport) await transport.stop();
      transport = null;
    },

    // One scan of the share (or a catch-up with online peers), plus an outbox re-send. Runs further rounds while
    // what it accepted widened the interest, so a single call follows an invite through to its inbox.
    async sync() {
      if (!transport) return;
      for (let i = 0; i < SYNC_ROUNDS; i += 1) {
        const before = interestKey;
        await transport.sync();
        await locked(() => flushOutbox());
        if (interestKey === before) break;
      }
    },

    ingest,

    // ---- identity and share ----

    setName(name) {
      return locked(async () => {
        if (typeof name !== 'string' || !NAME_RE.test(name)) refuse('NAME_INVALID', 'a name is 1–32 of A–Z a–z 0–9 . _ -, starting with a letter or digit');
        const r = nameRefusal(index, pins, self, name);
        if (r) refuse(r, r === 'NAME_TAKEN' ? `the name ${name} is pinned to another identity` : `another identity claims the name ${name}`);
        settings = { ...settings, name };
        await store.saveSettings(settings);
        return { name };
      });
    },

    setShare(shareDir) {
      return locked(async () => {
        await validateShareDir(shareDir, store.dataDir);
        settings = { ...settings, shareDir };
        await store.saveSettings(settings);
        await startTransport(shareDir);
        return { shareDir };
      });
    },

    announce() {
      return locked(async () => {
        requireShare();
        const { name } = settings;
        if (!name) refuse('NAME_MISSING', 'set a name before announcing');
        const r = nameRefusal(index, pins, self, name);
        if (r) refuse(r, `the name ${name} cannot be announced: ${r}`);
        return { id: await publish({ type: 'announce', name, addr: transport.addresses() }) };
      });
    },

    // ---- personal inboxes ----

    invite(to) {
      return locked(async () => {
        requireShare();
        requireKnownIdentity(to);
        for (const inv of index.invites.values()) {
          const p = inv.payload;
          const pair = (p.signer === self && p.to === to) || (p.signer === to && p.to === self);
          if (pair && p.kind === 'personal' && responseOf(index, inv.id)?.payload.accept !== false) refuse('INVITE_EXISTS', 'a personal invite between these identities is open or accepted');
        }
        const nonce = newNonce();
        const inbox = personalInboxId(self, to, nonce);
        return { id: await publish({ type: 'invite', to, kind: 'personal', inbox, nonce }), inbox };
      });
    },

    respondInvite(inviteId, acceptIt) {
      return locked(async () => {
        requireShare();
        if (typeof acceptIt !== 'boolean') refuse('BAD_REQUEST', 'accept must be a boolean');
        const inv = typeof inviteId === 'string' ? index.invites.get(inviteId) : null;
        if (!inv || inv.payload.to !== self) refuse('INVITE_UNKNOWN', 'no invite to this install with that id');
        if (responseOf(index, inv.id)) refuse('INVITE_ANSWERED', 'that invite is already answered');
        const p = inv.payload;
        return { id: await publish({ type: 'invite-response', to: p.signer, invite: inv.id, inbox: p.inbox, accept: acceptIt }) };
      });
    },

    // ---- shared inboxes ----

    createSharedInbox(name) {
      return locked(async () => {
        requireShare();
        if (typeof name !== 'string' || !NAME_RE.test(name)) refuse('NAME_INVALID', 'an inbox name is 1–32 of A–Z a–z 0–9 . _ -, starting with a letter or digit');
        const nonce = newNonce();
        const inbox = sharedInboxId(self, nonce);
        await publish({ type: 'inbox-create', inbox, nonce, name });
        return { id: inbox };
      });
    },

    inviteMember(inbox, to) {
      return locked(async () => {
        requireShare();
        const c = requireOwnedShared(inbox);
        requireKnownIdentity(to);
        if (currentMembers(index, inbox)?.has(to)) refuse('ALREADY_MEMBER', 'that identity is already a member');
        for (const inv of index.invitesByInbox.get(inbox) ?? []) {
          if (inv.payload.to === to && !responseOf(index, inv.id)) refuse('INVITE_EXISTS', 'an invite to that identity is still open');
        }
        return { id: await publish({ type: 'invite', to, kind: 'shared', inbox, nonce: c.payload.nonce }) };
      });
    },

    requestJoin(inbox) {
      return locked(async () => {
        requireShare();
        const c = typeof inbox === 'string' && ID_RE.test(inbox) ? sharedCreate(index, inbox) : null;
        if (!c) refuse('INBOX_UNKNOWN', `no shared inbox ${String(inbox).slice(0, 40)}`);
        if (currentMembers(index, inbox)?.has(self)) refuse('ALREADY_MEMBER', 'this install is already a member');
        if (pendingActions(index, self).outgoingJoins.some((r) => r.payload.inbox === inbox)) refuse('REQUEST_EXISTS', 'a join request for that inbox is still open');
        return { id: await publish({ type: 'join-request', to: c.payload.signer, inbox }) };
      });
    },

    respondJoin(requestId, acceptIt) {
      return locked(async () => {
        requireShare();
        if (typeof acceptIt !== 'boolean') refuse('BAD_REQUEST', 'accept must be a boolean');
        const req = typeof requestId === 'string' ? index.joinRequests.get(requestId) : null;
        if (!req || req.payload.to !== self) refuse('REQUEST_UNKNOWN', 'no join request to this install with that id');
        if (!pendingActions(index, self).incomingJoins.some((r) => r.id === req.id)) refuse('REQUEST_ANSWERED', 'that join request is already answered');
        const p = req.payload;
        if (acceptIt) return { id: await writeMember(p.inbox, 'add', p.signer) };
        return { id: await publish({ type: 'join-response', to: p.signer, request: req.id, inbox: p.inbox, accept: false }) };
      });
    },

    removeMember(inbox, member) {
      return locked(async () => {
        requireShare();
        requireOwnedShared(inbox);
        requireFp(member, 'member');
        if (member === self) refuse('BAD_REQUEST', 'the owner cannot remove itself');
        if (!currentMembers(index, inbox)?.has(member)) refuse('NOT_MEMBER', 'that identity is not a member');
        // Every reader keeps exactly the messages the owner had accepted from the member (docs/protocol.md → Removal).
        const keep = (index.msgs.get(inbox) ?? []).filter((m) => m.payload.signer === member).map((m) => m.id);
        return { id: await writeMember(inbox, 'remove', member, keep) };
      });
    },

    // ---- messages: the single send path for every surface ----

    sendMessage(inbox, body) {
      return locked(async () => {
        requireShare();
        const b = myInbox(inbox);
        if (typeof body !== 'string' || body.length === 0) refuse('BAD_REQUEST', 'body must be a non-empty string');
        const size = Buffer.byteLength(body, 'utf8');
        if (size > BODY_MAX_BYTES) refuse('BODY_TOO_LARGE', `the body is ${size} bytes; the limit is ${BODY_MAX_BYTES}`);
        const fields = { type: 'msg', inbox, body, ...(b.kind === 'shared' ? { epoch: currentEpoch(index, inbox) } : {}) };
        const probe = encodeRecord(identity, { ...fields, signer: self, ts: now() });
        if (probe.bytes.length > RECORD_MAX_BYTES) refuse('BODY_TOO_LARGE', `the encoded record exceeds ${RECORD_MAX_BYTES} bytes (escaped characters count more than once)`);
        return { id: await publish(fields), inbox };
      });
    },

    // Every valid message of an inbox this install belongs to, oldest first (the list the UI and agents read).
    messages(inbox) {
      myInbox(inbox);
      const ids = dir().identities;
      return messagesOf(index, inbox).map((m) => messageView(m, ids));
    },

    // Without `after`: the unread messages (past the read cursor, not this install's own). With `after`: every message
    // past that acceptance seq. `markRead` advances the cursor to the last one returned.
    readMessages(inbox, { after, limit = READ_LIMIT_DEFAULT, markRead = true } = {}) {
      return locked(async () => {
        myInbox(inbox);
        if (after !== undefined && !(Number.isSafeInteger(after) && after >= 0)) refuse('BAD_REQUEST', 'after must be a non-negative integer');
        if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= READ_LIMIT_MAX)) refuse('BAD_REQUEST', `limit must be an integer 1–${READ_LIMIT_MAX}`);
        const cursor = cursors[inbox] ?? 0;
        const ids = dir().identities;
        const all = messagesOf(index, inbox);
        const picked = (after === undefined ? all.filter((m) => m.seq > cursor && m.payload.signer !== self) : all.filter((m) => m.seq > after)).slice(0, limit);
        let next = cursor;
        if (markRead && picked.length) {
          next = Math.max(cursor, picked.at(-1).seq);
          if (next !== cursor) { cursors = { ...cursors, [inbox]: next }; await store.saveCursors(cursors); }
        }
        return { inbox, messages: picked.map((m) => messageView(m, ids)), cursor: next };
      });
    },

    listInboxes,

    // Valid messages from others, in this install's inboxes, accepted after `seq`: what the notifier announces.
    unseenSince(seq) {
      const out = [];
      for (const b of inboxesOf(index, self)) {
        for (const m of messagesOf(index, b.id)) if (m.seq > seq && m.payload.signer !== self) out.push({ seq: m.seq, inbox: b.id, signer: m.payload.signer });
      }
      return out.sort((a, b) => a.seq - b.seq);
    },

    maxSeq: () => index.maxSeq,
    person: (fp) => person(fp),
    inboxName(inbox) {
      const b = inboxesOf(index, self).find((x) => x.id === inbox);
      return b ? inboxView(b, dir().identities).name : null;
    },
    settings: () => settings,
    async saveNotifyTarget(target) {
      settings = { ...settings, notifyTarget: target };
      await store.saveSettings(settings);
    },

    // The UI's whole view.
    state() {
      const ids = dir().identities;
      const acts = pendingActions(index, self);
      const own = ids.get(self);
      const inviteView = (inv) => ({
        id: inv.id, kind: inv.payload.kind, inbox: inv.payload.inbox, from: person(inv.payload.signer, ids), to: person(inv.payload.to, ids),
        inboxName: inv.payload.kind === 'shared' ? sharedCreate(index, inv.payload.inbox)?.payload.name ?? null : null, ts: inv.payload.ts,
      });
      const joinView = (r) => ({ id: r.id, inbox: r.payload.inbox, inboxName: sharedCreate(index, r.payload.inbox)?.payload.name ?? null, from: person(r.payload.signer, ids), ts: r.payload.ts });
      const outgoingJoin = new Set(acts.outgoingJoins.map((r) => r.payload.inbox));
      return {
        identity: {
          fp: self,
          fingerprint: formatFingerprint(self),
          name: settings.name,
          announcedName: own?.name ?? null,
          nameStatus: own ? (own.shown ? 'shown' : own.reason) : 'unannounced',
        },
        share: { dir: settings.shareDir, configured: !!transport },
        directory: [...ids.values()].filter((i) => i.shown && i.fp !== self).map((i) => ({ fp: i.fp, fingerprint: formatFingerprint(i.fp), name: i.name })),
        sharedInboxes: sharedInboxes(index).map((s) => ({
          id: s.id, name: s.name, owner: person(s.owner, ids), memberCount: s.members?.length ?? null,
          isMember: !!s.members?.includes(self), isOwner: s.owner === self, requestPending: outgoingJoin.has(s.id),
        })),
        invites: { incoming: acts.incomingInvites.map(inviteView), outgoing: acts.outgoingInvites.map(inviteView) },
        joinRequests: { incoming: acts.incomingJoins.map(joinView), outgoing: acts.outgoingJoins.map(joinView) },
        inboxes: listInboxes(),
        diagnostics: { rejected: rejected.count, recent: rejected.recent, hidden: invalidMessages(index), pending: pending.size, outbox: outbox.length },
      };
    },
  };

  // Swaps in the transport for `shareDir`. The old one is stopped without waiting: its scan may be queued behind the
  // engine lock the caller holds. Its sink ignores whatever it still offers.
  async function startTransport(shareDir) {
    const old = transport;
    const t = assertTransport(makeTransport(shareDir));
    transport = t;
    if (old) old.stop().catch((err) => log.warn(`code-inbox: stopping the previous transport failed: ${err.message}`));
    interestKey = '';
    refreshInterest();
    await t.start({
      record: (incoming) => (transport === t ? ingest(incoming) : Promise.resolve({ retry: false })),
      peerOnline: (fp) => (transport === t ? locked(() => flushOutbox(fp)) : undefined),
    });
  }
}
