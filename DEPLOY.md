# Deploying josephcalitoy.com

The site is a static site hosted on **Cloudflare Pages** and deployed by
**direct upload** with Wrangler. It is NOT deployed by pushing to GitHub.

That distinction matters: `git push` updates the source of truth only. Until
someone runs the deploy below, github.com/JoS727/josephcalitoy and the live
site will drift apart.

## One-time setup

Authenticate Wrangler against the Cloudflare account that owns the Pages
project (browser OAuth flow):

```sh
npx wrangler login
```

Confirm the account and find the Pages project name:

```sh
npx wrangler whoami
npx wrangler pages project list
```

## Deploy

From the repository root:

```sh
npx wrangler pages deploy . --project-name=<project> --branch=main
```

Preview first (recommended) by deploying to a non-production branch:

```sh
npx wrangler pages deploy . --project-name=<project> --branch=preview
```

Wrangler prints a preview URL. Check it before promoting to production.

## Verify after deploying

```sh
curl -sI https://josephcalitoy.com | grep -i cf-ray
curl -s https://josephcalitoy.com/ | grep -c 'cdn-cgi'          # expect 0
curl -s https://josephcalitoy.com/ | grep -c 'calitoy-favicon'  # expect 1
```

## Known trap: Cloudflare email obfuscation

Cloudflare rewrites plain email addresses in served HTML into
`/cdn-cgi/l/email-protection` links and injects an `email-decode.min.js`
script. That is a serving-time transform — it must never be saved back into
the repository.

If you rebuild a page by scraping the live site, strip these first:

- `href="/cdn-cgi/l/email-protection#..."` -> the real `mailto:` link
- `<a class="__cf_email__" data-cfemail="...">[email protected]</a>` -> the
  real address text
- the trailing `<script ... email-decode.min.js></script>` tag

This exact bug shipped into a rebuild once and was caught before commit.
