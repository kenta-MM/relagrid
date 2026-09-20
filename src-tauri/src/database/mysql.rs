use super::mysql_sql;
use crate::models::{Column, ConnectionConfig, Preview, Relationship, SchemaSnapshot, Table};
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPoolOptions},
    MySqlPool, Row,
};
use std::collections::{HashMap, HashSet};
use std::time::Duration;

pub async fn connect(config: &ConnectionConfig) -> Result<MySqlPool, String> {
    if config.host.trim().is_empty()
        || config.database.trim().is_empty()
        || config.username.is_empty()
    {
        return Err("ホスト、データベース名、ユーザー名を入力してください。".into());
    }
    let options = MySqlConnectOptions::new()
        .host(&config.host)
        .port(config.port)
        .username(&config.username)
        .password(&config.password)
        .database(&config.database);
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
            estimated_rows: row.try_get::<u64, _>("ROW_COUNT").map_err(db_error)?,
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
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires isolated MySQL fixture on 127.0.0.1:3307; see README"]
    fn mysql_fixture_schema_preview_and_read_only() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let config = ConnectionConfig {
                    host: "127.0.0.1".into(),
                    port: 3307,
                    username: "root".into(),
                    password: String::new(),
                    database: "relagrid_fixture".into(),
                    read_only: true,
                };
                let pool = connect(&config).await.expect("fixture connection");
                let snapshot = schema(&pool, &config.database).await.expect("schema");
                assert_eq!(snapshot.tables.len(), 2);
                assert_eq!(snapshot.relationships.len(), 1);
                let order = snapshot
                    .tables
                    .iter()
                    .find(|t| t.name.eq_ignore_ascii_case("Order"))
                    .unwrap();
                let result = preview(&pool, order).await.expect("preview");
                assert_eq!(result.rows.len(), 1);
                assert_eq!(result.rows[0][0].as_deref(), Some("1052"));
                assert_eq!(result.rows[0][2].as_deref(), Some("1234.50"));
                assert_eq!(result.rows[0][3], None);
                assert_eq!(result.rows[0][4].as_deref(), Some("00FF"));
                let customer = snapshot
                    .tables
                    .iter()
                    .find(|t| t.name.eq_ignore_ascii_case("Customer"))
                    .unwrap();
                assert_eq!(
                    preview(&pool, customer).await.unwrap().rows[0][1].as_deref(),
                    Some("青木")
                );
                let write =
                    sqlx::query("UPDATE Customer SET name='should not write' WHERE customer_id=1")
                        .execute(&pool)
                        .await;
                assert!(write.is_err(), "read-only session must reject writes");
                let result = crate::database::query::execute(
                    &pool,
                    "SELECT 1234.50 AS amount, NULL AS memo, X'00FF' AS payload, '青木' AS name",
                    true,
                    false,
                )
                .await
                .unwrap();
                assert_eq!(result.columns, ["amount", "memo", "payload", "name"]);
                assert_eq!(
                    result.rows[0],
                    [
                        Some("1234.50".into()),
                        None,
                        Some("00FF".into()),
                        Some("青木".into())
                    ]
                );
                let empty = crate::database::query::execute(
                    &pool,
                    "SELECT * FROM Customer WHERE 1=0",
                    true,
                    false,
                )
                .await
                .unwrap();
                assert!(empty.rows.is_empty());
                assert_eq!(empty.columns.len(), 3);
                assert!(crate::database::query::execute(
                    &pool,
                    "UPDATE Customer SET name=name WHERE customer_id=1",
                    true,
                    false
                )
                .await
                .is_err());
                pool.close().await;
                let writable = connect(&ConnectionConfig {
                    read_only: false,
                    ..config
                })
                .await
                .unwrap();
                let update = crate::database::query::execute(
                    &writable,
                    "UPDATE Customer SET name=name WHERE customer_id=1",
                    false,
                    false,
                )
                .await
                .unwrap();
                assert_eq!(update.affected_rows, 1);
                let plan = crate::database::query::execute(
                    &writable,
                    "SELECT * FROM Customer",
                    false,
                    true,
                )
                .await
                .unwrap();
                assert!(!plan.rows.is_empty());
                writable.close().await;
            });
    }
}
