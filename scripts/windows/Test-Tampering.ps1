param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$ExpectedThumbprint
)
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/Verify-Signature.ps1" -Path $Path -ExpectedThumbprint $ExpectedThumbprint
$copy = Join-Path ([IO.Path]::GetTempPath()) "$([guid]::NewGuid()).exe"
try {
    [byte[]]$bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path).Path)
    # DOS stub byte is covered by the PE Authenticode digest (unlike checksum/certificate fields).
    if ($bytes.Length -lt 128 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw 'Expected a PE executable.' }
    $bytes[64] = $bytes[64] -bxor 1
    [IO.File]::WriteAllBytes($copy, $bytes)
    $rejected = $false
    try { & "$PSScriptRoot/Verify-Signature.ps1" -Path $copy -ExpectedThumbprint $ExpectedThumbprint }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Tampered artifact passed verification.' }
} finally {
    if (Test-Path -LiteralPath $copy) { Remove-Item -LiteralPath $copy }
}
