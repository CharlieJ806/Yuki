//! rusqlite 桥 —— 渲染层业务（store-bridge.js）经 IPC 读写 SQLite 的唯一通道。
//!
//! 设计约束（TAURI_MIGRATION.md §2.2 / §6）：
//! - **DB 路径显式复用** `%APPDATA%\desk-pet\desk-pet.db`，与 Electron 版共用
//!   同一文件（Tauri 默认 app_data_dir 随 identifier 变化，会让老用户数据「消失」）。
//! - Rust 不懂业务：只执行 JS 给来的 SQL。schema 的单一来源是
//!   `src/shared/db-schema.js`，由 JS 侧建表；本模块只负责打开连接与 PRAGMA。
//! - `Mutex<Connection>` 串行化：JS 宿主（pet 窗）单线程顺序调用，天然单写者。
//! - 传入参数仅支持标量（null/bool/数字/字符串）。业务层一律 JSON.stringify
//!   后存 TEXT，对象参数到这里就是用法错误，直接报错暴露。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value as Json};

struct ConnState {
    conn: Connection,
}

/// 可克隆的连接句柄；每个 command 克隆 Arc 进 spawn_blocking。
#[derive(Clone)]
pub struct Db(Arc<Mutex<ConnState>>);

/// 显式 DB 路径：%APPDATA%\desk-pet\desk-pet.db（见模块注释）。
pub fn default_db_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
    base.join("desk-pet").join("desk-pet.db")
}

pub fn open_at(path: &Path) -> Result<Db, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建数据库目录失败: {e}"))?;
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("打开数据库失败: {e}"))?;
    /* 与 store.js（Electron/Node 版）完全一致的 PRAGMA */
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("设置 PRAGMA 失败: {e}"))?;
    Ok(Db(Arc::new(Mutex::new(ConnState { conn }))))
}

/* ---------- JSON ↔ SQLite 值转换 ---------- */

fn json_to_sql(v: &Json) -> Result<SqlValue, String> {
    Ok(match v {
        Json::Null => SqlValue::Null,
        Json::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                return Err(format!("不支持的数字参数: {n}"));
            }
        }
        Json::String(s) => SqlValue::Text(s.clone()),
        other => return Err(format!("不支持的参数类型（业务对象应序列化为字符串）: {other}")),
    })
}

fn sql_to_json(v: rusqlite::types::ValueRef<'_>) -> Json {
    use rusqlite::types::ValueRef as V;
    match v {
        V::Null => Json::Null,
        V::Integer(i) => Json::from(i),
        V::Real(f) => Json::from(f),
        V::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        /* 本项目没有 BLOB 列；真出现时给字节数组而不是静默损坏 */
        V::Blob(b) => Json::Array(b.iter().map(|x| Json::from(*x)).collect()),
    }
}

fn params_to_sql(params: Option<Vec<Json>>) -> Result<Vec<SqlValue>, String> {
    params
        .unwrap_or_default()
        .iter()
        .map(json_to_sql)
        .collect::<Result<Vec<_>, String>>()
}

/* ---------- 命令实现 ---------- */

impl Db {
    pub fn exec_raw(&self, sql: &str, params: Vec<SqlValue>) -> Result<(), String> {
        let st = self.0.lock().map_err(|_| "数据库连接锁中毒".to_string())?;
        /* 无参 SQL 允许多语句（store-bridge 首次建表的 SCHEMA 就是一整段）；
           rusqlite 的 execute 只收单条，带参写语句必然是单条 */
        if params.is_empty() {
            return st.conn.execute_batch(sql).map_err(|e| e.to_string());
        }
        let mut stmt = st.conn.prepare_cached(sql).map_err(|e| e.to_string())?;
        stmt.execute(rusqlite::params_from_iter(params))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn select_raw(&self, sql: &str, params: Vec<SqlValue>) -> Result<Vec<Json>, String> {
        let st = self.0.lock().map_err(|_| "数据库连接锁中毒")?;
        let mut stmt = st.conn.prepare_cached(sql).map_err(|e| e.to_string())?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let mut rows = stmt.query(refs.as_slice()).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut obj = Map::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                let v = row.get_ref(i).map_err(|e| e.to_string())?;
                obj.insert(name.clone(), sql_to_json(v));
            }
            out.push(Json::Object(obj));
        }
        Ok(out)
    }

}

/// `db:exec` —— 写语句（INSERT/UPDATE/DELETE/DDL/PRAGMA）。
#[tauri::command]
pub async fn db_exec(db: tauri::State<'_, Db>, sql: String, params: Option<Vec<Json>>) -> Result<(), String> {
    let db = db.inner().clone();
    let p = params_to_sql(params)?;
    tauri::async_runtime::spawn_blocking(move || db.exec_raw(&sql, p))
        .await
        .map_err(|e| format!("执行任务失败: {e}"))?
}

/// `db:select` —— 查询，行以对象数组返回。
#[tauri::command]
pub async fn db_select(db: tauri::State<'_, Db>, sql: String, params: Option<Vec<Json>>) -> Result<Vec<Json>, String> {
    let db = db.inner().clone();
    let p = params_to_sql(params)?;
    tauri::async_runtime::spawn_blocking(move || db.select_raw(&sql, p))
        .await
        .map_err(|e| format!("执行任务失败: {e}"))?
}

/* ---------- Rust 侧直用的 meta 读写（petPosition 持久化等） ---------- */

pub fn meta_get(db: &Db, key: &str) -> Option<Json> {
    let st = db.0.lock().ok()?;
    let v: String = st
        .conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .ok()?;
    serde_json::from_str(&v).ok()
}

/// 读 settings 表的单项（JSON 值）。settings 表由 JS 侧建表并写入；
/// Electron 时代就存在的库此表必然存在，查不到或表未建返回 None。
pub fn settings_get(db: &Db, key: &str) -> Option<Json> {
    let st = db.0.lock().ok()?;
    let v: String = st
        .conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .ok()?;
    serde_json::from_str(&v).ok()
}

pub fn meta_set(db: &Db, key: &str, value: &Json) {
    let Ok(st) = db.0.lock() else { return };
    let text = value.to_string();
    let _ = st.conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, text.as_str()],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db() -> Db {
        let mut p = std::env::temp_dir();
        p.push(format!("desk-pet-dbtest-{}-{}.db", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let _ = std::fs::remove_file(&p);
        open_at(&p).expect("open")
    }

    #[test]
    fn exec_and_select_roundtrip() {
        let db = temp_db();
        db.exec_raw("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)", vec![]).unwrap();
        db.exec_raw(
            "INSERT INTO t (id, name, score) VALUES (?1, ?2, ?3)",
            vec![json!(1), json!("猫猫"), json!(3.5)]
                .into_iter()
                .map(|v| json_to_sql(&v).unwrap())
                .collect(),
        )
        .unwrap();
        let rows = db.select_raw("SELECT * FROM t WHERE id = ?1", vec![json_to_sql(&json!(1)).unwrap()]).unwrap();
        assert_eq!(rows.len(), 1);
        let row = rows[0].as_object().unwrap();
        assert_eq!(row["name"], json!("猫猫"));
        assert_eq!(row["score"], json!(3.5));
        assert_eq!(row["id"], json!(1));
    }

    #[test]
    fn select_param_types_and_empty_result() {
        let db = temp_db();
        db.exec_raw("CREATE TABLE t (k TEXT, v INTEGER)", vec![]).unwrap();
        db.exec_raw("INSERT INTO t VALUES ('a', 1)", vec![]).unwrap();
        let rows = db.select_raw("SELECT * FROM t WHERE k = ?1", vec![json_to_sql(&json!("zzz")).unwrap()]).unwrap();
        assert!(rows.is_empty());
        /* null 参数 */
        let rows = db.select_raw("SELECT * FROM t WHERE ?1 IS NULL", vec![json_to_sql(&Json::Null).unwrap()]).unwrap();
        assert_eq!(rows.len(), 1);
        /* bool 参数按 Integer 落库 */
        let rows = db.select_raw("SELECT ?1 AS v", vec![json_to_sql(&json!(true)).unwrap()]).unwrap();
        assert_eq!(rows[0]["v"], json!(1));
    }

    #[test]
    fn meta_roundtrip() {
        let db = temp_db();
        db.exec_raw("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)", vec![]).unwrap();
        assert_eq!(meta_get(&db, "petPosition"), None);
        meta_set(&db, "petPosition", &json!({"x": 10.0, "y": -3}));
        assert_eq!(meta_get(&db, "petPosition"), Some(json!({"x": 10.0, "y": -3})));
        meta_set(&db, "petPosition", &json!({"x": 99.0, "y": 1}));
        assert_eq!(meta_get(&db, "petPosition"), Some(json!({"x": 99.0, "y": 1})));
    }
}
