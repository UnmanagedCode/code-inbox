// The backend's wire shapes (docs/protocol.md → REST routes).
export interface Person { fp: string; name: string | null }

export interface Message { id: string; seq: number; sender: Person; ts: number; body: string }

export interface Inbox { id: string; kind: 'personal' | 'shared'; name: string | null; owner: Person | null; members: Person[]; unread: number }

export interface Invite { id: string; kind: 'personal' | 'shared'; inbox: string; inboxName: string | null; from: Person; to: Person; ts: number }

export interface JoinRequest { id: string; inbox: string; inboxName: string | null; from: Person; ts: number }

export interface SharedInbox { id: string; name: string; owner: Person; memberCount: number | null; isMember: boolean; isOwner: boolean; requestPending: boolean }

export interface NotifyView {
  target: { sessionId: string; label: string } | null;
  watermark: number;
  owed: number;
  lastDelivery: { at: number; count: number; text: string } | null;
  lastError: { at: number; reason: string } | null;
  autoStart: { ok: boolean; autoStart?: boolean; code?: string; error?: string } | null;
}

export interface Coded { code: string; message: string }

// One configured connection: `kind` is what its far end said it is (null until one answered).
export interface ConnectionView {
  address: string;
  kind: 'peer' | 'hub' | null;
  state: 'connecting' | 'up' | 'waiting' | 'idle' | 'stopped';
  peers: Person[];
  error: Coded | null;
}

export interface TransportView {
  kind: 'file-share' | 'network' | null;
  configured: boolean;
  dir: string | null;
  // The saved listener (network mode), and where it is bound while it is up.
  listen: { host: string; port: number } | null;
  listening: { host: string; port: number } | null;
  connections: ConnectionView[];
  card: string | null;
  error: Coded | null;
  outboxError: Coded | null;
}

// Where an identity can be reached now: a session's route (address: its connection, null for one accepted on the
// listener) or a hub's roster.
export interface Presence { via: 'direct' | 'hub'; address: string | null }

export interface DirectoryEntry { fp: string; fingerprint: string; name: string; contact: boolean; presence: Presence[] }

export interface State {
  identity: { fp: string; fingerprint: string; name: string | null; announcedName: string | null; nameStatus: string };
  transport: TransportView;
  directory: DirectoryEntry[];
  sharedInboxes: SharedInbox[];
  invites: { incoming: Invite[]; outgoing: Invite[] };
  joinRequests: { incoming: JoinRequest[]; outgoing: JoinRequest[] };
  inboxes: Inbox[];
  diagnostics: { rejected: number; recent: { reason: string; detail: string | null; id: string | null; at: number }[]; hidden: { id: string; inbox: string; signer: string; reason: string }[]; pending: number; outbox: number };
  notify: NotifyView;
}

export interface Session { sessionId: string; label: string; status: string; live: boolean }
