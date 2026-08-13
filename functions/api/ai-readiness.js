/**
 * POST /api/ai-readiness
 *
 * Scans a domain for "AI readiness" — how well it can be discovered, crawled,
 * and cited by AI answer engines (ChatGPT, Perplexity, Claude, AI Overviews).
 *
 * Two phases:
 *   1. DETERMINISTIC (always runs, costs nothing) — fetches the site and checks
 *      crawler access, structured data, and content extractability. This is the
 *      bulk of the real signal and it is free, so it never gets rate-limited
 *      into uselessness.
 *   2. LIVE LLM (optional, costs money) — actually asks a model buyer-intent
 *      questions about the brand and records what it says. This is the part
 *      with the wow factor and the part that burns credit, so it sits behind
 *      a hard daily spend cap and degrades silently to phase-1-only.
 *
 * SPEND SAFETY (this endpoint can cost real money — read before editing):
 *   - AI_SCAN_DAILY_CAP    max phase-2 scans per UTC day across ALL visitors
 *   - per-IP and per-domain throttles in KV
 *   - when the cap is hit the response still returns a full phase-1 report
 *     with `llm.skipped = "daily-cap"`; it does not error and does not queue.
 *
 * Bindings (Cloudflare Pages -> Settings -> Functions):
 *   LEADS            KV namespace  (reused; keys here are prefixed `scan:`/`rl:`)
 *   LLM_API_KEY      secret        OpenAI-compatible key. Absent = phase 1 only.
 *   LLM_BASE_URL     var           default https://inference-api.nousresearch.com/v1
 *   LLM_MODEL        var           default Hermes-4-70B
 *   AI_SCAN_DAILY_CAP var          default 40
 *   TURNSTILE_SECRET secret        optional; enforced only if set
 */

const CORS = {
  'Access-Control-Allow-Origin': 'https://josephcalitoy.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export const onRequestOptions = () =>
  new Response(null, { status: 204, headers: CORS });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Bots that matter for AI answer engines. Blocking these is the single most
// common (and most expensive) AI-visibility mistake a site makes.
const AI_CRAWLERS = [
  { ua: 'GPTBot', label: 'GPTBot', who: 'ChatGPT training + browsing', weight: 10 },
  { ua: 'OAI-SearchBot', label: 'OAI-SearchBot', who: 'ChatGPT Search index', weight: 12 },
  { ua: 'ChatGPT-User', label: 'ChatGPT-User', who: 'ChatGPT live fetches', weight: 8 },
  { ua: 'PerplexityBot', label: 'PerplexityBot', who: 'Perplexity index', weight: 10 },
  { ua: 'ClaudeBot', label: 'ClaudeBot', who: 'Claude citations', weight: 8 },
  { ua: 'Google-Extended', label: 'Google-Extended', who: 'Gemini / AI Overviews', weight: 10 },
  { ua: 'Applebot-Extended', label: 'Applebot-Extended', who: 'Apple Intelligence', weight: 4 },
  { ua: 'CCBot', label: 'CCBot', who: 'Common Crawl (feeds many models)', weight: 6 },
];

function normalizeDomain(raw) {
  let d = String(raw || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (!d || d.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  // Refuse internal / loopback targets — this endpoint must not be an SSRF proxy.
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1)/.test(d)) return null;
  if (d.endsWith('.local') || d.endsWith('.internal')) return null;
  return d;
}

async function fetchText(url, ms = 8000, limit = 400_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      cf: { cacheTtl: 300, cacheEverything: true },
      headers: {
        // Identify honestly. Never impersonate a real AI crawler.
        'User-Agent': 'CalitoyAIReadiness/1.0 (+https://josephcalitoy.com/ai-readiness)',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
    const body = (await res.text()).slice(0, limit);
    return { ok: res.ok, status: res.status, body, url: res.url };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal robots.txt evaluator: does `ua` have access to `/`? */
function robotsAllows(robotsTxt, ua) {
  if (!robotsTxt) return { allowed: true, reason: 'no robots.txt (open by default)' };

  const lines = robotsTxt.split('\n').map((l) => l.replace(/#.*$/, '').trim());
  const groups = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
    } else if (current) {
      current.rules.push({ type: key, path: val });
    }
  }

  const lower = ua.toLowerCase();
  const exact = groups.find((g) => g.agents.includes(lower));
  const wild = groups.find((g) => g.agents.includes('*'));
  const group = exact || wild;
  if (!group) return { allowed: true, reason: 'no matching rule' };

  // Longest-match wins, Allow beats Disallow on ties (per Google's spec).
  let best = null;
  for (const r of group.rules) {
    if (r.type === 'disallow' && r.path === '') continue; // empty disallow = allow all
    if (r.path === '/' || r.path === '' || '/'.startsWith(r.path.replace(/\*$/, ''))) {
      const len = r.path.length;
      if (!best || len > best.path.length || (len === best.path.length && r.type === 'allow')) {
        best = r;
      }
    }
  }
  if (!best) return { allowed: true, reason: exact ? 'explicit group, no root block' : 'wildcard group, no root block' };
  return {
    allowed: best.type === 'allow',
    reason: `${best.type}: ${best.path || '/'}${exact ? ' (explicit rule)' : ' (wildcard *)'}`,
  };
}

function analyzeHtml(html) {
  const pick = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };

  const title = pick(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]{0,500}?)["']/i)
    || pick(/<meta[^>]+content=["']([\s\S]{0,500}?)["'][^>]+name=["']description["']/i);

  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const schemaTypes = [];
  for (const b of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const walk = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n['@type']) [].concat(n['@type']).forEach((t) => schemaTypes.push(String(t)));
        if (n['@graph']) walk(n['@graph']);
      };
      walk(parsed);
    } catch { /* malformed JSON-LD still counts as "attempted" but we can't type it */ }
  }

  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  const h2count = (html.match(/<h2[\s>]/gi) || []).length;

  // Strip non-content, then measure what a text-only crawler would actually get.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = stripped ? stripped.split(' ').length : 0;

  return {
    title,
    titleLen: title ? title.length : 0,
    description,
    descLen: description ? description.length : 0,
    schemaTypes: [...new Set(schemaTypes)],
    jsonLdCount: jsonLdBlocks.length,
    h1s,
    h2count,
    words,
    textRatio: html.length ? +(stripped.length / html.length).toFixed(3) : 0,
    hasOg: /<meta[^>]+property=["']og:/i.test(html),
  };
}

function buildFindings(data) {
  const f = [];
  const add = (sev, title, detail, fix) => f.push({ sev, title, detail, fix });

  // ---- crawler access (the heaviest signal) ----
  const blocked = data.crawlers.filter((c) => !c.allowed);
  if (blocked.length) {
    add('critical',
      `${blocked.length} AI crawler${blocked.length > 1 ? 's are' : ' is'} blocked`,
      `Blocked: ${blocked.map((b) => b.label).join(', ')}. These engines cannot read the site, so it cannot be cited in their answers.`,
      'Remove or narrow the Disallow rules for these user-agents in robots.txt.');
  } else {
    add('pass', 'All major AI crawlers can access the site',
      `Checked ${data.crawlers.length} agents including GPTBot, PerplexityBot and Google-Extended.`, null);
  }

  // ---- llms.txt ----
  if (data.llmsTxt) {
    add('pass', 'llms.txt is published',
      'An emerging convention that gives models a curated map of the site.', null);
  } else {
    add('opportunity', 'No llms.txt',
      'llms.txt is an emerging standard letting you tell AI engines which pages matter and how to describe you. Few competitors have one yet.',
      'Publish /llms.txt listing key pages with one-line descriptions.');
  }

  // ---- structured data ----
  if (!data.page.jsonLdCount) {
    add('critical', 'No structured data (JSON-LD)',
      'Schema.org markup is how engines resolve what an entity IS. Without it they infer from prose and frequently get it wrong.',
      'Add Organization + WebSite JSON-LD, then Service/Product/FAQ as relevant.');
  } else {
    const want = ['Organization', 'WebSite', 'LocalBusiness', 'Product', 'Service', 'FAQPage', 'Person'];
    const have = data.page.schemaTypes.filter((t) => want.includes(t));
    if (have.length) {
      add('pass', `Structured data present (${have.join(', ')})`,
        `${data.page.jsonLdCount} JSON-LD block(s) found.`, null);
    } else {
      add('warn', 'Structured data present but missing entity types',
        `Found: ${data.page.schemaTypes.join(', ') || 'untyped'}. No Organization/WebSite entity.`,
        'Add an Organization and WebSite entity so engines can identify the brand.');
    }
  }

  // ---- title / description ----
  if (!data.page.title) {
    add('critical', 'Missing <title>', 'The single strongest naming signal is absent.', 'Add a descriptive title tag.');
  } else if (data.page.titleLen > 65) {
    add('warn', 'Title is long', `${data.page.titleLen} chars; may be truncated in citations.`, 'Trim to under ~60 characters.');
  } else {
    add('pass', 'Title tag is well-formed', `"${data.page.title}"`, null);
  }

  if (!data.page.description) {
    add('warn', 'No meta description',
      'Answer engines often lift this verbatim as the brand summary.',
      'Write a 140-160 char description stating what you do and for whom.');
  } else {
    add('pass', 'Meta description present', `${data.page.descLen} characters.`, null);
  }

  // ---- content extractability ----
  if (data.page.words < 150) {
    add('critical', 'Almost no server-rendered text',
      `Only ~${data.page.words} words visible without running JavaScript. Most AI crawlers do not execute JS, so they may see a nearly blank page.`,
      'Server-render or pre-render key copy so it exists in the raw HTML.');
  } else if (data.page.words < 400) {
    add('warn', 'Thin server-rendered content',
      `~${data.page.words} words in raw HTML. Enough to identify the site, thin for citation.`,
      'Add substantive copy that answers real buyer questions.');
  } else {
    add('pass', 'Content is extractable without JavaScript', `~${data.page.words} words in raw HTML.`, null);
  }

  if (!data.page.h1s.length) {
    add('warn', 'No H1 heading', 'Headings give engines the document outline.', 'Add one clear H1.');
  }

  // ---- sitemap ----
  if (data.sitemap) add('pass', 'Sitemap found', 'Helps engines discover the full page set.', null);
  else add('warn', 'No sitemap.xml', 'Engines must guess at your page inventory.', 'Publish /sitemap.xml and reference it in robots.txt.');

  return f;
}

function scoreOf(findings, crawlers) {
  // Weight crawler access heavily — it is a hard gate, not a nice-to-have.
  const crawlerMax = crawlers.reduce((s, c) => s + c.weight, 0);
  const crawlerGot = crawlers.reduce((s, c) => s + (c.allowed ? c.weight : 0), 0);
  const crawlerScore = crawlerMax ? crawlerGot / crawlerMax : 1;

  let pts = 0;
  let max = 0;
  for (const f of findings) {
    if (f.sev === 'pass') { pts += 10; max += 10; }
    else if (f.sev === 'opportunity') { pts += 5; max += 10; }
    else if (f.sev === 'warn') { pts += 4; max += 10; }
    else if (f.sev === 'critical') { pts += 0; max += 10; }
  }
  const findingScore = max ? pts / max : 0;
  return Math.round((crawlerScore * 0.45 + findingScore * 0.55) * 100);
}

/** Phase 2: ask a real model what it knows about the brand. Costs money. */
async function runLlmChecks(env, domain, page) {
  const key = env.LLM_API_KEY;
  if (!key) return { ran: false, skipped: 'not-configured' };

  const base = env.LLM_BASE_URL || 'https://inference-api.nousresearch.com/v1';
  const model = env.LLM_MODEL || 'Hermes-4-70B';
  const brand = (page.title || domain).split(/[|\u2014\-–]/)[0].trim().slice(0, 60);

  const prompts = [
    `What is ${brand} (${domain})? Answer in 2 sentences. If you do not know, say "I don't have information about this."`,
    `Would you recommend ${brand} (${domain})? Who is it best for? 2 sentences. If unknown, say "I don't have information about this."`,
  ];

  const results = [];
  for (const p of prompts) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 160,
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Answer only from what you already know. Never guess or invent details about a business. If you have no knowledge of it, say so plainly.' },
            { role: 'user', content: p },
          ],
        }),
      });
      clearTimeout(timer);
      if (!res.ok) {
        results.push({ prompt: p, error: `upstream ${res.status}` });
        continue;
      }
      const data = await res.json();
      const answer = (data.choices?.[0]?.message?.content || '').trim();
      const unknown = /don'?t have (any )?information|not familiar|no knowledge|cannot find|unable to find|i'?m not aware/i.test(answer);
      results.push({ prompt: p, answer, recognized: !unknown });
    } catch (err) {
      results.push({ prompt: p, error: String(err && err.message || err) });
    }
  }

  const answered = results.filter((r) => r.answer);
  const recognized = answered.filter((r) => r.recognized).length;
  return {
    ran: true,
    model,
    recognized,
    asked: results.length,
    verdict: !answered.length ? 'inconclusive'
      : recognized === 0 ? 'invisible'
      : recognized < answered.length ? 'partial'
      : 'recognized',
    results,
  };
}

export async function onRequestPost({ request, env }) {
  let email = '';
  let domainRaw = '';
  let honeypot = '';
  let turnstile = '';

  try {
    const b = await request.json();
    email = String(b.email || '').trim().toLowerCase();
    domainRaw = String(b.domain || '').trim();
    honeypot = String(b.company || '').trim();
    turnstile = String(b['cf-turnstile-response'] || '');
  } catch {
    return json({ ok: false, error: 'Malformed request.' }, 400);
  }

  if (honeypot) return json({ ok: true, queued: true });

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }
  const domain = normalizeDomain(domainRaw);
  if (!domain) {
    return json({ ok: false, error: 'Please enter a valid website domain.' }, 400);
  }

  // Turnstile is enforced only when a secret is configured, so the endpoint
  // still works before the widget is wired up.
  if (env.TURNSTILE_SECRET) {
    const ip = request.headers.get('cf-connecting-ip') || '';
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: turnstile, remoteip: ip }),
    }).then((r) => r.json()).catch(() => ({ success: false }));
    if (!v.success) return json({ ok: false, error: 'Verification failed. Please retry.' }, 403);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const today = new Date().toISOString().slice(0, 10);
  const kv = env.LEADS || null;

  // ---- throttles (cheap reads, fail-open so a KV blip cannot break the tool) ----
  let llmAllowed = true;
  let llmSkip = null;

  if (kv) {
    try {
      const ipKey = `rl:ip:${today}:${ip}`;
      const ipCount = parseInt((await kv.get(ipKey)) || '0', 10);
      if (ipCount >= 5) { llmAllowed = false; llmSkip = 'ip-throttle'; }
      await kv.put(ipKey, String(ipCount + 1), { expirationTtl: 86400 });

      const capRaw = parseInt(env.AI_SCAN_DAILY_CAP || '40', 10);
      const cap = Number.isFinite(capRaw) ? capRaw : 40;
      const globalKey = `rl:global:${today}`;
      const used = parseInt((await kv.get(globalKey)) || '0', 10);
      if (used >= cap) { llmAllowed = false; llmSkip = 'daily-cap'; }
    } catch (err) {
      console.error('throttle read failed (failing open for phase 1)', err);
    }
  }

  // ---- phase 1: deterministic, always ----
  const origin = `https://${domain}`;
  const [home, robots, llms, sitemap] = await Promise.all([
    fetchText(origin, 9000),
    fetchText(`${origin}/robots.txt`, 6000, 60_000),
    fetchText(`${origin}/llms.txt`, 5000, 40_000),
    fetchText(`${origin}/sitemap.xml`, 5000, 20_000),
  ]);

  if (!home.ok && !home.body) {
    return json({
      ok: false,
      error: `Could not reach ${domain}. Check the spelling, or the site may be blocking automated requests.`,
    }, 422);
  }

  const robotsTxt = robots.ok ? robots.body : '';
  const crawlers = AI_CRAWLERS.map((c) => {
    const r = robotsAllows(robotsTxt, c.ua);
    return { ...c, allowed: r.allowed, reason: r.reason };
  });

  const page = analyzeHtml(home.body);
  const data = {
    crawlers,
    page,
    llmsTxt: llms.ok && llms.body.length > 20,
    sitemap: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body),
    robotsFound: robots.ok,
  };

  const findings = buildFindings(data);
  const score = scoreOf(findings, crawlers);

  // ---- phase 2: live model check ----
  let llm = { ran: false, skipped: llmSkip || 'not-configured' };
  if (llmAllowed && env.LLM_API_KEY) {
    llm = await runLlmChecks(env, domain, page);
    if (llm.ran && kv) {
      try {
        const gk = `rl:global:${today}`;
        const used = parseInt((await kv.get(gk)) || '0', 10);
        await kv.put(gk, String(used + 1), { expirationTtl: 172800 });
      } catch (err) { console.error('cap increment failed', err); }
    }
  } else if (!llmAllowed) {
    llm = { ran: false, skipped: llmSkip };
  }

  // ---- store the lead (best effort, never blocks the report) ----
  if (kv) {
    try {
      await kv.put(`lead:ai-readiness:${email}`, JSON.stringify({
        email,
        domain,
        score,
        llmVerdict: llm.verdict || null,
        at: new Date().toISOString(),
        country: request.headers.get('cf-ipcountry') || null,
        referer: request.headers.get('referer') || null,
      }), { metadata: { at: new Date().toISOString(), source: 'ai-readiness', score } });
    } catch (err) {
      console.error('lead write failed', err);
    }
  }

  const counts = findings.reduce((a, f) => (a[f.sev] = (a[f.sev] || 0) + 1, a), {});

  return json({
    ok: true,
    domain,
    score,
    grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F',
    counts,
    findings,
    crawlers: crawlers.map(({ label, who, allowed, reason }) => ({ label, who, allowed, reason })),
    page: {
      title: page.title, description: page.description,
      words: page.words, schemaTypes: page.schemaTypes, h1s: page.h1s.slice(0, 3),
    },
    llm,
    scannedAt: new Date().toISOString(),
  });
}

export const onRequestGet = () =>
  json({ ok: false, error: 'POST { email, domain } to this endpoint.' }, 405);
