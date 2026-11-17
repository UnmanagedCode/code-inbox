import { CodedError } from './errors.js';

// The cc routes this plugin calls (docs/protocol.md → cc routes used). Base URLs are read from `env` on every call;
// every attempt has its own deadline; a failure is logged and thrown as CONDUCTOR_UNAVAILABLE.
export const CC_TIMEOUT_MS = 5000;

export function createCc({ env = process.env, timeoutMs = CC_TIMEOUT_MS, log = console } = {}) {
  async function ccFetch(name, path, { method = 'GET', body } = {}) {
    const root = env[name];
    if (!root) throw new CodedError('CONDUCTOR_UNAVAILABLE', `${name} is not set: run inside code-conductor`);
    const route = `${method} ${path}`;
    let res;
    let text;
    try {
      res = await fetch(root + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      log.warn(`code-inbox: cc ${route} failed: ${err.message}`);
      throw new CodedError('CONDUCTOR_UNAVAILABLE', `code-conductor ${route}: ${err.message}`);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, ok: res.ok, json };
  }

  const pluginId = () => env.CONDUCTOR_PLUGIN_ID || 'code-inbox';

  return {
    // GET /api/instances: every session row.
    async instances() {
      const r = await ccFetch('CONDUCTOR_URL', '/api/instances');
      if (!r.ok || !Array.isArray(r.json)) throw new CodedError('CONDUCTOR_UNAVAILABLE', `GET /api/instances answered ${r.status}`);
      return r.json;
    },

    // send_prompt through the anonymous REST alias. Resolves {delivered:true} or {delivered:false, code, reason}.
    async sendPrompt(sessionId, text) {
      const r = await ccFetch('CONDUCTOR_MCP_URL', '/tools/send_prompt', { method: 'POST', body: { sessionId, text } });
      const j = r.json && typeof r.json === 'object' ? r.json : {};
      if (r.status === 200 && j.ok !== false && !('code' in j) && !('error' in j)) return { delivered: true };
      return { delivered: false, code: j.code ?? `HTTP_${r.status}`, reason: j.reason ?? j.error ?? null };
    },

    // This plugin's row from GET /api/plugins: {autoStart, state}, or null when cc lists no such plugin.
    async pluginStatus() {
      const r = await ccFetch('CONDUCTOR_URL', '/api/plugins');
      if (!r.ok || !Array.isArray(r.json?.rows)) throw new CodedError('CONDUCTOR_UNAVAILABLE', `GET /api/plugins answered ${r.status}`);
      const row = r.json.rows.find((x) => x.id === pluginId());
      return row ? { autoStart: row.autoStart === true, state: row.state ?? null } : null;
    },

    // POST /api/plugins/:id/autostart. Resolves {autoStart} as cc stored it; a refusal throws AUTOSTART_REFUSED.
    async setAutoStart(autoStart) {
      const r = await ccFetch('CONDUCTOR_URL', `/api/plugins/${encodeURIComponent(pluginId())}/autostart`, { method: 'POST', body: { autoStart } });
      if (!r.ok) throw new CodedError('AUTOSTART_REFUSED', `cc refused auto-start (${r.status}): ${r.json?.error ?? 'no reason given'}`);
      return { autoStart: r.json?.autoStart ?? autoStart };
    },
  };
}
