import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { CodedError } from './errors.js';

// The HTTP server: security headers on every answer, the request guard, JSON bodies and the built UI.
// Check order for an /api request: route (404/405) → mutating: cross-site guard (403) → content type (415)
// → body (413/400) → handler.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// The largest JSON request accepted: well above BODY_MAX_BYTES even when every character of a body is escaped,
// so an oversize message body reaches the engine and is refused there (BODY_TOO_LARGE), as it is through MCP.
export const MAX_REQUEST_BYTES = 256 * 1024;

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(text);
}

export const sendJson = (res, status, value) => sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

const JSON_TYPE = /^application\/json\s*(;|$)/i;

// Why a mutating request is refused as cross-site, or null. A browser sends Sec-Fetch-Site; without it, a request
// carrying an Origin is refused, and one with neither (cc's server-side MCP call, curl) passes.
export function crossSiteRefusal(headers) {
  const site = headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin' || site === 'none' ? null : `Sec-Fetch-Site is ${site}`;
  return headers.origin === undefined ? null : 'an Origin without Sec-Fetch-Site';
}

// An empty body reads as {}.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_REQUEST_BYTES) { over = true; reject(new CodedError('PAYLOAD_TOO_LARGE', `request body larger than ${MAX_REQUEST_BYTES} bytes`)); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new CodedError('BAD_REQUEST', 'body is not valid JSON')); }
    });
  });
}

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const SERVED_NAME = /^assets\/[A-Za-z0-9._-]+\.(js|css|svg|woff2)$/;

// Only the built shell and its hashed assets are served; the host's /pluginBridge.js and /pluginTheme.css are
// cc's to serve and answer 404 here.
async function serveStatic(res, distDir, urlPath) {
  const rel = urlPath === '/' || urlPath === '/index.html' ? 'index.html' : urlPath.replace(/^\//, '');
  if (rel !== 'index.html' && !SERVED_NAME.test(rel)) return sendText(res, 404, 'not found');
  let data;
  try { data = await fs.readFile(path.join(distDir, rel)); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (rel === 'index.html') return sendText(res, 503, 'UI not built: run npm install in the plugin checkout');
    return sendText(res, 404, 'not found');
  }
  sendText(res, 200, data, rel === 'index.html' ? 'text/html; charset=utf-8' : TYPES[path.extname(rel)]);
}

const pathnameOf = (target) => { try { return new URL(target, 'http://localhost').pathname; } catch { return null; } };

// `routes`: [{method, path: RegExp, mutating?, handler({params, query, body}) → value | {status, body}}];
// `statusFor(err)` maps a thrown error to its HTTP status.
export function createServer({ routes, distDir, statusFor, log = console }) {
  async function dispatch(req, res) {
    const pathname = pathnameOf(req.url);
    if (pathname === null) return sendJson(res, 400, { error: 'malformed request target', code: 'BAD_REQUEST' });
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, distDir, pathname);
    let allowed = false;
    for (const route of routes) {
      const m = route.path.exec(pathname);
      if (!m) continue;
      allowed = true;
      if (route.method !== req.method) continue;
      let body;
      if (route.mutating) {
        const refusal = crossSiteRefusal(req.headers);
        if (refusal) return sendJson(res, 403, { error: `cross-site request refused: ${refusal}`, code: 'FORBIDDEN' });
        if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return sendJson(res, 415, { error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });
        body = await readJsonBody(req);
      }
      const query = new URL(req.url, 'http://localhost').searchParams;
      const out = await route.handler({ params: m.slice(1).map(decodeURIComponent), query, body });
      if (out && out.status && out.body) return sendJson(res, out.status, out.body);
      return sendJson(res, 200, out);
    }
    if (allowed) return sendJson(res, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return sendJson(res, 404, { error: 'not found', code: 'NOT_FOUND' });
  }

  const server = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    dispatch(req, res).catch((err) => {
      if (!(err instanceof CodedError)) log.error('code-inbox: request failed:', err);
      const coded = err instanceof CodedError;
      sendJson(res, statusFor(err), { error: coded ? err.message : 'internal error', code: coded ? err.code : 'INTERNAL' });
    });
  });
  server.on('clientError', (err, socket) => {
    socket.on('error', () => {});
    if (socket.writable) {
      socket.end(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\nContent-Security-Policy: ${CSP}\r\nX-Content-Type-Options: nosniff\r\n\r\n`);
    }
  });
  return server;
}
