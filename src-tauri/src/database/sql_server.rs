//! SQL Server adapter. Each operation owns its socket, so cancellation never returns
//! a partially consumed TDS stream to another operation.
use crate::models::{
    Column, ConnectionConfig, Preview, QueryResult, QueryResultSet, Relationship, SchemaSnapshot,
    Table,
};
use futures_util::TryStreamExt;
use sqlparser::{
    ast::{visit_relations, visit_statements, Statement},
    dialect::MsSqlDialect,
    parser::Parser,
    tokenizer::{Token, Tokenizer},
};
use std::{
    collections::HashMap,
    ops::ControlFlow,
    time::{Duration, Instant},
};
use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel, QueryItem, Row};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type SqlClient = Client<Compat<TcpStream>>;
fn error(e: impl std::fmt::Display) -> String {
    format!("SQL Server: {e}")
}

pub async fn connect(config: &ConnectionConfig) -> Result<SqlClient, String> {
    if config.host.trim().is_empty()
        || config.port == 0
        || config.database.trim().is_empty()
        || config.username.trim().is_empty()
    {
        return Err("ホスト・ポート・データベース名・ユーザー名を指定してください。".into());
    }
    if config.host.contains('\\') {
        return Err("名前付きインスタンスはホストとTCPポートで指定してください。".into());
    }
    let mut options = Config::new();
    options.host(&config.host);
    options.port(config.port);
    options.database(&config.database);
    options.authentication(AuthMethod::sql_server(&config.username, &config.password));
    options.application_name("RelaGrid");
    options.encryption(if config.tls_enabled == Some(true) {
        EncryptionLevel::Required
    } else {
        EncryptionLevel::NotSupported
    });
    if config.tls_enabled == Some(true) {
        if let Some(ca) = config
            .tls_ca_pem
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            if ca.len() > 65536
                || !ca.contains("-----BEGIN CERTIFICATE-----")
                || ca.contains("PRIVATE KEY")
            {
                return Err(
                    "信頼するCAには64KB以下のPEM証明書を指定してください。秘密鍵は指定できません。"
                        .into(),
                );
            }
            options.trust_cert_ca_bundle(ca.as_bytes().to_vec());
        }
    }
    tokio::time::timeout(Duration::from_secs(8), async {
        let tcp = TcpStream::connect((config.host.as_str(), config.port))
            .await
            .map_err(error)?;
        tcp.set_nodelay(true).map_err(error)?;
        let mut client = Client::connect(options, tcp.compat_write())
            .await
            .map_err(error)?;
        client
            .simple_query("SET LOCK_TIMEOUT 5000; SET QUOTED_IDENTIFIER ON; SET IMPLICIT_TRANSACTIONS OFF; SET NOCOUNT OFF;")
            .await
            .map_err(error)?
            .into_results()
            .await
            .map_err(error)?;
        Ok(client)
    })
    .await
    .map_err(|_| "SQL Serverへの接続が8秒を超えました。".to_owned())?
}

pub fn quote(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}
fn table_id(schema: &str, name: &str) -> String {
    format!("{}.{}", quote(schema), quote(name))
}

pub async fn schema(config: &ConnectionConfig) -> Result<SchemaSnapshot, String> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut client = connect(config).await?;
        let rows = client.simple_query(r#"
SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name,
 ty.name AS type_name, c.max_length, c.precision, c.scale, c.is_nullable,
 CAST(CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic
 ON ic.object_id=i.object_id AND ic.index_id=i.index_id
 WHERE i.object_id=t.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id) THEN 1 ELSE 0 END AS bit) AS is_pk
FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id
WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name,c.column_id;
"#).await.map_err(error)?.into_first_result().await.map_err(error)?;
        let mut tables: Vec<Table> = Vec::new();
        let mut positions = HashMap::new();
        for row in rows {
            let schema: &str = required(&row, "schema_name")?;
            let name: &str = required(&row, "table_name")?;
            let id = table_id(schema, name);
            let index = *positions.entry(id.clone()).or_insert_with(|| {
                tables.push(Table { id, schema: schema.into(), name: name.into(), estimated_rows: None, columns: vec![] });
                tables.len()-1
            });
            let ty: &str = required(&row, "type_name")?;
            let length: i16 = row.get("max_length").ok_or("Missing column length")?;
            let precision: u8 = row.get("precision").ok_or("Missing precision")?;
            let scale: u8 = row.get("scale").ok_or("Missing scale")?;
            let data_type = match ty {
                "nvarchar" | "nchar" | "varchar" | "char" | "varbinary" | "binary" => format!("{ty}({})", if length == -1 { "max".into() } else { (if ty.starts_with('n') { length / 2 } else { length }).to_string() }),
                "decimal" | "numeric" => format!("{ty}({precision},{scale})"),
                "datetime2" | "datetimeoffset" | "time" => format!("{ty}({scale})"),
                _ => ty.into(),
            };
            tables[index].columns.push(Column { name: required(&row, "column_name")?.into(), data_type, nullable: row.get("is_nullable").unwrap_or(false), primary_key: row.get("is_pk").unwrap_or(false) });
        }
        let rows = client.simple_query(r#"
SELECT fk.object_id AS fk_id, fkc.constraint_column_id AS ordinal,
 ps.name AS source_schema, pt.name AS source_table, pc.name AS source_column,
 rs.name AS target_schema, rt.name AS target_table, rc.name AS target_column
FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
JOIN sys.tables pt ON pt.object_id=fkc.parent_object_id JOIN sys.schemas ps ON ps.schema_id=pt.schema_id
JOIN sys.columns pc ON pc.object_id=pt.object_id AND pc.column_id=fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id=rt.schema_id
JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fkc.referenced_column_id
ORDER BY fk.object_id,fkc.constraint_column_id;
"#).await.map_err(error)?.into_first_result().await.map_err(error)?;
        let mut relationships = vec![];
        for row in rows {
            let source = table_id(required(&row, "source_schema")?, required(&row, "source_table")?);
            let target = table_id(required(&row, "target_schema")?, required(&row, "target_table")?);
            if !positions.contains_key(&source) || !positions.contains_key(&target) { continue; }
            relationships.push(Relationship {
                id: format!("{}:{}", row.get::<i32,_>("fk_id").unwrap(), row.get::<i32,_>("ordinal").unwrap()),
                source_table: source, target_table: target,
                source_column: required(&row,"source_column")?.into(), target_column: required(&row,"target_column")?.into(),
            });
        }
        Ok(SchemaSnapshot { session_id: None, tables, relationships })
    }).await.map_err(|_| "SQL Serverのスキーマ取得が15秒を超えました。".to_owned())?
}

fn required<'a>(row: &'a Row, name: &str) -> Result<&'a str, String> {
    row.try_get::<&str, _>(name)
        .map_err(error)?
        .ok_or_else(|| format!("列{name}がありません"))
}

// Conversion is performed on the server for table reads. This keeps decimal precision
// and bounds large text/binary cells before they cross the network.
pub fn table_query(table: &Table, preview: bool) -> Result<String, String> {
    if table.columns.is_empty() || table.columns.len() > 512 {
        return Err("テーブル取得は1〜512列に対応しています。".into());
    }
    let limit = if preview { 500 } else { 1_048_577 };
    let mut expressions = vec![];
    for column in &table.columns {
        let name = quote(&column.name);
        let ty = column.data_type.split('(').next().unwrap_or("");
        let value = match ty {
            "binary" | "varbinary" | "image" | "timestamp" | "rowversion" => format!(
                "CONVERT(varchar(max), SUBSTRING({name},1,{}),2)",
                (limit + 1) / 2
            ),
            "date" | "datetime" | "smalldatetime" | "datetime2" | "datetimeoffset" | "time" => {
                format!("CONVERT(nvarchar(64),{name},126)")
            }
            "tinyint" | "smallint" | "int" | "bigint" | "decimal" | "numeric" | "bit"
            | "uniqueidentifier" | "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext"
            | "xml" => format!("CONVERT(nvarchar(max),{name})"),
            "money" | "smallmoney" => format!("CONVERT(nvarchar(max),{name},2)"),
            "float" | "real" => format!("CONVERT(nvarchar(max),{name},3)"),
            _ => {
                return Err(format!(
                "列{}の型{}はプレビュー・CSV出力に未対応です。SQLで明示的にCONVERTしてください。",
                column.name, column.data_type
            ))
            }
        };
        expressions.push(format!("LEFT({value},{limit}) AS {name}"));
    }
    let keys: Vec<_> = table
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| quote(&c.name))
        .collect();
    Ok(format!(
        "SELECT {}{} FROM {}{}",
        if preview { "TOP (100) " } else { "" },
        expressions.join(","),
        table_id(&table.schema, &table.name),
        if keys.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", keys.join(","))
        }
    ))
}

pub async fn preview(config: &ConnectionConfig, table: &Table) -> Result<Preview, String> {
    let sql = table_query(table, true)?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut client = connect(config).await?;
        let rows = client
            .simple_query(sql)
            .await
            .map_err(error)?
            .into_first_result()
            .await
            .map_err(error)?;
        let rows = rows
            .iter()
            .map(|row| {
                (0..table.columns.len())
                    .map(|i| {
                        row.try_get::<&str, _>(i)
                            .map(|v| v.map(str::to_owned))
                            .map_err(error)
                    })
                    .collect()
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Preview {
            columns: table.columns.iter().map(|c| c.name.clone()).collect(),
            rows,
        })
    })
    .await
    .map_err(|_| "SQL Serverのプレビューが15秒を超えました。".to_owned())?
}

fn validate(sql: &str, read_only: bool, explain: bool) -> Result<(bool, Vec<String>), String> {
    if explain {
        return Err("SQL Serverの実行計画は未対応です。SELECTを通常実行してください。".into());
    }
    if sql.len() > 100_000 {
        return Err("SQLは100KB以内にしてください。".into());
    }
    let statements = Parser::parse_sql(&MsSqlDialect {}, sql)
        .map_err(|e| format!("T-SQLを解析できません: {e}"))?;
    if statements.len() != 1 {
        return Err("SQL ServerではSQLを1文ずつ実行してください。GO・複数文は未対応です。".into());
    }
    let statement = &statements[0];
    let is_query = matches!(statement, Statement::Query(_));
    if !is_query
        && (read_only
            || !matches!(
                statement,
                Statement::Insert(_) | Statement::Update { .. } | Statement::Delete(_)
            ))
    {
        return Err("SQL ServerではSELECTと、書き込み接続の単一INSERT・UPDATE・DELETEに対応しています。DDL・EXEC・セッション操作は未対応です。".into());
    }
    if is_query
        && visit_statements(statement, |nested| {
            if matches!(nested, Statement::Query(_)) {
                ControlFlow::Continue(())
            } else {
                ControlFlow::Break(())
            }
        })
        .is_break()
    {
        return Err("読み取りクエリ内の更新には対応していません。".into());
    }
    let tokens = Tokenizer::new(&MsSqlDialect {}, sql)
        .tokenize()
        .map_err(error)?;
    for token in tokens {
        if let Token::Word(word) = token {
            if word.quote_style.is_none()
                && (matches!(
                    word.value.to_ascii_uppercase().as_str(),
                    "OUTPUT" | "OPENROWSET" | "OPENQUERY" | "OPENDATASOURCE" | "NEXT"
                ) || (is_query && word.value.eq_ignore_ascii_case("INTO")))
            {
                return Err(
                    "SELECT INTO・OUTPUT・外部データアクセス・シーケンス更新は未対応です。".into(),
                );
            }
        }
    }
    let mut referenced = vec![];
    let _: ControlFlow<()> = visit_relations(statement, |name| {
        let name = name.to_string();
        if !referenced.contains(&name) {
            referenced.push(name);
        }
        ControlFlow::Continue(())
    });
    Ok((is_query, referenced))
}

fn cell(row: &Row, index: usize) -> Result<Option<String>, String> {
    let value = row.get_column_data(index).map_err(error)?;
    macro_rules! text {
        ($v:expr) => {
            $v.as_ref().map(ToString::to_string)
        };
    }
    Ok(match value {
        ColumnData::U8(v) => text!(v),
        ColumnData::I16(v) => text!(v),
        ColumnData::I32(v) => text!(v),
        ColumnData::I64(v) => text!(v),
        ColumnData::F32(v) => text!(v),
        ColumnData::F64(v) => text!(v),
        ColumnData::Bit(v) => v.map(|v| if v { "1" } else { "0" }.into()),
        ColumnData::String(v) => v.as_ref().map(|v| v.chars().take(5001).collect()),
        ColumnData::Guid(v) => text!(v),
        ColumnData::Numeric(v) => text!(v),
        ColumnData::Xml(v) => v.as_ref().map(|v| {
            let xml: &str = v.as_ref().as_ref();
            xml.chars().take(5001).collect()
        }),
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|v| v.iter().take(2501).map(|b| format!("{b:02X}")).collect()),
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => row
            .try_get::<chrono::NaiveDateTime, _>(index)
            .map_err(error)?
            .map(|v| v.to_string()),
        ColumnData::Date(_) => row
            .try_get::<chrono::NaiveDate, _>(index)
            .map_err(error)?
            .map(|v| v.to_string()),
        ColumnData::Time(_) => row
            .try_get::<chrono::NaiveTime, _>(index)
            .map_err(error)?
            .map(|v| v.to_string()),
        ColumnData::DateTimeOffset(_) => row
            .try_get::<chrono::DateTime<chrono::FixedOffset>, _>(index)
            .map_err(error)?
            .map(|v| v.to_rfc3339()),
    })
}

pub async fn execute(
    config: &ConnectionConfig,
    sql: &str,
    read_only: bool,
    explain: bool,
) -> Result<QueryResult, String> {
    let (is_query, referenced_tables) = validate(sql, read_only, explain)?;
    let started = Instant::now();
    let mut set = QueryResultSet {
        columns: vec![],
        rows: vec![],
        affected_rows: 0,
        truncated: false,
        complete: false,
    };
    let operation = async {
        let mut client = connect(config).await?;
        if !is_query {
            set.affected_rows = client.execute(sql, &[]).await.map_err(error)?.total();
            set.complete = true;
            return Ok::<(), String>(());
        }
        let mut stream = client.simple_query(sql).await.map_err(error)?;
        let mut bytes = 0;
        while let Some(item) = stream.try_next().await.map_err(error)? {
            match item {
                QueryItem::Metadata(meta) => {
                    if meta.result_index() != 0 || meta.columns().len() > 512 {
                        return Err("結果数・列数が上限を超えました。".into());
                    }
                    set.columns = meta.columns().iter().map(|c| c.name().into()).collect();
                    bytes = set.columns.iter().map(String::len).sum();
                }
                QueryItem::Row(row) => {
                    if set.rows.len() >= 1000 {
                        set.truncated = true;
                        return Ok(());
                    }
                    let mut cells = vec![];
                    for i in 0..row.len() {
                        let value = cell(&row, i)?.map(|v| {
                            let shortened: String = v.chars().take(5000).collect();
                            if shortened.len() != v.len() {
                                set.truncated = true;
                            }
                            shortened
                        });
                        bytes += value.as_ref().map_or(0, String::len)
                            + std::mem::size_of::<Option<String>>();
                        if bytes > 5_000_000 {
                            set.truncated = true;
                            return Ok(());
                        }
                        cells.push(value);
                    }
                    set.rows.push(cells);
                }
            }
        }
        set.complete = true;
        Ok(())
    };
    let outcome = tokio::time::timeout(Duration::from_secs(15), operation).await;
    let error = match outcome {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e),
        Err(_) => Some(
            "SQL Serverの実行・取得が15秒を超えました。更新の反映状況を確認してください。".into(),
        ),
    };
    if set.columns.is_empty() {
        if let Some(error) = error {
            return Err(error);
        }
    }
    Ok(QueryResult {
        columns: set.columns.clone(),
        rows: set.rows.clone(),
        elapsed_ms: started.elapsed().as_millis(),
        affected_rows: set.affected_rows,
        truncated: set.truncated,
        referenced_tables,
        result_sets: vec![set],
        error,
    })
}

pub async fn export_rows(
    config: &ConnectionConfig,
    table: &Table,
    mut write: impl FnMut(Vec<Option<String>>) -> Result<(), String>,
) -> Result<u64, String> {
    let sql = table_query(table, false)?;
    let mut client = connect(config).await?;
    let mut stream = client
        .simple_query(sql)
        .await
        .map_err(error)?
        .into_row_stream();
    let mut count = 0;
    while let Some(row) = stream.try_next().await.map_err(error)? {
        let mut cells = vec![];
        let mut bytes = 0;
        for i in 0..table.columns.len() {
            let value = row.try_get::<&str, _>(i).map_err(error)?;
            if value.is_some_and(|s| s.len() > 1_048_576) {
                return Err("全件出力のセル上限1MiBを超えました。出力は確定しません。".into());
            }
            bytes += value.map_or(0, str::len);
            if bytes > 8 * 1024 * 1024 {
                return Err("全件出力の行上限8MiBを超えました。出力は確定しません。".into());
            }
            cells.push(value.map(str::to_owned));
        }
        write(cells)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsupported_and_side_effecting_sql_before_connecting() {
        for sql in [
            "SELECT * INTO copy FROM source",
            "SELECT NEXT VALUE FOR seq",
            "EXEC sp_help",
            "SET NOCOUNT ON",
            "BEGIN TRANSACTION",
            "UPDATE x SET a=1",
            "SELECT 1; SELECT 2",
            "SELECT * FROM OPENQUERY(remote,'SELECT 1')",
        ] {
            assert!(validate(sql, true, false).is_err(), "{sql}");
        }
        for sql in [
            "CREATE TABLE x (id int)",
            "INSERT INTO x OUTPUT inserted.id VALUES (1)",
            "DELETE FROM x; DELETE FROM y",
        ] {
            assert!(validate(sql, false, false).is_err(), "{sql}");
        }
        assert!(validate("SELECT TOP (10) [id] FROM [dbo].[Order]", true, false).is_ok());
        assert!(validate("WITH x AS (SELECT 1 AS a) SELECT * FROM x", true, false).is_ok());
        assert!(validate("UPDATE [dbo].[Order] SET amount=1 WHERE id=1", false, false).is_ok());
        assert!(validate("SELECT 1", true, true).is_err());
    }
    #[test]
    fn schema_qualified_identifiers_are_unambiguous_and_escaped() {
        assert_eq!(table_id("a.b", "c"), "[a.b].[c]");
        assert_ne!(table_id("a.b", "c"), table_id("a", "b.c"));
        assert_eq!(quote("a];DROP TABLE x--"), "[a]];DROP TABLE x--]");
    }

    #[test]
    #[ignore = "Requires isolated Express; see docs/sql-server.md"]
    fn sql_server_express_adapter_smoke() {
        crate::mysql_test_support::run(async {
            assert_eq!(
                std::env::var("RELAGRID_SQLSERVER_TEST_ISOLATED").as_deref(),
                Ok("true")
            );
            let path = std::env::var("RELAGRID_SQLSERVER_TEST_CONFIG").expect("test config path");
            let config: ConnectionConfig =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert!(config.database.starts_with("relagrid_fixture_"));
            assert_eq!(
                config.database_kind,
                Some(crate::models::DatabaseKind::SqlServer)
            );
            let mut master = config.clone();
            master.database = "master".into();
            let mut admin = connect(&master).await.unwrap();
            let info=admin.simple_query("SELECT CONVERT(nvarchar(128),SERVERPROPERTY('Edition')), CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion'))").await.unwrap().into_row().await.unwrap().unwrap();
            let edition = info.get::<&str, _>(0).unwrap();
            assert!(
                edition.contains("Express"),
                "Expected actual Express edition"
            );
            println!(
                "{edition}; version={}; SQL Server authentication; TLS={}",
                info.get::<&str, _>(1).unwrap(),
                config.tls_enabled.unwrap_or(false)
            );
            let encryption = admin
                .simple_query(
                    "SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id=@@SPID",
                )
                .await
                .unwrap()
                .into_row()
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                encryption.get::<&str, _>(0),
                Some(if config.tls_enabled == Some(true) {
                    "TRUE"
                } else {
                    "FALSE"
                })
            );
            if config.tls_enabled == Some(true) {
                let mut untrusted = master.clone();
                untrusted.tls_ca_pem = None;
                assert!(connect(&untrusted).await.is_err(), "untrusted CA must fail");
            }
            admin
                .simple_query(format!("CREATE DATABASE {}", quote(&config.database)))
                .await
                .unwrap()
                .into_results()
                .await
                .unwrap();
            let mut setup = connect(&config).await.unwrap();
            setup
                .simple_query("CREATE SCHEMA audit")
                .await
                .unwrap()
                .into_results()
                .await
                .unwrap();
            setup.simple_query(r#"
CREATE TABLE dbo.Customer(id int PRIMARY KEY, name nvarchar(100));
CREATE TABLE audit.Customer(id int PRIMARY KEY);
CREATE TABLE dbo.[Order](id int PRIMARY KEY, customer_id int REFERENCES dbo.Customer(id), amount decimal(38,12), memo nvarchar(max), payload varbinary(max), created_at datetime2(7));
INSERT dbo.Customer VALUES (1,N'青木😀');
INSERT audit.Customer VALUES (1);
INSERT dbo.[Order] VALUES (1052,1,12345678901234567890.123456789012,NULL,0x00FF,'2026-10-07T01:02:03.1234567');
"#).await.unwrap().into_results().await.unwrap();
            drop(setup);
            let db = crate::database::Database::connect(&config).await.unwrap();
            let snapshot = db.schema(&config.database).await.unwrap();
            assert_eq!(snapshot.tables.len(), 3);
            assert_eq!(snapshot.relationships.len(), 1);
            assert!(snapshot.tables.iter().any(|t| t.id == "[audit].[Customer]"));
            let order = snapshot
                .tables
                .iter()
                .find(|t| t.id == "[dbo].[Order]")
                .unwrap();
            assert!(order.columns[0].primary_key);
            let preview = db.preview(order).await.unwrap();
            assert_eq!(
                preview.rows[0][2].as_deref(),
                Some("12345678901234567890.123456789012")
            );
            assert_eq!(preview.rows[0][3], None);
            assert_eq!(preview.rows[0][4].as_deref(), Some("00FF"));
            let query = db
                .execute("SELECT * FROM dbo.[Order]", true, false)
                .await
                .unwrap();
            assert_eq!(query.rows[0][2], preview.rows[0][2]);
            assert_eq!(query.rows[0][4], preview.rows[0][4]);
            let unicode = db
                .execute("SELECT name FROM dbo.Customer", true, false)
                .await
                .unwrap();
            assert_eq!(unicode.rows[0][0].as_deref(), Some("青木😀"));
            let empty = db
                .execute("SELECT * FROM dbo.Customer WHERE 1=0", true, false)
                .await
                .unwrap();
            assert_eq!(empty.columns.len(), 2);
            assert!(empty.rows.is_empty());
            assert!(db
                .execute(
                    "UPDATE dbo.Customer SET name=N'changed' WHERE id=1",
                    true,
                    false
                )
                .await
                .is_err());
            let update = db
                .execute("UPDATE dbo.Customer SET name=name WHERE id=1", false, false)
                .await
                .unwrap();
            assert_eq!(update.affected_rows, 1);
            assert!(db
                .execute("SELECT * FROM MissingTable", true, false)
                .await
                .is_err());
            assert!(db
                .execute("SELECT 1", true, false)
                .await
                .unwrap()
                .error
                .is_none());
            let limited = db
                .execute(
                    "SELECT a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b",
                    true,
                    false,
                )
                .await
                .unwrap();
            assert_eq!(limited.rows.len(), 1000);
            assert!(limited.truncated);
            assert!(!limited.result_sets[0].complete);
            let mut exported = vec![];
            assert_eq!(
                export_rows(&config, order, |row| {
                    exported.push(row);
                    Ok(())
                })
                .await
                .unwrap(),
                1
            );
            assert_eq!(exported[0][2], preview.rows[0][2]);
            assert_eq!(exported[0][4], preview.rows[0][4]);
            db.close().await;
            let restored = crate::database::Database::connect(&config).await.unwrap();
            assert!(restored.execute("SELECT 1", true, false).await.is_ok());
            restored.close().await;
            admin
                .simple_query(format!(
                    "ALTER DATABASE {} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE {}",
                    quote(&config.database),
                    quote(&config.database)
                ))
                .await
                .unwrap()
                .into_results()
                .await
                .unwrap();
        });
    }
}
