CREATE TABLE IF NOT EXISTS authors (
  author_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_score INTEGER NOT NULL DEFAULT 0,
  replacement_score INTEGER NOT NULL DEFAULT 0,
  suggestion_score INTEGER NOT NULL DEFAULT 0,
  inactive INTEGER NOT NULL DEFAULT 0,
  last_profile_checked_at INTEGER NOT NULL DEFAULT 0,
  last_suggestion_checked_at INTEGER NOT NULL DEFAULT 0,
  last_suggestion_found_at INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  card_id TEXT PRIMARY KEY,
  author TEXT,
  name TEXT,
  rank TEXT,
  image TEXT,
  image_url TEXT,
  anime_name TEXT,
  anime_link TEXT,
  first_seen_source TEXT,
  seen_in_suggestion INTEGER NOT NULL DEFAULT 0,
  seen_on_cards_page INTEGER NOT NULL DEFAULT 0,
  last_seen_suggestion_at INTEGER NOT NULL DEFAULT 0,
  last_seen_cards_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  card_id TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  author TEXT,
  checked_authors_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestions (
  card_id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  name TEXT,
  rank TEXT,
  image TEXT,
  image_url TEXT,
  anime_name TEXT,
  anime_link TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  detected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authors_suggestion_queue
  ON authors(inactive, suggestion_score, last_suggestion_checked_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status, type, updated_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_active_rank
  ON suggestions(active, rank, card_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at
  ON logs(created_at);
