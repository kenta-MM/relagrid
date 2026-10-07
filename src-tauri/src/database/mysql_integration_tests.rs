use super::*;
use crate::database::query::execute;
use crate::mysql_test_support::{config, run};

#[test]
#[ignore = "Run npm run test:mysql"]
fn mysql_fixture_schema_and_preview() {
    run(async {
        let config = config(true);
        let pool = connect(&config).await.expect("fixture connection");
        let snapshot = schema(&pool, &config.database).await.unwrap();
        assert_eq!(snapshot.tables.len(), 2);
        assert_eq!(snapshot.relationships.len(), 1);
        let relationship = &snapshot.relationships[0];
        assert_eq!(relationship.source_column, "customer_id");
        assert_eq!(relationship.target_column, "customer_id");
        let order = snapshot
            .tables
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case("Order"))
            .unwrap();
        assert!(order.columns[0].primary_key);
        let result = preview(&pool, order).await.unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0].as_deref(), Some("1052"));
        assert_eq!(result.rows[0][2].as_deref(), Some("1234.50"));
        assert_eq!(result.rows[0][3], None);
        assert_eq!(result.rows[0][4].as_deref(), Some("00FF"));
        assert_eq!(result.rows[0][5].as_deref(), Some("2026-09-20 12:00:00"));
        let customer = snapshot
            .tables
            .iter()
            .find(|t| t.name.eq_ignore_ascii_case("Customer"))
            .unwrap();
        assert_eq!(
            preview(&pool, customer).await.unwrap().rows[0][1].as_deref(),
            Some("青木")
        );
        pool.close().await;
    });
}

#[test]
#[ignore = "Run npm run test:mysql"]
fn mysql_fixture_values_empty_results_and_batches() {
    run(async {
        let pool = connect(&config(true)).await.unwrap();
        let result = execute(
            &pool,
            "SELECT 1234.50 AS amount, NULL AS memo, X'00FF' AS payload, '青木😀' AS name",
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
                Some("青木😀".into())
            ]
        );
        let empty = execute(&pool, "SELECT * FROM Customer WHERE 1=0", true, false)
            .await
            .unwrap();
        assert!(empty.rows.is_empty());
        assert_eq!(empty.columns.len(), 3);
        let batch = execute(
            &pool,
            "SELECT '日本語;😀' AS a; SELECT * FROM Customer WHERE 0; SELECT 9 AS tail",
            true,
            false,
        )
        .await
        .unwrap();
        assert!(batch.error.is_none());
        assert_eq!(batch.result_sets.len(), 3);
        assert!(batch.result_sets[1].rows.is_empty());
        assert_eq!(batch.result_sets[1].columns.len(), 3);
        assert_eq!(batch.result_sets[2].rows[0][0].as_deref(), Some("9"));
        pool.close().await;
    });
}

#[test]
#[ignore = "Run npm run test:mysql"]
fn mysql_fixture_read_only_and_write_permissions() {
    run(async {
        let pool = connect(&config(true)).await.unwrap();
        assert!(
            sqlx::query("UPDATE Customer SET name=name WHERE customer_id=1")
                .execute(&pool)
                .await
                .is_err()
        );
        assert!(execute(
            &pool,
            "UPDATE Customer SET name=name WHERE customer_id=1",
            true,
            false
        )
        .await
        .is_err());
        pool.close().await;
        let pool = connect(&config(false)).await.unwrap();
        let update = execute(
            &pool,
            "UPDATE Customer SET name=name WHERE customer_id=1",
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(update.affected_rows, 1);
        assert!(!execute(&pool, "SELECT * FROM Customer", false, true)
            .await
            .unwrap()
            .rows
            .is_empty());
        for sql in [
            "SELECT 1; UPDATE Customer SET name=name WHERE customer_id=1",
            "SELECT 1; INSERT INTO Customer(customer_id) VALUES (1); SELECT 2",
        ] {
            assert!(execute(&pool, sql, false, false)
                .await
                .err()
                .unwrap()
                .contains("トランザクション"));
        }
        pool.close().await;
        // DB permissions still reject writes even when the app's read-only switch is off.
        let mut reader = config(false);
        reader.username = "fixture_reader".into();
        let pool = connect(&reader).await.unwrap();
        assert_eq!(
            schema(&pool, &reader.database).await.unwrap().tables.len(),
            2
        );
        assert!(execute(&pool, "SELECT * FROM Customer", false, false)
            .await
            .unwrap()
            .error
            .is_none());
        assert!(execute(
            &pool,
            "UPDATE Customer SET name=name WHERE customer_id=1",
            false,
            false
        )
        .await
        .is_err());
        pool.close().await;
    });
}

#[test]
#[ignore = "Run npm run test:mysql"]
fn mysql_fixture_result_limits() {
    run(async {
        let pool = connect(&config(true)).await.unwrap();
        let limited = execute(&pool, "WITH RECURSIVE n AS (SELECT 0 AS v UNION ALL SELECT v+1 FROM n WHERE v<31) SELECT a.v FROM n a CROSS JOIN n b; SELECT 9 AS tail", true, false).await.unwrap();
        assert!(limited.error.is_none());
        assert_eq!(limited.result_sets[0].rows.len(), 1000);
        assert!(limited.result_sets[0].truncated);
        assert_eq!(limited.result_sets[1].rows[0][0].as_deref(), Some("9"));
        let wide = execute(&pool, "WITH RECURSIVE n AS (SELECT 0 AS v UNION ALL SELECT v+1 FROM n WHERE v<31) SELECT REPEAT('x',5000), REPEAT('y',5000) FROM n a CROSS JOIN n b; SELECT 1 AS tail", true, false).await.unwrap();
        assert!(wide.error.is_none());
        assert!(wide.result_sets[0].truncated);
        assert!(wide.result_sets[0].rows.len() < 1000);
        assert_eq!(wide.result_sets.len(), 2);
        pool.close().await;
    });
}

#[test]
#[ignore = "Run npm run test:mysql"]
fn mysql_fixture_client_cancel_timeout_and_recovery() {
    run(async {
        let pool = connect(&config(true)).await.unwrap();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let operation =
            crate::cancellable(execute(&pool, "SELECT SLEEP(10)", true, false), receiver);
        let (cancelled, ()) = futures_util::future::join(operation, async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = sender.send(());
        })
        .await;
        assert!(cancelled.err().unwrap().contains("中断"));
        // This verifies client cancellation, not confirmation that the server stopped (#19).
        assert!(execute(&pool, "SELECT 1", true, false)
            .await
            .unwrap()
            .error
            .is_none());
        assert!(
            execute(&pool, "SELECT * FROM MissingFixtureTable", true, false)
                .await
                .is_err()
        );
        let timeout = execute(
            &pool,
            "SELECT SLEEP(20) AS delayed, 1 AS marker",
            true,
            false,
        )
        .await;
        assert!(
            timeout.is_err() || timeout.unwrap().error.is_some(),
            "query timeout must be enforced"
        );
        assert!(execute(&pool, "SELECT 1", true, false)
            .await
            .unwrap()
            .error
            .is_none());
        pool.close().await;
        let pool = connect(&config(true)).await.unwrap();
        assert!(execute(&pool, "SELECT 1", true, false).await.is_ok());
        pool.close().await;
    });
}

#[test]
#[ignore = "Run npm run test:mysql"]
fn mysql_fixture_connection_modes_and_failures() {
    run(async {
        let config = config(true);
        let pool = connect(&config).await.unwrap();
        let row = sqlx::query("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let cipher: String = row.get(1);
        assert_eq!(!cipher.is_empty(), config.tls_enabled.unwrap());
        let version: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            version,
            std::env::var("RELAGRID_TEST_SERVER_VERSION").unwrap()
        );
        println!("MySQL {version}; TLS={}", config.tls_enabled.unwrap());
        pool.close().await;
        let mut invalid = config.clone();
        invalid.password.push_str("-invalid");
        assert!(connect(&invalid).await.is_err());
        let mut invalid = config.clone();
        invalid.database.push_str("_missing");
        assert!(connect(&invalid).await.is_err());
        if config.tls_enabled == Some(true) {
            let mut untrusted = config.clone();
            untrusted.tls_ca_pem = None;
            assert!(connect(&untrusted).await.is_err());
        }
        connect(&config).await.unwrap().close().await;
    });
}

#[test]
#[ignore = "Run npm run test:mysql (invalid certificate scenarios)"]
fn mysql_fixture_reject_invalid_tls() {
    run(async {
        let config = config(true);
        assert_eq!(config.tls_enabled, Some(true));
        assert!(config.tls_ca_pem.is_some());
        let error = connect(&config).await.unwrap_err();
        assert!(
            error.to_lowercase().contains("invalid peer certificate"),
            "must fail during TLS, not authentication: {error}"
        );
        let mut plain = config;
        plain.tls_enabled = Some(false);
        // Prove the server and credentials work; the preceding failure is TLS-specific.
        connect(&plain).await.unwrap().close().await;
    });
}
