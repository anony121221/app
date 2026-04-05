param(
  [string]$PrivateKeyPath = "C:\Users\ctsco\.tauri\radar-app-updater.key",
  [string]$PrivateKeyPassword = ""
)

if (-not (Test-Path -LiteralPath $PrivateKeyPath)) {
  throw "Signing key not found: $PrivateKeyPath"
}

$env:TAURI_SIGNING_PRIVATE_KEY = $PrivateKeyPath
if ($PrivateKeyPassword) {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $PrivateKeyPassword
} else {
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

Push-Location (Join-Path $PSScriptRoot "..\src-tauri")
try {
  cargo tauri build
} finally {
  Pop-Location
}
