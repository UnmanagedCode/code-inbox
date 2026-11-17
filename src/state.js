// The pure fold of accepted records (+ this install's name pins) into what the install knows: the directory,
// invites, inboxes, membership and which messages are valid. No I/O; the engine owns persistence.
//
// A record is {seq, id, payload}: `seq` is the local acceptance seq, `id` the record id (records.js). The index also
// holds the records waiting for a dependency (`pending`) and the ids refused for good (`rejected`): message validity
// walks through both, so a verdict never depends on the order records arrived in.
// Validity rules: docs/protocol.md → Record types.

const cmpTsId = (a, b) => (a.payload.ts - b.payload.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const lowestId = (recs) => recs.reduce((best, r) => (!best || r.id < best.id ? r : best), null);
const push = (map, key, rec) => { const list = map.get(key); if (list) list.push(rec); else map.set(key, [rec]); };

export function createIndex() {
  return {
    byId: new Map(),
    maxSeq: 0,
    announces: new Map(), // signer fp → [rec]
    inboxCreates: new Map(), // inbox id → [rec] (one signer and nonce per id; several only if re-signed)
    invites: new Map(), // invite record id → rec
    personalInvites: new Map(), // inbox id → [rec]
    invitesByInbox: new Map(), // inbox id → [rec] (shared)
    responses: new Map(), // invite record id → [rec]
    joinRequests: new Map(), // record id → rec
    joinRequestsByInbox: new Map(), // inbox id → [rec]
    joinResponses: new Map(), // join-request record id → [rec]
    members: new Map(), // inbox id → [rec]
    msgs: new Map(), // inbox id → [rec], in acceptance order
    pending: new Map(), // record id → {id, payload, …}: verified, route-bound, waiting for a dependency
    rejected: new Map(), // record id → {reason, type, inbox, signer}: refused for good
    // Settled message verdicts (accept/reject; never pending) and completed kept-chain walks. A settled verdict changes
    // only through a record that is not a msg or an announce (membership and removals, invites, responses,
    // inbox-creates), which clears `verdicts`. A completed walk may have crossed pending records; refusing one of them
    // ends the walk sooner, so a refusal clears both. A new message or pending record only settles what was undecided,
    // and undecided verdicts are never kept.
    verdicts: new Map(),
    chains: new Map(),
  };
}

export const addPending = (index, rec) => { index.pending.set(rec.id, rec); };
export const removePending = (index, id) => { index.pending.delete(id); };
export const addRejected = (index, id, info) => {
  index.rejected.set(id, info);
  index.chains.clear();
  index.verdicts.clear();
};

// Adds an accepted record to the index (mutates it). Idempotent by id.
export function addRecord(index, rec) {
  if (index.byId.has(rec.id)) return;
  index.byId.set(rec.id, rec);
  if (rec.payload.type !== 'msg' && rec.payload.type !== 'announce') index.verdicts.clear();
  index.maxSeq = Math.max(index.maxSeq, rec.seq);
  const p = rec.payload;
  switch (p.type) {
    case 'announce': push(index.announces, p.signer, rec); break;
    case 'inbox-create': push(index.inboxCreates, p.inbox, rec); break;
    case 'invite':
      index.invites.set(rec.id, rec);
      push(p.kind === 'personal' ? index.personalInvites : index.invitesByInbox, p.inbox, rec);
      break;
    case 'invite-response': push(index.responses, p.invite, rec); break;
    case 'join-request': index.joinRequests.set(rec.id, rec); push(index.joinRequestsByInbox, p.inbox, rec); break;
    case 'join-response': push(index.joinResponses, p.request, rec); break;
    case 'member': push(index.members, p.inbox, rec); break;
    case 'msg': push(index.msgs, p.inbox, rec); break;
    default: throw new Error(`unknown record type ${p.type}`);
  }
}

export function buildIndex(records) {
  const index = createIndex();
  for (const r of records) addRecord(index, r);
  return index;
}

// ---- inboxes and membership ----

export const sharedCreate = (index, inboxId) => lowestId(index.inboxCreates.get(inboxId) ?? []);
export const personalInvite = (index, inboxId) => lowestId(index.personalInvites.get(inboxId) ?? []);
// The response that counts for an invite: the lowest record id, so every reader picks the same one.
export const responseOf = (index, inviteId) => lowestId(index.responses.get(inviteId) ?? []);

// seq → the member record that counts for it (lowest record id among those sharing a seq).
function memberChain(index, inboxId) {
  const bySeq = new Map();
  for (const r of index.members.get(inboxId) ?? []) {
    const cur = bySeq.get(r.payload.seq);
    if (!cur || r.id < cur.id) bySeq.set(r.payload.seq, r);
  }
  return bySeq;
}

// The highest epoch with every member record 1..epoch present: later ones cannot be applied yet.
function knownEpoch(chain) {
  let e = 0;
  while (chain.has(e + 1)) e += 1;
  return e;
}

// The member set of a shared inbox at `epoch` (epoch 0: the owner alone), or null when this install has not seen
// every member record up to it.
export function membersAt(index, inboxId, epoch) {
  const create = sharedCreate(index, inboxId);
  if (!create) return null;
  const chain = memberChain(index, inboxId);
  if (epoch > knownEpoch(chain)) return null;
  const set = new Set([create.payload.signer]);
  for (let s = 1; s <= epoch; s += 1) {
    const { op, member } = chain.get(s).payload;
    if (op === 'add') set.add(member); else set.delete(member);
  }
  return set;
}

export function currentEpoch(index, inboxId) {
  return knownEpoch(memberChain(index, inboxId));
}

export const currentMembers = (index, inboxId) => membersAt(index, inboxId, currentEpoch(index, inboxId));

// ---- authorization ----

// The chain a removal keeps: walk `prev` from its owner-signed `keepHead`, through accepted and pending records.
// Every id commits to its `prev`, and the owner holds a message valid only once its whole prev chain is valid, so the
// ids reached are exactly messages the owner had accepted. Resolves {ids, missing}: `missing` is the first link not
// seen here yet (null when the walk ended: at null, at a rejected link, or at a record that is not the member's).
function keptChain(index, removal) {
  const cached = index.chains.get(removal.id);
  if (cached) return cached;
  const { inbox, member, keepHead } = removal.payload;
  const ids = new Set();
  let missing = null;
  for (let cur = keepHead; cur !== null && !ids.has(cur);) {
    const r = index.byId.get(cur) ?? index.pending.get(cur);
    if (!r) { if (!index.rejected.has(cur)) missing = cur; break; }
    const p = r.payload;
    if (p.type !== 'msg' || p.signer !== member || p.inbox !== inbox) break;
    ids.add(cur);
    cur = p.prev;
  }
  const result = { ids, missing };
  if (missing === null) index.chains.set(removal.id, result);
  return result;
}

const accept = { verdict: 'accept' };
const pending = (reason) => ({ verdict: 'pending', reason });
const reject = (reason) => ({ verdict: 'reject', reason });

function classifyMsg(index, rec, local) {
  const p = rec.payload;
  const invite = personalInvite(index, p.inbox);
  if (invite) {
    if ('epoch' in p) return reject('BAD_EPOCH');
    if (p.signer !== invite.payload.signer && p.signer !== invite.payload.to) return reject('NOT_PARTY');
    const resp = responseOf(index, invite.id);
    if (!resp) return pending('RESPONSE_UNSEEN');
    return resp.payload.accept ? accept : reject('INVITE_DECLINED');
  }
  if (!sharedCreate(index, p.inbox)) return pending('INBOX_UNSEEN');
  if (!('epoch' in p)) return reject('BAD_EPOCH');
  const members = membersAt(index, p.inbox, p.epoch);
  if (!members) return pending('EPOCH_UNSEEN');
  if (!members.has(p.signer)) return reject('NOT_MEMBER');
  // Prefix-closed: valid only on top of the sender's own valid previous message.
  if (p.prev !== null) {
    if (index.rejected.has(p.prev)) return reject('PREV_REJECTED');
    const prev = index.byId.get(p.prev);
    if (!prev) return pending('PREV_UNSEEN');
    const pp = prev.payload;
    if (pp.type !== 'msg' || pp.signer !== p.signer || pp.inbox !== p.inbox) return reject('BAD_PREV');
    const pv = index.verdicts.get(prev.id) ?? local?.get(prev.id) ?? verdictOf(index, prev);
    if (pv.verdict === 'reject') return reject('PREV_REJECTED');
    if (pv.verdict === 'pending') return pending('PREV_UNSETTLED');
  }
  // A later removal of the signer keeps only the messages on its kept chain: a backdated epoch, a fork or a message
  // pre-signed before the removal (but not held by the owner) is off it.
  for (const [seq, m] of memberChain(index, p.inbox)) {
    const mp = m.payload;
    if (seq <= p.epoch || mp.op !== 'remove' || mp.member !== p.signer) continue;
    const kept = keptChain(index, m);
    if (kept.ids.has(rec.id) || kept.missing === rec.id) continue;
    return kept.missing === null ? reject('REMOVED') : pending('CHAIN_UNSEEN');
  }
  return accept;
}

// The verdict of a message against everything known now. Iterative: it follows `prev` down through accepted
// messages to the first one already settled (or a root), then judges the path from there up, so a chain of any
// length costs one pass and no stack. Settled verdicts are kept (index.verdicts); pending ones only for this pass.
function verdictOf(index, rec) {
  const settled = index.verdicts.get(rec.id);
  if (settled) return settled;
  const path = [];
  const onPath = new Set();
  for (let cur = rec; cur && !index.verdicts.has(cur.id) && !onPath.has(cur.id);) {
    path.push(cur);
    onPath.add(cur.id);
    const prev = cur.payload.type === 'msg' && typeof cur.payload.prev === 'string' ? index.byId.get(cur.payload.prev) : null;
    cur = prev?.payload.type === 'msg' ? prev : null;
  }
  const local = new Map();
  let v;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    v = classifyMsg(index, path[i], local);
    if (v.verdict === 'pending') local.set(path[i].id, v); else if (index.byId.has(path[i].id)) index.verdicts.set(path[i].id, v); else local.set(path[i].id, v);
  }
  return v;
}

// Whether a verified, route-bound record may be accepted given what is known now:
// {verdict:'accept'} | {verdict:'pending', reason} (a record it depends on is unseen) | {verdict:'reject', reason}.
export function classify(index, rec) {
  const p = rec.payload;
  switch (p.type) {
    case 'announce':
    case 'inbox-create':
      return accept;
    case 'invite': {
      if (p.kind === 'personal') return accept;
      const create = sharedCreate(index, p.inbox);
      if (!create) return pending('INBOX_UNSEEN');
      return create.payload.signer === p.signer ? accept : reject('NOT_OWNER');
    }
    case 'invite-response': {
      const inv = index.invites.get(p.invite);
      if (!inv) return pending('INVITE_UNSEEN');
      const ok = inv.payload.to === p.signer && inv.payload.signer === p.to && inv.payload.inbox === p.inbox;
      return ok ? accept : reject('RESPONSE_MISMATCH');
    }
    case 'join-request': {
      const create = sharedCreate(index, p.inbox);
      if (!create) return pending('INBOX_UNSEEN');
      return create.payload.signer === p.to ? accept : reject('NOT_OWNER');
    }
    case 'join-response': {
      const req = index.joinRequests.get(p.request);
      if (!req) return pending('REQUEST_UNSEEN');
      const ok = req.payload.signer === p.to && req.payload.to === p.signer && req.payload.inbox === p.inbox;
      return ok ? accept : reject('RESPONSE_MISMATCH');
    }
    case 'member': {
      const create = sharedCreate(index, p.inbox);
      if (!create) return pending('INBOX_UNSEEN');
      if (create.payload.signer !== p.signer) return reject('NOT_OWNER');
      return p.member === p.signer ? reject('BAD_MEMBER_OP') : accept;
    }
    case 'msg':
      return classifyMsg(index, rec);
    default:
      return reject('BAD_PAYLOAD');
  }
}

// Whether this install, owner of `inv`'s shared inbox, still owes the invitee its admission: the invite's
// effective response (responseOf) accepts, the invitee is not a member, and the invite was accepted here after the
// invitee's last member record. A replayed or re-signed acceptance of an invite that predates a removal admits nobody.
export function admissionDue(index, inv) {
  const p = inv.payload;
  if (p.kind !== 'shared' || responseOf(index, inv.id)?.payload.accept !== true) return false;
  if (currentMembers(index, p.inbox)?.has(p.to)) return false;
  const last = (index.members.get(p.inbox) ?? []).filter((m) => m.payload.member === p.to).reduce((mx, m) => Math.max(mx, m.seq), 0);
  return inv.seq > last;
}

// A message is valid when it would still be accepted against everything known now (a later decline, removal or
// same-seq member record can invalidate one accepted earlier).
export const isValidMessage = (index, rec) => verdictOf(index, rec).verdict === 'accept';

// ---- directory and names ----

// The identities this install knows, with the name rules applied (docs/protocol.md → Names):
// a name pinned to another key → hidden NAME_TAKEN; an unpinned name with several claimants → all hidden
// NAME_CONFLICT; an unpinned name with one claimant → shown, and returned in `newPins` for the engine to persist.
// Resolves {identities: Map fp → {fp, id, name, ts, addr, shown, reason}, newPins: {name: fp}}: `id` is the current
// announce's record id.
export function directory(index, pins) {
  const identities = new Map();
  for (const [fp, recs] of index.announces) {
    const cur = [...recs].sort(cmpTsId).at(-1);
    identities.set(fp, { fp, id: cur.id, name: cur.payload.name, ts: cur.payload.ts, addr: cur.payload.addr, shown: false, reason: null });
  }
  const byName = new Map();
  for (const ident of identities.values()) push(byName, ident.name, ident);
  const newPins = {};
  for (const [name, claimants] of byName) {
    const pinned = Object.hasOwn(pins, name) ? pins[name] : null;
    for (const c of claimants) {
      if (pinned) { c.shown = c.fp === pinned; c.reason = c.shown ? null : 'NAME_TAKEN'; } else if (claimants.length === 1) { c.shown = true; newPins[name] = c.fp; } else { c.reason = 'NAME_CONFLICT'; }
    }
  }
  return { identities, newPins };
}

// Why `name` cannot be this install's (`selfFp`): NAME_TAKEN (pinned to another key), NAME_CONFLICT (another key's
// current announce claims it), or null.
export function nameRefusal(index, pins, selfFp, name) {
  if (Object.hasOwn(pins, name) && pins[name] !== selfFp) return 'NAME_TAKEN';
  const { identities } = directory(index, pins);
  for (const ident of identities.values()) if (ident.fp !== selfFp && ident.name === name) return 'NAME_CONFLICT';
  return null;
}

// ---- views for one install ----

// Every inbox `self` belongs to now: personal ones with an accepted invite, shared ones it is a current member of.
// [{id, kind, name, owner, members:[fp], epoch}] — `name` is the shared inbox's own name; for a personal inbox
// it is null and the caller names it after the other party.
export function inboxesOf(index, self) {
  const out = [];
  for (const [id, recs] of index.personalInvites) {
    const inv = lowestId(recs);
    const { signer, to } = inv.payload;
    if (self !== signer && self !== to) continue;
    if (responseOf(index, inv.id)?.payload.accept !== true) continue;
    out.push({ id, kind: 'personal', name: null, owner: null, members: [signer, to], epoch: null, peer: self === signer ? to : signer });
  }
  for (const id of index.inboxCreates.keys()) {
    const members = currentMembers(index, id);
    if (!members?.has(self)) continue;
    const create = sharedCreate(index, id);
    out.push({ id, kind: 'shared', name: create.payload.name, owner: create.payload.signer, members: [...members], epoch: currentEpoch(index, id), peer: null });
  }
  return out;
}

// Every shared inbox, for the directory: [{id, name, owner, members:[fp]|null}].
export function sharedInboxes(index) {
  return [...index.inboxCreates.keys()].map((id) => {
    const c = sharedCreate(index, id);
    const members = currentMembers(index, id);
    return { id, name: c.payload.name, owner: c.payload.signer, members: members ? [...members] : null };
  });
}

// Valid messages of an inbox, in acceptance order.
export const messagesOf = (index, inboxId) => (index.msgs.get(inboxId) ?? []).filter((r) => isValidMessage(index, r));

// Accepted messages that are no longer valid: [{id, inbox, signer, reason}].
export function invalidMessages(index) {
  const out = [];
  for (const recs of index.msgs.values()) {
    for (const r of recs) {
      const c = verdictOf(index, r);
      if (c.verdict !== 'accept') out.push({ id: r.id, inbox: r.payload.inbox, signer: r.payload.signer, reason: c.reason });
    }
  }
  return out;
}

// Every message of an inbox this install has seen, by verdict: valid and invalid (accepted, judged against
// everything known now), pending (waiting for a dependency), rejected (refused for good). Sorted ids.
export function inboxVerdicts(index, inboxId) {
  const out = { valid: [], invalid: [], pending: [], rejected: [] };
  for (const r of index.msgs.get(inboxId) ?? []) out[verdictOf(index, r).verdict === 'accept' ? 'valid' : 'invalid'].push(r.id);
  for (const r of index.pending.values()) if (r.payload.type === 'msg' && r.payload.inbox === inboxId) out.pending.push(r.id);
  for (const [id, info] of index.rejected) if (info.type === 'msg' && info.inbox === inboxId) out.rejected.push(id);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

// Invites and join requests `self` must act on or is waiting on.
export function pendingActions(index, self) {
  const incomingInvites = [];
  const outgoingInvites = [];
  for (const inv of index.invites.values()) {
    if (responseOf(index, inv.id)) continue;
    const p = inv.payload;
    if (p.to === self) incomingInvites.push(inv); else if (p.signer === self) outgoingInvites.push(inv);
  }
  const incomingJoins = [];
  const outgoingJoins = [];
  for (const req of index.joinRequests.values()) {
    const p = req.payload;
    if (index.joinResponses.has(req.id)) continue;
    // An admission is a member add written after the request.
    const admitted = (index.members.get(p.inbox) ?? []).some((m) => m.payload.op === 'add' && m.payload.member === p.signer && m.payload.ts >= p.ts);
    if (admitted) continue;
    if (p.to === self) incomingJoins.push(req); else if (p.signer === self) outgoingJoins.push(req);
  }
  return { incomingInvites, outgoingInvites, incomingJoins, outgoingJoins };
}

// The routes `self` wants delivered: the directory, its mailbox, and every inbox it is (or may become) part of.
export function interestOf(index, self) {
  const ids = new Set();
  for (const [id, recs] of index.personalInvites) if (recs.some((r) => r.payload.signer === self || r.payload.to === self)) ids.add(id);
  for (const [id, recs] of index.inboxCreates) if (recs.some((r) => r.payload.signer === self)) ids.add(id);
  for (const inv of index.invites.values()) if (inv.payload.kind === 'shared' && inv.payload.to === self) ids.add(inv.payload.inbox);
  for (const req of index.joinRequests.values()) if (req.payload.signer === self) ids.add(req.payload.inbox);
  return [{ kind: 'directory' }, { kind: 'mailbox', fp: self }, ...[...ids].sort().map((id) => ({ kind: 'inbox', id }))];
}

// ---- what a peer may read, whom to dial (the TCP transport) ----

// Whether `reader` (a proven fingerprint) may pull this install's records on `route`: the directory is public; a
// mailbox only its owner; a personal inbox its two parties; a shared inbox its current members.
export function mayRead(index, reader, route) {
  if (route.kind === 'directory') return true;
  if (route.kind === 'mailbox') return reader === route.fp;
  if (route.kind !== 'inbox') return false;
  const inv = personalInvite(index, route.id);
  if (inv) return reader === inv.payload.signer || reader === inv.payload.to;
  return !!currentMembers(index, route.id)?.has(reader);
}

// The identities `self` has a relationship with, so may dial: `imported` (card imports), the counterparties of
// records it signed (`to`, `member`), and the parties and members of every inbox it belongs to. Never `self`.
export function contactsOf(index, self, imported) {
  const set = new Set(imported);
  for (const r of index.byId.values()) {
    const p = r.payload;
    if (p.signer !== self) continue;
    if (typeof p.to === 'string') set.add(p.to);
    if (p.type === 'member') set.add(p.member);
  }
  for (const b of inboxesOf(index, self)) for (const fp of b.members) set.add(fp);
  set.delete(self);
  return [...set];
}
