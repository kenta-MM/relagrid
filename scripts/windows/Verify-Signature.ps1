param(
    [Parameter(Mandatory)][string[]]$Path,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$ExpectedThumbprint
)
$ErrorActionPreference = 'Stop'
foreach ($artifact in $Path) {
    $file = Get-Item -LiteralPath $artifact
    if ($file.PSIsContainer) { throw 'Expected a file.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid') { throw "Invalid signature: $($file.Name) ($($signature.Status))" }
    if ($signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) { throw "Unexpected signer: $($file.Name)" }
    if ($null -eq $signature.TimeStamperCertificate) { throw "Missing timestamp: $($file.Name)" }
    & signtool.exe verify /pa /all /tw $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "SignTool verification failed: $($file.Name)" }
}
