// Standalone test of the robots.txt evaluator + HTML analyzer.
// Extracts the pure functions from the Pages Function so we can assert on them
// without a Workers runtime.

import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert';

const src = readFileSync(new URL('../functions/api/ai-readiness.js', import.meta.url), 'utf8');

// Pull the two pure functions out of the module source.
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  let depth = 0, i = src.indexOf('{', start), started = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    else if (src[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const mod = new Function(`
  ${extract('robotsAllows')}
  ${extract('analyzeHtml')}
  ${extract('normalizeDomain')}
  return { robotsAllows, analyzeHtml, normalizeDomain };
`)();

const { robotsAllows, analyzeHtml, normalizeDomain } = mod;

test('no robots.txt = allowed', () => {
  assert.equal(robotsAllows('', 'GPTBot').allowed, true);
});

test('blanket disallow blocks everything', () => {
  const r = 'User-agent: *\nDisallow: /';
  assert.equal(robotsAllows(r, 'GPTBot').allowed, false);
  assert.equal(robotsAllows(r, 'PerplexityBot').allowed, false);
});

test('targeted GPTBot block is caught, others still allowed', () => {
  const r = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /';
  assert.equal(robotsAllows(r, 'GPTBot').allowed, false, 'GPTBot must be blocked');
  assert.equal(robotsAllows(r, 'PerplexityBot').allowed, true, 'Perplexity must be allowed');
});

test('explicit group overrides wildcard', () => {
  const r = 'User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nAllow: /';
  assert.equal(robotsAllows(r, 'ClaudeBot').allowed, true);
  assert.equal(robotsAllows(r, 'GPTBot').allowed, false);
});

test('empty disallow means allow all', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow:', 'GPTBot').allowed, true);
});

test('subdirectory disallow does not block root', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /admin/', 'GPTBot').allowed, true);
});

test('comments and case are handled', () => {
  const r = '# hello\nUSER-AGENT: gptbot\nDISALLOW: /';
  assert.equal(robotsAllows(r, 'GPTBot').allowed, false);
});

test('analyzeHtml extracts the core signals', () => {
  const html = `<html><head><title>Acme Widgets | Best Widgets</title>
    <meta name="description" content="We sell widgets to builders.">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
    </head><body><h1>Acme Widgets</h1><h2>Why us</h2>
    <p>${'word '.repeat(200)}</p><script>var x=1;</script></body></html>`;
  const a = analyzeHtml(html);
  assert.equal(a.title, 'Acme Widgets | Best Widgets');
  assert.equal(a.description, 'We sell widgets to builders.');
  assert.deepEqual(a.schemaTypes, ['Organization']);
  assert.deepEqual(a.h1s, ['Acme Widgets']);
  assert.equal(a.h2count, 1);
  assert.ok(a.words > 190, `expected >190 words, got ${a.words}`);
});

test('analyzeHtml handles @graph schema', () => {
  const html = `<html><head><script type="application/ld+json">
    {"@graph":[{"@type":"Organization"},{"@type":"WebSite"}]}</script></head><body>x</body></html>`;
  const a = analyzeHtml(html);
  assert.deepEqual(a.schemaTypes.sort(), ['Organization', 'WebSite']);
});

test('JS-only page shows near-zero words', () => {
  const html = '<html><head><title>App</title></head><body><div id="root"></div><script>' + 'var a=1;'.repeat(500) + '</script></body></html>';
  const a = analyzeHtml(html);
  assert.ok(a.words < 20, `expected thin content, got ${a.words} words`);
});

test('normalizeDomain strips scheme/www/path', () => {
  assert.equal(normalizeDomain('https://www.Example.com/pricing?a=1'), 'example.com');
  assert.equal(normalizeDomain('example.co.uk'), 'example.co.uk');
});

test('normalizeDomain rejects internal targets (SSRF guard)', () => {
  for (const bad of ['localhost', '127.0.0.1', '192.168.1.1', '10.0.0.5', 'foo.local', 'not a domain', '']) {
    assert.equal(normalizeDomain(bad), null, `${bad} must be rejected`);
  }
});
