# Builds GovGuide.exe (the desktop launcher) into the project root.
# Usage:  powershell -ExecutionPolicy Bypass -File launcher\build-launcher.ps1 [-Shortcut]
#   -Shortcut  also creates "Gov Guide" on your desktop.
# Uses the C# compiler that ships with Windows (.NET Framework 4); no extra installs.
param([switch]$Shortcut)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "C# compiler not found (.NET Framework 4 is required)." }

# 1. Icon: a purple circle with a white "G" (generated once, kept in launcher\).
$ico = Join-Path $here 'GovGuide.ico'
if (-not (Test-Path $ico)) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap 64, 64
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(124, 92, 255))), 2, 2, 60, 60)
  $font = New-Object System.Drawing.Font 'Segoe UI', 30, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('G', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 1, 64, 64), $fmt)
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $stream = [System.IO.File]::Create($ico)
  $icon.Save($stream)
  $stream.Close()
}

# 2. Compile (winexe = no console window).
$exe = Join-Path $root 'GovGuide.exe'
& $csc /nologo /target:winexe /optimize+ "/win32icon:$ico" "/out:$exe" `
  /reference:System.Windows.Forms.dll (Join-Path $here 'GovGuide.cs')
if ($LASTEXITCODE -ne 0) { throw "Compile failed (exit $LASTEXITCODE)." }
Write-Host "Built $exe"

# 3. Optional desktop shortcut.
if ($Shortcut) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gov Guide.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $root
  $s.IconLocation = "$exe,0"
  $s.Description = 'Gov Guide: guided help for voter registration and Aadhaar'
  $s.Save()
  Write-Host "Shortcut created: $lnk"
}
