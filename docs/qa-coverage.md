# QA検証記録（2026-09-29）

## 調査範囲

`src/` の全TypeScript・TSX・CSS、`src-tauri/src/` の全Rustソース、起動・ビルド・権限設定、既存の単体・画面・ネイティブテストを読み、READMEと機能別検証記録と照合した。依存ライブラリ本体や生成物はレビュー対象外。

本変更は不足していたテストと実行手順の追加。アプリ本体の振る舞い、依存パッケージ、製品の設定形式は変更していない。Rustファイルの追加コードは `#[cfg(test)]` 内のみ。

## 追加した自動テスト

| 層・対象                 | 追加ケース                                                                                                                                                     | ファイル                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 単体：ショートカット設定 | 壊れたJSON・null・競合設定からの復旧、部分設定、未知フィールド、解除済みキー、保存失敗時の状態維持と再試行、複数購読者への反映、修飾キーとアクセシビリティ表記 | `src/lib/shortcut-settings.test.ts`                   |
| 単体：キー入力           | SQL以外の入力・編集領域、IME/229、AltGraph、処理済みイベント、ダイアログ、対象なし、長押し時の重複実行と伝播の抑止                                             | `src/lib/shortcuts.test.ts`                           |
| 単体：接続とプレビュー   | 更新/切断失敗時の接続・キャッシュ保持と再試行、読み書き接続でSQL成功/失敗後のキャッシュ破棄、EXPLAIN/読み取り専用では保持、古いエラーの無視、未接続実行の拒否  | `src/features/explorer/useExplorer.test.ts`           |
| 単体：CSV                | 書き込み失敗に続く一時ファイル削除失敗を、削除済みと誤報しないこと                                                                                             | `src/features/csv/export.test.ts`                     |
| Rust：SQL                | 20文・UTF-8で100,000バイトの境界、書き込み可能接続でもセッション操作を拒否、EXPLAINの原文保持と更新拒否、保持容量の一致境界とNULLの管理領域                    | `src-tauri/src/database/query.rs`                     |
| Rust：プレビューSQL      | 複合主キーの順序、スキーマ・列名の引用、バイナリとテキストの扱い、主キーなし、100行上限                                                                        | `src-tauri/src/database/mysql_sql.rs`                 |
| Rust：保存               | 不正な接続ID・重複ID・ポート・空欄を拒否して既存ファイルを保持、同一ファイル内の暗号文交換を拒否、不正IDのクエリファイルを上書きしない                         | `src-tauri/src/connection_store.rs`、`query_store.rs` |
| Rust：CSV                | 数式先頭文字の保護と通常文字の保持、64KiBのUTF-8バイト境界                                                                                                     | `src-tauri/src/csv_export.rs`                         |
| 画面：接続               | 64KiB超過・不正JSON・BOM・同じファイルの再読み込み・不正入力時のフォーム保持、接続待機中の閉じる/Escape抑止と失敗後の復旧                                      | `tests/connection-file.spec.ts`                       |
| 画面：保存クエリ         | 実CodeMirrorから保存/全保存し再読込後に復元、未保存変更を復元しない、保存失敗後の未保存状態と閉じる取消、読込失敗時の保存禁止                                  | `tests/saved-queries.spec.ts`                         |
| 画面：設定               | ストレージ書込失敗時に編集中設定と有効なキーを保持、解除済みキーの再読込と初期化                                                                               | `tests/settings.spec.ts`                              |
| ネイティブ：SQL          | 実Tauri/MySQLで複数結果、0行結果の列、読み取り専用拒否、中断と再実行、SQLのファイル保存・画面再読込・接続復元                                                  | `tests/native-query-smoke.mjs`                        |

追加数はVitest 24件、Rust 10件、Playwright 7件、ネイティブスモーク1シナリオ。画面テストは実際にVite画面をEdgeで起動するが、DB/ファイル保存の応答は模擬する。実IPC・実DB・DPAPI・実ファイルの検証とは区別する。

既存の `tests/native-smoke.mjs` はリレーション画面で開始することを暗黙に要求していた。SQL画面から続けて実行すると失敗したため、開始時にリレーション画面へ移動する操作を追加し、実行順への依存を解消した。

## 実行結果

| 検証                                 | 結果                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Vitest                               | 128件成功（追加前104件）                                                                               |
| Rust通常テスト                       | 27件成功（追加前17件）、実DB用2件は通常スキップ                                                        |
| Edge画面テスト                       | 23件成功（追加前16件）、1ワーカー・60秒設定                                                            |
| 隔離MySQL統合                        | 2件成功。全件CSVの1,205行・長文・NULL・高精度数値・サイズ超過による既存ファイル保持を含む              |
| ネイティブSQLスモーク                | 成功。QAプロファイルで実IPCと実DBを使用                                                                |
| 既存ネイティブスモーク               | 成功。接続、プレビュー、失敗後の接続保持、更新、切断                                                   |
| フロントビルド・QAデスクトップビルド | 成功。既存の500kB超バンドル警告あり                                                                    |
| Clippy・Rustfmt・差分空白チェック    | 成功                                                                                                   |
| リポジトリ全体のPrettier             | 既存の `.github/instructions/playwright.instructions.md` と `.vscode/` 3ファイルで失敗。これらは未変更 |

ネイティブ画面のスクリーンショット `test-results/native-query.png` も確認した。`test-results/` は再実行で更新される検証生成物であり、Git管理には含めない。

検証後にQAアプリと隔離MySQLの終了を確認し、通常設定でデスクトップ版を再ビルドした。通常のユーザー設定・既存MySQLサービスは変更していない。

## 再実行

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:e2e -- --workers=1 --timeout=60000
npm run build
npm run check:rust
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

画面テストは1ワーカーで実行する。今回の初回再実行では、既存ケース1件と追加ケース1件が30秒で停止した。ページ読込・要素待機のタイムアウトを記録し、上記60秒の設定で再確認した。自動リトライやアサーションの削除で隠さない。

### 隔離MySQL

> 以下は2026-09-29時点の実行記録です。現在のRust実接続テストは [MySQL実接続テスト](mysql-integration.md) の自動実行手順を使用してください。旧固定ポート・root接続のコマンドは現在のテスト設定に適用しません。

通常テストでスキップされる2件は、READMEのfixture専用MySQLが必要。今回の検証は既存サービスを使わず、新規の一時データ領域・ループバック3307ポートで実施した。MySQL実行ファイルのパスは端末に合わせて指定する。

```powershell
# 3307が未使用であることを確認してから実行する。
$mysqlBin = 'C:\Program Files\MySQL\MySQL Server 26.7\bin'
$qaRoot = Join-Path $env:TEMP ('relagrid-qa-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $qaRoot | Out-Null
& "$mysqlBin\mysqld.exe" --no-defaults --initialize-insecure --datadir="$qaRoot\mysql" --console
$qaMysql = Start-Process -FilePath "$mysqlBin\mysqld.exe" -WindowStyle Hidden -PassThru -ArgumentList @(
  '--no-defaults', "--datadir=$qaRoot\mysql", '--port=3307',
  '--bind-address=127.0.0.1', '--mysqlx=OFF', '--console'
) -RedirectStandardOutput "$qaRoot\mysql.out.log" -RedirectStandardError "$qaRoot\mysql.err.log"
# mysql.err.logのready for connectionsを確認してから投入する。
Get-Content -Raw -Encoding utf8 tests/fixtures/schema.sql |
  & "$mysqlBin\mysql.exe" --no-defaults --host=127.0.0.1 --port=3307 --user=root --default-character-set=utf8mb4
cargo test --manifest-path src-tauri/Cargo.toml mysql_fixture -- --ignored --test-threads=1
```

全件CSVテストが一時テーブルを作り、スキーマテストが2テーブルを期待するため、同じDBへのテストは直列にする。下記ネイティブテストとも同時に実行しない。検証後、この手順で起動したPIDまたはその子プロセスが3307を使用し、コマンドラインのデータ領域が `$qaRoot\mysql` であることを確認してから、`mysqladmin.exe --no-defaults --host=127.0.0.1 --port=3307 --user=root shutdown` で停止する。

### デスクトップ版

通常のユーザー設定を変更しないため、`tests/fixtures/tauri.qa.json` で識別子 `com.relagrid.qa` の検証用アプリをビルドする。保存先は `%APPDATA%\com.relagrid.qa`。通常版の `com.relagrid.desktop` とは別。スモークは起動したアプリの識別子を実IPCで照合し、違う場合は操作前に停止する。

```powershell
npm run tauri -- build --debug --no-bundle --config tests/fixtures/tauri.qa.json
# 隔離MySQLの検証完了後、同じfixtureを使う。
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
$env:WEBVIEW2_USER_DATA_FOLDER = "$qaRoot\webview"
$qaApp = Start-Process .\src-tauri\target\debug\relagrid.exe -WindowStyle Hidden -PassThru
node tests/native-query-smoke.mjs
```

実SQLは合成データのみ。更新SQLは読み取り専用接続で拒否されるケースを確認する。保存成功後に未保存変更を加え、画面を再読込して保存版のみ復元し、復元した接続を選んで再実行する。これは画面の再読込であり、OS再起動やプロセス強制終了からの復旧確認ではない。

テストは検証用プロファイルに接続と保存クエリを残す。失敗時もスクリプトはCDPを切断し、アプリは調査用に残す。終了時は自分で起動した `$qaApp` を終了し、上記の環境変数を解除する。QAビルドは通常と同じdebug実行ファイルの場所を使うため、通常開発へ戻る際は `npm run dev` で通常設定からビルドし直す。検証用アプリを製品版として配布しない。

## 残る実機検証ケース

| ケース                                 | 操作と期待結果                                                                     | 状態                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 対象MySQL 8.0                          | 同じfixtureを8.0で実行し、スキーマ・SQL・CSVが成功する                             | 今回の実機は26.7.0。8.0は未実施                                    |
| ネイティブ保存ダイアログ               | 保存先取消、既存CSVへの保存、出力途中の中断。取消/中断では既存ファイルを変更しない | Rustでファイル保持、画面で模擬保存を検証。実ダイアログ操作は未実施 |
| 実ディスク不足・権限・ネットワーク切断 | 隔離した保存先で失敗を発生させ、エラー表示・既存ファイル保持・再試行を確認する     | 模擬エラーのみ。実環境障害は未実施                                 |
| 実IME・OS予約キー                      | 日本語変換中に実行・終了キーを押し、SQLを誤実行せず入力を保持する                  | 合成IMEイベントのみ。実候補ウィンドウは未実施                      |
| プロセス強制終了・電源断               | 出力途中に検証プロセスを終了し、完成ファイル保持とpartialの扱いを確認する          | 未実施                                                             |
| インストーラー                         | クリーン環境へのインストール・起動・更新・削除                                     | 未実施                                                             |

コード網羅率100%や全障害条件の確認を意味しない。追加テストは保守時のデータ消失・誤操作・失敗後の復旧・境界値に重点を置く。
