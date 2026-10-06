# 詳細設計：共通状態・エラー・ログ・ショートカット

[設計書目次](../README.md) / 対応機能：F-17〜F-19、全機能の共通制御

## 状態の所有と排他

| 所有者・実装                                                                                             | 状態・主要識別子                                                            | 更新・競合制御                                                                    |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [App](../../src/app/App.tsx)                                                                             | screen、query（検索）、relatedOnly、tab（下部）、sidebarOpen、inspectorOpen | 画面・パネル・検索の表示。DB接続処理はExplorerへ委譲                              |
| [useExplorer](../../src/features/explorer/useExplorer.ts)                                                | snapshot、selected、接続一覧／モード、busy、preview、logs、configs Map      | `beginOperation` の同期ref、`revision` による旧プレビュー応答の無視、storageReady |
| [QueryWorkspace](../../src/features/query/QueryWorkspace.tsx)                                            | tabs、tabId、history、保存状態、ダイアログ                                  | inFlight/saving ref、実行元tabId/UUID、保存時SQLスナップショット                  |
| [Rust AppState](../../src-tauri/src/lib.rs)                                                              | `session: Mutex<Option<Session>>`、`execution: Mutex<Option<(id,sender)>>`  | 現在接続の直列利用とSQL同時1件、中断後も解放までスロット維持                      |
| [接続store](../../src-tauri/src/connection_store.rs) / [query store](../../src-tauri/src/query_store.rs) | 読込成功boolのMutex                                                         | 読めなかったファイルへの保存禁止。各ファイル別に直列化                            |
| [CSV state](../../src-tauri/src/csv_export.rs)                                                           | ExportFileと中断送信口の別Mutex                                             | 同時出力1件、ID照合、ストリーム処理へ中断通知可能                                 |
| [キー設定](../../src/lib/shortcut-settings.ts)                                                           | module内shortcuts、listeners                                                | `useSyncExternalStore` で購読。localStorage保存成功後に通知                       |

UIのdisabledだけに排他を依存しない。previewはExplorerの通常操作refとは別要求を持ち、複数世代の通信が残りうるが旧応答を破棄する。全件CSVはExplorerのSQL実行枠とは別でRustのsessionロックを共有する。これらを単一の「全処理busy」と読み替えない。

画面状態にDBトランザクションは該当しない。副作用は委譲先のDB処理・保存処理に限定する。Reactローカル状態、ref、Rust Mutexを使い、独立したグローバル状態管理ライブラリは導入していない。

## エラーと復旧

| 発生箇所               | 伝播先・保持動作                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| 接続追加               | ConnectionDialog内エラー。以前の接続は保持                                                  |
| 既存接続選択           | connectionError＋アクティビティ                                                             |
| 接続保存・グループ保存 | connectionError＋ログ。接続成功後の保存失敗は新接続を保持、グループ変更は保存成功まで未反映 |
| スキーマ更新・切断     | ログ。失敗時は以前の状態保持                                                                |
| プレビュー             | 現行世代のみpreviewError＋ログ                                                              |
| SQL                    | 元タブerror・messages／部分結果バナー・履歴。自動再実行なし                                 |
| クエリ保存／復元       | storageError。保存失敗はdirty維持、復元失敗は保存禁止                                       |
| CSV                    | 各ダイアログmessage、部分ファイルのcleanup失敗も通知                                        |
| ショートカット保存     | 設定画面のエラー。メモリの有効設定は変えない                                                |
| ウィンドウ操作         | console.error。専用の画面通知・再試行処理はない                                             |

共通の例外境界・自動リトライキュー・集中監査ログは実装していない。業務データを含まないエラーだけを保証するフィルターもない。復旧は各画面で手動再試行。壊れた保存ファイルを自動修復・削除せず、読込エラーで保持する。

## アクティビティ

`useExplorer.log(message, error=false)` は単調増加id、`toLocaleTimeString('ja-JP')`、message、errorを作り、末尾99件＋新規1件を保持する。[BottomPanel](../../src/features/explorer/BottomPanel.tsx)のrole=logで時刻・色・本文を表示しclearLogsで空にする。接続・更新・切断・プレビュー・保存エラー等を記録する。SQL履歴とは別で、全ユーザー操作を網羅しない。ファイル永続化・ログ転送・日時込み監査レコードはない。

## ショートカット既定値

根拠：[shortcut-settings.ts](../../src/lib/shortcut-settings.ts) `shortcutDefinitions`。ModはCtrlまたはMetaを同じ割当として扱う。

| 操作ID                       | 既定キー                       | 適用条件                                                    |
| ---------------------------- | ------------------------------ | ----------------------------------------------------------- |
| search                       | /                              | 一般入力欄・SQL入力の外。サイドバーを開いて検索へフォーカス |
| sidebarOpen / sidebarClose   | Mod+B / Mod+B                  | 同じキーならトグル。別設定なら明示開閉                      |
| inspector                    | Mod+Alt+B                      | 詳細パネル開閉                                              |
| relations / sql / switchMode | Mod+1 / Mod+2 / Mod+Shift+M    | 画面切り替え、SQL入力は可                                   |
| newQuery / closeQuery        | Mod+N / Mod+W                  | アクティブSQLワークスペース内                               |
| saveQuery / saveAllQueries   | Mod+S / Mod+Shift+S            | 同上。保存可能状態のみ                                      |
| nextQuery / previousQuery    | Mod+Tab / Mod+Shift+Tab        | 同上、端で循環                                              |
| run / runAlternate           | F5 / Mod+Enter                 | 同上、全文実行条件を確認                                    |
| stop                         | Shift+F5                       | 同上、現在タブの実行だけ                                    |
| previousResult / nextResult  | Alt+ArrowLeft / Alt+ArrowRight | 結果領域内、通常結果表示、2結果以上                         |

[shortcuts.ts](../../src/lib/shortcuts.ts) `shortcutTarget` はdefaultPrevented、isComposing、keyCode229、AltGraph、開いたdialog/alertdialog、SQL以外のinput/textarea/select/contenteditableを除外する。`claimShortcut` はpreventDefault/stopPropagationし、長押しではactionを呼ばない。SQLキーはwindowのcaptureで処理し、実行不可でも認識したキーをブラウザのF5等へ渡さない。

画面をキーで変更した後、SQL入力または選択中の画面ボタンへフォーカスを移す。パネルを閉じる場合も必要に応じてフォーカスをメインへ戻す。CodeMirrorのTab補完等は別の編集キーとして維持する。

## 設定保存と入力

[SettingsMenu](../../src/app/SettingsMenu.tsx)はGeneralとShort cut keyを持つ。Generalはバージョンと設定説明のみ。キー設定は現在設定をdraftへ複写し、入力欄でkeydownを記録する。修飾キーだけ、IME、長押し、AltGraphは採用せず、通常Tabはフォーカス移動、Escapeは入力から離れる。解除は空文字、初期化はdefaultShortcutsをdraftへ反映するだけで保存するまでは有効化しない。

`keyBinding` は一文字を大文字化、Spaceを文字名へ、修飾順をMod/Alt/Shiftに正規化。`shortcutConflict` は空文字以外の完全一致を競合とし、sidebarOpen/Closeの組だけ重複を許す。競合中は保存不可。

保存先はlocalStorageの `relagrid.shortcuts.v1`。既知IDの文字列だけ読込み、既定値とマージする。不正JSON・null等や競合なら全既定値へ戻す。任意の保存文字列が実際に発火可能なキーかを完全検証する処理はない。`saveShortcuts` はsetItem成功後にmodule状態を変更しlistenersへ通知するため、保存失敗で有効設定は変わらない。DBやTauri保存コマンドは使わず、他プロセス／他WebViewのstorageイベント同期はない。

## ウィンドウ・共通UI

[WindowHeader](../../src/app/WindowHeader.tsx) `windowAction` はTauri環境のみでminimize/toggleMaximize/closeを呼ぶ。ブラウザではボタン無効。終了時のSQL未保存確認は呼ばない。

[Dialog](../../src/components/ui/dialog.tsx)、[Tabs](../../src/components/ui/tabs.tsx)、[Button](../../src/components/ui/button.tsx)はRadix等のラッパー。[main.tsx](../../src/main.tsx)がReactを起動し、[styles.css](../../src/styles.css)が領域別CSSを取り込む。これらはUI責務でDB入出力や独自保存形式はない。アクセシビリティ属性・フォーカス制御は各画面にも実装するが、実支援技術の完全な動作確認は要確認。

## テスト対応

| 観点                                                         | 既存テスト                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IME、AltGraph、入力領域、dialog、defaultPrevented、長押し    | [shortcuts.test.ts](../../src/lib/shortcuts.test.ts)                                                                                                                                                                      |
| 設定壊れ・競合・部分設定・未知項目・保存失敗・購読・キー表記 | [shortcut-settings.test.ts](../../src/lib/shortcut-settings.test.ts)                                                                                                                                                      |
| 設定UI・永続化・解除・初期化・保存失敗                       | [settings.spec.ts](../../tests/settings.spec.ts)                                                                                                                                                                          |
| 画面／パネル切替、フォーカス、キーとボタンの一致             | [sidebar.spec.ts](../../tests/sidebar.spec.ts)、[inspector.spec.ts](../../tests/inspector.spec.ts)、[query.spec.ts](../../tests/query.spec.ts)、[QueryWorkspace.test.ts](../../src/features/query/QueryWorkspace.test.ts) |
| 同期排他と旧応答                                             | [useExplorer.test.ts](../../src/features/explorer/useExplorer.test.ts)、lib.rs内execution_tests                                                                                                                           |

実IME候補ウィンドウ、OS予約キー、支援技術、ウィンドウAPI失敗の表示体験は追加実機確認観点。合成イベント・ブラウザテストだけで実機対応済みとは断定しない。
