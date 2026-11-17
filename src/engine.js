import { EventEmitter } from 'node:events';
import { CodedError } from './errors.js';
import { formatFingerprint } from './identity.js';
import { withLock } from './mutex.js';
import { BODY_MAX_BYTES, FP_RE, ID_RE, NAME_RE, RECORD_MAX_BYTES, decodeCard, decodeRecord, encodeCard, encodeRecord, newNonce, personalInboxId, routeFor, sharedInboxId } from './records.js';
import {
  addPending, addRecord, addRejected, admissionDue, classify, contactsOf, createIndex, inboxVerdicts, isValidMessage, mayPull, mayRead, removePending, currentEpoch, currentMembers, directory,
  inboxesOf, interestOf, invalidMessages, messagesOf, nameRefusal, pendingActions, personalInvite, responseOf, sharedCreate, sharedInboxes, sharesInbox,
} from './state.js';
import { assertTransport, isRoute, routeKey, sameRoute } from './transport/index.js';
import { checkStoredShareDir, validateShareDir } from './transport/fileShare.js';
import { resolveTcpConfig } from './transport/tcp.js';

export const RECENT_REJECTS = 20;
export const READ_LIMIT_DEFAULT = 50;
export const READ_LIMIT_MAX = 200;
// How often the whole outbox is re-sent while it holds anything.
export const OUTBOX_RETRY_MS = 30_000;
// How many scan rounds one sync() runs while the interest keeps growing (an accepted invite adds an inbox).
const SYNC_ROUNDS = 4;

const refuse = (code, message) => { throw new CodedError(code, message); };

// A send that throws one of these may succeed later (the share's mount is down, a filesystem or network error):
// the write stays owed in the outbox even when no recipient is named. Any other throw keeps only its recipients.
export const isRetryableSendError = (err) => err?.code === 'SHARE_UNAVAILABLE' || /^E[A-Z0-9]+$/.test(err?.code ?? '');

const defaultSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

// The install's protocol core: ingest (transport → verify → route binding → authorization → store) and every
// action a human or agent can take. Surfaces (REST, MCP) call these and only map results onto their wire shapes.
// `makeTransport(config, view)` builds the transport for `settings.transport` ({kind:'file-share', dir} or
// {kind:'tcp', host, port, advertise}); `view` is the read-only engine view a transport may need (docs/transport.md).
// `schedule(fn, ms)` → cancel drives the outbox retry timer (tests inject one).
export function createEngine({ store, identity, makeTransport, now = Date.now, schedule = defaultSchedule, outboxRetryMs = OUTBOX_RETRY_MS, log = console }) {
  const self = identity.fp;
  const events = new EventEmitter();
  const locked = (fn) => withLock(`engine:${store.dataDir}`, fn);
  let index = createIndex();
  let settings;
  let pins = {};
  let cursors = {};
  let outbox = [];
  const rejected = { count: 0, recent: [] };
  let transport = null;
  let transportError = null;
  let shareUnavailable = false; // the last file-share send found the share root missing
  let retryTimer = null; // cancel function of the armed outbox retry
  let stopped = false;
  let interestKey = '';
  let imported = []; // fingerprints of identities whose contact card a human imported
  const ownLog = new Map(); // routeKey → [{seq, bytes}] of records signed by self, seq ascending
  const announceBytes = new Map(); // announce record id → bytes

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

  function remember(seq, id, payload, route, bytes) {
    if (payload.type === 'announce') announceBytes.set(id, bytes);
    if (payload.signer !== self) return;
    const key = routeKey(route);
    const list = ownLog.get(key);
    if (list) list.push({ seq, bytes }); else ownLog.set(key, [{ seq, bytes }]);
  }

  async function acceptRecord(rec, reactions) {
    const seq = await store.appendAccepted({ id: rec.id, route: rec.route, bytes: rec.bytes });
    const entry = { seq, id: rec.id, payload: rec.payload, route: rec.route };
    addRecord(index, entry);
    remember(seq, rec.id, rec.payload, rec.route, rec.bytes);
    const p = rec.payload;
    if (p.type === 'msg') events.emit('message', { seq, id: rec.id, inbox: p.inbox, signer: p.signer });
    if (p.type === 'invite-response' && p.accept && p.to === self) reactions.push(rec);
  }

  // An accepted response to this install's shared invite admits the invitee (an admission is a member record), but
  // only while admissionDue holds: a replayed acceptance of an invite older than a removal admits nobody.
  async function react(reactions) {
    for (const rec of reactions) {
      const inv = index.invites.get(rec.payload.invite);
      if (!inv || inv.payload.signer !== self || !admissionDue(index, inv)) continue;
      await writeMember(inv.payload.inbox, 'add', inv.payload.to);
    }
  }

  // Admissions owed for acceptances accepted before a crash or restart (react runs only as a record arrives).
  async function reconcileAdmissions() {
    for (const inv of [...index.invites.values()]) {
      if (inv.payload.signer === self && admissionDue(index, inv)) await writeMember(inv.payload.inbox, 'add', inv.payload.to);
    }
  }

  // Refuses a record for good: counted, and its id remembered (persisted) so what builds on it is refused too.
  async function rejectRecord(rec, reason) {
    noteReject(reason, rec.payload.type, rec.id);
    const p = rec.payload;
    const info = { reason, type: p.type, inbox: p.inbox ?? null, signer: p.signer };
    addRejected(index, rec.id, info);
    await store.appendRejected({ id: rec.id, ...info });
  }

  // Classifies a verified, route-bound record; any verdict may settle pending ones, so pending is drained after.
  async function admit(rec) {
    if (index.byId.has(rec.id) || index.pending.has(rec.id) || index.rejected.has(rec.id)) return;
    const c = classify(index, rec);
    const reactions = [];
    if (c.verdict === 'reject') await rejectRecord(rec, c.reason);
    else if (c.verdict === 'pending') {
      addPending(index, rec);
      await store.savePending([...index.pending.values()]);
    } else await acceptRecord(rec, reactions);
    // Even a pending record can settle others: a removal's kept chain is walked through pending records.
    await drainPending(reactions);
    await persistNewPins();
    refreshInterest();
    await react(reactions);
  }

  // Re-classifies every pending record until a round settles none; settled ones leave the pending set.
  async function drainPending(reactions) {
    let changed = false;
    for (let progress = true; progress;) {
      progress = false;
      for (const [id, p] of [...index.pending]) {
        const pc = classify(index, p);
        if (pc.verdict === 'pending') continue;
        removePending(index, id);
        changed = true;
        progress = true;
        if (pc.verdict === 'reject') await rejectRecord(p, pc.reason); else await acceptRecord(p, reactions);
      }
    }
    if (changed) await store.savePending([...index.pending.values()]);
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

  // The outbox retry timer is armed exactly while the outbox holds anything (and the engine runs).
  function armRetry() {
    if (stopped || !outbox.length) { if (retryTimer) { retryTimer(); retryTimer = null; } return; }
    if (retryTimer) return;
    retryTimer = schedule(() => {
      retryTimer = null;
      locked(() => flushOutbox()).catch((err) => log.warn(`code-inbox: re-sending the outbox failed: ${err.message}`)).finally(armRetry);
    }, outboxRetryMs);
  }

  async function saveOutbox() {
    await store.saveOutbox(outbox);
    armRetry();
  }

  // One send through the transport: resolves the recipients still pending and whether the write itself is still
  // owed (a retryable throw). SHARE_UNSAFE is rethrown; any other throw keeps every recipient pending.
  async function trySend(bytes, route, to) {
    try {
      const { pending } = await transport.send(bytes, { route, to });
      shareUnavailable = false;
      return { left: pending, owed: false };
    } catch (err) {
      if (err.code === 'SHARE_UNSAFE') throw err;
      if (err.code === 'SHARE_UNAVAILABLE') shareUnavailable = true;
      const owed = isRetryableSendError(err);
      log.warn(`code-inbox: sending on ${routeKey(route)} failed, kept in the outbox${owed ? ' and retried' : ''}: ${err.message}`);
      return { left: to, owed };
    }
  }

  // An entry stays in the outbox while it has recipients left, or while its write is owed (`to` may then be []).
  async function deliver(bytes, route, to) {
    // A share this install must not write to is permanent: the action is refused, nothing is admitted locally.
    const { left, owed } = await trySend(bytes, route, to);
    if (left.length || owed) { outbox.push({ route, to: left, bytes }); await saveOutbox(); }
  }

  // Re-sends outbox entries: every one (a full flush), or only those addressed to `fp`. Only a full flush re-sends
  // an entry with no recipients left, which is an owed write; it leaves once a send succeeds. Always under the engine
  // lock, so two flushes never send one entry at once.
  async function flushOutbox(fp) {
    if (!transport || !outbox.length) return;
    const next = [];
    for (const e of outbox) {
      const targets = fp ? e.to.filter((t) => t === fp) : e.to;
      if (fp && !targets.length) { next.push(e); continue; }
      let sent;
      // SHARE_UNSAFE here refuses nothing (the action succeeded long ago): the entry waits for a human to fix the share.
      try { sent = await trySend(e.bytes, e.route, targets); } catch { sent = { left: targets, owed: true }; }
      const remaining = e.to.filter((t) => !targets.includes(t) || sent.left.includes(t));
      if (remaining.length || sent.owed) next.push({ ...e, to: remaining });
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

  async function writeMember(inbox, op, member, extra = {}) {
    const seqs = (index.members.get(inbox) ?? []).map((m) => m.payload.seq);
    const seq = Math.max(0, ...seqs) + 1;
    return publish({ type: 'member', inbox, seq, op, member, ...extra });
  }

  // The id of the last valid message by `signer` in `inbox` (acceptance order), or null: a sender's `prev`, an
  // owner's `keepHead`. Never an invalid one: validity is prefix-closed along prev.
  function lastValidOf(inbox, signer) {
    const msgs = index.msgs.get(inbox) ?? [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) if (msgs[i].payload.signer === signer && isValidMessage(index, msgs[i])) return msgs[i].id;
    return null;
  }

  // ---- guards ----

  const requireTransport = () => { if (!transport) refuse('TRANSPORT_UNCONFIGURED', 'no transport is configured: a human sets one in the code-inbox page'); };
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

  // ---- what a transport may read (docs/transport.md → The engine view). Synchronous, in memory, lock-free. ----

  // This install's own records on `route` with an acceptance seq past `since`, as many as fit in `budget` bytes,
  // if `reader` may read the route. A denial says nothing else, not even how many records this install holds.
  function serve(reader, route, since, budget) {
    if (!isRoute(route) || !mayRead(index, reader, route)) return { status: 'denied' };
    const head = index.maxSeq;
    const list = ownLog.get(routeKey(route)) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].seq <= since) lo = mid + 1; else hi = mid; }
    const recs = [];
    let used = 0;
    for (; lo < list.length && used + list[lo].bytes.length <= budget; lo += 1) { recs.push(list[lo]); used += list[lo].bytes.length; }
    return { status: 'ok', recs, more: lo < list.length, head };
  }

  const announceOf = (fp) => {
    const id = dir().identities.get(fp)?.id;
    return id ? announceBytes.get(id) ?? null : null;
  };

  const view = {
    addrsOf: (fp) => dir().identities.get(fp)?.addr ?? [],
    // `fp`'s announce for `requester`, only when the two share an inbox here (member discovery); else null.
    announceFor: (requester, fp) => (sharesInbox(index, requester, fp) ? announceOf(fp) : null),
    contacts: () => contactsOf(index, self, imported),
    mayPull: (peer, route) => mayPull(index, self, peer, route),
    serve,
  };

  function transportView() {
    const cfg = settings.transport;
    const tcp = cfg?.kind === 'tcp' ? cfg : null;
    const addresses = transport ? transport.addresses() : [];
    const own = dir().identities.get(self);
    const bytes = announceOf(self);
    return {
      kind: cfg?.kind === 'tcp' || cfg?.kind === 'file-share' ? cfg.kind : null,
      configured: !!transport,
      dir: cfg?.kind === 'file-share' ? cfg.dir : null,
      host: tcp?.host ?? null,
      port: tcp?.port ?? null,
      advertise: tcp?.advertise ?? null,
      addresses,
      card: bytes ? encodeCard(bytes) : null,
      cardStale: !!bytes && JSON.stringify(own.addr) !== JSON.stringify(addresses),
      error: transportError,
      // The share's root (its mount) was missing at the last write: writes wait in the outbox and are retried.
      unavailable: shareUnavailable,
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
      imported = loaded.contacts;
      cursors = loaded.cursors;
      outbox = loaded.outbox;
      index = createIndex();
      for (const e of loaded.accepted) {
        const d = decodeRecord(e.bytes);
        if (!d.ok) { log.warn(`code-inbox: accepted record seq ${e.seq} no longer decodes (${d.reason}): skipped`); continue; }
        addRecord(index, { seq: e.seq, id: d.id, payload: d.payload, route: e.route });
        remember(e.seq, d.id, d.payload, e.route, e.bytes);
      }
      for (const { id, ...info } of loaded.rejected) addRejected(index, id, info);
      for (const e of loaded.pending) {
        const d = decodeRecord(e.bytes);
        if (d.ok && !index.byId.has(d.id) && !index.rejected.has(d.id)) addPending(index, { id: d.id, payload: d.payload, route: e.route, bytes: e.bytes });
      }
      // Close the crash windows: pending records whose dependency was settled, and admissions not yet written.
      const reactions = [];
      await drainPending(reactions);
      if (index.pending.size !== loaded.pending.length) await store.savePending([...index.pending.values()]);
      await persistNewPins();
      if (settings.transport) {
        // A stored config is checked like a saved one: an invalid one leaves no transport, with the reason shown.
        let config;
        try {
          config = await validStoredTransport(settings.transport);
        } catch (err) {
          if (!(err instanceof CodedError)) throw err;
          transportError = { code: err.code, message: err.message };
          log.warn(`code-inbox: the stored transport is invalid, none started: ${err.message}`);
          return;
        }
        try {
          await startTransport(config);
        } catch (err) {
          if (err.code !== 'TCP_LISTEN_FAILED') throw err;
          log.warn(`code-inbox: ${err.message}`);
          return;
        }
        await locked(async () => { await reconcileAdmissions(); await flushOutbox(); });
      }
    },

    async stop() {
      stopped = true;
      if (retryTimer) { retryTimer(); retryTimer = null; }
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

    // ---- identity, transport and contacts ----

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
        settings = { ...settings, transport: { kind: 'file-share', dir: shareDir } };
        await store.saveSettings(settings);
        await startTransport(settings.transport);
        await reconcileAdmissions();
        await flushOutbox();
        return { shareDir };
      });
    },

    // Refused TCP_INVALID (resolveTcpConfig) or TCP_LISTEN_FAILED (the port is taken or not allowed): then no
    // transport is configured until a human saves settings that listen.
    setTcp(input) {
      return locked(async () => {
        const cfg = await resolveTcpConfig(input);
        settings = { ...settings, transport: { kind: 'tcp', ...cfg } };
        await store.saveSettings(settings);
        await startTransport(settings.transport);
        // Admissions owed since a boot that started no transport (e.g. the port was taken then), and the outbox.
        await reconcileAdmissions();
        await flushOutbox();
        return { ...cfg, addresses: transport.addresses() };
      });
    },

    // Imports another identity's contact card: its announce is ingested as if its signer wrote it (route
    // directory, writer = signer; every other check still runs), and the identity becomes a contact to dial.
    async importCard(text) {
      const result = await locked(async () => {
        const bytes = decodeCard(text);
        const d = bytes ? decodeRecord(bytes) : null;
        if (!d?.ok) refuse('CARD_INVALID', `not a contact card${d ? ` (${d.reason})` : ''}`);
        const p = d.payload;
        if (p.type !== 'announce') refuse('CARD_INVALID', `a contact card carries an announce, not ${p.type}`);
        if (p.signer === self) refuse('CARD_INVALID', 'that is this install\'s own card');
        await admit({ id: d.id, payload: p, route: routeFor(p), bytes });
        if (!imported.includes(p.signer)) {
          imported = [...imported, p.signer];
          await store.saveContacts(imported);
        }
        const ident = dir().identities.get(p.signer);
        return { fp: p.signer, name: ident?.name ?? p.name, shown: !!ident?.shown };
      });
      // Outside the lock: dialing pulls, and a pull waits for the lock.
      transport?.sync().catch((err) => log.warn(`code-inbox: syncing after a card import failed: ${err.message}`));
      return result;
    },

    announce() {
      return locked(async () => {
        requireTransport();
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
        requireTransport();
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
        requireTransport();
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
        requireTransport();
        if (typeof name !== 'string' || !NAME_RE.test(name)) refuse('NAME_INVALID', 'an inbox name is 1–32 of A–Z a–z 0–9 . _ -, starting with a letter or digit');
        const nonce = newNonce();
        const inbox = sharedInboxId(self, nonce);
        await publish({ type: 'inbox-create', inbox, nonce, name });
        return { id: inbox };
      });
    },

    inviteMember(inbox, to) {
      return locked(async () => {
        requireTransport();
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
        requireTransport();
        const c = typeof inbox === 'string' && ID_RE.test(inbox) ? sharedCreate(index, inbox) : null;
        if (!c) refuse('INBOX_UNKNOWN', `no shared inbox ${String(inbox).slice(0, 40)}`);
        if (currentMembers(index, inbox)?.has(self)) refuse('ALREADY_MEMBER', 'this install is already a member');
        if (pendingActions(index, self).outgoingJoins.some((r) => r.payload.inbox === inbox)) refuse('REQUEST_EXISTS', 'a join request for that inbox is still open');
        return { id: await publish({ type: 'join-request', to: c.payload.signer, inbox }) };
      });
    },

    respondJoin(requestId, acceptIt) {
      return locked(async () => {
        requireTransport();
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
        requireTransport();
        requireOwnedShared(inbox);
        requireFp(member, 'member');
        if (member === self) refuse('BAD_REQUEST', 'the owner cannot remove itself');
        if (!currentMembers(index, inbox)?.has(member)) refuse('NOT_MEMBER', 'that identity is not a member');
        // Every reader keeps the member's messages on the prev chain back from the last one valid here
        // (docs/protocol.md → Removal): a fixed-size record however busy the member was.
        return { id: await writeMember(inbox, 'remove', member, { keepHead: lastValidOf(inbox, member) }) };
      });
    },

    // ---- messages: the single send path for every surface ----

    sendMessage(inbox, body) {
      return locked(async () => {
        requireTransport();
        const b = myInbox(inbox);
        if (typeof body !== 'string' || body.length === 0) refuse('BAD_REQUEST', 'body must be a non-empty string');
        const size = Buffer.byteLength(body, 'utf8');
        if (size > BODY_MAX_BYTES) refuse('BODY_TOO_LARGE', `the body is ${size} bytes; the limit is ${BODY_MAX_BYTES}`);
        const shared = b.kind === 'shared' ? { epoch: currentEpoch(index, inbox), prev: lastValidOf(inbox, self) } : {};
        try {
          return { id: await publish({ type: 'msg', inbox, body, ...shared }), inbox };
        } catch (err) {
          if (err.code === 'RECORD_TOO_LARGE') refuse('BODY_TOO_LARGE', `the encoded record exceeds ${RECORD_MAX_BYTES} bytes (escaped characters count more than once)`);
          throw err;
        }
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
    // Every message of an inbox this install has seen, by verdict (diagnostics; the convergence tests compare them).
    verdicts: (inbox) => inboxVerdicts(index, inbox),
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
        transport: transportView(),
        directory: [...ids.values()].filter((i) => i.shown && i.fp !== self).map((i) => ({ fp: i.fp, fingerprint: formatFingerprint(i.fp), name: i.name })),
        sharedInboxes: sharedInboxes(index).map((s) => ({
          id: s.id, name: s.name, owner: person(s.owner, ids), memberCount: s.members?.length ?? null,
          isMember: !!s.members?.includes(self), isOwner: s.owner === self, requestPending: outgoingJoin.has(s.id),
        })),
        invites: { incoming: acts.incomingInvites.map(inviteView), outgoing: acts.outgoingInvites.map(inviteView) },
        joinRequests: { incoming: acts.incomingJoins.map(joinView), outgoing: acts.outgoingJoins.map(joinView) },
        inboxes: listInboxes(),
        diagnostics: { rejected: rejected.count, recent: rejected.recent, hidden: invalidMessages(index), pending: index.pending.size, outbox: outbox.length },
      };
    },
  };

  // The stored transport config, checked at boot: a TCP config as when it was saved (resolveTcpConfig); a share dir
  // by checkStoredShareDir, which does not require it to exist, so a share whose mount is not up yet still starts and
  // is scanned once it appears. Refused SHARE_INVALID, TCP_INVALID or TRANSPORT_INVALID (an unknown kind).
  async function validStoredTransport(cfg) {
    if (cfg?.kind === 'tcp') {
      const { host, port, advertise } = cfg;
      return { kind: 'tcp', ...(await resolveTcpConfig({ host, port, advertise })) };
    }
    if (cfg?.kind === 'file-share') return { kind: 'file-share', dir: await checkStoredShareDir(cfg.dir, store.dataDir) };
    throw new CodedError('TRANSPORT_INVALID', `unknown transport kind ${JSON.stringify(cfg?.kind)?.slice(0, 40)}`);
  }

  // Swaps in the transport for `config`. The old one is stopped without waiting: its scan or pull may be queued
  // behind the engine lock the caller holds. Its sink ignores whatever it still offers. A TCP listener that cannot
  // bind leaves no transport configured and refuses TCP_LISTEN_FAILED.
  async function startTransport(config) {
    const old = transport;
    const t = assertTransport(makeTransport(config, view));
    transport = t;
    transportError = null;
    shareUnavailable = false;
    if (old) old.stop().catch((err) => log.warn(`code-inbox: stopping the previous transport failed: ${err.message}`));
    interestKey = '';
    refreshInterest();
    try {
      await t.start({
        record: (incoming) => (transport === t ? ingest(incoming) : Promise.resolve({ retry: false })),
        peerOnline: (fp) => {
          if (transport === t) locked(() => flushOutbox(fp)).catch((err) => log.warn(`code-inbox: flushing the outbox failed: ${err.message}`));
        },
      });
    } catch (err) {
      if (transport === t) transport = null;
      t.stop().catch(() => {});
      if (config.kind !== 'tcp') throw err;
      transportError = { code: 'TCP_LISTEN_FAILED', message: `cannot listen on ${config.host}:${config.port}: ${err.code ?? err.message}` };
      throw new CodedError(transportError.code, transportError.message);
    }
  }
}
