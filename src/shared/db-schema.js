/**
 * SQLite 建表语句 —— 数据层的单一事实来源。
 *
 * Electron（src/main/store.js，node:sqlite）与 Tauri（渲染层 store-bridge，
 * 经 IPC 走 rusqlite）共用同一份 schema，保证两条运行时写出的库完全一致。
 * 纯字符串、零依赖，手机端不会 import 它。
 *
 * 同步友好设计：每张业务表都带 id / updatedAt / deletedAt / syncState，
 * 云端同步只需按 updatedAt 做增量推拉，不需要改表结构。
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  syncState TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS checkins (
  id        TEXT PRIMARY KEY,
  dateKey   TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  note      TEXT,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(dateKey);

CREATE TABLE IF NOT EXISTS worklogs (
  id        TEXT PRIMARY KEY,
  dateKey   TEXT NOT NULL,
  minutes   INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_worklogs_date ON worklogs(dateKey);

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  payload   TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, createdAt);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/*
 * 自定义人设：内置人设写死在 CHAT_PERSONAS，这里只存用户自建的。
 * sortOrder 决定展示顺序，内置的排在前面。
 */
CREATE TABLE IF NOT EXISTS personas (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  prompt    TEXT NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updatedAt DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id        TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  role      TEXT NOT NULL,
  content   TEXT NOT NULL,
  model     TEXT,
  error     INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local',
  FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(sessionId, createdAt);
`
