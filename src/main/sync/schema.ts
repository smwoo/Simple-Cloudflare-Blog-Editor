/**
 * The shared database: what every computer connected to a blog reads and writes.
 *
 * Timestamps come from the database clock (`NOW_MS`), never a computer's, so a
 * laptop with the wrong time cannot hide its changes from the others.
 */
export const SCHEMA_VERSION = 1

export const NOW_MS = `(CAST(strftime('%s','now') AS INTEGER) * 1000)`

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS blog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  site_url TEXT NOT NULL,
  custom_domain TEXT,
  site_password TEXT,
  bucket TEXT NOT NULL,
  r2_access_key_id TEXT NOT NULL,
  r2_secret TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 1,
  markdown TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS posts_updated ON posts(updated_at);
CREATE TABLE IF NOT EXISTS post_versions (
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  machine_id TEXT,
  PRIMARY KEY (slug, version)
);
CREATE TABLE IF NOT EXISTS assets (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  post_slug TEXT NOT NULL,
  grp TEXT NOT NULL,
  state TEXT NOT NULL,
  bytes_output INTEGER,
  width INTEGER,
  height INTEGER,
  duration_sec REAL,
  has_poster INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  origin_machine TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS assets_updated ON assets(updated_at);
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT,
  app_version TEXT,
  last_seen INTEGER NOT NULL
);
`
