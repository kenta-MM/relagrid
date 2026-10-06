# 基本設計：データモデル

[設計書目次](../README.md)

## メモリ内モデル

根拠：[TypeScriptドメイン](../../src/domain/database.ts)、[Rustモデル](../../src-tauri/src/models.rs)、[QueryWorkspace](../../src/features/query/QueryWorkspace.tsx)。Rustのsnake_caseフィールドは原則 `serde(rename_all = "camelCase")` でIPCに変換する。

| 型                 | 主なフィールド・意味                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConnectionConfig` | host・database・username・passwordはstring、portはTS number / Rust u16。readOnlyはbool（既定true）、tlsCaPemは任意string。TSのgroupは一覧分類用でDB接続引数として使用しない |
| `ConnectionEntry`  | id:number、database、host、port、group?。サイドバー用。資格情報は含めず `connectionConfigs` Mapに分離                                                                       |
| `SchemaSnapshot`   | sessionId?:string/null、tables:Table[]、relationships:Relationship[]                                                                                                        |
| `Table`            | id=`database.name`、schema、name、estimatedRows:number/null、columns:Column[]。実取得ではestimatedRows=None                                                                 |
| `Column`           | name、dataType（MySQL COLUMN_TYPE）、nullable、primaryKey                                                                                                                   |
| `Relationship`     | id=`source.constraint.ordinal`、sourceTable/sourceColumn、targetTable/targetColumn。複合FKは列ペアごとに1レコード                                                           |
| `Preview`          | columns:string[]、rows:(string/null)[][]。列順と行内位置で対応。SQL型・精度情報を保持しない                                                                                 |
| `QueryResultSet`   | Preview＋affectedRows:number、truncated:boolean、complete:boolean                                                                                                           |
| `QueryResult`      | Preview互換フィールド＋elapsedMs、affectedRows合計、truncatedのOR、referencedTables、resultSets、error?                                                                     |
| `QueryTab`         | id/name/sql/savedSql、所有connectionId/label/readOnly、result/plan/error、表示種別・結果番号、views、executionId/cancelling                                                 |
| `ResultView`       | page、size、top、left。タブ内の `result:番号` / `plan:番号` をキーに保持                                                                                                    |
| `Execution`        | 実行UUID、tabId、開始時sql、表示時刻、結果／エラー、explain、所有接続。履歴最大50件                                                                                         |
| `LogEntry`         | id、ja-JPの時刻文字列、message、error。アクティビティ最大100件                                                                                                              |

`sessionId` はRust `NEXT_SESSION` が接続成功ごとに発行する文字列で、同一DB名でも接続世代を区別する。保存接続IDとは異なる。`useExplorer.sessionId` は別のUI内数値カウンターであり、全件出力に渡すのは `snapshot.sessionId`。

テーブルの業務構造は接続時に取得するため固定の業務ER図は定義しない。関係は「Snapshotが複数TableとRelationshipを持つ」「TableがColumnを持つ」「Relationshipが両端のTable IDとColumn名を参照する」。多重度や業務上の意味は推定しない。同一スキーマ内の取得済み両端のみを扱う。

## 永続化

| 保存対象       | 形式と保存タイミング                                               | 復元・非保存対象                                                                    |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 接続＋グループ | app_config_dirのconnections.json。接続成功後、グループ追加・移動時 | 起動時に一覧・資格情報だけ復元。自動接続なし                                        |
| 保存クエリ     | 同ディレクトリのqueries.json。保存／全保存                         | 保存済みSQL・名前・接続ID/表示名/モードを全タブとして復元。閉じた保存済み項目も残る |
| キー設定       | localStorage、設定画面で保存                                       | 不正JSONや割当競合は既定値に戻す                                                    |
| CSV            | 利用者が選んだ外部パス                                             | アプリが自動復元する対象ではない                                                    |

スキーマ、図の位置、検索、プレビューキャッシュ、実行結果、実行履歴、アクティビティ、未保存SQL編集はアプリファイルに保存しない。結果が別接続タブに残っていても取得当時のデータである。

### 接続保存形式

[connection_store.rs](../../src-tauri/src/connection_store.rs) `Envelope` は `{format, protectedKey, data:{connections, groups}}`。各接続は `{id, group, config}`。形式識別子は `relagrid-connections-v2-aes256gcm-dpapi`。`config.password` は12バイトnonce＋暗号文＋認証タグのBase64。256ビットAES鍵を保存ごとに再生成し、DPAPIで保護した鍵を `protectedKey` に格納する。

AADには形式・ID・group・host・port・username・database・readOnly・CAを含める。これらのメタデータ自体は平文。groups配列全体や項目の削除を完全性検証する設計ではない。v1はCAなしで復号し、次の保存でv2。v1にCAが追加されていれば拒否する。

### クエリ保存形式

[query_store.rs](../../src-tauri/src/query_store.rs) `Envelope` は `{format:"relagrid-queries-v1-dpapi", payload:Base64}`。payloadは `SavedQuery[]` のJSON全体をDPAPIで保護したもの。`SavedQuery` はid/name/sql/connectionId/connectionLabel/readOnly。IDは正かつ一意。SQL本文の100KB制限は保存時には適用せず実行時に適用する。

旧平文配列を読むと同じパスに暗号化保存してから成功を返す。接続とクエリの2ファイルをまとめて確定するトランザクションはない。保存クエリのconnectionIdが存在することをRustの保存検証では確認しない。

保存は同じディレクトリの一時ファイルへ書込み・sync_all・persist。読込失敗時はUIとRustで保存を禁止し、保存直前にも既存ファイルを読み直す。破損ファイルを空設定で上書きしない。別Windowsユーザー／端末への移送は通常復号できず、汎用バックアップ・同期仕様は未定義。
