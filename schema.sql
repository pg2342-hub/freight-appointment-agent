-- Live data for the freight appointment agent (Cloudflare D1).
CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (thread_id TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sender TEXT,
  version TEXT NOT NULL, messages TEXT NOT NULL, cost_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS turns (
  conversation_id TEXT NOT NULL, turn INTEGER NOT NULL, created_at TEXT NOT NULL, version TEXT NOT NULL,
  user_text TEXT NOT NULL, reply TEXT NOT NULL, stopped TEXT NOT NULL, steps TEXT NOT NULL, cost_usd REAL NOT NULL, ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, turn)
);
CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL NOT NULL);
