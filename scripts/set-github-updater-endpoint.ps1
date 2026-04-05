param(
  [Parameter(Mandatory = $true)]
  [string]$Repo
)

$repo = $Repo.Trim()
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "Repo must look like owner/repo."
}

$endpoint = "https://github.com/$repo/releases/latest/download/latest.json"
$target = Join-Path $PSScriptRoot "..\src-tauri\updater-endpoint.txt"

Set-Content -LiteralPath $target -Value $endpoint -NoNewline
Write-Host "Updater endpoint written to $target"
Write-Host $endpoint
