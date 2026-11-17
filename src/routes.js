import { CodedError } from './errors.js';
import { createServer } from './http.js';

// The REST surface for the plugin's page (docs/protocol.md → REST routes). Every handler calls the engine or the
// notifier and only maps the result or refusal onto HTTP; nothing here validates a message of its own.
export const STATUS = {
  BAD_REQUEST: 400,
  NAME_INVALID: 400,
  SHARE_INVALID: 400,
  TCP_INVALID: 400,
  CARD_INVALID: 400,
  NAME_MISSING: 409,
  NAME_TAKEN: 409,
  NAME_CONFLICT: 409,
  NOT_OWNER: 403,
  INBOX_UNKNOWN: 404,
  INVITE_UNKNOWN: 404,
  REQUEST_UNKNOWN: 404,
  IDENTITY_UNKNOWN: 404,
  SESSION_UNKNOWN: 404,
  NOT_MEMBER: 409,
  TRANSPORT_UNCONFIGURED: 409,
  TCP_LISTEN_FAILED: 409,
  SHARE_UNSAFE: 409,
  ALREADY_MEMBER: 409,
  INVITE_EXISTS: 409,
  INVITE_ANSWERED: 409,
  REQUEST_EXISTS: 409,
  REQUEST_ANSWERED: 409,
  BODY_TOO_LARGE: 413,
  RECORD_TOO_LARGE: 413,
  PAYLOAD_TOO_LARGE: 413,
  CONDUCTOR_UNAVAILABLE: 503,
};

export const statusFor = (err) => (err instanceof CodedError ? STATUS[err.code] ?? 409 : 500);

// A top-level conductor: cc's `isConductorInstance` (project '.conduct', not itself conducted).
const isTopConductor = (row) => row.project === '.conduct' && !row.conducted;
const isLive = (row) => row.status !== 'exited' && row.status !== 'crashed';

const field = (body, k) => (body && typeof body === 'object' ? body[k] : undefined);

export function buildRoutes({ engine, notifier, cc, mcp }) {
  const id = '([^/]+)';
  const post = (path, handler) => ({ method: 'POST', path, mutating: true, handler });
  return [
    { method: 'GET', path: /^\/api\/health$/, handler: () => ({ ok: true }) },
    { method: 'GET', path: /^\/api\/state$/, handler: () => ({ ...engine.state(), notify: notifier.view() }) },
    {
      method: 'GET', path: new RegExp(`^/api/inboxes/${id}/messages$`),
      handler: ({ params }) => ({ inbox: params[0], messages: engine.messages(params[0]) }),
    },
    {
      method: 'GET', path: /^\/api\/sessions$/,
      handler: async () => {
        const rows = await cc.instances();
        const sessions = rows.filter(isTopConductor).map((r) => ({ sessionId: r.sessionId, label: r.displayLabel ?? r.sessionId, status: r.status, live: isLive(r) }));
        let plugin = null;
        try { plugin = await cc.pluginStatus(); } catch { /* the session list still answers */ }
        return { sessions, target: engine.settings().notifyTarget, autoStart: plugin?.autoStart ?? null };
      },
    },
    post(/^\/api\/identity$/, ({ body }) => engine.setName(field(body, 'name'))),
    post(/^\/api\/share$/, ({ body }) => engine.setShare(field(body, 'dir'))),
    post(/^\/api\/tcp$/, ({ body }) => engine.setTcp({ host: field(body, 'host'), port: field(body, 'port'), advertise: field(body, 'advertise') })),
    post(/^\/api\/contacts$/, ({ body }) => engine.importCard(field(body, 'card'))),
    post(/^\/api\/tcp$/, ({ body }) => engine.setTcp({ host: field(body, 'host'), port: field(body, 'port'), advertise: field(body, 'advertise') })),
    post(/^\/api\/contacts$/, ({ body }) => engine.importCard(field(body, 'card'))),
    post(/^\/api\/announce$/, () => engine.announce()),
    post(/^\/api\/invites$/, ({ body }) => engine.invite(field(body, 'to'))),
    post(new RegExp(`^/api/invites/${id}/respond$`), ({ params, body }) => engine.respondInvite(params[0], field(body, 'accept'))),
    post(/^\/api\/inboxes$/, ({ body }) => engine.createSharedInbox(field(body, 'name'))),
    post(new RegExp(`^/api/inboxes/${id}/invites$`), ({ params, body }) => engine.inviteMember(params[0], field(body, 'to'))),
    post(new RegExp(`^/api/inboxes/${id}/join$`), ({ params }) => engine.requestJoin(params[0])),
    post(new RegExp(`^/api/join-requests/${id}/respond$`), ({ params, body }) => engine.respondJoin(params[0], field(body, 'accept'))),
    post(new RegExp(`^/api/inboxes/${id}/members/${id}/remove$`), ({ params }) => engine.removeMember(params[0], params[1])),
    post(new RegExp(`^/api/inboxes/${id}/messages$`), ({ params, body }) => engine.sendMessage(params[0], field(body, 'body'))),
    post(/^\/api\/notify$/, async ({ body }) => {
      const sessionId = field(body, 'sessionId');
      if (sessionId === null) return notifier.setTarget(null);
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new CodedError('BAD_REQUEST', 'sessionId must be a session id or null');
      const row = (await cc.instances()).find((r) => r.sessionId === sessionId);
      if (!row || !isTopConductor(row)) throw new CodedError('SESSION_UNKNOWN', 'no top-level conductor session with that id');
      return notifier.setTarget({ sessionId, label: String(row.displayLabel ?? sessionId).slice(0, 200) });
    }),
    post(/^\/api\/mcp$/, ({ body }) => mcp.handle(body)),
  ];
}

export function createApp({ engine, notifier, cc, mcp, distDir, log }) {
  return createServer({ routes: buildRoutes({ engine, notifier, cc, mcp }), distDir, statusFor, log });
}
