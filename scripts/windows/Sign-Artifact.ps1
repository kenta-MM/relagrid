param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
$thumbprint = $env:WINDOWS_SIGNING_THUMBPRINT
if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'WINDOWS_SIGNING_THUMBPRINT must identify the provisioned signing certificate.' }
$timestamp = $env:WINDOWS_TIMESTAMP_URL
if ($timestamp -notmatch '^https://') { throw 'WINDOWS_TIMESTAMP_URL must be an HTTPS RFC 3161 timestamp service.' }
# The private key remains in the provisioned hardware/provider-backed certificate store.
& signtool.exe sign /s My /sha1 $thumbprint /fd SHA256 /tr $timestamp /td SHA256 $Path
if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed.' }
& "$PSScriptRoot/Verify-Signature.ps1" -Path $Path -ExpectedThumbprint $thumbprint
