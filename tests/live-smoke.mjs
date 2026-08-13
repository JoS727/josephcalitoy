// Smoke-test the scanner logic against REAL sites, outside Workers.
// Proves the robots evaluation and scoring produce sane results on live data.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../functions/api/ai-readiness.js', import.meta.url), 'utf8');
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0, i = src.indexOf('{', start), started = false;
  for (; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    else if (src[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const AI_CRAWLERS = eval(src.match(/const AI_CRAWLERS = (\[[\s\S]*?\n\]);/)[1]);
const fns = new Function(`
  ${extract('robotsAllows')} ${extract('analyzeHtml')} ${extract('buildFindings')} ${extract('scoreOf')}
  return { robotsAllows, analyzeHtml, buildFindings, scoreOf };
`)();

async function get(url, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'CalitoyAIReadiness/1.0 (+https://josephcalitoy.com/ai-readiness)' } });
    return { ok: r.ok, body: (await r.text()).slice(0, 400000) };
  } catch (e) { return { ok: false, body: '', err: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

const targets = process.argv.slice(2);
for (const domain of targets) {
  const origin = `https://${domain}`;
  const [home, robots, llms, sitemap] = await Promise.all([
    get(origin), get(`${origin}/robots.txt`), get(`${origin}/llms.txt`), get(`${origin}/sitemap.xml`),
  ]);
  if (!home.body) { console.log(`\n### ${domain}\n  UNREACHABLE: ${home.err}`); continue; }

  const robotsTxt = robots.ok ? robots.body : '';
  const crawlers = AI_CRAWLERS.map(c => {
    const r = fns.robotsAllows(robotsTxt, c.ua);
    return { ...c, allowed: r.allowed, reason: r.reason };
  });
  const page = fns.analyzeHtml(home.body);
  const data = { crawlers, page, llmsTxt: llms.ok && llms.body.length > 20,
                 sitemap: sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.body), robotsFound: robots.ok };
  const findings = fns.buildFindings(data);
  const score = fns.scoreOf(findings, crawlers);

  const blocked = crawlers.filter(c => !c.allowed).map(c => c.label);
  console.log(`\n### ${domain}  ->  score ${score}`);
  console.log(`  title:   ${(page.title || '(none)').slice(0, 62)}`);
  console.log(`  words:   ${page.words}   schema: ${page.schemaTypes.join(',') || '(none)'}`);
  console.log(`  llms.txt: ${data.llmsTxt}   sitemap: ${data.sitemap}   robots: ${data.robotsFound}`);
  console.log(`  blocked AI crawlers: ${blocked.length ? blocked.join(', ') : 'none'}`);
  for (const f of findings.filter(f => f.sev === 'critical')) console.log(`   [CRIT] ${f.title}`);
}
