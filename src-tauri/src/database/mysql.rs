use super::mysql_sql;
use crate::models::{Column, ConnectionConfig, Preview, Relationship, SchemaSnapshot, Table};
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode},
    MySqlPool, Row,
};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

#[cfg(test)]
#[path = "tls_tests.rs"]
mod tls_tests;

fn connection_options(config: &ConnectionConfig) -> Result<MySqlConnectOptions, String> {
    if config.host.trim().is_empty()
        || config.database.trim().is_empty()
        || config.username.is_empty()
    {
        return Err("ホスト、データベース名、ユーザー名を入力してください。".into());
    }
    let mut options = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .username(&config.username)
        .password(&config.password)
        .database(&config.database)
        .ssl_mode(if config.tls_enabled.unwrap_or(false) {
            MySqlSslMode::VerifyIdentity
        } else {
            MySqlSslMode::Disabled
        });
    if let Some(pem) = config
        .tls_ca_pem
        .as_deref()
        .filter(|pem| config.tls_enabled.unwrap_or(false) && !pem.trim().is_empty())
    {
        if pem.len() > 64 * 1024
            || !pem.contains("-----BEGIN CERTIFICATE-----")
            || pem.contains("PRIVATE KEY")
        {
            return Err(
                "信頼するCAには64KB以下のPEM証明書を指定してください。秘密鍵は指定できません。"
                    .into(),
            );
        }
        options = options.ssl_ca_from_pem(pem.as_bytes().to_vec());
    }
    Ok(options)
}

pub async fn connect(config: &ConnectionConfig) -> Result<MySqlPool, String> {
    let options = connection_options(config)?;
    let read_only = config.read_only;
    MySqlPoolOptions::new()
        .max_connections(3)
        .acquire_timeout(Duration::from_secs(8))
        .after_connect(move |connection, _| {
            Box::pin(async move {
                sqlx::query(if read_only {
                    "SET SESSION TRANSACTION READ ONLY"
                } else {
                    "SET SESSION TRANSACTION READ WRITE"
                })
                .execute(&mut *connection)
                .await?;
                sqlx::query("SET SESSION MAX_EXECUTION_TIME=5000")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(|error| format!("MySQLに接続できませんでした: {error}"))
}

pub async fn schema(pool: &MySqlPool, database: &str) -> Result<SchemaSnapshot, String> {
    let table_rows = sqlx::query(mysql_sql::TABLES)
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    let column_rows = sqlx::query(mysql_sql::COLUMNS)
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    let mut columns_by_table: HashMap<String, Vec<Column>> = HashMap::new();
    for column in column_rows {
        let table_name: String = column.try_get("TABLE_NAME").map_err(db_error)?;
        columns_by_table
            .entry(table_name)
            .or_default()
            .push(Column {
                name: column.try_get("COLUMN_NAME").map_err(db_error)?,
                data_type: column.try_get("COLUMN_TYPE").map_err(db_error)?,
                nullable: column
                    .try_get::<String, _>("IS_NULLABLE")
                    .map_err(db_error)?
                    == "YES",
                primary_key: column
                    .try_get::<String, _>("COLUMN_KEY")
                    .map_err(db_error)?
                    == "PRI",
            });
    }
    let mut tables = Vec::with_capacity(table_rows.len());
    for row in table_rows {
        let name: String = row.try_get("TABLE_NAME").map_err(db_error)?;
        tables.push(Table {
            id: format!("{database}.{name}"),
            schema: database.into(),
            columns: columns_by_table.remove(&name).unwrap_or_default(),
            name,
            estimated_rows: None,
        });
    }
    let table_ids: HashSet<_> = tables.iter().map(|table| table.id.as_str()).collect();
    let foreign_keys = sqlx::query(mysql_sql::RELATIONSHIPS)
        .bind(database)
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    let mut relationships = Vec::new();
    for row in foreign_keys {
        let source: String = row.try_get("TABLE_NAME").map_err(db_error)?;
        let target: String = row.try_get("REFERENCED_TABLE_NAME").map_err(db_error)?;
        let constraint: String = row.try_get("CONSTRAINT_NAME").map_err(db_error)?;
        let ordinal: u64 = row.try_get("ORDINAL_POSITION").map_err(db_error)?;
        let source_table = format!("{database}.{source}");
        let target_table = format!("{database}.{target}");
        if !table_ids.contains(source_table.as_str()) || !table_ids.contains(target_table.as_str())
        {
            continue;
        }
        relationships.push(Relationship {
            id: format!("{source}.{constraint}.{ordinal}"),
            source_table,
            target_table,
            source_column: row.try_get("COLUMN_NAME").map_err(db_error)?,
            target_column: row.try_get("REFERENCED_COLUMN_NAME").map_err(db_error)?,
        });
    }
    Ok(SchemaSnapshot {
        session_id: None,
        tables,
        relationships,
    })
}

pub async fn preview(pool: &MySqlPool, table: &Table) -> Result<Preview, String> {
    let query = mysql_sql::preview_query(table);
    let result = sqlx::query(&query)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    let rows = result
        .iter()
        .map(|row| {
            (0..table.columns.len())
                .map(|index| row.try_get::<Option<String>, _>(index).map_err(db_error))
                .collect()
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Preview {
        columns: table.columns.iter().map(|c| c.name.clone()).collect(),
        rows,
    })
}

fn db_error(error: sqlx::Error) -> String {
    format!("データベースの読み取りに失敗しました: {error}")
}

#[cfg(test)]
#[path = "mysql_integration_tests.rs"]
mod integration_tests;
