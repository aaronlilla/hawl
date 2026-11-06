# Signing hook for Microsoft Artifact Signing (formerly Trusted Signing). Tauri calls it for every
# file it signs (the app, the bundled hawl.exe, the installer) through bundle.windows.signCommand;
# scripts/build-installer.ps1 and the Inno build call it too. With no signing values set it leaves
# the file unsigned and exits 0, so plain builds keep working.
#
#   ARTIFACT_SIGNING_ENDPOINT  regional URI of the account (must match its region, else 403)
#   ARTIFACT_SIGNING_ACCOUNT   Artifact Signing account name
#   ARTIFACT_SIGNING_PROFILE   certificate profile name
#   ARTIFACT_SIGNING_TOOLS     optional folder for the tools below (default %LOCALAPPDATA%\hawl-signing-tools)
# Sign-in to Azure is DefaultAzureCredential: `az login`, or AZURE_CLIENT_ID / AZURE_TENANT_ID and a
# secret or OIDC in CI. The account needs the "Artifact Signing Certificate Profile Signer" role.
#
# Tools (no admin needed): the Windows SDK Build Tools signtool.exe and the Artifact Signing dlib,
# both from NuGet, as in Microsoft's SignTool steps:
# https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'

$endpoint = $env:ARTIFACT_SIGNING_ENDPOINT
$account = $env:ARTIFACT_SIGNING_ACCOUNT
$profileName = $env:ARTIFACT_SIGNING_PROFILE
if (-not ($endpoint -and $account -and $profileName)) {
  Write-Host "sign.ps1: signing values not set, leaving $File unsigned"
  exit 0
}
if (-not (Test-Path -LiteralPath $File)) { throw "sign.ps1: no such file $File" }

$tools = $env:ARTIFACT_SIGNING_TOOLS
if (-not $tools) { $tools = Join-Path $env:LOCALAPPDATA 'hawl-signing-tools' }
function Find-Under([string]$name, [string]$archDir) {
  if (-not (Test-Path $tools)) { return $null }
  Get-ChildItem -Path $tools -Recurse -Filter $name -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\$archDir\\" } | Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
$signtool = Find-Under 'signtool.exe' 'x64'
$dlib = Find-Under 'Azure.CodeSigning.Dlib.dll' 'x64'
if (-not ($signtool -and $dlib)) {
  Write-Host 'sign.ps1: fetching signtool and the Artifact Signing dlib from NuGet'
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $nuget = Join-Path $tools 'nuget.exe'
  if (-not (Test-Path $nuget)) {
    Invoke-WebRequest -Uri 'https://dist.nuget.org/win-x86-commandline/latest/nuget.exe' -OutFile $nuget
  }
  Push-Location $tools
  try {
    & $nuget install Microsoft.Windows.SDK.BuildTools -x | Out-Host
    & $nuget install Microsoft.ArtifactSigning.Client -x | Out-Host
  } finally { Pop-Location }
  $signtool = Find-Under 'signtool.exe' 'x64'
  $dlib = Find-Under 'Azure.CodeSigning.Dlib.dll' 'x64'
  if (-not ($signtool -and $dlib)) { throw 'sign.ps1: could not set up signtool and the dlib' }
}

# The dlib wants .NET 8; a newer runtime is fine when roll-forward is allowed.
if (-not $env:DOTNET_ROLL_FORWARD) { $env:DOTNET_ROLL_FORWARD = 'Major' }

# metadata.json must be UTF-8 without a BOM (Windows PowerShell 5's -Encoding utf8 adds one).
$meta = Join-Path ([IO.Path]::GetTempPath()) "hawl-artifact-signing-$PID.json"
$json = @{ Endpoint = $endpoint; CodeSigningAccountName = $account; CertificateProfileName = $profileName } | ConvertTo-Json
[IO.File]::WriteAllText($meta, $json, (New-Object Text.UTF8Encoding($false)))
try {
  & $signtool sign /v /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib $dlib /dmdf $meta $File
  if ($LASTEXITCODE -ne 0) { throw "sign.ps1: signtool failed ($LASTEXITCODE) on $File" }
} finally {
  Remove-Item -Force $meta -ErrorAction SilentlyContinue
}
