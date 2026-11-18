// Entry: config → store → identity → engine (+ the configured transport) → notifier → MCP → HTTP app → listen on
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
import { proofSigner } from './src/transport/handshake.js';
import { createNetwork } from './src/transport/network.js';

// The engine's transport factory: (settings.transport, engine view) → a Transport. `pollMs` overrides the file
// share's poll; `tcpSyncMs` the maintain interval of the network endpoint (tests). `now` and `schedule` reach the
// network endpoint (reconnect backoff, session timers) when given (tests).
export function transportFactory({ identity, store, pollMs, tcpSyncMs, now, schedule, log }) {
  return (config, view) => {
    const network = {
      identity: proofSigner(identity), view, cursors: { load: store.loadPullCursors, save: store.savePullCursors }, syncMs: tcpSyncMs, log,
      ...(now ? { now } : {}), ...(schedule ? { schedule } : {}),
    };
    if (config.kind === 'network') return createNetwork({ listen: config.listen, connections: config.connections, ...network });
    return createFileShare({ shareDir: config.dir, dataDir: store.dataDir, selfFp: identity.fp, pollMs, log });
  };
}

// Builds one install; the caller listens. `pollMs`, `tcpSyncMs`, `schedule` (the notifier's timers, the engine's
// outbox retry, the network endpoint's timers) and `now` (their clock) override the defaults (tests).
// Resolves {server, engine, notifier, mcp, identity, close}.
export async function wire({ dataDir, distDir, env = process.env, pollMs, tcpSyncMs, now, schedule, log = console }) {
  const store = createStore(dataDir, { log });
  await store.load(); // creates the data dir (0700) before the identity goes into it
  const identity = await loadIdentity(dataDir);
  const engine = createEngine({ store, identity, log, ...(schedule ? { schedule } : {}), makeTransport: transportFactory({ identity, store, pollMs, tcpSyncMs, now, schedule, log }) });
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
