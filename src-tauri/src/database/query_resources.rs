//! Application-level limits. These are not a MySQL packet allocation ceiling.
pub const MAX_RECEIVED_VALUE_BYTES: usize = 20_000_000;
pub const MAX_RECEIVED_ROWS: usize = 1001;

pub fn account_received(total: &mut usize, value_bytes: usize) -> bool {
    *total = total.saturating_add(value_bytes);
    *total <= MAX_RECEIVED_VALUE_BYTES
}

pub fn preview(value: &[u8], binary_type: bool) -> (String, bool) {
    match std::str::from_utf8(value) {
        Ok(text) if !binary_type => {
            let mut chars = text.chars();
            let output = chars.by_ref().take(5000).collect();
            (output, chars.next().is_some())
        }
        _ => {
            const HEX: &[u8] = b"0123456789ABCDEF";
            let mut output = String::with_capacity(value.len().min(2500) * 2);
            for byte in value.iter().take(2500) {
                output.push(HEX[(byte >> 4) as usize] as char);
                output.push(HEX[(byte & 15) as usize] as char);
            }
            (output, value.len() > 2500)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoded_budget_checks_exact_boundary_and_overflow() {
        let mut total = MAX_RECEIVED_VALUE_BYTES - 3;
        assert!(account_received(&mut total, 3));
        assert!(!account_received(&mut total, 1));
        assert!(!account_received(&mut total, usize::MAX));
        assert_eq!(total, usize::MAX);
    }

    #[test]
    fn preview_bounds_utf8_without_copying_the_full_cell() {
        let value = "😀".repeat(5001);
        let (output, truncated) = preview(value.as_bytes(), false);
        assert_eq!(output.chars().count(), 5000);
        assert!(truncated);
        assert_eq!(preview(b"abc", false), ("abc".into(), false));
    }

    #[test]
    fn binary_and_invalid_utf8_have_bounded_hex_previews() {
        assert_eq!(preview(&[0, 255], false), ("00FF".into(), false));
        assert_eq!(preview(b"a", true), ("61".into(), false));
        let (output, truncated) = preview(&vec![255; 2501], true);
        assert_eq!(output.len(), 5000);
        assert!(truncated);
    }

    #[test]
    #[ignore = "Requires isolated TLS MySQL fixture; RELAGRID_TEST_PORT and RELAGRID_TEST_CA_PEM"]
    fn mysql_resource_limits_reject_blob_and_stop_cumulative_retrieval() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let config = crate::models::ConnectionConfig {
                host: "127.0.0.1".into(),
                port: std::env::var("RELAGRID_TEST_PORT").unwrap_or("3307".into()).parse().unwrap(),
                username: "root".into(), password: String::new(),
                database: "relagrid_fixture".into(), read_only: true,
                tls_ca_pem: std::env::var("RELAGRID_TEST_CA_PEM").ok(),
            };
            let pool = super::super::mysql::connect(&config).await.unwrap();
            let error = super::super::query::execute(&pool, "SELECT REPEAT('x', 8000001)", true, false).await.err().expect("oversized packet must fail");
            assert!(error.contains("receive packet"), "{error}");
            let result = super::super::query::execute(&pool,
                "WITH RECURSIVE n AS (SELECT 1 AS v UNION ALL SELECT v+1 FROM n WHERE v<22) SELECT REPEAT('x', 1000000) FROM n; SELECT 9 AS tail",
                true, false).await.unwrap();
            assert!(result.error.as_ref().is_some_and(|e| e.contains("20MB")));
            assert!(result.truncated);
            assert_eq!(result.result_sets.len(), 1);
            assert!(!result.result_sets[0].complete);
            assert!(super::super::query::execute(&pool, "SELECT 1", true, false).await.unwrap().error.is_none());
            pool.close().await;
        });
    }
}
