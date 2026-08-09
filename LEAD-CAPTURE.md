# Lead capture: research paper download

The research landing page at `/research/mobile-ua-ai-ecosystems/` captures an
email address and then reveals the PDF **immediately in the page** — there is
no "check your inbox" round-trip. That is deliberate: an inbox hop is where
most lead-magnet conversions are lost.

## How it works

```
research/mobile-ua-ai-ecosystems/index.html   the landing page (two forms)
functions/api/subscribe.js                    POST endpoint, stores the lead
assets/research/…-joseph-calitoy.pdf          the asset itself
scripts/export-leads.sh                       dump the list to CSV
```

Submitting posts JSON to `/api/subscribe`. The endpoint validates the address,
writes it to KV, and returns the download URL, which the page then opens.

### The asset is public

`/assets/research/…pdf` is a plain static file. Anyone who knows the URL can
fetch it without giving an email. This is intentional — gating the bytes would
mean signed URLs and a token flow, which is a lot of machinery to slow down
determined people while adding failure modes for everyone else. The email is
the ask, not a toll gate.

The same reasoning drives the fallback: **if the API is down or errors, the
page still hands over the PDF.** A capture failure is a marketing problem; a
broken download is a trust problem. Only a 400 (a genuinely invalid address)
stops the flow and asks the reader to correct it.

## Setup

### 1. KV namespace — done

Created 2026-08-09; the binding is committed in `wrangler.toml`:

| Variable name | Namespace             | ID                                 |
|---------------|-----------------------|------------------------------------|
| `LEADS`       | `josephcalitoy-leads` | `1aeb9d7e34f14399a7ebf4d2b59cfcb9` |

The binding variable must stay exactly `LEADS` — `subscribe.js` reads
`env.LEADS`. Wrangler applies it on deploy, so no dashboard step is needed.

### 2. Reading the list

```sh
export KV_NAMESPACE_ID=1aeb9d7e34f14399a7ebf4d2b59cfcb9
./scripts/export-leads.sh > leads.csv
```

### 3. Optional — mirror to an inbox

To also receive captures by email, set an environment variable on the Pages
project:

```
FORMSPREE_ENDPOINT = https://formspree.io/f/xxxxxxxx
```

Leave it unset and the endpoint just uses KV. If *neither* is configured the
function still returns the download and logs a warning — it will not 500.

## Deploy

Per DEPLOY.md, this site deploys by direct upload:

```sh
npx wrangler pages deploy . --project-name=josephcalitoy --branch=preview   # check first
npx wrangler pages deploy . --project-name=josephcalitoy --branch=main
```

Functions deploy automatically with the site — the `functions/` directory is
picked up by convention, no extra step.

## Local development

```sh
npx wrangler pages dev . --kv LEADS --compatibility-date=2026-08-08
```

`--kv LEADS` creates a throwaway local namespace, so local test submissions
never touch the real list.

> Pin the compatibility date. Wrangler otherwise defaults to *today's* date,
> which its bundled runtime can reject with "requires compatibility date …
> but the newest date supported by this server binary is …".

## Adding another lead magnet

1. Drop the PDF in `assets/research/`.
2. Add an entry to the `DOWNLOADS` map in `functions/api/subscribe.js`.
3. Use that key as the form's hidden `source` value.

The `source` field is validated against that map, so an unknown value is
rejected rather than silently captured against nothing.

## Testing

The form was verified end-to-end in a real browser (Playwright driving
Chrome) against a local Pages server: submission, validation, download
trigger, the two-form sync, mobile layout, and the API-down / 500 / 400
paths. If you change the form or the endpoint, re-check at minimum:

- a valid address reveals the panel and starts the download
- an invalid address shows an error and does **not** reveal the download
- with the API blocked, the download is still delivered
