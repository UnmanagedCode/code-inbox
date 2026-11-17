import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const srcDir = path.join(root, 'frontend', 'src');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const sources = walk(srcDir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes(`${path.sep}test${path.sep}`));

// Peer-written names and bodies must only ever become React text. Each sink has a sample it must match, so a typo in
// a pattern cannot make the scan pass silently.
const BANNED = [
  { name: 'dangerouslySetInnerHTML', re: /dangerouslySetInnerHTML/, sample: '<div dangerouslySetInnerHTML={x} />' },
  { name: 'innerHTML/outerHTML', re: /\b(inner|outer)HTML\b/, sample: 'el.innerHTML = x' },
  { name: 'insertAdjacentHTML', re: /insertAdjacentHTML/, sample: 'el.insertAdjacentHTML("a", x)' },
  { name: 'document.write', re: /document\s*\.\s*write(ln)?\s*\(/, sample: 'document.write(x)' },
  { name: 'eval / new Function', re: /\beval\s*\(|new\s+Function\s*\(/, sample: 'new Function("x")' },
  { name: 'srcDoc', re: /\bsrcDoc\b/, sample: '<iframe srcDoc={x} />' },
  { name: 'built href/src/style attribute', re: /\b(href|src|style)=\{/, sample: '<a href={x} />' },
  { name: 'setAttribute href/src/style', re: /setAttribute\(\s*['"](href|src|style|srcdoc)['"]/i, sample: 'el.setAttribute("href", x)' },
  { name: 'javascript: URL', re: /javascript:/i, sample: 'const u = "javascript:alert(1)"' },
  { name: 'location.hash', re: /location\.hash|\.hash\s*=/, sample: 'location.hash = "x"' },
];
// A root-relative URL literal, e.g. '/api/state': the page lives under /plugins/<id>/ and must use relative URLs.
const ROOT_RELATIVE = /(['"`])\/[A-Za-z_]/;

test('the scan patterns match their own samples', () => {
  for (const b of BANNED) assert.match(b.sample, b.re, b.name);
  assert.match("fetch('/api/x')", ROOT_RELATIVE);
  assert.doesNotMatch("fetch('api/x')", ROOT_RELATIVE);
});

// Invariant: no UI source can turn peer text into markup, a URL or a style.
test('UI sources use none of the raw-HTML sinks', () => {
  assert.ok(sources.length > 5, 'sources were found');
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const b of BANNED) assert.doesNotMatch(text, b.re, `${path.relative(root, file)} uses ${b.name}`);
  }
});

// Invariant: every URL the page builds is relative.
test('UI sources contain no root-relative URL literal', () => {
  for (const file of sources) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), ROOT_RELATIVE, path.relative(root, file));
});

const HOST_URLS = ['/pluginBridge.js', '/pluginTheme.css'];
const refs = (html) => [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

// Invariant: the only root-relative references are cc's bridge and theme, and the bridge loads first.
test('index.html: the only root-relative references are the two host URLs', () => {
  const rootRel = refs(fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8')).filter((r) => r.startsWith('/'));
  assert.deepEqual(rootRel.sort(), [...HOST_URLS].sort());
});

// Invariant: the built page loads its own assets relatively, with no inline script or style (CSP: 'self' only).
test('the built dist/index.html references only relative assets plus the host URLs', () => {
  const file = path.join(root, 'frontend', 'dist', 'index.html');
  assert.ok(fs.existsSync(file), 'frontend/dist is missing: run `npm run prepare`');
  const html = fs.readFileSync(file, 'utf8');
  for (const r of refs(html)) assert.ok(HOST_URLS.includes(r) || r.startsWith('./assets/'), `unexpected reference ${r}`);
  assert.ok(html.indexOf('/pluginBridge.js') < html.indexOf('<script type="module"'), 'the bridge script is first');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style attributes');
});
