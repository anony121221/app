Push-Location (Join-Path $PSScriptRoot "..\src-tauri")
try {
  cargo tauri build
} finally {
  Pop-Location
}
