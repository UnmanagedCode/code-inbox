import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodedError } from '../errors.js';
import { TMP_PREFIX, writeFileAtomic } from '../fsAtomic.js';
import { FP_RE, RECORD_MAX_BYTES } from '../records.js';

// The v1 transport: a directory every install can reach (Dropbox, SMB, NFS). Layout under <shareDir>/code-inbox/v1/
// (docs/protocol.md → Share layout); every writer writes only below its own fingerprint subdir and never rewrites
// a file, so the share holds no mutable file two installs could race on.
export const SHARE_POLL_MS = 2000;
export const SHARE_ROOT = path.join('code-inbox', 'v1');
export const FILE_RE = /^\d{13}-[0-9a-f]{32}\.rec$/;
const YIELD_EVERY = 64;

const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// Refuses (SHARE_INVALID) a share dir that is not absolute, not an existing writable directory, or that contains
// the data dir or lies inside it (compared by realpath): the private key must never sit on the share.
// Resolves the dir unchanged.
export async function validateShareDir(dir, dataDir) {
  const refuse = (why) => { throw new CodedError('SHARE_INVALID', `share dir ${JSON.stringify(dir)} ${why}`); };
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) refuse('is not an absolute path');
  let st;
  try { st = await fs.stat(dir); } catch { refuse('does not exist'); }
  if (!st.isDirectory()) refuse('is not a directory');
  const real = await fs.realpath(dir);
  const realData = await fs.realpath(dataDir);
  if (isInside(realData, real)) refuse('is inside the data dir');
  if (isInside(real, realData)) refuse('contains the data dir');
  const probe = path.join(dir, `${TMP_PREFIX}probe-${crypto.randomBytes(8).toString('hex')}`);
  try {
    await fs.writeFile(probe, '', { flag: 'wx' });
    await fs.rm(probe, { force: true });
  } catch (err) {
    refuse(`is not writable (${err.code ?? err.message})`);
  }
  return dir;
}

// The share dir that holds a route's records; writers sit one level below it.
export function routeDir(root, route) {
  if (route.kind === 'directory') return path.join(root, 'directory');
  if (route.kind === 'mailbox') return path.join(root, 'mailbox', route.fp);
  return path.join(root, 'inboxes', route.id);
}

// Reads at most RECORD_MAX_BYTES + 1 bytes: an oversize file is still offered (and rejected) without being read whole.
async function readCapped(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(RECORD_MAX_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return buf.subarray(0, total);
  } finally {
    await handle.close();
  }
}

const tick = () => new Promise((r) => setImmediate(r));

/** @returns {import('./index.js').Transport} */
export function createFileShare({ shareDir, selfFp, pollMs = SHARE_POLL_MS, now = Date.now, log = console }) {
  const root = path.join(shareDir, SHARE_ROOT);
  let interest = [];
  let sink = null;
  let timer = null;
  let stopped = false;
  let chain = Promise.resolve();
  const offered = new Set(); // paths handed over for good
  const retry = new Map(); // path → "size:mtime" of a file whose bytes may be incomplete

  async function scanRoute(route, counter) {
    const base = routeDir(root, route);
    let writers;
    try { writers = await fs.readdir(base); } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const writer of writers.sort()) {
      if (!FP_RE.test(writer)) continue;
      let names;
      try { names = await fs.readdir(path.join(base, writer)); } catch { continue; }
      for (const name of names.sort()) {
        if (stopped) return;
        if (!FILE_RE.test(name)) continue;
        const file = path.join(base, writer, name);
        if (offered.has(file)) continue;
        let st;
        try { st = await fs.stat(file); } catch { continue; }
        if (!st.isFile()) continue;
        const key = `${st.size}:${st.mtimeMs}`;
        if (retry.get(file) === key) continue;
        let bytes;
        try { bytes = await readCapped(file); } catch { continue; }
        const r = await sink.record({ route, writer, bytes });
        if (r?.retry) retry.set(file, key); else { offered.add(file); retry.delete(file); }
        counter.n += 1;
        if (counter.n % YIELD_EVERY === 0) await tick();
      }
    }
  }

  async function scan() {
    if (!sink || stopped) return;
    const counter = { n: 0 };
    for (const route of interest) {
      try {
        await scanRoute(route, counter);
      } catch (err) {
        log.warn(`code-inbox: scanning ${routeDir(root, route)} failed: ${err.message}`);
      }
    }
  }

  // Scans never overlap: each queues behind the last.
  const queueScan = () => { chain = chain.then(scan, scan); return chain; };

  function loop() {
    timer = null;
    queueScan().finally(() => { if (!stopped) { timer = setTimeout(loop, pollMs); timer.unref?.(); } });
  }

  return {
    capabilities: { directory: true, push: false },
    root,
    addresses: () => [],
    async start(s) {
      sink = s;
      loop();
    },
    setInterest(routes) { interest = [...routes]; },
    // The share stores everything, so every recipient counts as delivered.
    async send(bytes, { route, to }) {
      const dir = path.join(routeDir(root, route), selfFp);
      await fs.mkdir(dir, { recursive: true });
      const name = `${String(now()).padStart(13, '0')}-${crypto.randomBytes(16).toString('hex')}.rec`;
      await writeFileAtomic(path.join(dir, name), bytes, 0o644);
      return { delivered: [...to], pending: [] };
    },
    sync: () => queueScan(),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await chain;
    },
  };
}
