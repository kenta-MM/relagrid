use super::query_resources::{account_received, preview, MAX_RECEIVED_ROWS};
use crate::models::{QueryResult, QueryResultSet};
use futures_util::TryStreamExt;
use sqlparser::{
    ast::{visit_relations, visit_statements, Statement},
    dialect::MySqlDialect,
    parser::Parser,
    tokenizer::{Location, Token, Tokenizer},
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
    }
    if is_query || is_explain {
        let tokens = Tokenizer::new(&MySqlDialect {}, sql)
            .tokenize()
            .map_err(|e| e.to_string())?;
        if tokens.iter().any(|t| matches!(t, Token::Word(w) if w.quote_style.is_none() && w.value.eq_ignore_ascii_case("INTO"))) {
            return Err("SELECT INTOは実行できません。".into());
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

const MAX_RESULTS: usize = 20;
const MAX_ROWS: usize = 1000;
const MAX_BYTES: usize = 5_000_000;

// Parser locations count Unicode characters, not UTF-8 bytes.
fn byte_offset(sql: &str, location: Location) -> Result<usize, String> {
    let (mut line, mut column) = (1, 1);
    for (offset, ch) in sql.char_indices() {
        if line == location.line && column == location.column {
            return Ok(offset);
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    if line == location.line && column == location.column {
        return Ok(sql.len());
    }
    Err("SQLの文位置を取得できません。".into())
}

fn batch_statements(sql: &str, read_only: bool, explain: bool) -> Result<Vec<String>, String> {
    if sql.len() > 100_000 || sql.contains("/*!") || sql.contains("/*M!") {
        return Err("SQLは100KB以内で指定し、実行可能コメントは使用しないでください。".into());
    }
    let dialect = MySqlDialect {};
    let mut parser = Parser::new(&dialect)
        .try_with_sql(sql)
        .map_err(|e| e.to_string())?;
    let mut statements = Vec::new();
    let mut batch_supported = true;
    while parser.peek_token().token != Token::EOF {
        let start = byte_offset(sql, parser.peek_token().span.start)?;
        let statement = parser
            .parse_statement()
            .map_err(|e| format!("SQLを解析できません: {e}"))?;
        batch_supported &= matches!(
            statement,
            Statement::Query(_)
                | Statement::Insert(_)
                | Statement::Update { .. }
                | Statement::Delete(_)
        );
        let next = parser.peek_token();
        let end = if next.token == Token::EOF {
            sql.len()
        } else {
            if next.token != Token::SemiColon {
                return Err("SQL文の間には区切りが必要です。".into());
            }
            byte_offset(sql, next.span.start)?
        };
        // Only metadata preparation uses parser-delimited original source slices.
        // Execution sends the original batch once; no string splitting or SQL rewriting.
        statements.push(validated_sql(&sql[start..end], read_only, explain)?);
        if statements.len() > MAX_RESULTS {
            return Err("1回の実行は20文以内にしてください。".into());
        }
        if next.token == Token::SemiColon {
            parser.next_token();
        }
    }
    if statements.is_empty() {
        return Err("SQLを入力してください。".into());
    }
    if statements.len() > 1 && !read_only {
        return Err("安全なトランザクション機能が未実装のため、読み書き接続では複数文を実行できません。SQLは1文ずつ実行してください（自動コミット）。".into());
    }
    if statements.len() > 1 && (explain || !batch_supported) {
        return Err("複数文はSELECT・INSERT・UPDATE・DELETEのみ対応しています。DDL・実行計画は1文ずつ実行してください。".into());
    }
    Ok(statements)
}

fn empty_set(columns: Vec<String>) -> QueryResultSet {
    QueryResultSet {
        columns,
        rows: Vec::new(),
        affected_rows: 0,
        truncated: false,
        complete: false,
    }
}

fn retain_row(set: &mut QueryResultSet, cells: Vec<Option<String>>, bytes: &mut usize) {
    let cost = cells
        .iter()
        .map(|value| value.as_ref().map_or(0, String::len) + std::mem::size_of::<Option<String>>())
        .sum::<usize>();
    if set.rows.len() >= MAX_ROWS || cost > MAX_BYTES.saturating_sub(*bytes) {
        set.truncated = true;
        return;
    }
    *bytes += cost;
    set.rows.push(cells);
}

pub async fn execute(
    pool: &MySqlPool,
    sql: &str,
    read_only: bool,
    explain: bool,
) -> Result<QueryResult, String> {
    let statements = batch_statements(sql, read_only, explain)?;
    let execution_sql = if explain {
        statements[0].clone()
    } else {
        sql.to_owned()
    };
    let parsed = Parser::parse_sql(&MySqlDialect {}, &execution_sql).map_err(|e| e.to_string())?;
    let viewing_selects = read_only
        && !explain
        && parsed.iter().all(|s| matches!(s, Statement::Query(_)))
        && statements
            .iter()
            .all(|s| validated_sql(s, true, false).is_ok());
    let mut referenced_tables = Vec::new();
    let _: ControlFlow<()> = visit_relations(&parsed, |name| {
        let name = name.to_string();
        if !referenced_tables.contains(&name) {
            referenced_tables.push(name);
        }
        ControlFlow::Continue(())
    });
    let started = Instant::now();
    let mut connection = pool.acquire().await.map_err(|e| e.to_string())?.detach();
    let mut sets: Vec<QueryResultSet> = Vec::new();
    let mut bytes = 0;
    let operation = async {
        if viewing_selects {
            (&mut connection)
                .execute("SET SESSION sql_select_limit = 1001")
                .await
                .map_err(|e| format!("取得行数制限を設定できません: {e}（SQLは未実行）"))?;
        }
        let mut received_bytes = 0;
        let mut received_rows = 0;
        // sqlx does not expose metadata for empty sets through fetch_many.
        // Prepare all original statements without executing them before sending the batch.
        let mut descriptions = Vec::new();
        for (index, statement) in statements.iter().enumerate() {
            let description = (&mut connection).describe(statement).await.map_err(|e| {
                format!(
                    "文{}の事前確認に失敗しました: {e}（SQLは未実行）",
                    index + 1
                )
            })?;
            let columns = description
                .columns()
                .iter()
                .map(|c| c.name().to_owned())
                .collect::<Vec<_>>();
            bytes += columns
                .iter()
                .map(|s| s.len() + std::mem::size_of::<String>())
                .sum::<usize>();
            if bytes > MAX_BYTES {
                return Err("列定義が表示上限を超えました（SQLは未実行）。".into());
            }
            descriptions.push(columns);
        }
        let mut index = 0;
        let mut retaining = true;
        let mut stream = sqlx::raw_sql(&execution_sql).fetch_many(&mut connection);
        while let Some(item) = stream.try_next().await.map_err(|e| format!("文{}の実行・取得に失敗しました: {e}。後続文は未完了です。更新の反映状況を確認してください。", index + 1))? {
            if index >= descriptions.len() { return Err("想定外の結果数です。取得を中断しました。".into()); }
            if sets.len() == index { sets.push(empty_set(std::mem::take(&mut descriptions[index]))); }
            let set = &mut sets[index];
            match item {
                Either::Left(done) => {
                    set.affected_rows = done.rows_affected();
                    set.complete = true;
                    index += 1;
                    retaining = true;
                    received_rows = 0;
                }
                Either::Right(row) => {
                    received_rows += 1;
                    if viewing_selects && received_rows >= MAX_RECEIVED_ROWS {
                        set.truncated = true;
                        return Err(format!("文{}の閲覧取得上限（1,000行）に達し、接続を破棄しました。後続文の実行状態は不明です。", index + 1));
                    }
                    for i in 0..row.len() {
                        let value: Option<&[u8]> = row.try_get_unchecked(i).map_err(|e| e.to_string())?;
                        if !account_received(&mut received_bytes, value.map_or(0, |v| v.len())) {
                            set.truncated = true;
                            return Err(format!("文{}の累積取得値が20MBを超え、接続を破棄しました。現在・後続文の完了状態は不明です。更新の反映状況を確認してください。", index + 1));
                        }
                    }
                    if !retaining || set.rows.len() >= MAX_ROWS || bytes >= MAX_BYTES {
                        set.truncated = true;
                        continue; // Drain to the next result without retaining more rows.
                    }
                    let mut cells = Vec::new();
                    let mut row_bytes = 0;
                    let mut row_exceeds_budget = false;
                    for (i, column) in row.columns().iter().enumerate() {
                        let value: Option<&[u8]> = row.try_get_unchecked(i).map_err(|e| e.to_string())?;
                        cells.push(value.map(|value| {
                            let binary = matches!(column.type_info().name(), "BINARY" | "VARBINARY" | "BLOB" | "BIT");
                            let (text, truncated) = preview(value, binary);
                            set.truncated |= truncated;
                            text
                        }));
                        row_bytes += cells.last().unwrap().as_ref().map_or(0, String::len) + std::mem::size_of::<Option<String>>();
                        if row_bytes > MAX_BYTES.saturating_sub(bytes) {
                            set.truncated = true;
                            row_exceeds_budget = true;
                            retaining = false;
                            break;
                        }
                    }
                    if !row_exceeds_budget { retain_row(set, cells, &mut bytes); }
                }
            }
        }
        if index != descriptions.len() {
            return Err("すべての文の完了を確認できませんでした。".into());
        }
        Ok::<(), String>(())
    };
    let outcome = tokio::time::timeout(Duration::from_secs(15), operation).await;
    // Error/timeout drops the socket without draining an unfinished response.
    if matches!(outcome, Ok(Ok(()))) {
        let _ = tokio::time::timeout(Duration::from_secs(1), connection.close()).await;
    }
    let error = match outcome {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(_) => Some("実行・取得が15秒を超えました。取得済み結果のみ表示しています。更新の反映状況を確認してから再実行してください。".into()),
    };
    if sets.is_empty() {
        if let Some(error) = error {
            return Err(error);
        }
    }
    Ok(QueryResult {
        // Retain the existing single-result fields for IPC consumers.
        columns: sets.first().map(|s| s.columns.clone()).unwrap_or_default(),
        rows: sets.first().map(|s| s.rows.clone()).unwrap_or_default(),
        elapsed_ms: started.elapsed().as_millis(),
        affected_rows: sets.iter().map(|s| s.affected_rows).sum(),
        truncated: sets.iter().any(|s| s.truncated),
        referenced_tables,
        result_sets: sets,
        error,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_exact_statement_and_utf8_byte_limits() {
        assert_eq!(
            batch_statements(&vec!["SELECT 1"; MAX_RESULTS].join(";"), true, false)
                .unwrap()
                .len(),
            MAX_RESULTS
        );
        let prefix = "SELECT '日本語😀' /*";
        let sql = format!("{prefix}{}*/", "x".repeat(100_000 - prefix.len() - 2));
        assert_eq!(sql.len(), 100_000);
        assert!(batch_statements(&sql, true, false).is_ok());
        assert!(batch_statements(&(sql + " "), true, false).is_err());
    }

    #[test]
    fn rejects_session_control_even_on_writable_connections() {
        for sql in [
            "SET autocommit=0",
            "USE other_db",
            "START TRANSACTION",
            "BEGIN",
            "COMMIT",
            "ROLLBACK",
            "CALL p()",
            "PREPARE stmt FROM 'SELECT 1'",
            "EXECUTE stmt",
            "LOCK TABLES t WRITE",
            "UNLOCK TABLES",
        ] {
            assert!(batch_statements(sql, false, false).is_err(), "{sql}");
        }
        assert!(batch_statements("CREATE TABLE t (id INT)", false, false).is_ok());
        assert!(batch_statements("CREATE TABLE t (id INT)", true, false).is_err());
    }

    #[test]
    fn explain_preserves_original_sql_and_does_not_allow_writes() {
        let sql = "SELECT '日本語;😀' AS `INTO`";
        assert_eq!(
            batch_statements(sql, true, true).unwrap(),
            [format!("EXPLAIN {sql}")]
        );
        assert!(batch_statements("SELECT 1 INTO @value", true, false).is_err());
        assert!(batch_statements("SELECT 1 INTO OUTFILE '/tmp/test'", false, true).is_err());
        assert!(batch_statements("/*M! SELECT 1 */", false, false).is_err());
        assert!(batch_statements("SELECT 'INTO', `INTO` FROM t /* INTO */", true, false).is_ok());
    }

    #[test]
    fn retention_accepts_exact_byte_budget_and_counts_null_overhead() {
        let mut set = empty_set(vec!["v".into()]);
        let cost = "日".len() + std::mem::size_of::<Option<String>>();
        let mut bytes = MAX_BYTES - cost;
        retain_row(&mut set, vec![Some("日".into())], &mut bytes);
        assert_eq!(bytes, MAX_BYTES);
        assert_eq!(set.rows.len(), 1);
        assert!(!set.truncated);
        retain_row(&mut set, vec![None], &mut bytes);
        assert_eq!(set.rows.len(), 1);
        assert!(set.truncated);
        assert_eq!(bytes, MAX_BYTES);
        let mut next = empty_set(vec!["null".into()]);
        bytes = 0;
        retain_row(&mut next, vec![None], &mut bytes);
        assert_eq!(bytes, std::mem::size_of::<Option<String>>());
        assert_eq!(next.rows, vec![vec![None]]);
    }

    #[test]
    fn batch_uses_parser_boundaries_and_preserves_original_literals() {
        let sql =
            "/* 前置き ; */ SELECT '日本語;😀' AS a;\r\n\tSELECT 'it''s;ok' AS b -- ; ignored\r\n;";
        let statements = batch_statements(sql, true, false).unwrap();
        assert_eq!(
            statements,
            [
                "SELECT '日本語;😀' AS a",
                "SELECT 'it''s;ok' AS b -- ; ignored\r\n"
            ]
        );
        assert_eq!(
            batch_statements("SELECT ';' AS a; SELECT NULL AS b WHERE 0", true, false)
                .unwrap()
                .len(),
            2
        );
        assert!(batch_statements("SELECT 1; UPDATE t SET a=1; SELECT 2", false, false).is_err());
    }

    #[test]
    fn refuses_write_batches_before_any_statement_executes() {
        for sql in [
            "UPDATE inventory SET quantity=quantity-1 WHERE id=1; INSERT INTO orders(id) VALUES(1)",
            "SELECT 1; DELETE FROM t",
            "UPDATE t SET a=1; SELECT 1",
            "WITH c AS (SELECT 1) UPDATE t SET a=1; SELECT 2",
        ] {
            assert!(
                batch_statements(sql, false, false)
                    .unwrap_err()
                    .contains("トランザクション"),
                "{sql}"
            );
        }
        assert!(batch_statements("UPDATE t SET a=1 WHERE id=1", false, false).is_ok());
        assert!(batch_statements("SELECT 1; SELECT 2", true, false).is_ok());
        assert!(
            batch_statements("SELECT stored_function(); SELECT 2", false, false)
                .unwrap_err()
                .contains("トランザクション")
        );
        assert!(batch_statements("SELECT 1 INTO OUTFILE '/tmp/x'", false, false).is_err());
        assert!(batch_statements("SELECT 1; SELECT 2 INTO @value", false, false).is_err());
    }

    #[test]
    fn batch_checks_every_statement_before_execution() {
        for sql in [
            "SELECT 1; UPDATE t SET a=1",
            "SELECT 1; SET autocommit=0",
            "SELECT 1; SELECT 2 INTO OUTFILE '/tmp/x'",
            "SELECT 1; /*! DELETE FROM t */",
        ] {
            assert!(batch_statements(sql, true, false).is_err(), "{sql}");
        }
        for sql in [
            "SELECT 1; CREATE TABLE t(a INT)",
            "SELECT 1; CALL p()",
            "SELECT 1; COMMIT",
            "SELECT 1;;SELECT 2",
        ] {
            assert!(batch_statements(sql, false, false).is_err(), "{sql}");
        }
        assert!(batch_statements("SELECT 1; SELECT 2", true, true).is_err());
        assert!(batch_statements(&vec!["SELECT 1"; 21].join(";"), true, false).is_err());
        assert!(batch_statements(" -- comment only", true, false).is_err());
    }

    #[test]
    fn retention_bounds_rows_and_shared_bytes_without_losing_empty_columns() {
        let mut set = empty_set(vec!["a".into()]);
        let mut bytes = 0;
        for _ in 0..1001 {
            retain_row(&mut set, vec![Some("x".into())], &mut bytes);
        }
        assert_eq!(set.rows.len(), MAX_ROWS);
        assert!(set.truncated);
        let mut next = empty_set(vec!["b".into()]);
        bytes = MAX_BYTES - 1;
        retain_row(&mut next, vec![Some("日本語".into())], &mut bytes);
        assert!(next.rows.is_empty());
        assert!(next.truncated);
        assert_eq!(next.columns, ["b"]);
        assert!(bytes <= MAX_BYTES);
    }
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
