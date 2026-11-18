import { EventEmitter } from 'node:events';
import { createDirectory } from './directory.js';
import { CodedError } from './errors.js';
import { formatFingerprint } from './identity.js';
import { withLock } from './mutex.js';
import { BODY_MAX_BYTES, FP_RE, ID_RE, NAME_RE, RECORD_MAX_BYTES, decodeCard, decodeRecord, encodeCard, encodeRecord, newNonce, personalInboxId, routeFor, sharedInboxId } from './records.js';
import {
  addPending, addRecord, addRejected, admissionDue, classify, contactsOf, createIndex, inboxVerdicts, isValidMessage, mayPull, mayRead, mayRelay, removePending, currentEpoch, currentMembers,
  directory, inboxesOf, interestOf, invalidMessages, messagesOf, nameRefusal, pendingActions, personalInvite, responseOf, sharedCreate, sharedInboxes, sharedOwner,
} from './state.js';
import { assertTransport, isRoute, routeKey, sameRoute } from './transport/index.js';
import { checkStoredShareDir, ensureShareRoot, validateShareDir } from './transport/fileShare.js';
import { resolveNetworkConfig } from './transport/network.js';

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
// {kind:'network', listen, connections}); `view` is the read-only engine view a transport may need
// (docs/transport.md).
// `schedule(fn, ms)` → cancel drives the outbox retry timer (tests inject one).
// `lookup` replaces the DNS lookup TCP and hub settings are checked with (tests).
export function createEngine({ store, identity, makeTransport, now = Date.now, schedule = defaultSchedule, outboxRetryMs = OUTBOX_RETRY_MS, lookup, log = console }) {
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
  let outboxError = null; // {code, message}: the latest send failure that still holds a write in the outbox
  let loggedCode = null; // the failure code last logged: a retry failing the same way is not logged again
  let retryTimer = null; // cancel function of the armed outbox retry
  let stopped = false;
  let interestKey = '';
  // The announces this install knows, in memory only (src/directory.js); `identities` is what of them persists
  // (identities.json): {fp: {announce: base64url, imported}} for card imports and every fp the log names.
  const known = createDirectory();
  let identities = {};
  let ownAnnounce = null; // this install's current signed announce (re-signed at boot from settings.announced)
  // routeKey → [{seq, bytes, signer}], seq ascending: what this install serves on a route. Its own records, plus, on a
  // shared inbox it owns, every record it accepted there (the owner relays its members' records).
  const serveLog = new Map();

  function noteReject(reason, detail, id) {
    rejected.count += 1;
    rejected.recent.unshift({ reason, detail: detail ?? null, id: id ?? null, at: now() });
    rejected.recent.length = Math.min(rejected.recent.length, RECENT_REJECTS);
  }

  // ---- derived views ----

  const dir = () => directory(known.entries(), pins);
  function person(fp, ids = dir().identities) {
    const ident = ids.get(fp);
    return { fp, name: ident?.shown ? ident.name : null };
  }

  const imported = () => Object.keys(identities).filter((fp) => identities[fp].imported);
  // The identities this install keeps across a restart: card imports and every fp its log names.
  const kept = (fp) => fp !== self && (identities[fp]?.imported || index.named.has(fp));

  // Pins only names of this install and of identities it keeps: a stranger's name is judged in memory and never
  // written, until it becomes a counterparty (then it pins, first key wins).
  async function persistNewPins() {
    const add = Object.entries(dir().newPins).filter(([, fp]) => fp === self || kept(fp));
    if (add.length === 0) return;
    pins = { ...pins, ...Object.fromEntries(add) };
    await store.savePins(pins);
  }

  // identities.json follows the memory directory for every kept fp: written (whole, atomically) only on a change.
  async function syncIdentities() {
    let changed = false;
    const next = { ...identities };
    for (const e of known.entries()) {
      const fp = e.payload.signer;
      if (!kept(fp)) continue;
      const announce = Buffer.from(e.bytes).toString('base64url');
      if (next[fp]?.announce === announce) continue;
      next[fp] = { announce, imported: next[fp]?.imported ?? false };
      changed = true;
    }
    if (!changed) return;
    identities = next;
    await store.saveIdentities(identities);
  }

  // A verified announce (writer binding already checked) into the memory directory; never into the log.
  async function noteAnnounce(d, bytes) {
    if (!known.note({ id: d.id, payload: d.payload, bytes })) return;
    await persistNewPins();
    await syncIdentities();
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

  // Decidable at acceptance and at boot replay alike: an inbox's inbox-create is always accepted before anything on it
  // (msg and member records pend INBOX_UNSEEN without it), and its owner never changes.
  function remember(seq, payload, route, bytes) {
    if (payload.signer !== self && !(route.kind === 'inbox' && sharedOwner(index, route.id) === self)) return;
    const key = routeKey(route);
    const e = { seq, bytes, signer: payload.signer };
    const list = serveLog.get(key);
    if (list) list.push(e); else serveLog.set(key, [e]);
  }

  // `after` collects what an acceptance owes once the index settles: `reactions` (acceptances of this install's
  // shared invites, which admit) and `relays` (a co-member's message on a shared inbox this install owns).
  async function acceptRecord(rec, after) {
    const seq = await store.appendAccepted({ id: rec.id, route: rec.route, bytes: rec.bytes });
    const entry = { seq, id: rec.id, payload: rec.payload, route: rec.route };
    addRecord(index, entry);
    remember(seq, rec.payload, rec.route, rec.bytes);
    const p = rec.payload;
    if (p.type === 'msg') events.emit('message', { seq, id: rec.id, inbox: p.inbox, signer: p.signer });
    if (p.type === 'invite-response' && p.accept && p.to === self) after.reactions.push(rec);
    if (p.type === 'msg' && p.signer !== self && sharedOwner(index, p.inbox) === self) after.relays.push(rec);
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

  // The owner's live relay: a member's message it just accepted goes on to every other current member at once.
  // Best-effort: a member without a session gets it on its next pull from this install's served log, so nothing goes
  // into the outbox. Only where peers pull (capabilities.pull); never at boot, before a transport runs.
  async function relayOut(relays) {
    if (!transport?.capabilities.pull) return;
    for (const rec of relays) {
      const to = [...(currentMembers(index, rec.payload.inbox) ?? [])].filter((fp) => fp !== self && fp !== rec.payload.signer);
      if (!to.length) continue;
      try {
        await transport.send(rec.bytes, { route: rec.route, to });
      } catch (err) {
        log.warn(`code-inbox: relaying on ${routeKey(rec.route)} failed (${err.code ?? 'ERROR'}); members pull it instead: ${err.message}`);
      }
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
    const after = { reactions: [], relays: [] };
    if (c.verdict === 'reject') await rejectRecord(rec, c.reason);
    else if (c.verdict === 'pending') {
      addPending(index, rec);
      await store.savePending([...index.pending.values()]);
    } else await acceptRecord(rec, after);
    // Even a pending record can settle others: a removal's kept chain is walked through pending records.
    await drainPending(after);
    await persistNewPins();
    await syncIdentities();
    refreshInterest();
    await react(after.reactions);
    await relayOut(after.relays);
  }

  // Re-classifies every pending record until a round settles none; settled ones leave the pending set.
  async function drainPending(after) {
    let changed = false;
    for (let progress = true; progress;) {
      progress = false;
      for (const [id, p] of [...index.pending]) {
        const pc = classify(index, p);
        if (pc.verdict === 'pending') continue;
        removePending(index, id);
        changed = true;
        progress = true;
        if (pc.verdict === 'reject') await rejectRecord(p, pc.reason); else await acceptRecord(p, after);
      }
    }
    if (changed) await store.savePending([...index.pending.values()]);
  }

  // The transport's sink: `retry` only while the bytes may still be arriving. The writer must be the record's signer,
  // except for the owner relaying a member's message on its shared inbox (mayRelay); the route must be the record's.
  function ingest({ route, writer, bytes }) {
    return locked(async () => {
      const d = decodeRecord(bytes);
      if (!d.ok) {
        if (d.reason === 'BAD_JSON') return { retry: true };
        noteReject(d.reason, d.detail);
        return { retry: false };
      }
      if (!isRoute(route) || !sameRoute(routeFor(d.payload), route) || (d.payload.signer !== writer && !mayRelay(index, writer, route, d.payload))) {
        noteReject('ROUTE_MISMATCH', `${d.payload.type} arrived on ${isRoute(route) ? routeKey(route) : 'an invalid route'}`, d.id);
        return { retry: false };
      }
      if (d.payload.type === 'announce') await noteAnnounce(d, bytes);
      else await admit({ id: d.id, payload: d.payload, route, bytes: Buffer.from(bytes) });
      return { retry: false };
    });
  }

  // The sink's `announce`: a hub-relayed announce. Self-certifying (the writer is its own signer, as for a card),
  // announces only, into memory only.
  function ingestAnnounce(bytes) {
    return locked(async () => {
      const d = decodeRecord(bytes);
      if (!d.ok || d.payload.type !== 'announce') { noteReject(d.ok ? 'ROUTE_MISMATCH' : d.reason, d.ok ? `a relayed ${d.payload.type}` : d.detail, d.id); return; }
      await noteAnnounce(d, bytes);
    });
  }

  // ---- sending ----

  function recipientsOf(p) {
    // An inbox-create goes to the contacts; anyone else gets it from this install's directory route when it pulls.
    if (p.type === 'inbox-create') return contactsOf(index, self, imported());
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
    if (!outbox.length) { outboxError = null; loggedCode = null; }
    await store.saveOutbox(outbox);
    armRetry();
  }

  // One send through the transport: resolves the recipients still pending, whether the write itself is still owed,
  // and whether it failed. SHARE_UNSAFE is rethrown when `refuseUnsafe` (a fresh action is refused); on a re-send it
  // keeps the write owed until a human fixes the share. A failure is recorded in `outboxError` and logged when its
  // code differs from the last one logged, so a retry timer failing the same way does not flood the log.
  async function trySend(bytes, route, to, { refuseUnsafe = false } = {}) {
    try {
      const { pending } = await transport.send(bytes, { route, to });
      return { left: pending, owed: false, failed: false };
    } catch (err) {
      if (err.code === 'SHARE_UNSAFE' && refuseUnsafe) throw err;
      const code = err.code ?? 'ERROR';
      const owed = code === 'SHARE_UNSAFE' || isRetryableSendError(err);
      // Recorded only for a write the outbox keeps: a dropped one leaves nothing to explain or to clear.
      if (owed || to.length) outboxError = { code, message: err.message };
      if (!owed && !to.length) log.warn(`code-inbox: sending on ${routeKey(route)} failed (${code}) and nothing is left to retry: dropped: ${err.message}`);
      else if (code !== loggedCode) log.warn(`code-inbox: sending on ${routeKey(route)} failed (${code}), kept in the outbox and retried: ${err.message}`);
      loggedCode = code;
      return { left: to, owed, failed: true };
    }
  }

  // An entry stays in the outbox while it has recipients left that it must reach (`keep`), or while its write is owed
  // (`to` may then be []). Recipients outside `keep` are sent to once and never retried.
  async function deliver(bytes, route, to, keep = to) {
    // A share this install must not write to is permanent: the action is refused, nothing is admitted locally.
    const { left, owed } = await trySend(bytes, route, to, { refuseUnsafe: true });
    const kept = left.filter((fp) => keep.includes(fp));
    if (kept.length || owed) { outbox.push({ route, to: kept, bytes }); await saveOutbox(); }
  }

  // The recipients a write must reach. Where peers pull, a member's message on a shared inbox someone else owns must
  // reach only the owner: the owner relays it, and co-members pull it from the owner.
  function mustReach(payload, to) {
    if (!transport.capabilities.pull || payload.type !== 'msg') return to;
    const owner = sharedOwner(index, payload.inbox);
    return owner && owner !== self ? to.filter((fp) => fp === owner) : to;
  }

  // Re-sends outbox entries: every one (a full flush), or only those addressed to `fp`. Only a full flush re-sends
  // an entry with no recipients left, which is an owed write; it leaves once a send succeeds. Always under the engine
  // lock, so two flushes never send one entry at once.
  async function flushOutbox(fp) {
    if (!transport || !outbox.length) return;
    const next = [];
    let failed = false;
    for (const e of outbox) {
      const targets = fp ? e.to.filter((t) => t === fp) : e.to;
      if (fp && !targets.length) { next.push(e); continue; }
      const sent = await trySend(e.bytes, e.route, targets);
      failed ||= sent.failed;
      const remaining = e.to.filter((t) => !targets.includes(t) || sent.left.includes(t));
      if (remaining.length || sent.owed) next.push({ ...e, to: remaining });
    }
    outbox = next;
    // A full flush in which every send went through clears the standing failure.
    if (!fp && !failed) { outboxError = null; loggedCode = null; }
    await saveOutbox();
  }

  // Signs, sends and ingests one record of this install's; resolves its record id.
  async function publish(fields) {
    const payload = { ...fields, signer: self, ts: now() };
    const { bytes, id } = encodeRecord(identity, payload);
    const route = routeFor(payload);
    const to = recipientsOf(payload);
    await deliver(bytes, route, to, mustReach(payload, to));
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

  // What this install serves on `route` (serveLog: its own records, and on a shared inbox it owns every record it
  // accepted there) with an acceptance seq past `since`, never the reader's own, as many as fit in `budget` bytes, if
  // `reader` may read the route. A denial says nothing else, not even how many records this install holds.
  function serve(reader, route, since, budget) {
    if (!isRoute(route) || !mayRead(index, reader, route)) return { status: 'denied' };
    const head = index.maxSeq;
    const list = serveLog.get(routeKey(route)) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].seq <= since) lo = mid + 1; else hi = mid; }
    const recs = [];
    let used = 0;
    for (; lo < list.length; lo += 1) {
      const e = list[lo];
      if (e.signer === reader) continue;
      if (used + e.bytes.length > budget) break;
      recs.push(e);
      used += e.bytes.length;
    }
    return { status: 'ok', recs, more: lo < list.length, head };
  }

  const view = {
    contacts: () => contactsOf(index, self, imported()),
    mayPull: (peer, route) => mayPull(index, self, peer, route),
    serve,
  };

  // A connection's row for the page: the fps it reached, named when the directory shows them.
  const connectionView = (ids) => (c) => ({
    address: c.address,
    kind: c.kind,
    state: c.state,
    peers: c.remote.map((fp) => ({ fp, name: ids.get(fp)?.shown ? ids.get(fp).name : null })),
    error: c.error,
  });

  function transportView() {
    const cfg = settings.transport;
    const network = cfg?.kind === 'network' ? cfg : null;
    const stats = network && transport?.stats ? transport.stats() : null;
    const ids = dir().identities;
    const bytes = ownAnnounce;
    return {
      kind: ['file-share', 'network'].includes(cfg?.kind) ? cfg.kind : null,
      configured: !!transport,
      dir: cfg?.kind === 'file-share' ? cfg.dir : null,
      listen: network?.listen ?? null,
      // Where the listener is bound (the port of an ephemeral listen), while it is up.
      listening: stats?.listening ?? null,
      // Each configured connection's state, for display only; the saved list while no transport runs.
      connections: stats ? stats.connections.map(connectionView(ids))
        : (network?.connections ?? []).map((address) => ({ address, kind: null, state: 'connecting', peers: [], error: null })),
      card: bytes ? encodeCard(bytes) : null,
      error: transportError,
      // The latest send failure still holding writes in the outbox (SHARE_UNAVAILABLE: the share is not mounted).
      outboxError,
    };
  }

  // Every shown identity but this install, strangers included: whether it is a contact, and where it can be reached
  // now (`presence`: [{via, address}], empty when not reachable; the file share reports none).
  function directoryView(ids) {
    const contacts = new Set(contactsOf(index, self, imported()));
    const presence = transport?.stats ? transport.stats().presence : {};
    return [...ids.values()].filter((i) => i.shown && i.fp !== self).map((i) => ({
      fp: i.fp, fingerprint: formatFingerprint(i.fp), name: i.name, contact: contacts.has(i.fp), presence: presence[i.fp] ?? [],
    }));
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
      identities = loaded.identities;
      cursors = loaded.cursors;
      outbox = loaded.outbox;
      index = createIndex();
      // identities.json entries were verified as their fp's announces by the store.
      for (const { announce } of Object.values(identities)) {
        const bytes = Buffer.from(announce, 'base64url');
        const d = decodeRecord(bytes);
        known.note({ id: d.id, payload: d.payload, bytes });
      }
      if (settings.announced) signOwnAnnounce(settings.announced);
      for (const e of loaded.accepted) {
        const d = decodeRecord(e.bytes);
        if (!d.ok) { log.warn(`code-inbox: accepted record seq ${e.seq} no longer decodes (${d.reason}): skipped`); continue; }
        if (d.payload.type === 'announce') { log.warn(`code-inbox: accepted record seq ${e.seq} is an announce, which the log no longer holds: skipped`); continue; }
        addRecord(index, { seq: e.seq, id: d.id, payload: d.payload, route: e.route });
        remember(e.seq, d.payload, e.route, e.bytes);
      }
      for (const { id, ...info } of loaded.rejected) addRejected(index, id, info);
      for (const e of loaded.pending) {
        const d = decodeRecord(e.bytes);
        if (d.ok && d.payload.type !== 'announce' && !index.byId.has(d.id) && !index.rejected.has(d.id)) addPending(index, { id: d.id, payload: d.payload, route: e.route, bytes: e.bytes });
      }
      // Close the crash windows: pending records whose dependency was settled, and admissions not yet written.
      // Reactions and relays wait: admissions are reconciled once a transport runs, and members pull what is relayed.
      await drainPending({ reactions: [], relays: [] });
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
          if (err.code !== 'LISTEN_FAILED') throw err;
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
        const r = nameRefusal(known.entries(), pins, self, name);
        if (r) refuse(r, r === 'NAME_TAKEN' ? `the name ${name} is pinned to another identity` : `another identity claims the name ${name}`);
        settings = { ...settings, name };
        await store.saveSettings(settings);
        return { name };
      });
    },

    setShare(shareDir) {
      return locked(async () => {
        await validateShareDir(shareDir, store.dataDir);
        await ensureShareRoot(shareDir, store.dataDir);
        settings = { ...settings, transport: { kind: 'file-share', dir: shareDir } };
        await store.saveSettings(settings);
        await startTransport(settings.transport);
        await reconcileAdmissions();
        await flushOutbox();
        return { shareDir };
      });
    },

    // Saves the whole network config and rebuilds the transport. Refused NETWORK_INVALID (resolveNetworkConfig,
    // which must resolve every host on a save) or LISTEN_FAILED (the listen port is taken or not allowed): then no
    // transport is configured until a human saves settings that listen. Hosts are resolved before the engine lock is
    // taken: a slow DNS answer blocks no other action.
    async setNetwork(input) {
      const cfg = await resolveNetworkConfig(input, { lookup, mustResolve: true });
      return locked(async () => {
        settings = { ...settings, transport: { kind: 'network', ...cfg } };
        await store.saveSettings(settings);
        await startTransport(settings.transport);
        // Admissions owed since a boot that started no transport (e.g. the port was taken then), and the outbox.
        await reconcileAdmissions();
        await flushOutbox();
        return { ...cfg, listening: transport.stats().listening };
      });
    },

    // Imports another identity's contact card: its announce goes to the memory directory as if its signer wrote it
    // (writer = signer, as for a hub-relayed announce), and the identity becomes a contact, kept in identities.json.
    // A card says who someone is, never where: it gives no route.
    async importCard(text) {
      const result = await locked(async () => {
        const bytes = decodeCard(text);
        const d = bytes ? decodeRecord(bytes) : null;
        if (!d?.ok) refuse('CARD_INVALID', `not a contact card${d ? ` (${d.reason})` : ''}`);
        const p = d.payload;
        if (p.type !== 'announce') refuse('CARD_INVALID', `a contact card carries an announce, not ${p.type}`);
        if (p.signer === self) refuse('CARD_INVALID', 'that is this install\'s own card');
        known.note({ id: d.id, payload: p, bytes });
        identities = { ...identities, [p.signer]: { announce: Buffer.from(known.get(p.signer).bytes).toString('base64url'), imported: true } };
        await store.saveIdentities(identities);
        await persistNewPins();
        const ident = dir().identities.get(p.signer);
        return { fp: p.signer, name: ident?.name ?? p.name, shown: !!ident?.shown };
      });
      // Outside the lock: dialing pulls, and a pull waits for the lock.
      transport?.sync().catch((err) => log.warn(`code-inbox: syncing after a card import failed: ${err.message}`));
      return result;
    },

    // Signs this install's announce, remembers its name (settings.announced: re-signed at every boot) and presents
    // it: the transport gives it to every peer and hub; on the file share it is written as the directory file.
    announce() {
      return locked(async () => {
        requireTransport();
        const { name } = settings;
        if (!name) refuse('NAME_MISSING', 'set a name before announcing');
        const r = nameRefusal(known.entries(), pins, self, name);
        if (r) refuse(r, `the name ${name} cannot be announced: ${r}`);
        settings = { ...settings, announced: name };
        await store.saveSettings(settings);
        const { bytes, id } = signOwnAnnounce(name);
        await persistNewPins();
        transport.setAnnounce(bytes);
        if (transport.capabilities.directory) await deliver(bytes, { kind: 'directory' }, []);
        return { id };
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
        directory: directoryView(ids),
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

  // Signs this install's announce of `name` now, into the memory directory (and the card); → {bytes, id}.
  function signOwnAnnounce(name) {
    const signed = encodeRecord(identity, { type: 'announce', name, signer: self, ts: now() });
    known.note(signed);
    ownAnnounce = signed.bytes;
    return signed;
  }

  // The stored transport config, checked at boot: network settings as when they were saved, except that a
  // connection host that does not resolve yet still starts (resolveNetworkConfig, mustResolve false); a share dir by
  // checkStoredShareDir, which does not require it to exist, so a share whose mount is not up yet still starts and is
  // scanned once it appears. Refused SHARE_INVALID, SHARE_UNSAFE, NETWORK_INVALID or TRANSPORT_INVALID (any other
  // kind).
  async function validStoredTransport(cfg) {
    if (cfg?.kind === 'network') {
      const { listen, connections } = cfg;
      return { kind: 'network', ...(await resolveNetworkConfig({ listen, connections }, { lookup, mustResolve: false })) };
    }
    if (cfg?.kind === 'file-share') return { kind: 'file-share', dir: await checkStoredShareDir(cfg.dir, store.dataDir) };
    throw new CodedError('TRANSPORT_INVALID', `unknown transport kind ${JSON.stringify(cfg?.kind)?.slice(0, 40)}`);
  }

  // Swaps in the transport for `config`. The old one is stopped without waiting: its scan or pull may be queued
  // behind the engine lock the caller holds. Its sink ignores whatever it still offers. A listener that cannot bind
  // leaves no transport configured and refuses LISTEN_FAILED.
  async function startTransport(config) {
    const old = transport;
    const t = assertTransport(makeTransport(config, view));
    transport = t;
    transportError = null;
    outboxError = null;
    loggedCode = null;
    if (old) old.stop().catch((err) => log.warn(`code-inbox: stopping the previous transport failed: ${err.message}`));
    interestKey = '';
    refreshInterest();
    t.setAnnounce(ownAnnounce);
    try {
      await t.start({
        record: (incoming) => (transport === t ? ingest(incoming) : Promise.resolve({ retry: false })),
        announce: (bytes) => {
          if (transport === t) ingestAnnounce(bytes).catch((err) => log.warn(`code-inbox: a relayed announce failed: ${err.message}`));
        },
        peerOnline: (fp) => {
          if (transport === t) locked(() => flushOutbox(fp)).catch((err) => log.warn(`code-inbox: flushing the outbox failed: ${err.message}`));
        },
      });
    } catch (err) {
      if (transport === t) transport = null;
      t.stop().catch(() => {});
      if (config.kind !== 'network') throw err;
      const at = config.listen ? `${config.listen.host}:${config.listen.port}` : 'no address';
      transportError = { code: 'LISTEN_FAILED', message: `cannot listen on ${at}: ${err.code ?? err.message}` };
      throw new CodedError(transportError.code, transportError.message);
    }
  }
}
