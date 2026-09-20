use crate::models::QueryResult;
use futures_util::TryStreamExt;
use sqlparser::{
    ast::{visit_relations, visit_statements, Statement},
    dialect::MySqlDialect,
    parser::Parser,
    tokenizer::{Token, Tokenizer},
};
use sqlx::{Column, Connection, Either, Executor, MySqlPool, Row, TypeInfo};
use std::ops::ControlFlow;
use std::time::{Duration, Instant};

fn validated_sql(sql: &str, read_only: bool, explain: bool) -> Result<String, String> {
    if sql.len() > 100_000 {
        return Err("SQLは100KB以内にしてください。".into());
    }
    // MySQL executes special comments that a generic parser could otherwise discard.
    if sql.contains("/*!") || sql.contains("/*M!") {
        return Err("実行可能コメントには対応していません。".into());
    }
    let statements = Parser::parse_sql(&MySqlDialect {}, sql)
        .map_err(|e| format!("SQLを解析できません: {e}"))?;
    if statements.len() != 1 {
        return Err("SQLは1文ずつ実行してください。".into());
    }
    let statement = &statements[0];
    let is_query = matches!(statement, Statement::Query(_));
    let is_explain = matches!(statement, Statement::Explain { statement, analyze: false, .. } if matches!(statement.as_ref(), Statement::Query(_)));
    if read_only && !is_query && !is_explain {
        return Err("この接続は読み取り専用です。SELECTのみ実行できます。".into());
    }
    if explain && !is_query {
        return Err("実行計画はSELECTに対して取得してください。".into());
    }
    if read_only || explain {
        let checked = visit_statements(statement, |nested| {
            if matches!(nested, Statement::Query(_) | Statement::Explain { .. }) {
                ControlFlow::Continue(())
            } else {
                ControlFlow::Break(())
            }
        });
        if checked.is_break() {
            return Err("読み取り専用のクエリのみ実行できます。".into());
        }
        let tokens = Tokenizer::new(&MySqlDialect {}, sql)
            .tokenize()
            .map_err(|e| e.to_string())?;
        if tokens.iter().any(|t| matches!(t, Token::Word(w) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case("INTO"))) {
            return Err("読み取りモードではSELECT INTOを実行できません。".into());
        }
    }
    // Each execution uses a fresh connection: session/transaction control would be misleading.
    let normalized = statement.to_string();
    let first = normalized.split_whitespace().next().unwrap_or("");
    if matches!(
        first,
        "SET"
            | "USE"
            | "START"
            | "BEGIN"
            | "COMMIT"
            | "ROLLBACK"
            | "PREPARE"
            | "EXECUTE"
            | "CALL"
            | "LOCK"
            | "UNLOCK"
    ) {
        return Err("セッション操作・トランザクション操作・CALLには対応していません。1文ずつ自動コミットで実行します。".into());
    }
    Ok(if explain {
        format!("EXPLAIN {sql}")
    } else {
        sql.to_owned()
    })
}

pub async fn execute(
    pool: &MySqlPool,
    sql: &str,
    read_only: bool,
    explain: bool,
) -> Result<QueryResult, String> {
    let sql = validated_sql(sql, read_only, explain)?;
    let parsed = Parser::parse_sql(&MySqlDialect {}, &sql).map_err(|e| e.to_string())?;
    let mut referenced_tables = Vec::new();
    let _: ControlFlow<()> = visit_relations(&parsed, |name| {
        let name = name.to_string();
        if !referenced_tables.contains(&name) {
            referenced_tables.push(name);
        }
        ControlFlow::Continue(())
    });
    let started = Instant::now();
    // Never return user-modified session state to the metadata/preview pool.
    let mut connection = pool.acquire().await.map_err(|e| e.to_string())?.detach();
    let operation = async {
        // COM_STMT_PREPARE validates the *original* SQL as a single MySQL statement
        // before text-protocol execution, retaining literals exactly as entered.
        let description = (&mut connection)
            .describe(&sql)
            .await
            .map_err(|e| e.to_string())?;
        let mut result = QueryResult {
            columns: description
                .columns()
                .iter()
                .map(|c| c.name().to_owned())
                .collect(),
            rows: Vec::new(),
            elapsed_ms: 0,
            affected_rows: 0,
            truncated: false,
            referenced_tables,
        };
        let mut stream = sqlx::raw_sql(&sql).fetch_many(&mut connection);
        let mut bytes = 0;
        while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
            match item {
                Either::Left(done) => result.affected_rows += done.rows_affected(),
                Either::Right(row) => {
                    if result.rows.len() >= 1000 || bytes >= 5_000_000 {
                        result.truncated = true;
                        break;
                    }
                    let mut cells = Vec::new();
                    for (i, column) in row.columns().iter().enumerate() {
                        // raw_sql uses MySQL's text protocol, preserving numeric/date precision.
                        let value: Option<Vec<u8>> =
                            row.try_get_unchecked(i).map_err(|e| e.to_string())?;
                        cells.push(value.map(|value| {
                            let binary = matches!(
                                column.type_info().name(),
                                "BINARY" | "VARBINARY" | "BLOB" | "BIT"
                            ) || std::str::from_utf8(&value).is_err();
                            let text = if binary {
                                value
                                    .iter()
                                    .take(2500)
                                    .map(|b| format!("{b:02X}"))
                                    .collect::<String>()
                            } else {
                                String::from_utf8_lossy(&value)
                                    .chars()
                                    .take(5000)
                                    .collect::<String>()
                            };
                            if (binary && value.len() > 2500)
                                || (!binary
                                    && String::from_utf8_lossy(&value).chars().count() > 5000)
                            {
                                result.truncated = true;
                            }
                            bytes += text.len();
                            text
                        }));
                    }
                    result.rows.push(cells);
                }
            }
        }
        result.elapsed_ms = started.elapsed().as_millis();
        Ok(result)
    };
    let result = tokio::time::timeout(Duration::from_secs(15), operation)
        .await
        .map_err(|_| {
            "実行が15秒を超えました。更新SQLの場合は反映状況を確認してから再実行してください。"
                .to_string()
        });
    // Dropping a timed-out socket closes it without draining the outstanding result.
    if result.is_ok() {
        let _ = tokio::time::timeout(Duration::from_secs(1), connection.close()).await;
    }
    result?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enforces_connection_mode_and_single_statement() {
        for sql in [
            "UPDATE t SET a=1",
            "DROP TABLE t",
            "SET TRANSACTION READ WRITE",
            "WITH c AS (SELECT 1) DELETE FROM t",
            "SELECT 1 INTO OUTFILE '/tmp/x'",
            "SELECT 1; DELETE FROM t",
            "/*!50000 DELETE FROM t */",
        ] {
            assert!(validated_sql(sql, true, false).is_err(), "{sql}");
        }
        for sql in [
            "SELECT 1",
            "WITH c AS (SELECT 1) SELECT * FROM c",
            "SELECT '; INTO' AS value",
            "EXPLAIN SELECT * FROM t",
        ] {
            assert!(validated_sql(sql, true, false).is_ok(), "{sql}");
        }
        assert!(validated_sql("UPDATE t SET a=1", false, false).is_ok());
        assert!(validated_sql("DELETE FROM t", false, true).is_err());
        assert!(validated_sql("SELECT 1; SELECT 2", false, false).is_err());
    }
}
