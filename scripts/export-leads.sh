#!/usr/bin/env bash
# Export captured leads from the Cloudflare KV namespace to CSV.
#
#   ./scripts/export-leads.sh                     # all leads -> stdout
#   ./scripts/export-leads.sh > leads.csv         # save to a file
#   SOURCE=mobile-ua-ai-ecosystems ./scripts/export-leads.sh
#
# Requires: npx wrangler login, and KV_NAMESPACE_ID set below or in the env.
set -euo pipefail

KV_NAMESPACE_ID="${KV_NAMESPACE_ID:-}"
SOURCE="${SOURCE:-}"

if [[ -z "$KV_NAMESPACE_ID" ]]; then
  echo "KV_NAMESPACE_ID is not set." >&2
  echo "Find it with: npx wrangler kv namespace list" >&2
  exit 1
fi

PREFIX="lead:"
[[ -n "$SOURCE" ]] && PREFIX="lead:${SOURCE}:"

keys="$(npx wrangler kv key list --namespace-id "$KV_NAMESPACE_ID" --prefix "$PREFIX")"
count="$(echo "$keys" | jq 'length')"

if [[ "$count" == "0" ]]; then
  echo "No leads found for prefix '${PREFIX}'." >&2
  exit 0
fi

echo "email,source,captured_at,country"
echo "$keys" | jq -r '.[].name' | while read -r key; do
  npx wrangler kv key get --namespace-id "$KV_NAMESPACE_ID" "$key" 2>/dev/null \
    | jq -r '[.email, .source, .at, (.country // "")] | @csv'
done

echo "Exported ${count} lead(s)." >&2
