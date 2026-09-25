//! MySQL SQL generation, kept separate from network and row decoding.
use crate::models::Table;

pub const TABLES: &str = r#"
    SELECT TABLE_NAME, CAST(COALESCE(TABLE_ROWS, 0) AS UNSIGNED) AS ROW_COUNT
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
"#;

// INFORMATION_SCHEMA can expose textual metadata as binary/decimal types.
// Normalize its wire types explicitly rather than relying on driver coercion.
pub const COLUMNS: &str = r#"
    SELECT TABLE_NAME, COLUMN_NAME,
           CAST(COLUMN_TYPE AS CHAR CHARACTER SET utf8mb4) AS COLUMN_TYPE,
           CAST(IS_NULLABLE AS CHAR CHARACTER SET utf8mb4) AS IS_NULLABLE,
           CAST(COLUMN_KEY AS CHAR CHARACTER SET utf8mb4) AS COLUMN_KEY
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME, ORDINAL_POSITION
"#;

pub const RELATIONSHIPS: &str = r#"
    SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME,
           REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME,
           CAST(ORDINAL_POSITION AS UNSIGNED) AS ORDINAL_POSITION
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION
"#;

pub const PREVIEW_ROW_LIMIT: usize = 100;
pub const PREVIEW_VALUE_LIMIT: usize = 500;
pub const EXPORT_VALUE_LIMIT: usize = 1024 * 1024;
pub fn export_cell_limit(table: &Table) -> usize {
    EXPORT_VALUE_LIMIT.min(8 * 1024 * 1024 / table.columns.len().max(1))
}

/// Export is a catalog-derived SELECT, never a replay of user SQL. One extra
/// byte detects oversized cells so they are rejected instead of truncated.
pub fn export_query(table: &Table) -> String {
    let columns = table
        .columns
        .iter()
        .map(|column| {
            let name = quote_identifier(&column.name);
            let value = if is_binary_type(&column.data_type) {
                format!("HEX({name})")
            } else {
                format!("CAST({name} AS CHAR CHARACTER SET utf8mb4)")
            };
            format!(
                "LEFT(CAST({value} AS BINARY), {}) AS {name}",
                export_cell_limit(table) + 1
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {columns} FROM {}.{}",
        quote_identifier(&table.schema),
        quote_identifier(&table.name)
    )
}

/// SQL parameters cannot bind identifiers. Only catalog-derived names reach this function.
fn quote_identifier(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn is_binary_type(data_type: &str) -> bool {
    let base = data_type.split('(').next().unwrap_or(data_type).trim();
    matches!(
        base,
        "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "binary"
            | "varbinary"
            | "bit"
            | "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
    )
}

pub fn preview_query(table: &Table) -> String {
    let columns = table
        .columns
        .iter()
        .map(|column| {
            let name = quote_identifier(&column.name);
            let value = if is_binary_type(&column.data_type) {
                format!("HEX({name})")
            } else {
                format!("CAST({name} AS CHAR CHARACTER SET utf8mb4)")
            };
            format!("LEFT({value}, {PREVIEW_VALUE_LIMIT}) AS {name}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let keys = table
        .columns
        .iter()
        .filter(|column| column.primary_key)
        .map(|column| quote_identifier(&column.name))
        .collect::<Vec<_>>();
    let order = if keys.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", keys.join(", "))
    };
    format!(
        "SELECT {columns} FROM {}.{}{order} LIMIT {PREVIEW_ROW_LIMIT}",
        quote_identifier(&table.schema),
        quote_identifier(&table.name)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_export_has_no_row_limit_and_bounds_each_wire_value() {
        let table = Table {
            id: "db.t".into(),
            schema: "d`b".into(),
            name: "t`x".into(),
            estimated_rows: 0,
            columns: vec![crate::models::Column {
                name: "a`b".into(),
                data_type: "blob".into(),
                nullable: true,
                primary_key: false,
            }],
        };
        let sql = export_query(&table);
        assert!(sql.contains("FROM `d``b`.`t``x`"));
        assert!(sql.contains("LEFT(CAST(HEX(`a``b`) AS BINARY), 1048577)"));
        assert!(!sql.contains(" LIMIT "));
        let mut wide = table;
        wide.columns = vec![wide.columns[0].clone(); 512];
        assert_eq!(export_cell_limit(&wide), 16384);
    }

    #[test]
    fn identifiers_are_escaped_as_single_identifiers() {
        assert_eq!(quote_identifier("Order"), "`Order`");
        assert_eq!(
            quote_identifier("a`; DROP TABLE b;--"),
            "`a``; DROP TABLE b;--`"
        );
        assert_eq!(quote_identifier("a.b"), "`a.b`");
    }

    #[test]
    fn enum_values_are_not_mistaken_for_binary_types() {
        assert!(!is_binary_type("enum('rabbit','point','blob')"));
        assert!(!is_binary_type("varchar(100)"));
        assert!(is_binary_type("varbinary(32)"));
        assert!(is_binary_type("geometrycollection"));
    }
}
