// A whole install in its own process: boots from `dataDir` (share and membership already set up by the test),
// sends `count` messages "<tag>-<i>" to `inbox`, then exits. Usage: node writer.mjs <dataDir> <inbox> <count> <tag>
import { wire } from '../../server.js';

const [dataDir, inbox, count, tag] = process.argv.slice(2);
const quiet = { log() {}, warn() {}, error() {} };
const app = await wire({ dataDir, distDir: dataDir, env: {}, pollMs: 3_600_000, log: quiet });
for (let i = 0; i < Number(count); i += 1) await app.engine.sendMessage(inbox, `${tag}-${i}`);
await app.close();
process.send?.({ done: Number(count) });
