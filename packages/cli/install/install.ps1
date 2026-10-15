# hawl installer: irm https://hawl.ai/install.ps1 | iex
# Join a site in one line: & ([scriptblock]::Create((irm https://hawl.ai/install.ps1))) <site>
# or: $env:HAWL_SITE='<site>'; irm https://hawl.ai/install.ps1 | iex
# Downloads the release manifest and binary from hawl.ai / GitHub Releases over TLS and
# checks the binary's sha256 against the manifest. Nothing is installed on a mismatch.
# The Ed25519 manifest signature is checked by the daemon on every update; Windows
# PowerShell has no Ed25519 verifier, so this script does not check it.
param([string]$Site)
$ErrorActionPreference = 'Stop'
if (-not $Site -and $env:HAWL_SITE) { $Site = $env:HAWL_SITE }

$base = if ($env:HAWL_BASE_URL) { $env:HAWL_BASE_URL } else { 'https://hawl.ai/cli' }
$dest = if ($env:HAWL_INSTALL_DIR) { $env:HAWL_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.hawl\bin' }

function Fail($msg) { throw "hawl install: $msg" }

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'unsupported CPU: 32-bit' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail "unsupported CPU: $($env:PROCESSOR_ARCHITECTURE)" }

$manifest = Invoke-RestMethod -Uri "$base/manifest.json"
$asset = $manifest.assets | Where-Object { $_.os -eq 'win32' -and $_.arch -eq 'x64' } | Select-Object -First 1
if (-not $asset) { Fail 'no release for win32-x64' }
if (-not $asset.url.StartsWith('https://')) { Fail 'release url is not https' }
if ($asset.sha256 -notmatch '^[0-9a-f]{64}$') { Fail 'bad sha256 in manifest' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hawl-" + [Guid]::NewGuid().ToString('N') + '.exe')
try {
  Invoke-WebRequest -Uri $asset.url -OutFile $tmp -UseBasicParsing
  $got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
  if ($got -ne $asset.sha256) { Fail 'sha256 mismatch; nothing installed' }

  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Move-Item -Force -Path $tmp -Destination (Join-Path $dest 'hawl.exe')
} finally {
  if (Test-Path $tmp) { Remove-Item -Force $tmp }
}

Write-Host "hawl installed to $dest\hawl.exe"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dest) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  Write-Host "added $dest to your user PATH"
}
# This session can use `hawl` right away.
if (($env:Path -split ';') -notcontains $dest) { $env:Path = "$env:Path;$dest" }

if ($Site) {
  & (Join-Path $dest 'hawl.exe') join $Site
  if ($LASTEXITCODE -ne 0) { Fail "hawl join $Site failed (exit $LASTEXITCODE)" }
}
