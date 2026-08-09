#!/usr/bin/env bash
# Export captured leads from the Cloudflare KV namespace to CSV.
#
#   ./scripts/export-leads.sh                     # all leads -> stdout
#   ./scripts/export-leads.sh > leads.csv         # save to a file
#   SOURCE=mobile-ua-ai-ecosystems ./scripts/export-leads.sh
#
# Requires: npx wrangler login.
#
# NOTE: --remote is mandatory on every kv call. Without it Wrangler reads the
# LOCAL simulator state and cheerfully reports "no leads found" while your real
# list sits untouched in the cloud. This cost a debugging session once.
set -euo pipefail

# Defaults to the josephcalitoy-leads namespace; override via the environment.
KV_NAMESPACE_ID="${KV_NAMESPACE_ID:-1aeb9d7e34f14399a7ebf4d2b59cfcb9}"
SOURCE="${SOURCE:-}"

PREFIX="lead:"
[[ -n "$SOURCE" ]] && PREFIX="lead:${SOURCE}:"

keys="$(npx wrangler kv key list --namespace-id "$KV_NAMESPACE_ID" --remote --prefix "$PREFIX")"
count="$(echo "$keys" | jq 'length')"

if [[ "$count" == "0" ]]; then
  echo "No leads found for prefix '${PREFIX}'." >&2
  exit 0
fi

echo "email,source,captured_at,country"
echo "$keys" | jq -r '.[].name' | while read -r key; do
  npx wrangler kv key get --namespace-id "$KV_NAMESPACE_ID" --remote "$key" 2>/dev/null \
    | jq -r '[.email, .source, .at, (.country // "")] | @csv'
done

echo "Exported ${count} lead(s)." >&2
