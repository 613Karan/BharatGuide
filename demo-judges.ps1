# Judges demo: starts on google.com, asks "I am 18 and a new voter, how to register?",
# opens the ECI portal, points at the Form 6 section, then hands over to live mode
# (type your own questions in the Guide panel).
# Usage:  powershell -ExecutionPolicy Bypass -File demo-judges.ps1  [-NoBuild] [-DelayMs 9000]
param([switch]$NoBuild, [int]$DelayMs = 9000)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:Path = 'C:\Program Files\nodejs;' + $env:Path

# 1. RAG service (port 8008) must be up for the cited answer.
$up = $false
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8008/healthz | Out-Null; $up = $true } catch {}
if (-not $up) {
  Write-Host 'Starting RAG service on :8008 ...'
  Start-Process -FilePath python -ArgumentList '-m', 'rag.service' -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 30 -and -not $up; $i++) {
    Start-Sleep 1
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8008/healthz | Out-Null; $up = $true } catch {}
  }
  if (-not $up) { Write-Warning 'RAG service did not answer on :8008; the demo will show the abstain card.' }
}

# 2. Build and launch the shell in judges mode.
Set-Location (Join-Path $root 'shell')
if (-not $NoBuild) { node node_modules\electron-vite\bin\electron-vite.js build | Out-Null }
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
$env:DEMO_DELAY_MS = "$DelayMs"
Start-Process -FilePath (Resolve-Path 'node_modules\electron\dist\electron.exe') -ArgumentList '.', '--demo=judges'
Write-Host 'Demo launched. Keep the window in front (the ghost pauses when it loses focus).'
