/**
 * POST /api/subscribe
 *
 * Captures an email address for a lead magnet and returns the download URL.
 *
 * Storage is best-effort and layered so a capture failure NEVER blocks the
 * reader from getting the asset they were promised:
 *
 *   1. LEADS (KV namespace binding)  - primary store, you own the list.
 *   2. FORMSPREE_ENDPOINT (env var)  - optional mirror/fallback to an inbox.
 *
 * If neither is configured the function still returns 200 with the download
 * URL and logs a warning. A broken list is a marketing problem; a broken
 * download is a trust problem.
 *
 * Configure bindings in the Cloudflare dashboard:
 *   Pages project -> Settings -> Functions -> KV namespace bindings
 *     Variable name: LEADS   Namespace: josephcalitoy-leads
 *   Pages project -> Settings -> Environment variables
 *     FORMSPREE_ENDPOINT = https://formspree.io/f/xxxxxxxx   (optional)
 */

const DOWNLOADS = {
  'mobile-ua-ai-ecosystems':
    '/assets/research/mobile-ua-ai-ecosystems-joseph-calitoy.pdf',
};

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

// Deliberately permissive: reject only what is clearly not an address.
// Over-strict client-side validation loses real leads.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const onRequestOptions = () => new Response(null, { status: 204, headers: CORS });

export async function onRequestPost({ request, env }) {
  let email = '';
  let source = '';
  let honeypot = '';

  try {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const body = await request.json();
      email = String(body.email || '').trim().toLowerCase();
      source = String(body.source || '').trim();
      honeypot = String(body.company || '').trim();
    } else {
      const form = await request.formData();
      email = String(form.get('email') || '').trim().toLowerCase();
      source = String(form.get('source') || '').trim();
      honeypot = String(form.get('company') || '').trim();
    }
  } catch {
    return json({ ok: false, error: 'Malformed request.' }, 400);
  }

  // Bots fill hidden fields. Humans do not. Return success so the bot
  // does not learn it was caught, but store nothing.
  if (honeypot) return json({ ok: true, download: DOWNLOADS[source] || null });

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  const download = DOWNLOADS[source];
  if (!download) {
    return json({ ok: false, error: 'Unknown download requested.' }, 400);
  }

  const record = {
    email,
    source,
    at: new Date().toISOString(),
    country: request.headers.get('cf-ipcountry') || null,
    referer: request.headers.get('referer') || null,
    ua: (request.headers.get('user-agent') || '').slice(0, 300),
  };

  const stored = [];

  if (env.LEADS) {
    try {
      // Key by source+email so a repeat download does not create duplicates,
      // and the whole list for one magnet is listable by prefix.
      await env.LEADS.put(`lead:${source}:${email}`, JSON.stringify(record), {
        metadata: { at: record.at, source },
      });
      stored.push('kv');
    } catch (err) {
      console.error('KV write failed', err);
    }
  }

  if (env.FORMSPREE_ENDPOINT) {
    try {
      const res = await fetch(env.FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(record),
      });
      if (res.ok) stored.push('formspree');
      else console.error('Formspree rejected', res.status);
    } catch (err) {
      console.error('Formspree post failed', err);
    }
  }

  if (stored.length === 0) {
    console.warn(`No lead store configured. Dropped capture for ${email}.`);
  }

  return json({ ok: true, download, stored });
}

// A GET here is almost always a human poking the URL. Be explicit.
export const onRequestGet = () =>
  json({ ok: false, error: 'POST an email address to this endpoint.' }, 405);
