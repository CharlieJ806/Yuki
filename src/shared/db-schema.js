/**
 * SQLite 建表语句 —— 数据层的单一事实来源。
 *
 * Electron（src/main/store.js，node:sqlite）与 Tauri（渲染层 store-bridge，
 * 经 IPC 走 rusqlite）共用同一份 schema，保证两条运行时写出的库完全一致。
 * 纯字符串、零依赖，手机端不会 import 它。
 *
 * 同步友好设计：每张业务表都带 id / updatedAt / deletedAt / syncState，
 * 云端同步只需按 updatedAt 做增量推拉，不需要改表结构。
 *
 * 版本迁移：CREATE TABLE IF NOT EXISTS 对已存在的旧表零作用，结构性变更
 * 必须走迁移段。SCHEMA_VERSION 递增时，两后端（store.js / store-bridge.js）
 * 按 ensureSchema 的同一套逻辑推进 user_version；迁移段的执行条件写在
 * 各自的检测代码里（按 sqlite_master 的实际 DDL 判断，天然幂等）。
 */
export const SCHEMA_VERSION = 2

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  syncState TEXT NOT NULL DEFAULT 'local'
);

/*
 * dateKey 不做列级 UNIQUE（v2 起）：列级唯一约束不排软删行，一旦出现
 * 「删卡」，该日期会被死行永久占住无法再打卡。改用 partial unique index
 * 只约束未删除的行。
 */
CREATE TABLE IF NOT EXISTS checkins (
  id        TEXT PRIMARY KEY,
  dateKey   TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  note      TEXT,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(dateKey);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_date_live ON checkins(dateKey) WHERE deletedAt IS NULL;

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

/*
 * v1→v2：把老库 checkins 的列级 UNIQUE 重建为 partial unique index。
 * 执行前提：调用方已从 sqlite_master 检测到 checkins 的建表 DDL 仍含
 * 列级 UNIQUE（新库的 DDL 没有，天然跳过）。整段无参，走 execute_batch 原子执行。
 */
export const MIGRATE_CHECKINS_V2 = `
CREATE TABLE checkins_v2 (
  id        TEXT PRIMARY KEY,
  dateKey   TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  note      TEXT,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER,
  syncState TEXT NOT NULL DEFAULT 'local'
);
INSERT INTO checkins_v2 (id, dateKey, createdAt, note, updatedAt, deletedAt, syncState)
  SELECT id, dateKey, createdAt, note, updatedAt, deletedAt, syncState FROM checkins;
DROP TABLE checkins;
ALTER TABLE checkins_v2 RENAME TO checkins;
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(dateKey);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_date_live ON checkins(dateKey) WHERE deletedAt IS NULL;
`

/* 老库检测：checkins 建表 DDL 里 dateKey 列带 UNIQUE 即 v1 形态（新库该列无 UNIQUE，
   partial index 是独立的 index 条目，不会命中 type='table' 的检测） */
export const CHECKINS_DDL_DETECT = "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'checkins'"
