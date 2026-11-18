// The in-memory directory of announces (docs/architecture.md → Directory): the latest verified announce per
// fingerprint, by (ts, then record id). Fed by every route (sessions, hub rosters, the file share, card imports,
// identities.json at boot, this install's own announce); never written to the record log. No I/O.

const newer = (a, b) => a.payload.ts > b.payload.ts || (a.payload.ts === b.payload.ts && a.id > b.id);

export function createDirectory() {
  const map = new Map(); // fp → {id, bytes, payload}
  return {
    // `d`: a decoded announce ({id, payload}) and its `bytes`. → true when it became the current one for its signer.
    note({ id, payload, bytes }) {
      const cur = map.get(payload.signer);
      if (cur && !newer({ id, payload }, cur)) return false;
      map.set(payload.signer, { id, bytes: Buffer.from(bytes), payload });
      return true;
    },
    get: (fp) => map.get(fp) ?? null,
    entries: () => [...map.values()],
  };
}
