// Writes seed.sql: resets the demo world and clears bookings. Run: node scripts/seed_sql.mjs > seed.sql
import { readFileSync } from "node:fs";
const doc = JSON.stringify(JSON.parse(readFileSync(new URL("../seed/world.json", import.meta.url))));
const q = (s) => `'${s.replaceAll("'", "''")}'`;
console.log(`DELETE FROM events;\nINSERT OR REPLACE INTO world (id, doc, updated_at) VALUES (1, ${q(doc)}, datetime('now'));`);
