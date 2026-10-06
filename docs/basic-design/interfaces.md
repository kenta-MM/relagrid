# 基本設計：インターフェース

[設計書目次](../README.md) / [データモデル](data-model.md)

## Tauriコマンド

登録元は[lib.rs](../../src-tauri/src/lib.rs) `run` の `generate_handler!`。下表は登録された15コマンドを全て示す。引数はUI側のcamelCase表記。返却型は成功値で、失敗はRustの `Result<_, String>` からPromise拒否へ伝播する。`void` はRustの `()`、`?` は省略可能。

| コマンド              | 引数                                                                  | 成功値・役割                                                             |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `load_connections`    | なし                                                                  | `SavedConnections`。ファイルなしなら空。復号成功で保存許可               |
| `save_connections`    | `data: SavedConnections`                                              | `void`。既存ファイル再検証後に暗号化保存                                 |
| `load_queries`        | なし                                                                  | `SavedQuery[]`。旧平文形式は暗号化移行してから返す                       |
| `save_queries`        | `data: SavedQuery[]`                                                  | `void`。クエリ配列全体を暗号化保存                                       |
| `connect_database`    | `config: ConnectionConfig`                                            | `SchemaSnapshot`。接続と初回スキーマの両方成功後に交換                   |
| `refresh_schema`      | なし                                                                  | `SchemaSnapshot`。現在接続を更新、sessionIdは維持                        |
| `preview_table`       | `tableId: string`                                                     | `Preview`。保持スキーマ内のIDのみ                                        |
| `execute_query`       | `sql: string, explain: boolean, executionId?: string`                 | `QueryResult`。部分失敗は成功値内の `error` に入る場合もある             |
| `cancel_query`        | `executionId: string`                                                 | `void`。一致する実行への中断通知。終了完了通知ではない                   |
| `begin_csv_export`    | `name: string, source?: ExportSource`                                 | `string \| null`。出力IDまたは保存先取消                                 |
| `write_csv_export`    | `id: string, text: string`                                            | `void`。最大65,536 UTF-8バイト／呼出                                     |
| `finish_csv_export`   | `id: string`                                                          | `void`。同期・保存先置換                                                 |
| `abort_csv_export`    | `id: string`                                                          | `void`。一致する出力へ中断、部分ファイル削除。古いIDでは他出力を触らない |
| `export_table_csv`    | `id: string, source: ExportSource, progress: Channel<ExportProgress>` | `u64`相当の行数。DB全件取得からファイル確定まで実施                      |
| `disconnect_database` | なし                                                                  | `void`。現在プールを閉じる                                               |

型・ファイル：[domain/database.ts](../../src/domain/database.ts)、[models.rs](../../src-tauri/src/models.rs)、[connection-store.ts](../../src/data/connection-store.ts)、[query-store.ts](../../src/data/query-store.ts)、[csv_export.rs](../../src-tauri/src/csv_export.rs)。`ExportSource` は `{sessionId: string, tableId: string}`、`ExportProgress` は `{rows: number}`。Rust整数からJS numberへの大整数精度は別途要確認。

`DatabaseGateway.execute` は `explain` 省略をfalseで補う。コマンドを直接呼ぶ場合はboolを渡す。`executionId` 省略時はRust側で空文字となるが製品UIはUUIDを渡す。接続の `readOnly` 省略はRustでもtrue、CA省略はNone。

## DB境界

SQLxがMySQLへ直接接続する。TLS `VerifyIdentity` を必須にし、指定CAまたはドライバの信頼CAを利用する。スキーマは `information_schema.TABLES / COLUMNS / KEY_COLUMN_USAGE` から取得。対象DB名は値バインド、プレビュー／全件出力の識別子は保持カタログ由来でバッククォートを二重化する。

任意SQLは `sqlparser::MySqlDialect` で検証し、全ての文を `describe` してから原文バッチを一度送る。実行計画はSELECTに `EXPLAIN` を付加。アプリの読み取り専用判定とDB権限は独立。[SQL詳細](../detailed-design/sql-execution.md)参照。

## ファイル・その他入出力

| 入出力              | 形式・対象                                          | 補足                                                                            |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| 外部接続JSON入力    | 単一 `ConnectionConfig`、最大64KiBのファイル        | BOM除去。暗号化保存ファイルとは非互換。入力元は変更しない                       |
| connections.json    | v2 AES-GCM/DPAPI envelope                           | アプリ設定ディレクトリ。v1読込・次回保存時移行                                  |
| queries.json        | v1 DPAPI envelope                                   | クエリ配列全体。旧配列は読込時に移行                                            |
| SQL                 | エディタ文字列、最大100,000 UTF-8バイトで実行検証   | 独立した `.sql` 読込／書出コマンドはない                                        |
| 汎用CSV出力         | UTF-8 BOM、全フィールド引用、カンマ、CRLF、ヘッダー | 取得済み結果と全件取得の差は[CSV詳細](../detailed-design/results-and-export.md) |
| 型保持CSV＋metadata | `round-trip.ts` のメモリ内API                       | UI／ファイル選択／DB取込には未接続                                              |
| キー設定            | `relagrid.shortcuts.v1` のJSON                      | WebView localStorage。Tauriコマンドを経由しない                                 |
| ウィンドウ操作      | Tauri core window API                               | 最小化・最大化切替・閉じる。独自コマンド一覧には含めない                        |

ブラウザで接続は拒否、接続・クエリ読込は空、保存は拒否。取得済み結果のCSVだけBlobダウンロードのフォールバックがある。テスト用IPCモックを製品のDBプロバイダーとみなさない。
