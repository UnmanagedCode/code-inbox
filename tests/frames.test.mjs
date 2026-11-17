import test from 'node:test';
import assert from 'node:assert/strict';
import { RECORD_MAX_BYTES } from '../src/records.js';
import {
  TCP_FRAME_MAX, TCP_HELLO_FRAME_MAX, TCP_MAX_IDENTITIES, TCP_PULL_ROUTES_MAX, TCP_WHOIS_MAX, createDecoder, encodeFrame, parseFrame,
} from '../src/transport/frames.js';

const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);
const b64 = (n, fill = 1) => Buffer.alloc(n, fill).toString('base64url');
const id = { key: b64(32), sig: b64(64) };
const DIR = { kind: 'directory' };
const REC = b64(100);

const drain = (d) => { const out = []; for (let f; (f = d.next()) !== null;) out.push(f); return out; };

// Invariant: frames survive any split or coalescing of the byte stream, and a header over the limit is refused
// before its body is buffered.
test('the decoder reassembles split and coalesced frames and rejects each schema violation', async (t) => {
  const frames = [{ t: 'ping' }, { t: 'hello', v: 1, nonce: 'c'.repeat(64) }, { t: 'bye', reason: 'STOP' }];
  const stream = Buffer.concat(frames.map(encodeFrame));
  for (const size of [1, 3, 7, stream.length]) {
    const d = createDecoder({ maxFrame: TCP_FRAME_MAX });
    const out = [];
    for (let i = 0; i < stream.length; i += size) { d.push(stream.subarray(i, i + size)); out.push(...drain(d)); }
    assert.deepEqual(out, frames, `chunks of ${size}`);
    assert.equal(d.pending(), 0);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(TCP_HELLO_FRAME_MAX + 1);
  const d = createDecoder({ maxFrame: TCP_HELLO_FRAME_MAX });
  d.push(header);
  assert.throws(() => d.next(), { code: 'LIMIT' });
  const notJson = createDecoder({ maxFrame: TCP_FRAME_MAX });
  notJson.push(Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('{x}')]));
  assert.throws(() => notJson.next(), { code: 'PROTOCOL' });

  await t.test('the schema of each frame, by phase', () => {
    const valid = [
      ['hello', { t: 'hello', v: 1, nonce: 'c'.repeat(64) }],
      ['prove-dial', { t: 'prove', target: FP, ids: [id] }],
      ['prove-accept', { t: 'prove', ids: [id] }],
      ['ok', { t: 'ok' }],
      ['ready', { t: 'rec', from: FP, to: FP2, route: DIR, rec: REC }],
      ['ready', { t: 'pull', id: 1, from: FP, to: FP2, routes: [{ route: DIR, since: 0 }] }],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'ok', recs: [{ seq: 1, rec: REC }], more: false, head: 3 }] }],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'denied' }] }],
      ['ready', { t: 'whois', id: 2, from: FP, to: FP2, fps: [FP] }],
      ['ready', { t: 'cards', id: 2, from: FP, to: FP2, recs: [REC] }],
      ['ready', { t: 'ping' }],
      ['hello', { t: 'bye', reason: 'PROOF' }],
    ];
    for (const [phase, f] of valid) assert.doesNotThrow(() => parseFrame(f, phase), `${phase} ${f.t}`);
    assert.deepEqual(parseFrame({ t: 'rec', from: FP, to: FP2, route: DIR, rec: REC }, 'ready').rec, Buffer.alloc(100, 1));

    const invalid = [
      ['ready', { t: 'hello', v: 1, nonce: 'c'.repeat(64) }, 'a handshake frame after ready'],
      ['hello', { t: 'rec', from: FP, to: FP2, route: DIR, rec: REC }, 'a session frame before ready'],
      ['prove-dial', { t: 'pull', id: 1, from: FP, to: FP2, routes: [{ route: DIR, since: 0 }] }, 'a pull before ready'],
      ['ready', { t: 'nope' }, 'an unknown t'],
      ['ready', [], 'not an object'],
      ['hello', { t: 'hello', v: 2, nonce: 'c'.repeat(64) }, 'another version'],
      ['hello', { t: 'hello', v: 1, nonce: 'C'.repeat(64) }, 'an uppercase nonce'],
      ['hello', { t: 'hello', v: 1, nonce: 'c'.repeat(64), x: 1 }, 'an extra key'],
      ['prove-dial', { t: 'prove', ids: [id] }, 'a dialer proof without target'],
      ['prove-accept', { t: 'prove', target: FP, ids: [id] }, 'an acceptor proof with a target'],
      ['prove-dial', { t: 'prove', target: FP, ids: [] }, 'no ids'],
      ['prove-dial', { t: 'prove', target: FP, ids: Array(TCP_MAX_IDENTITIES + 1).fill(id) }, 'too many ids'],
      ['prove-dial', { t: 'prove', target: FP, ids: [{ key: b64(31), sig: b64(64) }] }, 'a short key'],
      ['prove-dial', { t: 'prove', target: FP, ids: [{ key: `${b64(32)}=`, sig: b64(64) }] }, 'a padded key'],
      ['ready', { t: 'rec', from: 'x', to: FP2, route: DIR, rec: REC }, 'a bad from'],
      ['ready', { t: 'rec', from: FP, to: FP2, route: { kind: 'inbox' }, rec: REC }, 'a bad route'],
      ['ready', { t: 'rec', from: FP, to: FP2, route: DIR, rec: b64(RECORD_MAX_BYTES + 1) }, 'an oversize record'],
      ['ready', { t: 'rec', from: FP, to: FP2, route: DIR, rec: 'AB' }, 'non-canonical record bytes'],
      ['ready', { t: 'pull', id: -1, from: FP, to: FP2, routes: [{ route: DIR, since: 0 }] }, 'a negative id'],
      ['ready', { t: 'pull', id: 1, from: FP, to: FP2, routes: [] }, 'no routes'],
      ['ready', { t: 'pull', id: 1, from: FP, to: FP2, routes: Array(TCP_PULL_ROUTES_MAX + 1).fill({ route: DIR, since: 0 }) }, 'too many routes'],
      ['ready', { t: 'pull', id: 1, from: FP, to: FP2, routes: [{ route: DIR, since: 1.5 }] }, 'a fractional since'],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'denied', recs: [{ seq: 1, rec: REC }], more: false, head: 3 }] }, 'records on a denied route'],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'denied', recs: [], more: false, head: 3 }] }, 'a head on a denied route'],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'ok' }] }, 'an ok route without records'],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'ok', recs: [{ seq: 0, rec: REC }], more: false, head: 3 }] }, 'seq 0'],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'maybe', recs: [], more: false, head: 3 }] }, 'an unknown status'],
      ['ready', { t: 'whois', id: 2, from: FP, to: FP2, fps: Array(TCP_WHOIS_MAX + 1).fill(FP) }, 'too many fps'],
      ['ready', { t: 'cards', id: 2, from: FP, to: FP2, recs: Array(TCP_WHOIS_MAX + 1).fill(REC) }, 'too many cards'],
      ['ready', { t: 'bye', reason: 'BECAUSE' }, 'an unknown bye reason'],
      ['ready', { t: 'ping', extra: true }, 'a ping with a field'],
    ];
    for (const [phase, f, what] of invalid) assert.throws(() => parseFrame(f, phase), { code: 'PROTOCOL' }, what);
  });
});
