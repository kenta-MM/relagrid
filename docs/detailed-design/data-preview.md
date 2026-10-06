# 詳細設計：データプレビュー

[設計書目次](../README.md) / 対応機能：F-07

## 責務・入出力

[TableDetails](../../src/features/explorer/TableDetails.tsx)の「データを表示」→[App](../../src/app/App.tsx)で下部タブをpreviewに設定→[useExplorer](../../src/features/explorer/useExplorer.ts) `browse` →[Gateway](../../src/data/tauri-gateway.ts) `preview` →[lib.rs](../../src-tauri/src/lib.rs) `preview_table(tableId)` →[mysql.rs](../../src-tauri/src/database/mysql.rs) `preview` と[mysql_sql.rs](../../src-tauri/src/database/mysql_sql.rs) `preview_query` の順で処理する。

入力は現在snapshot内のTable ID。Rustはsessionが存在し、そのsnapshotにIDがあることを必須にする。任意のテーブル名やSQLを入力から直接実行しない。出力は `Preview {columns:string[], rows:(string|null)[][]}`。カラムはメタデータ順、NULLはnull、表示はNULLの強調文字。

## SQLと制限

カタログ由来のschema/table/columnをバッククォートで引用し、内部のバッククォートは二重化する。非バイナリはCHAR CHARACTER SET utf8mb4へCAST、binary/blob/bit/地理型はHEXへ変換し、各表現の先頭500文字を返す。列型判定は括弧より前の型名で行い、enumの値などと混同しない。

PKがあればカラム配列順にORDER BYを作り、なければORDER BYなし。LIMIT 100。複合PKの索引定義順を別途取得しているわけではない。結果全体をfetch_allし、列位置からOption<String>として取り出す。SELECT権限が必要、明示トランザクション・DB更新はない。

省略情報や総件数はPreview型にない。100件返却や500文字の値だけで元データがその長さだと断定できない。固定行数・値長以外の全体バイト予算は設定していない。

## キャッシュと非同期競合

`previewsByTable: Map<string, Preview>` は現在接続／スキーマのメモリ内キャッシュ。選択で `invalidatePreview` が要求世代 `revision` を増やし、表示・エラーをリセットした後キャッシュがあれば表示する。キャッシュ未取得のテーブルを選択するだけではDB取得しない。明示的なbrowseで再取得し、同じテーブルの成功結果を置き換える。0件の成功もキャッシュする。

開始時はExplorer操作中または同じ世代のpreview要求中なら無視する。要求ごとに世代を増やし、その値をキャプチャする。完了時の世代が一致する場合だけキャッシュ・表示・ログを更新する。選択変更後の旧成功／旧エラーを反映せず、旧finallyで新要求のbusyを解除しない。

接続成功・更新成功・切断成功で全キャッシュを破棄。これらの失敗では以前のキャッシュを維持する。読み書き接続の通常SQL実行後は成功／失敗にかかわらず破棄する（更新済みの可能性があるため）。読み取り専用やEXPLAINでは保持する。

Rustは取得中session Mutexを保持し、接続交換を待たせる。UI上の旧要求無視はDBクエリのキャンセルではない。プレビュー専用中断APIや全体タイマーはなく、プール取得とSELECT制限に依存する。

## エラー・復旧・依存

対象テーブルなしはスキーマ更新を促す。SQL／デコード失敗は読取エラーとしてIPC拒否、現行世代のみ `previewError` とログへ表示しbusy解除。自動リトライはなく「データを表示」で再試行する。失敗時に以前のキャッシュを削除する処理はなく、再選択すると以前の成功結果が表示されうる。画面には取得時刻・鮮度ラベルを保持していない。

[BottomPanel](../../src/features/explorer/BottomPanel.tsx)は取得中→エラー→結果→未取得の順に描画する。全件CSVボタンはこのキャッシュを利用せず[別処理](results-and-export.md)へ進む。永続設定はなく、セッション終了でキャッシュを失う。

## テスト対応

| 観点                                       | 既存テスト・識別子                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 重複要求、古い成功／失敗、新しい選択のbusy | [useExplorer.test.ts](../../src/features/explorer/useExplorer.test.ts) `deduplicates preview requests...` / `allows a new selection...` / `does not show a stale preview error...` |
| キャッシュ復元、0件、再読込、更新失敗      | 同上 `restores each table preview...` / `also retains successful empty previews` / `retains cached previews...`                                                                    |
| SQL後無効化とEXPLAIN／読取専用の保持       | 同上の読み書きモード別パラメータ化ケース                                                                                                                                           |
| 識別子、型、複合PK、PKなし、100行          | mysql_sql.rs内 `preview_orders_composite_keys_and_escapes_every_identifier`、他SQL生成テスト                                                                                       |
| UIと実DB                                   | [explorer.spec.ts](../../tests/explorer.spec.ts)、mysql.rs内fixtureテスト、[native-smoke](../../tests/native-smoke.mjs)                                                            |

SELECT権限なし、同時DDLで列が変わる場合、巨大列数時のメモリ、実ネットワーク断は追加確認観点。アプリ側で望ましい動作を補完した仕様にはしない。
