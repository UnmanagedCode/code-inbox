// The hub's command-line entry: `node hub.js --host H --port P` (docs/transport.md → Hub). Thin wiring over
// src/hub/hub.js, behind a direct-run guard like server.js. Imports nothing of the plugin host.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HUB_DEFAULT_PORT, createHub, isLoopbackHost, validateHubListen } from './src/hub/hub.js';

const USAGE = `usage: node hub.js [--host HOST] [--port PORT]
  --host  the address to listen on (default 127.0.0.1; 0.0.0.0 or an interface IP exposes the hub)
  --port  the TCP port (default ${HUB_DEFAULT_PORT}; 0 = ephemeral)`;

// The listen config from argv, or null after printing why (and the usage) to stderr.
function config(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: { host: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } } }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return null;
  }
  if (values.help) { console.log(USAGE); process.exit(0); }
  const port = values.port === undefined ? HUB_DEFAULT_PORT : /^\d{1,5}$/.test(values.port) ? Number(values.port) : NaN;
  try {
    return validateHubListen({ host: values.host ?? '127.0.0.1', port });
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return null;
  }
}

async function main() {
  const cfg = config(process.argv.slice(2));
  if (!cfg) process.exit(2);
  const hub = createHub(cfg);
  const { host, port } = await hub.listen();
  console.log(`code-inbox hub listening on ${host}:${port}`);
  if (!isLoopbackHost(host)) console.warn(`code-inbox hub: ${host} is not loopback: the port is open to the network, and records and metadata travel unencrypted`);
  const stop = () => { hub.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
