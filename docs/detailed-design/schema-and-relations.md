# 詳細設計：スキーマ・検索・関係図

[設計書目次](../README.md) / 対応機能：F-04〜F-06

## 責務・型・入口

[mysql.rs](../../src-tauri/src/database/mysql.rs) `schema(pool, database)` が `SchemaSnapshot` を組み立て、[mysql_sql.rs](../../src-tauri/src/database/mysql_sql.rs) の `TABLES` / `COLUMNS` / `RELATIONSHIPS` が取得SQLを定義する。[lib.rs](../../src-tauri/src/lib.rs) `connect_database` と `refresh_schema` が呼び出す。

UIは[useExplorer](../../src/features/explorer/useExplorer.ts) `accept` / `refresh` / `select`、[Sidebar](../../src/features/explorer/Sidebar.tsx)、[SchemaGraph](../../src/features/graph/SchemaGraph.tsx) `Graph`、[schema-layout](../../src/features/graph/schema-layout.ts) `layoutTables`、[TableNode](../../src/features/graph/TableNode.tsx)、[TableDetails](../../src/features/explorer/TableDetails.tsx) が分担する。型は[ドメイン](../../src/domain/database.ts)のTable/Column/Relationship。

## 取得順序・DB条件

1. TABLESにdatabaseをbindし、BASE TABLEだけをTABLE_NAME順で取得する。ビューは対象外。COUNTやTABLE_ROWSは取得しない。
2. COLUMNSを同じDBに絞りTABLE_NAME, ORDINAL_POSITION順で取得。COLUMN_TYPE・IS_NULLABLE・COLUMN_KEYをCHARに変換し、ドライバ型差を吸収する。
3. テーブル名をキーとするMapへカラムをまとめ、nullableはYES、primaryKeyはPRIで判定。Table IDは `database.name`、estimatedRowsは常にNone。
4. KEY_COLUMN_USAGEはTABLE_SCHEMAとREFERENCED_TABLE_SCHEMAの両方を同じdatabaseで絞る。取得済みBASE TABLEに両端が存在する列ペアだけRelationshipにする。複合FKはORDINAL_POSITIONごとに識別する。
5. 接続時は新しいsessionId、更新時は以前のsessionIdを設定して返す。更新成功時だけSession内snapshotを交換する。

必要なのは対象のメタデータが見えるDB権限。アプリ独自の権限昇格はない。3回の取得を囲う明示トランザクションはなく、外部DDLとの一貫したスナップショットは保証しない。DBへのデータ更新は行わない。

失敗は `db_error` で読取エラー文字列にしIPCへ返す。接続時の失敗は新接続を破棄、更新時は既存snapshot・プレビューを維持してログへ表示する。手動更新で再試行可能。専用キャンセルはなく、プール取得8秒・セッションのSELECT制限5秒以外にschema全体タイマーはない。

## UI反映・検索・選択

`accept` はキャッシュを空にしプレビュー要求世代を更新する。選択IDが新snapshotにあれば保持し、なければ先頭テーブル、空なら空文字とする。更新失敗ではacceptを呼ばない。

Sidebarはテーブル名・スキーマ名・全カラム名を連結し、小文字化した検索文字列で部分一致する。検索のtrimやDB問い合わせはない。検索は図や接続一覧を絞り込まない。テーブル選択は図・サイドバー・詳細内の参照リンクが同じ `select` を呼ぶ。詳細のタブはテーブルIDをkeyにし、テーブル変更時に概要へ戻る。

`relatedTableIds` は選択自身とFKの直接の隣接テーブルだけを返す。推移的な依存探索ではない。「関連テーブルを強調」は無関係ノードと線を薄くする処理で、削除／非表示にはしない。

## レイアウト・描画

`layoutTables` は参照元→参照先をparents Mapにし、明示スタックの深さ優先探索で深さを求める。自己参照を階層計算から除外し、訪問中ノードへの循環を既知深さなしの参照として扱う。深さは最大6（0〜6）。入力順で決定し、最適配置を保証するアルゴリズムではない。

位置は `x=level*340+40`、各階層のyは前テーブルの `120+columns.length*25` を積算して40加える。大量の連鎖でJS呼出スタックを消費しない。snapshot変更で配置を作り直し、100ms後fitView。手動の自動配置は初期位置に戻し50ms後fitViewする。

FK線は `out:列名` から `in:列名` のハンドルへsmoothstep、矢印は参照先、ラベルはFK。多重度は表示しない。ズーム範囲0.15〜1.8、ミニマップあり。ノード移動はUI内のみ、線接続・再接続・Deleteは無効。位置をファイルに保存しない。

描画と検索は同期メモリ処理のためDBトランザクション・再試行・タイムアウトは該当しない。React Flowの状態更新とタイマーのcleanupを使う。大量スキーマのUI性能目標は要確認。

## テスト対応

| 観点                                                   | 既存テスト                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 循環、自己参照、欠落参照、連鎖、配置の安定性、隣接集合 | [schema-layout.test.ts](../../src/features/graph/schema-layout.test.ts)                                                                              |
| 更新成功／失敗、接続競合、選択と古い応答               | [useExplorer.test.ts](../../src/features/explorer/useExplorer.test.ts)                                                                               |
| 検索、選択、強調、詳細、パネル                         | [explorer.spec.ts](../../tests/explorer.spec.ts)、[sidebar.spec.ts](../../tests/sidebar.spec.ts)、[inspector.spec.ts](../../tests/inspector.spec.ts) |
| 実DBの2テーブルとFK、型変換                            | mysql.rs内 `mysql_fixture_schema_preview_and_read_only`、[native-smoke](../../tests/native-smoke.mjs)                                                |

DB権限で一部テーブルだけ見える場合、クロススキーマFK、同時DDLでの欠落、大規模スキーマの描画時間は追加確認観点。全てを既存テストで保証したとは扱わない。
