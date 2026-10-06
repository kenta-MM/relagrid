# 詳細設計：接続・グループ・TLS・保存

[設計書目次](../README.md) / 対応機能：F-01〜F-03

## 責務・実装

| 実装                                                                                                              | 主要識別子・責務                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [ConnectionDialog](../../src/features/connection/ConnectionDialog.tsx)                                            | `submit` / `importFile`。フォーム・ファイル入力、エラー、待機中の閉鎖抑止                                             |
| [connection-file](../../src/features/connection/connection-file.ts)                                               | `parseConnectionFile`。外部JSONの実行時型検証                                                                         |
| [useExplorer](../../src/features/explorer/useExplorer.ts)                                                         | `connect` / `selectConnection` / `disconnect` / `persist` / `addConnectionGroup` / `moveConnection`。UI状態・保存順序 |
| [Sidebar](../../src/features/explorer/Sidebar.tsx) / [GroupDialog](../../src/features/connection/GroupDialog.tsx) | `dropHandlers`、グループ追加・移動の入力                                                                              |
| [Gateway](../../src/data/tauri-gateway.ts) / [store](../../src/data/connection-store.ts)                          | `mysqlGateway` / `connectionStore`。IPC境界                                                                           |
| [lib.rs](../../src-tauri/src/lib.rs)                                                                              | `connect_database` / `disconnect_database` / `Session`。現在接続の交換                                                |
| [mysql.rs](../../src-tauri/src/database/mysql.rs)                                                                 | `connection_options` / `connect`。入力・TLS・プール設定                                                               |
| [connection_store.rs](../../src-tauri/src/connection_store.rs)                                                    | `load_connections` / `save_connections` / `validate` / `seal` / `unseal` / `os_protect`。保存と改ざん検知             |

## 入出力と検証

入力型は `ConnectionConfig`、成功結果は `SchemaSnapshot`。フォームのhost既定はループバック、port=3306、username/database/passwordは空、readOnly=true、group/CAは任意。host/database/groupはtrim、username/passwordは入力を維持する。

| 境界     | 条件・失敗動作                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| フォーム | host/database/username必須、portは1〜65535のnumber入力。CAはmaxLength=65536。HTMLの検証とRust検証の両方がある                                   |
| ファイル | `File.size` が64KiB超なら読まない。UTF-8 BOMを取り除きJSON.parse、非配列オブジェクト必須                                                        |
| JSON     | host/database/usernameは非空文字列、portは整数1〜65535、password/group/CAは任意文字列、readOnlyは任意bool。password省略は空、readOnly省略はtrue |
| JSONのCA | JS文字数64KiB以内、PRIVATE KEYを含めない。PEM証明書としての検証は接続時に行う                                                                   |
| Rust接続 | host/databaseはtrim後非空、usernameは `is_empty` で検査。portはu16。CAはUTF-8バイト長64KiB以内、BEGIN CERTIFICATEを含みPRIVATE KEYを含めない    |
| 保存     | IDはu32の正数かつ一意、port≠0、host/database/usernameはtrim後非空。不正な保存要求で既存ファイルを置換しない                                     |

外部JSON読込はフォームを埋めるだけで接続しない。取消／構文失敗は接続先を変えない。暗号化connections.jsonはこのインポート形式ではない。入力ファイルを書換・削除しない。画面入力、JSON、Rust接続、保存で検証条件が完全一致していない点は[確認事項](../design-verification.md)に記録する。

## 接続・切り替え・切断

1. 起動時の `connectionStore.load` 成功でconfigs Mapと一覧・groups・次IDを復元し、`storageReady=true`。失敗はconnectionErrorとログへ表示し、既存ファイルへの保存を許可しない。完了後も未接続のまま。
2. `beginOperation` はloadingまたは同期refの `operationInFlight` が立っていれば開始しない。Reactのdisabled更新前の連打も抑止する。
3. `connect_database` はsession Mutexを保持して新プールを作成。`VerifyIdentity` でCA・期限・ホスト名を検証し、検証省略の再接続はしない。
4. プールは最大3接続・取得待機8秒。各新規接続へTRANSACTION READ ONLYまたはREAD WRITEとMAX_EXECUTION_TIME=5000を設定する。アプリがDBユーザーの権限を増減する処理はない。
5. 新プールでスキーマを取得。失敗したら新プールだけcloseしてErr。以前のSessionは交換しない。成功したらsessionIdを採番して交換し、旧プールをcloseする。
6. UIは接続ID（既存選択なら同じID）とgroupを登録し、現在接続・DB・モードを更新。`accept` でプレビューキャッシュを破棄し、選択を維持可能なら維持、なければ最初のテーブルへ。
7. 接続成功ログ後に一覧を保存する。保存だけ失敗した場合はエラーを表示するが、新しい接続・メモリ上の一覧は維持する。DB接続の成功と保存成功は別である。

既にアクティブな接続の再選択は何もしない。切断はプールをclose後に未接続へ移し、activeConnectionId=null、DB名空、readOnly=true、スキーマとプレビューを空にする。保存済み接続・グループは残す。失敗時は旧表示を保持しログへ通知する。SQLタブの保持規則は[クエリ管理](query-management.md)参照。

SQL実行中はExplorerの同じ操作refで接続変更を拒否する。Rust側でもSQL・プレビュー・スキーマ更新・全件CSVがsession Mutexを使い、接続交換を直列化する。自動再接続・自動リトライはなく、失敗後は利用者が再選択する。接続からスキーマ取得までの一括タイムアウトは設定していない。

## グループ

グループ名はtrim後非空かつ同名未登録。追加時は変更候補を保存してからメモリへ反映する。移動も既知グループまたはグループ外だけ許可し、保存成功後にconfigsと一覧を更新する。失敗時に所属を変更しない。DB再接続・DBトランザクションは不要で、分類のファイル更新だけを行う。

Sidebarは内部の `draggedId` と `application/x-relagrid-connection` の一致を確認する。busy中はドラッグ不可。外部からの任意IDドロップをそのまま受け入れない。空グループも残り、名称変更・削除UIはない。GroupDialogは非同期保存完了前に閉じるため、失敗はサイドバー側のエラーとなる。

## 暗号化・復元・保存

[データモデル](../basic-design/data-model.md)のv2 envelopeを使用する。`seal` は保存ごとにランダムAES-256鍵、パスワードごとに96ビットnonceを生成し、メタデータAAD付きAES-GCMで暗号化。鍵は現在WindowsユーザーのDPAPIで保護しBase64化する。非Windowsでは安全でない保存へフォールバックせずErr。

`unseal` は形式、Base64、保存モデル、暗号文の最短長（nonce12＋tag16）、認証、UTF-8を検証する。v1のCA混入は拒否。通常の読込には移行書込みを伴わず、v1は次回保存でv2となる。`StoreState(Mutex<bool>)` は読込成功まで保存を禁止し、保存時もread(path)で破損・外部変更を再検査する。同じフォルダーの一時ファイルへ暗号化済みバイトを書き、sync_all後persistする。パスワード平文を一時ファイルに出さない。

平文の資格情報はUIのconfigs MapとRust接続設定に存在する。鍵の一部バッファはZeroizingだが、全ての資格情報メモリをゼロ化する仕様ではない。グループ配列全体の完全性認証や複数アプリプロセス間のファイル排他は実装していない。

## テスト対応

| 観点                                          | 既存テスト・識別子                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初期復元、自動接続しない、切り替え失敗保持    | [useExplorer.test.ts](../../src/features/explorer/useExplorer.test.ts) `restores saved credentials...` / `preserves the active connection...`                                                                              |
| 保存失敗・グループ移動・読込失敗後上書き禁止  | 同上 `reports save failures...` / `does not overwrite settings...`、[saved-connections](../../tests/saved-connections.spec.ts)、[connection-group](../../tests/connection-group.spec.ts)                                   |
| JSON型、BOM、上限、フォーム保持、待機中閉鎖   | [connection-file.test.ts](../../src/features/connection/connection-file.test.ts)、[connection-file.spec.ts](../../tests/connection-file.spec.ts)、[connections.spec.ts](../../tests/connections.spec.ts)                   |
| DPAPI往復、nonce、暗号文交換、破損保持、v1/CA | connection_store.rs内 `dpapi_aes_round_trip_and_fresh_nonces` / `ciphertext_cannot_be_swapped_between_connections_in_the_same_file` / `ca_configuration_is_authenticated_and_legacy_fields_are_not_trusted`（Windows限定） |
| 信頼CA、期限、ホスト不一致、非TLS、CA上限     | [tls_tests.rs](../../src-tauri/src/database/tls_tests.rs) `verified_tls_reaches_authentication_only_with_trusted_matching_certificate` / `untrusted_expired_wrong_host_and_non_tls_never_receive_credentials`              |
| 実DB権限差・接続・プレビュー                  | mysql.rs内 `mysql_fixture_schema_preview_and_read_only`（通常ignore）、[native-connection-file-smoke](../../tests/native-connection-file-smoke.mjs)、[native-group-smoke](../../tests/native-group-smoke.mjs)              |

TLSテストはローカル模擬ハンドシェイクで認証へ進むかを確認し、実DBの全SQL互換性検証ではない。実Windowsユーザー変更・端末移送や本番の最小権限運用は今回未実施。
