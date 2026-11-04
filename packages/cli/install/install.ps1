# hawl installer: irm https://hawl.ai/install.ps1 | iex
# Join a site in one line: & ([scriptblock]::Create((irm https://hawl.ai/install.ps1))) <site>
# or: $env:HAWL_SITE='<site>'; irm https://hawl.ai/install.ps1 | iex
# Add -InstallTools claude,codex,git (or $env:HAWL_INSTALL_TOOLS) to install Claude Code, Codex and git
# without being asked; join asks at the keyboard otherwise. -AgentHost claude_code picks the tool to connect
# when several are installed and nobody is there to choose.
# Downloads the release manifest and binary from hawl.ai / GitHub Releases over TLS and
# checks the binary's sha256 against the manifest. Nothing is installed on a mismatch.
# The Ed25519 manifest signature is checked by the daemon on every update; Windows
# PowerShell has no Ed25519 verifier, so this script does not check it.
param([string]$Site, [string]$InstallTools, [string]$AgentHost)
$ErrorActionPreference = 'Stop'
if (-not $Site -and $env:HAWL_SITE) { $Site = $env:HAWL_SITE }
if (-not $InstallTools -and $env:HAWL_INSTALL_TOOLS) { $InstallTools = $env:HAWL_INSTALL_TOOLS }

$base = if ($env:HAWL_BASE_URL) { $env:HAWL_BASE_URL } else { 'https://hawl.ai/cli' }
$dest = if ($env:HAWL_INSTALL_DIR) { $env:HAWL_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.hawl\bin' }

function Fail($msg) { throw "hawl install: $msg" }
# A tick per step, label padded to 38 columns; colour only when the host shows it and NO_COLOR is unset.
$useColor = (-not $env:NO_COLOR) -and ($Host.Name -ne 'Default Host')
$utf8 = [Console]::OutputEncoding.CodePage -eq 65001
$barText = '#' * 24
function Tick($label, [switch]$Bar) {
  $line = $label.PadRight(37)
  $mark = if ($utf8) { [string][char]0x2713 } else { 'ok' }
  if ($useColor) { Write-Host -NoNewline "$([char]27)[32m$mark$([char]27)[0m $line" } else { Write-Host -NoNewline "$mark $line" }
  if ($Bar) { Write-Host " $barText" } else { Write-Host '' }
}

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'unsupported CPU: 32-bit' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail "unsupported CPU: $($env:PROCESSOR_ARCHITECTURE)" }

$manifest = Invoke-RestMethod -Uri "$base/manifest.json"
$asset = $manifest.assets | Where-Object { $_.os -eq 'win32' -and $_.arch -eq 'x64' } | Select-Object -First 1
if (-not $asset) { Fail 'no release for win32-x64' }
if (-not $asset.url.StartsWith('https://')) { Fail 'release url is not https' }
if ($asset.sha256 -notmatch '^[0-9a-f]{64}$') { Fail 'bad sha256 in manifest' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hawl-" + [Guid]::NewGuid().ToString('N') + '.exe')
try {
  Tick 'Checking the release manifest'
  Invoke-WebRequest -Uri $asset.url -OutFile $tmp -UseBasicParsing
  Tick 'Downloading hawl for win32-x64' -Bar
  $got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
  if ($got -ne $asset.sha256) { Fail 'sha256 mismatch; nothing installed' }
  Tick 'Checking the sha256'

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
  $joinArgs = @('join', $Site)
  if ($InstallTools) { $joinArgs += @('--install-tools', $InstallTools) }
  if ($AgentHost) { $joinArgs += @('--host', $AgentHost) }
  & (Join-Path $dest 'hawl.exe') @joinArgs
  if ($LASTEXITCODE -ne 0) { Fail "hawl join $Site failed (exit $LASTEXITCODE)" }
}
else {
  # The helper starts at login (turn off: hawl autostart off). A failure here never fails the install.
  try { & (Join-Path $dest 'hawl.exe') autostart on *> $null } catch { }
  Write-Host 'Hawl starts when you log in. Turn that off with `hawl autostart off`.'
  Write-Host 'Sign in: hawl login'
  Write-Host 'Then connect a folder: hawl join <site>'
}
