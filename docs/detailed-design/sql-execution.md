# 詳細設計：SQL検証・実行・実行計画・中断

[設計書目次](../README.md) / 対応機能：F-11〜F-12

## 責務・型・入口

[QueryWorkspace](../../src/features/query/QueryWorkspace.tsx) `run` / `stop` →[useExplorer](../../src/features/explorer/useExplorer.ts) `execute` →[Gateway](../../src/data/tauri-gateway.ts) →[lib.rs](../../src-tauri/src/lib.rs) `execute_query` / `cancel_query` →[query.rs](../../src-tauri/src/database/query.rs) `execute`。

入力はsql:string、explain:boolean（Gateway既定false）、executionId:string（UIはUUID）。現在Sessionのプールとread_onlyを使う。戻り値は `QueryResult` またはエラー文字列。`QueryResult.error` 付きで返る部分失敗もあるため、Promise成功だけで実行成功と判断しない。

## UI開始条件・確認

`canRun` は現在connectionId≠0、busyでない、inFlightでない、タブ所有接続が一致、SQL.trimが非空。runは同期refで再確認し、連打とキー重複を抑止する。選択範囲があってもSQL全文が対象。

現在接続が読み書き可能かつ通常実行なら[WriteQueryDialog](../../src/features/query/WriteQueryDialog.tsx)で接続先・SQL全文・破壊的操作と自動コミットの注意を出す。SELECTも確認対象。EXPLAIN取得は確認を省くがRustでSELECT限定。確定時はタブID・SQL文字列・connectionId・表示targetが要求時と一致する場合だけ実行する。

開始時にtabId/sql/UUIDを固定し、該当する通常結果または計画とその表示位置をクリアする。他方の結果は残す。途中のSQL編集は次回用。応答は開始元IDにのみ反映するので、タブや画面を移動しても別タブへ結果が流れない。

## 許可条件とSQL検証

`batch_statements` はUTF-8のsql.len≤100,000、実行可能コメント `/*!` / `/*M!` を含まないことを先に確認する。コメント文字列チェックは単純包含であり、文字列リテラル内でも該当すれば拒否される。

MySqlDialectのパーサーで文境界を求め、位置のUnicode文字単位を `byte_offset` でバイト単位へ変換する。引用符内のセミコロンを単純splitしない。先頭／連続の空文は拒否、末尾セミコロンは許可。各原文スライスを `validated_sql` で再検証する。

| 条件                 | 受付範囲                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| 読み取り専用・単文   | AST Query、またはanalyze=falseかつQueryに対するEXPLAIN。SELECT系でもDB権限に従う                      |
| 読み取り専用・複数   | 最大20文。各文が許可対象で、複数文対象種別の条件も満たす。実際に通るのはQuery群                       |
| 読み書き・単文       | パーサーが理解し、禁止セッション操作等に該当しないSQL。DML/DDLが可能だがDB権限・describeにも依存      |
| 読み書き・複数       | SELECTだけでも実行前に拒否。安全なトランザクション機能がないため                                      |
| explain=true         | 単一Queryだけ。原文へEXPLAINを付加                                                                    |
| Query／EXPLAINのINTO | 引用されていないINTOトークンを拒否。文字列・引用識別子内は除外                                        |
| セッション・制御     | 正規化AST先頭がSET、USE、START、BEGIN、COMMIT、ROLLBACK、PREPARE、EXECUTE、CALL、LOCK、UNLOCKなら拒否 |

読み取り専用／計画ではネストしたStatementもQuery/Explain以外を拒否する。対応するMySQL構文はsqlparserの解析範囲に限り、サーバーが受理する全文法を保証しない。汎用エラーメッセージにINSERT等の複数文対応が書かれていても、現在のread_only分岐では読み書き複数文は通らない。

## DB実行・結果組立

1. lib.rsはexecution Mutexの空きを確認し、中断用oneshotと実行IDを登録する。既に実行中なら即時Err。
2. operationはsession Mutexをロックし、現在接続を要求する。query.rsで全SQLを検証し、参照テーブル／CTE名をASTから重複除去して採取する。
3. 時間計測を開始し、プールから接続を取得してdetachする。接続のセッションは読み取りモードとSELECT制限が初期化済み。実行後この接続はプールへ戻さない。
4. 各文をdescribeし空結果用の列名を取得する。全て成功するまでユーザーSQLを実行しない。列定義が5,000,000バイト予算を超える場合も未実行でErr。
5. 通常実行は原文全体を `raw_sql(...).fetch_many` で一度送る。EXPLAINは生成した単文を送る。明示トランザクションは開始しない。
6. 行通知を現在ResultSetへ追加し、完了通知でaffectedRows/complete=trueを設定して次結果へ進む。列情報だけの0行結果も作る。想定外の結果数や全ての完了が確認できない場合は失敗。
7. 行・値・全体予算の上限を超える場合はtruncatedを立てる。行を保持できなくなっても後続結果へ進むためストリームを読み捨てる。詳細は[結果設計](results-and-export.md)。
8. 正常時は最大1秒で接続closeを試みる。異常／タイムアウトではソケットを破棄。結果が1つもなければErr、あれば取得済みsetsとerrorを返す。

UIは実行全体の失敗バナー、未完了結果、履歴エラーを表示する。Promise拒否は元タブをmessagesへ切り替える。finallyで実行ref/ID/cancellingとExplorer busyを解除する。読み書き通常実行後は失敗でもプレビューキャッシュを無効化する。

## 排他・時間・中断

describe〜取得のoperationに15秒タイマーを掛ける。同期パース、session Mutex待ち、プール取得（最大8秒）、成功時close（最大1秒）はこの15秒に含まれない。elapsedMsはquery.rsのプール取得前から結果組立直前までで、UIの確認待ちなどは含まない。DBセッションのMAX_EXECUTION_TIME=5000はSELECT向けであり、書込みの全体時間保証ではない。

stopは選択中タブのexecutionIdだけを送る。lib.rs `cancel_query` はID不一致／実行なしをErrにし、一致すれば通知する。`cancel_matching` は送信後も実行スロットを占有し、query側のリソース解放前に次実行を許可しない。`cancellable` はoperationとreceiverの早い方を採り、中断ではfutureを破棄してErrを返す。

中断コマンドの成功とSQL終了は別。UIはexecuteのfinallyまで中断待ちとし、実行中タブを閉じさせない。明示中断は取得途中結果を返さない。15秒タイムアウトは、既に作った結果があれば部分結果を返せる。中断通知エラーは同じ実行IDのタブへだけ表示し、再度の中断操作を可能にする。

クライアント接続を解放してもサーバー停止・自動コミット済み更新の取消を保証しない。UPDATE、DDL、ストアド関数等の副作用は実DBで確認が必要。SQLの自動再試行はしない。DB権限はSessionのread_onlyより強いセキュリティ境界として別途設定する。

## テスト対応

| 観点                                                                       | 既存テスト・識別子                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 100,000バイト／20文境界、Unicode位置、全件事前検証、INTO・コメント・制御文 | query.rs内 `accepts_exact_statement_and_utf8_byte_limits` / `batch_uses_parser_boundaries_and_preserves_original_literals` / `batch_checks_every_statement_before_execution`                           |
| 読取専用／読み書き差、EXPLAIN、更新複数文拒否                              | 同上 `enforces_connection_mode_and_single_statement` / `refuses_write_batches_before_any_statement_executes` / `explain_preserves_original_sql_and_does_not_allow_writes`                              |
| 古い中断ID、futureリソース解放                                             | lib.rs内 `stale_cancel_does_not_interrupt_current_execution` / `cancellation_releases_pending_operation_before_returning`                                                                              |
| 二重実行、所有タブ、編集中のSQL固定、部分失敗、確認後SQL／接続変更         | [QueryWorkspace.test.ts](../../src/features/query/QueryWorkspace.test.ts) `routes a delayed result...` / `requires writable SQL confirmation...` / `does not execute a stale writable confirmation...` |
| 接続変更排他、失敗後再試行                                                 | [useExplorer.test.ts](../../src/features/explorer/useExplorer.test.ts) `blocks reconnect and refresh while SQL runs...`                                                                                |
| 実画面と実DB                                                               | [query.spec.ts](../../tests/query.spec.ts)、mysql.rs内fixture、[native-query-smoke](../../tests/native-query-smoke.mjs)                                                                                |

本番DBでの更新は検証しない。通信断後の確定状態、非トランザクション表、KILLによる停止確認は未実装／追加運用確認。過去RG-02の更新混在バッチ成功記録は現在の許可仕様とは異なる。
