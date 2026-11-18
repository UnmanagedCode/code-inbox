import test from 'node:test';
import assert from 'node:assert/strict';
import { ANNOUNCE_MAX_BYTES, RECORD_MAX_BYTES } from '../src/records.js';
import {
  HUB_CHUNK_BYTES, HUB_DATA_MAX, TCP_FRAME_MAX, TCP_HELLO_FRAME_MAX, TCP_MAX_IDENTITIES, TCP_PULL_ROUTES_MAX,
  createDecoder, encodeFrame, parseFrame, parseGreeting, parseHubFrame,
} from '../src/transport/frames.js';

const FP = 'a'.repeat(64);
const FP2 = 'b'.repeat(64);
const b64 = (n, fill = 1) => Buffer.alloc(n, fill).toString('base64url');
const id = { key: b64(32), sig: b64(64) };
const DIR = { kind: 'directory' };
const REC = b64(100);

const NONCE = 'c'.repeat(64);
const hello = (kind, extra = {}) => ({ t: 'hello', v: 2, nonce: NONCE, kind, ...extra });
const drain = (d) => { const out = []; for (let f; (f = d.next()) !== null;) out.push(f); return out; };

// Invariant: frames survive any split or coalescing of the byte stream, and a header over the limit is refused
// before its body is buffered.
test('the decoder reassembles split and coalesced frames and rejects each schema violation', async (t) => {
  const frames = [{ t: 'ping' }, hello('endpoint'), { t: 'bye', reason: 'STOP' }];
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
      ['hello', hello('endpoint')],
      ['prove-dial', { t: 'prove', target: FP, ids: [id] }],
      ['prove-dial', { t: 'prove', target: null, ids: [id] }],
      ['prove-accept', { t: 'prove', ids: [id] }],
      ['ok', { t: 'ok' }],
      ['ready', { t: 'rec', from: FP, to: FP2, route: DIR, rec: REC }],
      ['ready', { t: 'pull', id: 1, from: FP, to: FP2, routes: [{ route: DIR, since: 0 }] }],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'ok', recs: [{ seq: 1, rec: REC }], more: false, head: 3 }] }],
      ['ready', { t: 'recs', id: 1, from: FP, to: FP2, routes: [{ route: DIR, status: 'denied' }] }],
      ['ready', { t: 'ping' }],
      ['hello', { t: 'bye', reason: 'PROOF' }],
    ];
    for (const [phase, f] of valid) assert.doesNotThrow(() => parseFrame(f, phase), `${phase} ${f.t}`);
    assert.deepEqual(parseFrame({ t: 'rec', from: FP, to: FP2, route: DIR, rec: REC }, 'ready').rec, Buffer.alloc(100, 1));

    const invalid = [
      ['ready', hello('endpoint'), 'a handshake frame after ready'],
      ['hello', { t: 'rec', from: FP, to: FP2, route: DIR, rec: REC }, 'a session frame before ready'],
      ['prove-dial', { t: 'pull', id: 1, from: FP, to: FP2, routes: [{ route: DIR, since: 0 }] }, 'a pull before ready'],
      ['ready', { t: 'nope' }, 'an unknown t'],
      ['ready', [], 'not an object'],
      ['hello', { t: 'hello', v: 1, nonce: NONCE }, 'a v1 hello'],
      ['hello', { ...hello('endpoint'), v: 3 }, 'another version'],
      ['hello', { t: 'hello', v: 2, nonce: NONCE }, 'a hello without kind'],
      ['hello', hello('hub'), 'a hub hello sent to an endpoint session'],
      ['hello', hello('peer'), 'an unknown kind'],
      ['hello', { ...hello('endpoint'), nonce: 'C'.repeat(64) }, 'an uppercase nonce'],
      ['hello', hello('endpoint', { x: 1 }), 'an extra key'],
      ['prove-dial', { t: 'prove', ids: [id] }, 'a dialer proof without target'],
      ['prove-dial', { t: 'prove', target: 'x', ids: [id] }, 'a target that is neither a fingerprint nor null'],
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
      ['ready', { t: 'whois', id: 2, from: FP, to: FP2, fps: [FP] }, 'whois is no frame'],
      ['ready', { t: 'cards', id: 2, from: FP, to: FP2, recs: [REC] }, 'cards is no frame'],
      ['ready', { t: 'bye', reason: 'BECAUSE' }, 'an unknown bye reason'],
      ['ready', { t: 'ping', extra: true }, 'a ping with a field'],
    ];
    for (const [phase, f, what] of invalid) assert.throws(() => parseFrame(f, phase), { code: 'PROTOCOL' }, what);
  });
});

// Invariant: every hub-link frame has an exact schema per receiving role and phase; a frame meant for the other
// direction, or out of phase, is refused like an unknown one.
test('parseHubFrame accepts each hub frame in its role and phase and rejects each schema violation', () => {
  const valid = [
    ['hub', 'hello', hello('endpoint')],
    ['hub', 'register', { t: 'register', ids: [id] }],
    ['client', 'ok', { t: 'ok' }],
    ['hub', 'ready', { t: 'open', s: 1, to: FP }],
    ['client', 'ready', { t: 'incoming', s: 2 }],
    ['hub', 'ready', { t: 'data', s: 3, b: 'AAEC-_' }],
    ['client', 'ready', { t: 'data', s: 2, b: b64(HUB_CHUNK_BYTES) }],
    ['hub', 'ready', { t: 'close', s: 1, reason: 'CLOSED' }],
    ['hub', 'ready', { t: 'close', s: 1, reason: 'LIMIT' }],
    ['client', 'ready', { t: 'close', s: 1, reason: 'ABSENT' }],
    ['client', 'ready', { t: 'close', s: 2, reason: 'GONE' }],
    ['hub', 'ready', { t: 'announce', rec: REC }],
    ['hub', 'ready', { t: 'announce', rec: b64(ANNOUNCE_MAX_BYTES) }],
    ['client', 'ready', { t: 'peer', fp: FP, rec: REC }],
    ['client', 'ready', { t: 'peer', fp: FP, rec: null }],
    ['client', 'ready', { t: 'gone', fp: FP }],
    ['hub', 'ready', { t: 'ping' }],
    ['client', 'ready', { t: 'pong' }],
    ['hub', 'register', { t: 'bye', reason: 'STOP' }],
    ['client', 'ok', { t: 'bye', reason: 'DUPLICATE' }],
  ];
  for (const [role, phase, f] of valid) assert.doesNotThrow(() => parseHubFrame(f, role, phase), `${role} ${phase} ${f.t}`);
  assert.equal(b64(HUB_CHUNK_BYTES).length, HUB_DATA_MAX);
  assert.deepEqual(parseHubFrame({ t: 'register', ids: [id] }, 'hub', 'register').ids[0].key, Buffer.alloc(32, 1));
  assert.deepEqual(parseHubFrame({ t: 'announce', rec: REC }, 'hub', 'ready').rec, Buffer.alloc(100, 1));
  assert.deepEqual(parseHubFrame({ t: 'peer', fp: FP, rec: REC }, 'client', 'ready').rec, Buffer.alloc(100, 1));

  const invalid = [
    ['hub', 'hello', { t: 'open', s: 1, to: FP }, 'an open before registering'],
    ['hub', 'register', { t: 'announce', rec: REC }, 'an announce before ok'],
    ['hub', 'ready', { t: 'register', ids: [id] }, 'a second register'],
    ['hub', 'ready', { t: 'incoming', s: 2 }, 'a hub-to-client frame sent to the hub'],
    ['hub', 'ready', { t: 'peer', fp: FP, rec: null }, 'a roster frame sent to the hub'],
    ['client', 'ready', { t: 'open', s: 1, to: FP }, 'an open sent to a client'],
    ['client', 'ready', { t: 'announce', rec: REC }, 'an announce sent to a client'],
    ['hub', 'ready', { t: 'watch', id: 1, fps: [] }, 'watch is no frame'],
    ['client', 'ready', { t: 'present', id: 7, fps: [FP] }, 'present is no frame'],
    ['client', 'ready', { t: 'presence', fp: FP, online: true }, 'presence is no frame'],
    ['hub', 'hello', hello('hub'), 'a hub hello sent to the hub'],
    ['hub', 'hello', { t: 'hello', v: 1, nonce: NONCE }, 'a v1 hello sent to the hub'],
    ['client', 'hello', hello('hub'), 'a client has no hello phase: the greeting read it'],
    ['client', 'ok', hello('hub'), 'a hello after the greeting'],
    ['hub', 'ready', { t: 'nope' }, 'an unknown t'],
    ['hub', 'ready', { t: 'open', s: 2, to: FP }, 'an even open.s'],
    ['hub', 'ready', { t: 'open', s: 0, to: FP }, 'stream 0'],
    ['hub', 'ready', { t: 'open', s: 1, to: 'x' }, 'a bad to'],
    ['hub', 'ready', { t: 'open', s: 1, to: FP, x: 1 }, 'an extra key'],
    ['client', 'ready', { t: 'incoming', s: 3 }, 'an odd incoming.s'],
    ['hub', 'ready', { t: 'data', s: 1, b: '' }, 'empty data'],
    ['hub', 'ready', { t: 'data', s: 1, b: 'AA==' }, 'padded data'],
    ['hub', 'ready', { t: 'data', s: 1, b: 'A+/A' }, 'standard base64 data'],
    ['hub', 'ready', { t: 'data', s: 1, b: 'A'.repeat(HUB_DATA_MAX + 1) }, 'an oversize chunk'],
    ['hub', 'ready', { t: 'data', s: 1.5, b: 'AA' }, 'a fractional s'],
    ['hub', 'ready', { t: 'close', s: 1, reason: 'ABSENT' }, 'a client claiming ABSENT'],
    ['client', 'ready', { t: 'close', s: 1, reason: 'BECAUSE' }, 'an unknown close reason'],
    ['hub', 'ready', { t: 'announce', rec: b64(ANNOUNCE_MAX_BYTES + 1) }, 'an announce over ANNOUNCE_MAX_BYTES'],
    ['hub', 'ready', { t: 'announce', rec: '' }, 'an empty announce'],
    ['hub', 'ready', { t: 'announce', rec: REC, fp: FP }, 'an announce with an extra key'],
    ['client', 'ready', { t: 'peer', fp: 'x', rec: null }, 'a peer of a non-fingerprint'],
    ['client', 'ready', { t: 'peer', fp: FP }, 'a peer without rec'],
    ['client', 'ready', { t: 'peer', fp: FP, rec: 'AB' }, 'a peer with non-canonical bytes'],
    ['client', 'ready', { t: 'gone', fp: FP, rec: null }, 'a gone with an extra key'],
    ['hub', 'register', { t: 'register', ids: [] }, 'no ids'],
    ['hub', 'register', { t: 'register', ids: Array(TCP_MAX_IDENTITIES + 1).fill(id) }, 'too many ids'],
    ['hub', 'register', { t: 'register', target: FP, ids: [id] }, 'a register with a target'],
  ];
  for (const [role, phase, f, what] of invalid) assert.throws(() => parseHubFrame(f, role, phase), { code: 'PROTOCOL' }, what);
});

// Invariant: the greeting reads exactly one v2 hello of a known kind, whoever sent it; anything else (a v1 hello, an
// unknown kind, another frame, a bye) is refused PROTOCOL, so a connection never guesses what it reached.
test('parseGreeting accepts a v2 hello of either kind and nothing else', () => {
  for (const kind of ['endpoint', 'hub']) assert.deepEqual(parseGreeting(hello(kind)), hello(kind));
  const invalid = [
    [{ t: 'hello', v: 1, nonce: NONCE }, 'a v1 hello'],
    [{ t: 'hello', v: 2, nonce: NONCE }, 'no kind'],
    [hello('peer'), 'an unknown kind'],
    [hello('hub', { x: 1 }), 'an extra key'],
    [{ ...hello('hub'), nonce: 'x' }, 'a bad nonce'],
    [{ t: 'bye', reason: 'PROOF' }, 'a bye'],
    [{ t: 'ok' }, 'another frame'],
    [[], 'not an object'],
  ];
  for (const [f, what] of invalid) assert.throws(() => parseGreeting(f), { code: 'PROTOCOL' }, what);
});
