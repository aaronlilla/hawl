# Builds the Windows desktop installer: HawlTray.exe (csc from .NET Framework 4.x) and
# hawl-setup-win-x64.exe (Inno Setup 6, preinstalled on GitHub's windows-2025 image).
# Needs packages/cli/dist/hawl-win-x64.exe first: pnpm --filter @hawl/cli run build:sea -- --target win-x64
# Usage: pwsh packages/desktop/windows/build.ps1 -Version 0.1.2
param([string]$Version = '0.0.0')
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repo = Resolve-Path (Join-Path $here '..\..\..')
$dist = Join-Path $repo 'packages\cli\dist'
$work = Join-Path $here 'out'
New-Item -ItemType Directory -Force -Path $work | Out-Null

$hawl = Join-Path $dist 'hawl-win-x64.exe'
if (-not (Test-Path $hawl)) { throw "missing $hawl; run build:sea --target win-x64 first" }
Copy-Item -Force $hawl (Join-Path $work 'hawl.exe')
# sign.ps1 signs only when ARTIFACT_SIGNING_ENDPOINT, _ACCOUNT and _PROFILE are set (see sign.ps1).
$sign = Join-Path $here 'sign.ps1'
& $sign (Join-Path $work 'hawl.exe')

# Tray: GUI subsystem (/target:winexe), so no console window.
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
$icon = Join-Path $here '..\assets\hawl.ico'
& $csc /nologo /optimize+ /target:winexe /platform:anycpu "/win32icon:$icon" `
  "/out:$(Join-Path $work 'HawlTray.exe')" `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $here 'HawlTray.cs')
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
& $sign (Join-Path $work 'HawlTray.exe')

$iscc = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
  choco install innosetup -y --no-progress | Out-Host
  $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
}
& $iscc /Qp "/DAppVersion=$Version" "/DBuildDir=$work" "/O$dist" (Join-Path $here 'hawl.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }
& $sign (Join-Path $dist 'hawl-setup-win-x64.exe')
Write-Host "built $(Join-Path $dist 'hawl-setup-win-x64.exe')"
