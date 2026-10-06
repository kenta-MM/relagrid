# 詳細設計：結果表示・CSV出力・共通API

[設計書目次](../README.md) / 対応機能：F-13〜F-16

## 責務・実装

| モジュール                                                                                                                     | 主要識別子・責務                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [QueryWorkspace](../../src/features/query/QueryWorkspace.tsx)                                                                  | `resultSets` / `ResultTable` / `updateView` / `exportCsv`。結果所有、ページ、出力対象の固定              |
| [query.rs](../../src-tauri/src/database/query.rs)                                                                              | `empty_set` / `retain_row` / `execute`。結果分離と保持予算                                               |
| [CsvExportDialog](../../src/features/csv/CsvExportDialog.tsx)                                                                  | `ExportSelection` / `start`。取得済み結果の保存・中断・再試行                                            |
| [export.ts](../../src/features/csv/export.ts)                                                                                  | `CsvSink` / `streamGenericCsv` / `openCsvSink`。結果をチャンク化して保存                                 |
| [BottomPanel](../../src/features/explorer/BottomPanel.tsx) / [TableExportDialog](../../src/features/csv/TableExportDialog.tsx) | テーブルとsessionIdを固定して全件出力                                                                    |
| [csv_export.rs](../../src-tauri/src/csv_export.rs)                                                                             | `CsvExportState` / `ExportFile` / `source_table` / `stream_table`、5コマンド。ファイル確定とDBストリーム |
| [mysql_sql.rs](../../src-tauri/src/database/mysql_sql.rs)                                                                      | `export_query` / `export_cell_limit`。カタログ由来SELECTとサイズ検出                                     |
| [csv.ts](../../src/features/csv/csv.ts) / [round-trip.ts](../../src/features/csv/round-trip.ts)                                | CSV構文、汎用出力、型とNULLの往復API                                                                     |

## 結果保持と表示

`QueryResult.resultSets` があれば使い、旧単一結果なら `complete=true` の1結果として表示する。Rustは互換用columns/rowsに先頭結果をコピーし、affectedRowsは各結果合計、truncatedはORを返す。

値はstring/null。型名BINARY/VARBINARY/BLOB/BITまたはUTF-8不正の値をバイナリ扱いにして最大2,500バイトを大文字HEXにする。他は最大5,000コードポイント。元の値が長ければtruncated。列名と管理領域、セルのUTF-8バイトとOption<String>のサイズを全結果で加算し、5,000,000バイト以内で行を保持する。結果単位の行数は1,000。残予算を超える行は途中列まで保存せず、その結果の以降の行も保持しない。通信は後続結果を受けるため継続する。

truncatedは「省略あり」、complete=falseは「取得未完了」。列あり0行の正常結果、列ありだが上限省略、未完了で行なし、列なしの更新件数を区別してcaptionを表示する。結果のerrorは実行全体の失敗として扱う。

結果／計画／メッセージ、選択結果番号、ページ・行数・縦横スクロールはQueryTabに保持。既定はpage0、size10、scroll0、選べるsizeは10/25/100。ページ／サイズ変更でスクロールを0へ、結果・タブ変更で保存位置を復元する。再実行は該当側の結果とviewsをリセットする。表示・ページ移動・結果CSVはDBを再実行しない。

結果と履歴はメモリに残るため、5MBはアプリ全体の上限ではない。タブ数の明示上限や履歴の総バイト上限もない。

## 2種類の汎用CSV

| 項目     | 取得済み結果（F-14）                                            | テーブル全件（F-15）                                                     |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 入力     | `ExportSelection {result, name, label}`。選択中の結果または計画 | `ExportSource {sessionId, tableId}`。保存先選択時の対象                  |
| 条件     | columns.length>0。メッセージ／更新件数のみは不可                | Tauri、mysql、tableあり、busyでなくsessionIdあり                         |
| DB       | アクセスしない。取得済み全ページを出す                          | 新規のカタログ由来SELECT。プレビュー行数を使わない                       |
| 省略     | 取得時に切れた行／値を復元しない。未完了も告知して出力可能      | 100行／500文字／SQL結果1,000行制限はなし。値上限超過は全出力を失敗させる |
| 件数     | 開始時に既知                                                    | 終了時に確定、行順保証なし                                               |
| 形式     | UTF-8 BOM、全フィールド引用、カンマ、CRLF、ヘッダー             | 同左                                                                     |
| 値       | NULL→空文字、危険な先頭にアポストロフィ                         | 同左。バイナリ・BIT・地理型はHEX。TIMESTAMPはUTC、DATETIMEは保存表現     |
| 末尾改行 | なし                                                            | 最終レコードにもCRLF                                                     |
| 中断     | AbortController、チェック時にsink.abort                         | oneshotでDB future破棄、ファイルcleanup                                  |
| ブラウザ | Blobダウンロードにフォールバック                                | 提供しない                                                               |

数式対策は先頭が `=` / `+` / `-` / `@` / タブ / CR のとき `'` を付加し、ヘッダーにも適用する。負数も文字列として変更される。NULLと空文字は区別できず、型・精度メタデータを付けない。可逆なDBバックアップ形式とは扱わない。

## 取得済み結果の処理

1. `exportCsv` でresult参照と名前を固定する。複数結果では名前に `-result-番号` を付ける。
2. startのcontroller refで重複要求を防ぎ `openCsvSink` を呼ぶ。Tauriでは `begin_csv_export({name})` で保存先を選ぶ。取消はnullで終了。
3. `streamGenericCsv` はヘッダーと1行ずつ `exportGenericCsv` を適用。ヘッダーのみBOMを残し、データ行にはCRLFを前置する。
4. UnicodeコードポイントごとにUTF-8サイズを計算し最大64KiBに分割。各sink.write完了を待ち、進捗を通知しsetTimeout(0)で描画・中断の機会を作る。
5. 中断チェック後にsink.finish。途中失敗ではsink.abortを試し、削除にも失敗した場合はその旨のエラーを優先して返す。

実行中はダイアログを閉じない。アンマウント時もabort要求。失敗・取消後は再試行可能で、新規出力として最初から開始する。ブラウザでは全partsをBlobにしダウンロードを開始するだけで、ディスク保存完了は判定できない。結果出力の全体時間制限は実装していない。

## 全件取得・進捗・競合

`begin_csv_export` にsourceを付けると保存先選択前後に現在sessionIdとtableIdを照合する。`export_table_csv` でもfileに保持したsourceとの一致と、現在snapshotの一致を再検証する。同名テーブルが別接続に存在しても出力しない。

DBセッションMutexを取得からreader解放まで保持する。1〜512列を検証し、poolからdetachした接続でREAD ONLY、time_zone='+00:00'、MAX_EXECUTION_TIME=600000を設定する。読み書き接続からでも全件出力専用接続は読み取り専用。明示トランザクションや複数テーブルの一貫性制御はない。

`export_query` は各カタログ列を文字またはHEXに変換しBINARYへCAST、`LEFT(..., limit+1)` で上限超過を検出できる1バイトを追加取得する。limitは `min(1,048,576, floor(8,388,608/列数))`。schema/table/columnは引用し、LIMIT/ORDER BYは付けない。

Rustは行ストリームから値を取得し、セル上限と合計8MiBを先に確認してから厳密UTF-8へ変換する。超過・不正文字・取得失敗はレコード／列位置付きエラー。行をcsv writerに渡し、100行ごとにyield、250ms以上経過時にflushしてChannelへ件数を送る。完了時にもflushと最終件数通知。通知失敗は画面通信終了として処理を失敗させる。

接続ロック待ちからstream終了まで600秒で制限する。完了後のsync_all/persistはタイマー外。中断受信口はbeginで作成し、開始前・完了直前の通知も `table_cancellable` で確認する。中断はSQL実行のcancel_queryとは別API。確定処理に入った後の取消は保証しない。

UIはsessionIdまたはExplorer busyの変更で全件出力ダイアログを閉じ、そのcleanupで中断を要求する。選択テーブルの変更だけなら出力対象は開始時に固定したまま。Rustにも別の出力状態Mutexと中断送信Mutexがあり、DBストリーム中にabortを送れる。接続切り替え・他DB操作はsession Mutexの解放を待つ。

## ファイル状態・副作用・復旧

`CsvExportState` は最大1つのExportFileと中断送信口を保持。beginは保存ダイアログをspawn_blockingで開き、保存先と同じディレクトリに `.relagrid-export-*.partial` を作る。任意パスをIPC引数に取らない。write/finishは出力IDを照合する。

writeのサイズ／I/O失敗でactiveを破棄し、後からfinishできなくする。finishはsync_allの後persistで保存先を置き換える。abortは一致するジョブへ通知してから部分ファイルを削除する。通常失敗では既存完成ファイルを変更せずcleanupし、cleanup失敗も返す。全件出力はコマンド内でfinishまで行うためUIからfinishを追加送信しない。

再試行は新しい保存先選択から。途中再開、自動retry、強制終了で残るpartialの自動回収はない。DBへの書込副作用はなく、ファイルの置換と読み取り負荷が副作用となる。

## CSV構文・型保持API（UI未接続）

`decodeCsvUtf8` は32MiB以下のバイト列をfatal UTF-8デコード。`parseCsv` はBOMを許容し、カンマ、CRLFまたはLF、空行を自動スキップせず、レコード8MiB・列4,096・データ10,000行まで検証する。`writeCsv` は不正サロゲートを拒否し、全セル引用・BOM・CRLF・末尾改行なしで出力する。構文エラーは `CsvDataError(code, record, column)` とし、パーサーの生メッセージにあるセル値を公開しない。

`encodeRoundTrip(columns, rows)` → `{csv, metadata}`、`decodeRoundTrip(csv, rawMetadata)` → `{columns, rows}`。metadataはformat=relagrid-csv、version=1、encoding=utf-8、bom/header=true、delimiter=カンマ、newline=CRLF、nullEncoding=backslash-v1、rowCount、columns。`readMetadata` が未知形式・不正な型範囲を拒否する。

NULLは `\N`、非NULLでバックスラッシュ開始ならもう1つ付加する。復号ではそれ以外の先頭バックスラッシュを拒否。ヘッダー名・列順・行数・NULL許可を照合し、値は数値へ変換せず文字列を保持する。型保持APIでは数式対策文字を付加しない。

| 型             | 検証条件                                                                |
| -------------- | ----------------------------------------------------------------------- |
| text           | 任意の最大コードポイント数。不正Unicodeは拒否                           |
| integer        | signed/unsigned、8/16/32/64bit、BigInt範囲。指数・小数・先頭ゼロは不可  |
| decimal        | precision 1〜65、scale 0〜precision。固定小数文字列の桁数検証、丸めなし |
| boolean        | true/falseの文字列のみ                                                  |
| date           | YYYY-MM-DD、西暦0001〜9999、閏日を検証                                  |
| datetime       | ISOのT区切り、時分秒の範囲、小数秒0〜7桁、offsetなし                    |
| datetimeOffset | 同上＋Zまたは±HH:MM（最大±14:00）必須                                   |
| binary         | 偶数桁HEX、任意maxBytes。大文字小文字を維持                             |

共通APIにDBアクセス・トランザクション・非同期中断・永続設定は該当しない（同期メモリ処理）。DB型マッピング・ファイル読込画面・DB取込は未実装。[RG-04](../rg-04.md)は形式の補足として参照する。

## テスト対応

| 観点                                                           | 既存テスト                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 結果独立、0件、更新件数、未完了、省略、再実行                  | [QueryWorkspace.test.ts](../../src/features/query/QueryWorkspace.test.ts)、[query.spec.ts](../../tests/query.spec.ts)、query.rs内retentionテスト                                                                                                                       |
| チャンク境界、Unicode、ヘッダーのみ、中断、cleanup失敗、再試行 | [export.test.ts](../../src/features/csv/export.test.ts)、[CsvExportDialog.test.ts](../../src/features/csv/CsvExportDialog.test.ts)                                                                                                                                     |
| 対象固定、古いsession、開始前／完了直前中断                    | [TableExportDialog.test.ts](../../src/features/csv/TableExportDialog.test.ts)、[BottomPanel.test.tsx](../../src/features/explorer/BottomPanel.test.tsx)、csv_export.rs内 `stale_session_cannot_export_same_named_table` / `table_cancel_prevents_start_and_completion` |
| 完成先保持、書込上限、確定失敗、cleanup                        | csv_export.rs内 `only_finished_export_replaces_destination` / `oversized_chunk_and_failed_commit_leave_no_completed_output` / `chunk_limit_counts_utf8_bytes_and_accepts_the_exact_boundary`                                                                           |
| 1,205行、長文、高精度、NULL、UTC、超過保持                     | csv_export.rs内 `mysql_fixture_full_table_export`（通常ignore）、[table-export.spec.ts](../../tests/table-export.spec.ts)（画面側はIPC模擬）                                                                                                                           |
| CSV構文・往復・型・NULL・位置付きエラー・境界                  | [csv.test.ts](../../src/features/csv/csv.test.ts)、mysql_sql.rs内export SQL生成テスト                                                                                                                                                                                  |

実保存ダイアログ、ネットワークドライブ、実ディスク不足、電源断、権限別全件出力の実機結果は今回未確認。過去記録と残件は[照合結果](../design-verification.md)。
