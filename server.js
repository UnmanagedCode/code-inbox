// Entry: config → store → identity → engine (+ file-share transport) → notifier → MCP → HTTP app → listen on
// loopback. Behind a direct-run guard, so tests import `wire` to build whole installs in-process.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCc } from './src/cc.js';
import { loadConfig } from './src/config.js';
import { createEngine } from './src/engine.js';
import { loadIdentity } from './src/identity.js';
import { createMcp } from './src/mcp.js';
import { createNotifier } from './src/notifier.js';
import { createApp } from './src/routes.js';
import { createStore } from './src/store.js';
import { createFileShare } from './src/transport/fileShare.js';

// Builds one install; the caller listens. `pollMs` and `schedule` override the defaults (tests).
// Resolves {server, engine, notifier, mcp, identity, close}.
export async function wire({ dataDir, distDir, env = process.env, pollMs, schedule, log = console }) {
  const store = createStore(dataDir, { log });
  await store.load(); // creates the data dir (0700) before the identity goes into it
  const identity = await loadIdentity(dataDir);
  const engine = createEngine({
    store, identity, log,
    makeTransport: (shareDir) => createFileShare({ shareDir, selfFp: identity.fp, pollMs, log }),
  });
  await engine.boot();
  const cc = createCc({ env, log });
  const notifier = createNotifier({ engine, cc, store, log, ...(schedule ? { schedule } : {}) });
  await notifier.start();
  const mcp = createMcp({ engine });
  const server = createApp({ engine, notifier, cc, mcp, distDir, log });
  return {
    server, engine, notifier, mcp, identity,
    async close() {
      notifier.stop();
      await engine.stop();
      await new Promise((r) => server.close(r));
    },
  };
}

async function main() {
  const config = loadConfig(process.env);
  const app = await wire({ dataDir: config.dataDir, distDir: config.distDir });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, '127.0.0.1', resolve);
  });
  console.log(`code-inbox listening on 127.0.0.1:${app.server.address().port} (data: ${config.dataDir})`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
