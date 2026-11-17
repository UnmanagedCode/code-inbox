import type { Message, Session, State } from './types';

// A refused request: `code` is the backend's machine code (e.g. NOT_MEMBER), when it sent one.
export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number;
  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Every URL is relative: the page is served under /plugins/<id>/ and may sit behind any proxy.
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof json.error === 'string' ? json.error : `request failed (${res.status})`, typeof json.code === 'string' ? json.code : null, res.status);
  return json as T;
}

const seg = encodeURIComponent;

export const api = {
  state: () => call<State>('GET', 'api/state'),
  messages: (inbox: string) => call<{ inbox: string; messages: Message[] }>('GET', `api/inboxes/${seg(inbox)}/messages`),
  sessions: () => call<{ sessions: Session[]; target: State['notify']['target']; autoStart: boolean | null }>('GET', 'api/sessions'),
  setName: (name: string) => call('POST', 'api/identity', { name }),
  setShare: (dir: string) => call('POST', 'api/share', { dir }),
  setTcp: (cfg: { host?: string; port?: number | string; advertise?: string }) => call('POST', 'api/tcp', cfg),
  importCard: (card: string) => call<{ fp: string; name: string; shown: boolean }>('POST', 'api/contacts', { card }),
  announce: () => call('POST', 'api/announce'),
  invite: (to: string) => call('POST', 'api/invites', { to }),
  respondInvite: (id: string, accept: boolean) => call('POST', `api/invites/${seg(id)}/respond`, { accept }),
  createInbox: (name: string) => call('POST', 'api/inboxes', { name }),
  inviteMember: (inbox: string, to: string) => call('POST', `api/inboxes/${seg(inbox)}/invites`, { to }),
  requestJoin: (inbox: string) => call('POST', `api/inboxes/${seg(inbox)}/join`),
  respondJoin: (id: string, accept: boolean) => call('POST', `api/join-requests/${seg(id)}/respond`, { accept }),
  removeMember: (inbox: string, fp: string) => call('POST', `api/inboxes/${seg(inbox)}/members/${seg(fp)}/remove`),
  send: (inbox: string, body: string) => call<{ id: string; inbox: string }>('POST', `api/inboxes/${seg(inbox)}/messages`, { body }),
  setNotify: (sessionId: string | null) => call('POST', 'api/notify', { sessionId }),
};

// "CODE: message" for a refusal, else the error's message.
export const describe = (e: unknown) => (e instanceof ApiError ? `${e.code ?? `HTTP ${e.status}`}: ${e.message}` : e instanceof Error ? e.message : String(e));
