# Deploying josephcalitoy.com

The site is a static site on **Cloudflare Pages**, deployed **automatically on
push to `main`**. Merge or push to `main` and Cloudflare builds and publishes.

Check a deploy: https://dash.cloudflare.com -> Pages -> josephcalitoy -> Deployments.
A healthy deploy shows trigger `github:push` and the commit hash you pushed.

## History: why this used to be a direct upload

Auto-deploy silently did nothing until 2026-08-09. The project's GitHub source
was wired correctly, but its **build configuration was empty** — no
`build_command`, no `destination_dir`, no `root_dir` — so a push had no build
to run and the project no-opped. Every deployment before `4416bc4` was an
`ad_hoc` direct upload.

The fix was to set an explicit (empty) static build config:

```
build_command   = ""      # static site, nothing to compile
destination_dir = ""      # serve from the repository root
root_dir        = ""
```

If pushes ever stop deploying again, check that build config first — an empty
`build_config` object is the failure signature, not a permissions error.

## Manual deploy (fallback only)

Auto-deploy is the normal path. Use this only if Pages is down or you need to
ship without a commit:

```sh
npx wrangler pages deploy . --project-name=josephcalitoy --branch=main
```

## Bindings

`wrangler.toml` declares the KV namespace that `functions/api/subscribe.js`
writes leads to. Pages reads it on git builds, so it does not need to be set
in the dashboard:

```
[[kv_namespaces]]
binding = "LEADS"
id      = "1aeb9d7e34f14399a7ebf4d2b59cfcb9"   # josephcalitoy-leads
```

## Verify after deploying

```sh
curl -sI https://josephcalitoy.com | grep -i cf-ray
curl -s https://josephcalitoy.com/ | grep -c 'calitoy-favicon'  # expect 1
curl -s https://josephcalitoy.com/api/subscribe                 # expect 405 JSON
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
