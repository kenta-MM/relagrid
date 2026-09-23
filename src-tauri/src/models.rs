use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: String,
    #[serde(default = "default_read_only")]
    pub read_only: bool,
}
fn default_read_only() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub elapsed_ms: u128,
    pub affected_rows: u64,
    pub truncated: bool,
    pub referenced_tables: Vec<String>,
    pub result_sets: Vec<QueryResultSet>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub affected_rows: u64,
    pub truncated: bool,
    pub complete: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub id: String,
    pub schema: String,
    pub name: String,
    pub estimated_rows: u64,
    pub columns: Vec<Column>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub id: String,
    pub source_table: String,
    pub source_column: String,
    pub target_table: String,
    pub target_column: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub tables: Vec<Table>,
    pub relationships: Vec<Relationship>,
}

#[derive(Serialize)]
pub struct Preview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}
