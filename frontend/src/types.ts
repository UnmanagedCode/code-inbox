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

export interface TransportView {
  kind: 'file-share' | 'tcp' | null;
  configured: boolean;
  dir: string | null;
  host: string | null;
  port: number | null;
  advertise: string | null;
  addresses: string[];
  card: string | null;
  cardStale: boolean;
  error: { code: string; message: string } | null;
}

export interface State {
  identity: { fp: string; fingerprint: string; name: string | null; announcedName: string | null; nameStatus: string };
  transport: TransportView;
  directory: { fp: string; fingerprint: string; name: string }[];
  sharedInboxes: SharedInbox[];
  invites: { incoming: Invite[]; outgoing: Invite[] };
  joinRequests: { incoming: JoinRequest[]; outgoing: JoinRequest[] };
  inboxes: Inbox[];
  diagnostics: { rejected: number; recent: { reason: string; detail: string | null; id: string | null; at: number }[]; hidden: { id: string; inbox: string; signer: string; reason: string }[]; pending: number; outbox: number };
  notify: NotifyView;
}

export interface Session { sessionId: string; label: string; status: string; live: boolean }
