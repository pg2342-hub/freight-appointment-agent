#!/usr/bin/env bash
# Staged rollout on Cloudflare Workers gradual deployments. CI runs it on every push to main:
#   release.sh upload             upload the new version with no traffic
#   release.sh stage 10 holdout   send 10% of traffic to it, then run the held-out gate pinned to it
#   release.sh stage 50 golive    50%, then the 25-thread gate
#   release.sh stage 100          all traffic
#   release.sh rollback           put the previous version back at 100% (CI runs it when a stage fails)
# Each stage is written to the releases table, which the page reads from /api/releases.
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, EVAL_TOKEN, ANTHROPIC_API_KEY (upload only).
set -euo pipefail
NAME=freight-appointment-agent
STATE=.release.env
[ -f "$STATE" ] && . "./$STATE"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-local}/actions/runs/${GITHUB_RUN_ID:-0}"

record() { # stage decision detail
  node -e '
    const q = (s) => `'"'"'${String(s).replaceAll("'"'"'", "'"'"''"'"'")}'"'"'`;
    const [v, id, stage, decision, detail, url] = process.argv.slice(1);
    console.log(`INSERT INTO releases (version, version_id, stage, at, decision, detail, run_url) VALUES (${q(v)}, ${q(id)}, ${Number(stage)}, datetime(${q("now")}), ${q(decision)}, ${q(detail)}, ${q(url)});`);
  ' "$LABEL" "$NEW_ID" "$1" "$2" "$3" "$RUN_URL" > .release.sql
  npx wrangler d1 execute "$NAME" --remote --file .release.sql >/dev/null
  echo "stage $1: $2 ($3)"
}

pinned() { curl -sf -H "Cloudflare-Workers-Version-Overrides: $NAME=\"$NEW_ID\"" "$@"; }

case "$1" in
upload)
  LABEL="v${GITHUB_RUN_NUMBER:-0}"
  OLD_ID=$(npx wrangler deployments status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const v=(d.versions||[]).sort((a,b)=>b.percentage-a.percentage)[0];console.log(v?v.version_id:"")})')
  node -e 'console.log(JSON.stringify({ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, EVAL_TOKEN: process.env.EVAL_TOKEN}))' > .secrets.json
  out=$(npx wrangler versions upload --tag "$(git rev-parse --short HEAD)" --message "$(git log -1 --format=%s | cut -c1-100)" --var "VERSION:$LABEL" --secrets-file .secrets.json)
  rm -f .secrets.json
  echo "$out" | grep -v -i secret
  NEW_ID=$(echo "$out" | grep -oE 'Worker Version ID: [0-9a-f-]+' | awk '{print $4}')
  sub=$(curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.subdomain))')
  # Page-only changes skip the model gates (they cost API credit); anything that can change the agent runs them.
  base=$(git rev-parse HEAD^ 2>/dev/null || echo "")
  changed=$( [ -n "$base" ] && git diff --name-only "$base" HEAD || echo "src/")
  if echo "$changed" | grep -qvE '^(public/|README\.md|scripts/build_page\.ts|gate/results/)'; then GATED=yes; else GATED=no; fi
  printf 'LABEL=%s\nOLD_ID=%s\nNEW_ID=%s\nURL=%s\nGATED=%s\n' "$LABEL" "$OLD_ID" "$NEW_ID" "https://$NAME.$sub.workers.dev" "$GATED" > "$STATE"
  [ -n "${GITHUB_ENV:-}" ] && cat "$STATE" >> "$GITHUB_ENV"
  LABEL=$LABEL NEW_ID=$NEW_ID record 0 uploaded "no traffic yet; previous version ${OLD_ID:0:8}"
  ;;
stage)
  pct=$2; suite=${3:-}
  if [ "$pct" = 100 ] || [ -z "$OLD_ID" ]; then
    npx wrangler versions deploy "$NEW_ID@100" -y --message "$LABEL at 100%" >/dev/null
  else
    npx wrangler versions deploy "$OLD_ID@$((100 - pct))" "$NEW_ID@$pct" -y --message "$LABEL at $pct%" >/dev/null
  fi
  ok=""
  for i in $(seq 1 20); do
    if pinned "$URL/api/health" | grep -q "\"version\":\"$LABEL\""; then ok=1; break; fi
    sleep 3
  done
  if [ -z "$ok" ]; then record "$pct" "NO-GO" "the new version did not answer its health check"; exit 1; fi
  if [ -z "$suite" ]; then record "$pct" "GO" "health check passed"; exit 0; fi
  if [ "$GATED" != yes ]; then record "$pct" "GO" "page-only change: health check passed, model gate skipped"; exit 0; fi
  sed "s|^agent_headers:|agent_headers:\n  Cloudflare-Workers-Version-Overrides: $NAME=\"$NEW_ID\"|" "gate/$suite.yml" > "gate/_stage.yml"
  set +e
  (cd gate && golive run _stage.yml --agent "$URL/eval" --runs 1 --out "../reports/stage$pct")
  code=$?
  set -e
  detail=$(node -e '
    const r = require(process.argv[1]); const b = r.summary.by_run[0];
    const name = process.argv[2] === "holdout" ? "held-out gate" : "25-thread gate";
    console.log(`${name}: ${b.passed} of ${b.total}, ${b.critical} critical, $${r.summary.total_cost_usd.toFixed(2)}`);
  ' "$PWD/reports/stage$pct/results.json" "$suite")
  if [ $code -eq 0 ]; then record "$pct" "GO" "$detail"; else record "$pct" "NO-GO" "$detail"; exit 1; fi
  ;;
rollback)
  if [ -n "${OLD_ID:-}" ]; then
    npx wrangler versions deploy "$OLD_ID@100" -y --message "roll back $LABEL" >/dev/null
    record 0 "rolled back" "previous version ${OLD_ID:0:8} back at 100%"
  fi
  ;;
esac
