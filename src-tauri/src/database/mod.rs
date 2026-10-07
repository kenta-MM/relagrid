pub mod mysql;
pub(crate) mod mysql_sql;
pub mod query;
pub mod sql_server;

use crate::models::{ConnectionConfig, DatabaseKind, Preview, QueryResult, SchemaSnapshot, Table};

pub enum Database {
    Mysql(sqlx::MySqlPool),
    SqlServer(ConnectionConfig),
}

impl Database {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self, String> {
        match config.database_kind.unwrap_or_default() {
            DatabaseKind::Mysql => mysql::connect(config).await.map(Self::Mysql),
            DatabaseKind::SqlServer => {
                // Validate now; subsequent operations use fresh, cancellation-safe connections.
                sql_server::connect(config).await?;
                Ok(Self::SqlServer(config.clone()))
            }
        }
    }

    pub async fn schema(&self, database: &str) -> Result<SchemaSnapshot, String> {
        match self {
            Self::Mysql(pool) => mysql::schema(pool, database).await,
            Self::SqlServer(config) => sql_server::schema(config).await,
        }
    }

    pub async fn preview(&self, table: &Table) -> Result<Preview, String> {
        match self {
            Self::Mysql(pool) => mysql::preview(pool, table).await,
            Self::SqlServer(config) => sql_server::preview(config, table).await,
        }
    }

    pub async fn execute(
        &self,
        sql: &str,
        read_only: bool,
        explain: bool,
    ) -> Result<QueryResult, String> {
        match self {
            Self::Mysql(pool) => query::execute(pool, sql, read_only, explain).await,
            Self::SqlServer(config) => sql_server::execute(config, sql, read_only, explain).await,
        }
    }

    pub async fn close(self) {
        if let Self::Mysql(pool) = self {
            pool.close().await;
        }
    }
}
