# Windows 署名付きリリース

配布先は [公式 GitHub Releases](https://github.com/kenta-MM/relagrid/releases) です。
`v<tauri.conf.json の version>` タグを作成すると `release-windows.yml` が実行され、
アプリ本体と、本体を含む NSIS インストーラーへ SHA-256 Authenticode 署名と
RFC 3161 タイムスタンプを付与します。署名・署名者・タイムスタンプの検証と
改ざんコピーの拒否テストに成功した場合だけ公開します。通常の
`npm run build:desktop` は開発用の未署名ビルドです。
インストーラーは実行せず 7-Zip で展開し、内包される `relagrid.exe` の署名と、
検証済み単体実行ファイルとの SHA-256 一致も公開前に確認します。

## 導入前提（管理者による外部設定が必要）

実際の証明書・契約・資格情報はこのリポジトリには含まれません。
本番用コード署名証明書を調達し、非エクスポート可能なハードウェア鍵または
互換の署名プロバイダーを用意してください。公開される署名者名はその証明書の
Subject にある発行者組織名です。調達後、利用者向けにその正式名称と証明書
thumbprint を README 等の信頼できる経路でも告知してください。

- 専用の使い捨て Windows x64 runner に `relagrid-signing` ラベルを付与する。
  Windows SDK の `signtool.exe`、NSIS 展開対応の 7-Zip（`7z.exe` を PATH に設定）、
  PowerShell 7、GitHub CLI、Rust（リポジトリ指定版）、
  Visual Studio C++ build tools と Tauri の Windows ビルド依存関係を用意する。
- runner アカウントの `CurrentUser/My` 証明書ストアに証明書と鍵への参照を設定する。
  キーはプロバイダー内に保持し、PFX・秘密鍵・PIN・サービス資格情報を
  リポジトリ、成果物、ログ、コマンドラインへ保存しない。認証が必要な場合は
  runner 側の安全なプロバイダー構成を使用する。
- GitHub Environment `windows-production` に公開情報の Variables
  `WINDOWS_SIGNING_THUMBPRINT`（証明書の SHA-1 thumbprint、40桁、空白なし）と
  `WINDOWS_TIMESTAMP_URL`（契約したサービスの HTTPS RFC 3161 URL）を設定する。
  これは署名の SHA-256 ハッシュ方式とは別の証明書識別子です。
- Environment の承認者とデプロイ対象タグ制限、`v*` タグの ruleset を設定し、
  保護されたコミットだけを信頼できる管理者がタグ付けできるようにする。
  runner group はこのリポジトリの承認済みリリース専用とし、PR や一般ビルドの
  コードを署名用 runner で実行しない。証明書更新時は thumbprint と告知を更新する。

未設定の場合は署名の前に失敗し、未署名成果物を代わりに公開しません。
本番証明書での初回実行とインストーラー内の実行ファイルの確認は、導入時に必要です。
証明書を用意するまでは、本番署名の有効性を検証済みとは扱えません。

## 利用者による確認

公式 Releases から取得した `.exe` のプロパティ →「デジタル署名」で、
署名が有効で、署名者が事前に告知された正式名称に一致することを確認します。
リリースの `SIGNER.txt` に証明書 thumbprint、`SHA256SUMS.txt` に SHA-256 値が
あります。同じ配布元のチェックサムだけで発行元を認証することはできないため、
署名と事前に告知された証明書識別子を照合してください。

Windows SDK とこのリポジトリを取得済みなら、次を PowerShell で実行できます。

```powershell
./scripts/windows/Verify-Signature.ps1 -Path ./RelaGrid_0.1.0_x64-setup.exe -ExpectedThumbprint '<事前に確認した40桁の証明書thumbprint>'
Get-FileHash ./RelaGrid_0.1.0_x64-setup.exe -Algorithm SHA256
```

検証スクリプトは Windows の信頼チェーン、期待する証明書、タイムスタンプと
SignTool の Authenticode ポリシーを確認します。インストール後の
`relagrid.exe` にも同じ検証を実施できます。SmartScreen の評判判定は署名の
有効性とは別であり、署名が有効でも警告が表示される場合があります。

参考: [Tauri Windows code signing](https://v2.tauri.app/distribute/sign/windows/)、
[Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)。
