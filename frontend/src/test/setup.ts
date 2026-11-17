import { afterEach, expect, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// No test may reach the network: the default `fetch` is a tripwire that records and refuses. A test that needs
// answers stubs fetch itself (vi.stubGlobal), and the stub is removed after it.
const escaped: string[] = [];
const tripwire = ((input: RequestInfo | URL) => {
  escaped.push(String(input instanceof Request ? input.url : input));
  return Promise.reject(new Error('a test reached the real network'));
}) as typeof fetch;
globalThis.fetch = tripwire;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.fetch = tripwire;
  expect(escaped.splice(0), 'requests that reached the real fetch').toEqual([]);
});
