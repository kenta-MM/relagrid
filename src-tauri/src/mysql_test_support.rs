//! Opt-in test configuration. Never fall back to a developer's default database.
use crate::models::ConnectionConfig;

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required; run npm run test:mysql"))
}

pub(crate) fn config(read_only: bool) -> ConnectionConfig {
    assert_eq!(required("RELAGRID_TEST_ISOLATED"), "true");
    let database = required("RELAGRID_TEST_DATABASE");
    assert!(database.starts_with("relagrid_fixture_"));
    let tls = required("RELAGRID_TEST_TLS");
    assert!(tls == "true" || tls == "false");
    ConnectionConfig {
        database_kind: None,
        host: required("RELAGRID_TEST_HOST"),
        port: required("RELAGRID_TEST_PORT")
            .parse()
            .expect("fixture port"),
        username: required("RELAGRID_TEST_USERNAME"),
        password: required("RELAGRID_TEST_PASSWORD"),
        database,
        read_only,
        tls_enabled: Some(tls == "true"),
        tls_ca_pem: std::env::var("RELAGRID_TEST_CA_PEM").ok(),
    }
}

pub(crate) fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(std::time::Duration::from_secs(60), test)
                .await
                .expect("integration case exceeded 60 seconds")
        });
}
