# RelaGrid

[![Tauri](https://img.shields.io/badge/Tauri-2.0.0-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19.0.0-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7.3-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-1.94.0-000000?logo=rust)](https://www.rust-lang.org/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql)](https://www.mysql.com/)
[![Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?logo=microsoft)](https://www.microsoft.com/windows)

RelaGrid は、MySQL のスキーマを可視化し、テーブル関係とデータの流れを探索できる Windows デスクトップアプリです。

Tauri + React + TypeScript + React Flow + shadcn/ui を採用し、読み取り専用で MySQL を安全に調査できます。

## 技術スタック

- アプリバージョン: `0.1.0`
- 言語:
  - TypeScript `~5.7.3`
  - Rust `1.94.0` (toolchain)
  - SQL / MySQL `8.0.44`（検証環境）
- フレームワーク・基盤:
  - React `19.0.0`
  - Vite `6.4.0`
  - Tauri `2.0.0`
  - React Flow `12.8.0`
  - Tailwind CSS `4.0.0`
  - shadcn/ui（Radix ベースの UI コンポーネント群）
  - Playwright `1.55.0`
- 実行環境:
  - Windows 11 / Windows 10 向けデスクトップアプリ
  - WebView2 依存
  - MySQL 8.0 を対象とした読み取り専用アクセス

## 起動

WindowsではNode.js 20以上、Rustup、Visual StudioのC++ビルドツール、WebView2が必要です。Rustは `rust-toolchain.toml` のバージョンを使用します。

```powershell
npm install
npm run dev
```

この1コマンドで画面の開発サーバーとTauriをまとめて起動します。バックエンド用サーバーの管理は不要です。初回はRustの依存ライブラリのダウンロードとコンパイルに時間がかかります。MySQLサーバーは別サービスとして稼働している必要があります。

起動時はデモモードです。「接続」からホスト（既定 `127.0.0.1`）、ポート（既定 `3306`）、DB名、ユーザー名、パスワードを入力すると実際のMySQLを探索できます。接続情報はディスクに保存しません。閲覧専用ユーザーの利用を推奨します。

React・ViteはTauri内の画面を構築するために使用します。`dev:ui` はTauriと画面テストが内部で呼び出す開発サーバー用コマンドです。通常の開発では `npm run dev`、アプリ全体のビルドでは `npm run build:desktop` を使用してください。`npm run build` はアプリに組み込む画面部分を生成する内部工程です。ブラウザ版の配布は対象にしていません。

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

画面のE2Eは、デスクトップ版と共通のReact画面をインストール済みのMicrosoft Edge上で検証します。ブラウザ版製品のためではなく、画面の回帰テスト用です。レイアウト・循環参照・関連ノードの単体テストと、検索・選択・プレビュー・接続エラーの操作テストがあります。実際のTauri通信の検証は `tests/native-smoke.mjs` が担当します。

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

アイコンはWindows用の `src-tauri/icons/icon.ico` と、再生成用の元画像 `source.png` のみ管理します。

## 初期版の範囲

- 対応DBはMySQL 8.0。初回に指定した1つのDBを表示します。
- 行数はMySQLの推定値です。外部キーのない関係は推測しません。
- DBをまたぐ外部キー、ビュー、インデックス詳細は未対応です。
- 複合外部キーはカラムごとに表示します。線の `FK` は外部キーを意味します。UNIQUE制約やNULL許可による厳密な多重度は判定しません。
- 大規模スキーマの仮想化、レイアウト永続化、データ編集、INSERT生成、依存データのコピー、環境間同期は未実装です。
- 自動配置は軽量な階層配置です。循環参照のある図の最適化は今後ELKなどへ差し替えられます。
- バイナリは16進文字列で表示します。プレビューは全文・全件エクスポートではありません。
