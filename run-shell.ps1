# Launch the Guide shell (the real app in shell/), not the legacy root prototype.
# Usage:  powershell -ExecutionPolicy Bypass -File run-shell.ps1  [-NoBuild]
param([switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:Path = 'C:\Program Files\nodejs;' + $env:Path
# Electron runs as plain Node (no window) when this is set.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 1. RAG service (port 8008) must be up for cited answers.
$up = $false
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8008/healthz | Out-Null; $up = $true } catch {}
if (-not $up) {
  Write-Host 'Starting RAG service on :8008 ...'
  Start-Process -FilePath python -ArgumentList '-m', 'rag.service' -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    Start-Sleep 1
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8008/healthz | Out-Null; $up = $true } catch {}
  }
  if (-not $up) { Write-Warning 'RAG service did not answer on :8008; answers will show the service-down card.' }
}

# 2. Build and launch the shell.
Set-Location (Join-Path $root 'shell')
if (-not $NoBuild) { node node_modules\electron-vite\bin\electron-vite.js build | Out-Null }
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath (Resolve-Path 'node_modules\electron\dist\electron.exe') -ArgumentList '.'
Write-Host 'Guide launched. Logs: %APPDATA%\gov-guide-shell\logs\shell.jsonl'
