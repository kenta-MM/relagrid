# RelaGrid

Tauri + React + TypeScript + React Flow + shadcn/ui による、読み取り専用のMySQLデータベース探索アプリです。

## 起動

WindowsではNode.js 20以上、Rustup、Visual StudioのC++ビルドツール、WebView2が必要です。Rustは `rust-toolchain.toml` のバージョンを使用します。

```powershell
npm install
npm run dev
```

この1コマンドで画面の開発サーバーとTauriをまとめて起動します。バックエンド用サーバーの管理は不要です。初回はRustの依存ライブラリのダウンロードとコンパイルに時間がかかります。MySQLサーバーは別サービスとして稼働している必要があります。

起動時はデモモードです。「接続」からホスト（既定 `127.0.0.1`）、ポート（既定 `3306`）、DB名、ユーザー名、パスワードを入力すると実際のMySQLを探索できます。接続情報はディスクに保存しません。閲覧専用ユーザーの利用を推奨します。

画面だけをブラウザーで確認する場合は `npm run dev:web` を使用してください。このモードではデモが動きますが、MySQL接続はデスクトップ版専用です。

## 実装済み

- 接続先DBのベーステーブル、カラム、主キー、外部キーの取得
- カラム単位の関係図、ドラッグ、ズーム、ミニマップ、自動配置
- テーブル名・カラム名でのサイドバー検索、詳細表示、関連テーブルの強調
- 選択テーブルのプレビュー（先頭100件、各値最大500文字）
- スキーマ更新、接続切り替え・切断、アクティビティログ
- 実DBに接続せず利用できるデモ

SQLはアプリ側で生成する固定の読み取り処理のみです。MySQLのセッションも読み取り専用にし、SELECTの実行時間を5秒に制限しています。テーブル名は取得済みのカタログと照合し、識別子をエスケープします。パスワードをフロントの永続状態やログに保持しません。

## 構成と拡張

```text
src/
  app/                  画面全体の組み立て
  domain/               DBに依存しないデータ型・Gateway契約
  data/                 デモとTauri通信のGateway実装
  features/
    connection/         接続フォーム
    explorer/           探索状態・サイドバー・詳細・プレビュー
    graph/              関係図・ノード・自動配置
  components/ui/        shadcn/uiの構成に沿った共通部品（Radixベース）
  lib/                  共通ユーティリティ
  styles/               画面領域別のスタイル
src-tauri/src/
  lib.rs                Tauriコマンド・接続セッション管理
  models.rs             IPCのデータ型
  database/mysql.rs     MySQL固有のメタデータ取得・プレビュー
  database/mysql_sql.rs SQL定義・安全なプレビューSQLの組み立て
```

画面は `DatabaseGateway` に依存します。デモと実接続で同じインターフェースを使います。新しいDBを追加する場合はRust側のアダプターと接続設定を追加し、共通の `SchemaSnapshot` / `Preview` を返すようにします。Rust側でDB種別が2つ以上になる時点で共通トレイトを導入する想定です。現段階では不要な汎用化を避けています。

プレビュー要求には世代番号を持たせ、テーブル変更・接続変更後に古い結果が表示されるのを防ぎます。接続・更新・切断は同時実行を防ぎます。接続変更は、新しい接続とスキーマの取得に成功した時点で置き換えるため、失敗しても以前の接続は維持されます。

`components.json` でshadcn/uiの追加先・テーマを設定しています。UI部品はプロジェクト内で所有し、画面固有のスタイルと分離しています。TypeScriptのstrictモード、Prettier、Rustfmtを使用します。

## 検証

```powershell
npm run build
npm test
npm run test:e2e
npm run format:check
cargo test --manifest-path src-tauri/Cargo.toml
npm run check:rust
```

E2Eはインストール済みのMicrosoft Edgeを使います。レイアウト・循環参照・関連ノードの単体テストと、検索・選択・プレビュー・接続エラーの操作テストがあります。

MySQL統合テストは通常スキップします。**検証用の独立したMySQL**を `127.0.0.1:3307` に立て、`tests/fixtures/schema.sql` を投入してから実行してください。ユーザーは `root`、空パスワード、DBは `relagrid_fixture` です。既存の業務DBには投入しないでください。

```powershell
cargo test --manifest-path src-tauri/Cargo.toml mysql_fixture -- --ignored
```

このテストはスキーマ・外部キー・日本語・NULL・数値・バイナリの読み取りと、読み取り専用セッションがUPDATEを拒否することを確認します。

## 配布

```powershell
npm run build:desktop
```

Windowsインストーラーは `src-tauri/target/release/bundle/nsis/` に出力されます。配布版では開発サーバーやNode.jsは不要です。コード署名は未設定です。

## 初期版の範囲

- 対応DBはMySQL 8.0。初回に指定した1つのDBを表示します。
- 行数はMySQLの推定値です。外部キーのない関係は推測しません。
- DBをまたぐ外部キー、ビュー、インデックス詳細は未対応です。
- 複合外部キーはカラムごとに表示します。線の `FK` は外部キーを意味します。UNIQUE制約やNULL許可による厳密な多重度は判定しません。
- 大規模スキーマの仮想化、レイアウト永続化、データ編集、INSERT生成、依存データのコピー、環境間同期は未実装です。
- 自動配置は軽量な階層配置です。循環参照のある図の最適化は今後ELKなどへ差し替えられます。
- バイナリは16進文字列で表示します。プレビューは全文・全件エクスポートではありません。
