#!/usr/bin/env bash
# Finds (or creates) the D1 database, writes its id into wrangler.toml, applies the schema,
# and seeds the world when it is empty or seed/world.json has a new version. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail
NAME=freight-appointment-agent
id=$(npx wrangler d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(d?d.uuid:"")})' "$NAME")
if [ -z "$id" ]; then
  npx wrangler d1 create "$NAME" >/dev/null
  id=$(npx wrangler d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(x=>x.name===process.argv[1]).uuid))' "$NAME")
fi
sed -i "s/^database_id = .*/database_id = \"$id\"/" wrangler.toml
npx wrangler d1 execute "$NAME" --remote --file schema.sql
n=$(npx wrangler d1 execute "$NAME" --remote --json --command "SELECT count(*) AS n FROM world" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].n))')
want=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("seed/world.json")).version||1)')
have=$(npx wrangler d1 execute "$NAME" --remote --json --command "SELECT coalesce(json_extract(doc,'$.version'),1) AS v FROM world WHERE id=1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s)[0].results;console.log(r.length?r[0].v:0)})')
if [ "$n" = "0" ] || [ "$have" != "$want" ]; then node scripts/seed_sql.mjs > seed.sql && npx wrangler d1 execute "$NAME" --remote --file seed.sql; fi
echo "D1 $id ready (world rows before seeding: $n)"
