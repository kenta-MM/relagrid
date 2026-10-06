# 基本設計：共通仕様・非機能・運用

[設計書目次](../README.md)

## 検証・権限・エラー

UIは必須入力・操作中状態・接続所有を確認するが、DB接続、SQL許可判定、対象テーブル照合、暗号化保存、ファイル確定はRustで再検証する。アプリの独立したログイン機構はなく、DBユーザーの権限とWindowsユーザーのDPAPIに依存する。[本番接続ガイド](../production-access.md)の最小権限方針を参照。

読み取り専用は既定true。SQL AST検証と `SET SESSION TRANSACTION READ ONLY` を併用する。読み書きでは通常実行前に接続先とSQLを確認し、1文の自動コミットに限定する。サーバーの権限付与／変更はアプリで行わない。TLSは `VerifyIdentity`、検証なしへのフォールバックはない。

エラーはPromise拒否または `QueryResult.error` として画面に表示する。自動再接続・SQL自動再試行はない。SQLのサーバーエラーを一律に匿名化する処理もないため、ログ・履歴の表示情報を完全に無害化済みとは扱わない。アクティビティはメモリ内100件、実行履歴は50件で監査ログではない。

## 実装上の上限

| 対象           | 現行値・意味                                                         | 根拠                                                                                |
| -------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 接続           | プール最大3、acquire_timeout 8秒                                     | [mysql.rs](../../src-tauri/src/database/mysql.rs) `connect`                         |
| 通常SELECT     | SESSION MAX_EXECUTION_TIME=5000ms                                    | 同上。全SQLやUI全操作の時間保証ではない                                             |
| SQL入力        | UTF-8で100,000バイト、最大20文。読み書き・EXPLAIN・DDLは1文          | [query.rs](../../src-tauri/src/database/query.rs) `batch_statements`                |
| SQL取得        | describeから取得まで15秒、成功時close最大1秒                         | `execute`。プール取得や同期パースは15秒の外                                         |
| SQL表示保持    | 結果ごと1,000行、文字値5,000コードポイント、バイナリ2,500バイトをHEX | `execute` / `retain_row`                                                            |
| 結果の保持予算 | 全結果合計5,000,000バイト（列名・セル文字列・管理領域）              | プロセス総メモリ上限ではない。IPC・互換コピー・履歴・ドライバは別                   |
| プレビュー     | 100行、値の文字列表現500文字                                         | [mysql_sql.rs](../../src-tauri/src/database/mysql_sql.rs) `preview_query`           |
| 接続JSON入力   | ファイル64KiB                                                        | [ConnectionDialog](../../src/features/connection/ConnectionDialog.tsx) `importFile` |
| CA入力         | Rustで最大64KiB、証明書開始マーカー必須、秘密鍵不可                  | `connection_options`。UIの文字数制限とは単位が異なる                                |
| CSV IPC書込    | 65,536 UTF-8バイト／呼出、同時出力1件                                | [csv_export.rs](../../src-tauri/src/csv_export.rs) `MAX_CHUNK` / `CsvExportState`   |
| 全件CSV        | 600秒、1〜512列、値はmin(1MiB, floor(8MiB/列数))バイト               | `export_table_csv` / `export_cell_limit`。固定行数上限なし、HEX展開後で判定         |
| CSV共通読取API | 32MiB、1レコード8MiB、データ10,000行、4,096列                        | [csv.ts](../../src/features/csv/csv.ts)。全件出力の上限とは別                       |

接続・スキーマ取得・プレビューを一括で囲うアプリ側タイマーはない。SQL中断は保留futureと専用接続の破棄であり、サーバーでの停止確認やロールバックを保証しない。全件CSVの600秒には接続ロック待ち・プール取得・取得処理が含まれるが、保存先選択と最後の同期・置換は外側。

## 設定・ビルド・配布

| 項目         | 仕様・参照                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| アプリ識別子 | `com.relagrid.desktop`。保存先はTauri app_config_dir（WindowsではAPPDATA配下）                                                                                                                   |
| ウィンドウ   | 初期1480×940、最小1000×720、decorations=false、dragDropEnabled=false。[tauri.conf.json](../../src-tauri/tauri.conf.json)                                                                         |
| CSP・権限    | 配布UIはself、IPCへの接続などを許可。window操作権限は[default.json](../../src-tauri/capabilities/default.json)。汎用ファイルパス書込APIを公開しない                                              |
| 依存         | [package.json](../../package.json)と[Cargo.toml](../../src-tauri/Cargo.toml)の範囲指定、実解決版は[package-lock.json](../../package-lock.json)と[Cargo.lock](../../src-tauri/Cargo.lock)         |
| 開発         | Node.js 20以上、Rust指定toolchain、C++ビルドツール、WebView2。`npm run dev` でTauriとVite                                                                                                        |
| UIビルド     | `npm run build` = TypeScript検査＋Vite。distをTauriへ同梱                                                                                                                                        |
| デスクトップ | `npm run build:desktop`。NSISを生成。通常ビルドは開発用未署名                                                                                                                                    |
| リリース     | [workflow](../../.github/workflows/release-windows.yml)がv*タグとバージョン一致、専用runner、windows-production、証明書設定を要求。署名・タイムスタンプ・改ざん拒否・内包EXEの一致を検証して公開 |

署名スクリプトは[Sign-Artifact](../../scripts/windows/Sign-Artifact.ps1)、[Verify-Signature](../../scripts/windows/Verify-Signature.ps1)、[Test-Tampering](../../scripts/windows/Test-Tampering.ps1)。証明書・runner・GitHub Environmentの実配置と本番署名実績は本調査では未確認。[運用手順](../windows-release.md)に従う。

自動アップデート、障害時の自動復旧、ファイルの世代バックアップ、全体性能目標は定義されていない。強制終了時のCSV `.partial` は未完成品で、再開処理はない。定量性能やOS実機検証の残件は[照合結果](../design-verification.md)を参照。
