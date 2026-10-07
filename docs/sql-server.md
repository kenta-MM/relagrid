# SQL Server Express対応（Issue #25）

## 接続の準備

接続画面でSQL Server Expressを選び、ホスト・TCPポート・DB名・SQL Server認証のユーザー名とパスワードを指定します。既定ポートは1433ですが、Expressの実際のポートを確認してください。

WindowsのSQL Server Configuration Managerで対象インスタンスのTCP/IPを有効にし、IPAllのTCP動的ポートを空にして固定TCPポートを設定し、SQL Serverサービスを再起動します。SQL Server認証を使うにはサーバーの認証モードをSQL ServerとWindows認証の混合モードにし、対象DBにログインを対応付けたユーザーを作成します。リモート接続では設定したTCPポートへのアクセスも許可します。サーバー管理者と設定を確認してください。

`host\SQLEXPRESS` 形式、SQL Browserによる自動探索、Windows統合認証、LocalDBの名前付きパイプは対象外です。名前付きインスタンスでもホストと実際のTCPポートを指定します。通常の閲覧にはSELECT権限を持つ専用ユーザーを使います。見えるメタデータはそのユーザーの権限に依存します。

JSON例は [sqlserver.example.json](../connections/sqlserver.example.json)。`databaseKind` は `sqlServer`、省略時は従来どおりMySQLです。接続と保存クエリにDB種別を保持し、再接続・復元・SQLエディタの方言にも反映します。

## ドライバーとTLS

[Tiberius 0.13.0](https://docs.rs/tiberius/0.13.0/tiberius/)（MIT / Apache-2.0、最低Rust 1.88）を使用します。Windows/TauriのRustバックエンドからTDS/TCPで接続し、native-tls（WindowsではSchannel）で証明書を検証します。MySQL用の初期化SQLや識別子引用は使用しません。

- TLS無効（既定）: 非TLSを要求し、通常は通信を暗号化しません。追加CA設定は使いません。サーバーが暗号化を要求した場合、ドライバーはTLSを交渉してOSの信頼ストアで検証するため、信頼できない証明書では接続に失敗します。暗号化必須のサーバーにはTLSを明示的に有効にし、必要なCAを指定してください。
- TLS有効: TLS必須で接続し、OSの信頼済みCAと任意の追加CA、接続ホスト名を検証します。失敗時に非TLSへ切り替えません。
- `tlsCaPem` は最大64KiBのPEM証明書。秘密鍵は指定できません。追加CAは接続ごとにメモリ内で適用し、OSの信頼ストアは変更しません。証明書のSANには接続ホスト名またはIPが必要です。

接続保存はAES-GCM + Windows DPAPIのv4形式です。DB種別・TLS・CAも認証対象に含めます。v1/v2はTLS有効のMySQL、v3は保存したTLS設定のMySQLとして読み込み、次回保存でv4になります。旧形式への未認証のDB種別追加は拒否します。保存クエリのDB種別も既存の暗号化ペイロードに含まれます。

## 対応範囲と制約

| 操作 | SQL Serverの仕様 |
| --- | --- |
| スキーマ | ベーステーブル・カラム・主キー・外部キー。`[schema].[table]` で同名テーブルを区別 |
| プレビュー | 先頭100行、値500文字。主キーがあれば主キーで並べ替え |
| SELECT | T-SQLパーサーで解析できる単一SELECT / CTE。空結果でも列名を保持 |
| 更新 | 書き込み許可時のみ単一INSERT / UPDATE / DELETE。自動コミット、影響行数を表示 |
| 未対応 | DDL、EXEC、GO、複数文、OUTPUT、SELECT INTO、外部データアクセス、シーケンス更新、セッション変更、明示トランザクション、実行計画 |
| 読み取り専用 | アプリの構文検証。SQL Serverのセッション読み取り専用保証ではないためDB権限も制限 |
| 型変換 | NULL、Unicode、整数、浮動小数、decimal/numeric、日時、GUID、XML、バイナリ。decimalは文字列で精度維持、バイナリは16進 |
| 独自型 | プレビュー・全件CSVで未対応型を明示エラー。SQLで対応する標準型へCONVERTして取得 |
| SQL結果 | 512列、1,000行、値5,000文字、約5MB。行数・容量上限で接続を解放し、結果を未完了・省略ありとして表示 |
| 待機 | 接続8秒、スキーマ・プレビュー・SQL実行取得は各15秒、ロック待ち5秒 |
| 中断 | 操作ごとの接続を破棄。サーバーの即時停止・更新ロールバックは保証しない（#19） |
| 全件CSV | 既存の確認・進捗・中断・一時ファイル確定を共用。BOM付きUTF-8、引用、数式対策を適用。10分・512列、1セル1MiB・1行8MiB上限。超過時は完成ファイルを確定しない |

日時はSQL Serverの値を表示します。MySQLのTIMESTAMP向けUTCセッション変換は行いません。全件CSVはサーバー側で値サイズを制限して超過を検出します。任意SELECTの上限は保持結果への制限で、ドライバーが単一の巨大値を受信する際のメモリ上限は保証しません。トリガーによる副作用や結果セットは初期サポートの対象外です。

## 実接続スモークテスト

通常のRustテストは外部DBを必要としません。以下はアプリ本体の `Database` / SQL Serverアダプターを通す明示実行のテストです。専用サーバーにのみ実行してください。新規の `relagrid_fixture_` で始まるDBを作成し、成功時に削除します。途中失敗時は専用環境ごと後片付けしてください。同名の既存DBを削除して開始する処理はありません。

インポート形式のJSONに `databaseKind: "sqlServer"`、専用ホスト・ポート、未使用の `relagrid_fixture_...` DB名、作成・削除可能なテスト専用資格情報、TLS設定を書きます。JSONはGit管理外に置き、検証後に資格情報とともに削除します。

```powershell
$env:RELAGRID_SQLSERVER_TEST_ISOLATED = 'true'
$env:RELAGRID_SQLSERVER_TEST_CONFIG = 'C:/temporary/express-test.json'
cargo test --manifest-path src-tauri/Cargo.toml sql_server_express_adapter_smoke -- --ignored --nocapture
```

2026-10-07にWindowsクライアントから、公式SQL Serverコンテナーの `MSSQL_PID=Express` に接続して確認しました。Editionは **Express Edition (64-bit)**、製品バージョンは **16.0.4295.3**、認証はSQL Server認証です。イメージは `mcr.microsoft.com/mssql/server@sha256:4402d880dd4c34bfa7d8705e56a86cd6c88da80a1f6bbbe741f999e76264a090`。サーバーはLinuxであり、Windows版Express固有のサービス設定・配布アプリでの確認は別途必要です。

TLSなし／専用CA付きTLSありの両方で、接続・メタデータ・同名別スキーマ・PK/FK・Unicode・高精度decimal・NULL・バイナリ・空結果・更新件数・上限・CSV用ストリーム・切断再接続を確認しました。サーバーの `encrypt_option` も照合し、TLSありではCA未指定の接続失敗を確認しています。接続保存の移行・改ざん拒否はRustテスト、画面のDB種別・ポート・インポート・復元・方言・実行計画無効化はIPCを模擬したPlaywrightで検証しています。

サーバーの `network.forceencryption=1` でも、TLS無効・追加CAなしは接続失敗、TLS有効・専用CA指定では同じスモークテストが成功しました。

このスモークテストは環境の自動構築を行いません。再現可能なExpress専用環境と包括的な回帰テストは [#26](https://github.com/kenta-MM/relagrid/issues/26)、CI組み込みは [#27](https://github.com/kenta-MM/relagrid/issues/27) の対象です。
