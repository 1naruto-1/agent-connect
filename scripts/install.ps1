# Agent Connect per-user installer for Windows.
# Usage: irm https://raw.githubusercontent.com/1naruto-1/agent-connect/main/scripts/install.ps1 | iex
[CmdletBinding()]
param(
  [string]$Version = 'latest',
  [string]$Repository = '1naruto-1/agent-connect',
  [switch]$SkipPathUpdate
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-ReleaseVersion([string]$RequestedVersion, [string]$Repo) {
  if ($RequestedVersion -ne 'latest') {
    if ($RequestedVersion.StartsWith('v')) { return $RequestedVersion.Substring(1) }
    return $RequestedVersion
  }
  $headers = @{ 'User-Agent' = 'agent-connect-installer'; 'Accept' = 'application/vnd.github+json' }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
  if (-not $release.tag_name) { throw 'GitHub did not return a latest release tag.' }
  $tag = $release.tag_name.ToString()
  if (-not $tag.StartsWith('v')) { throw "GitHub returned an invalid release tag: $tag" }
  return $tag.Substring(1)
}

function Get-Sha256([string]$Path) {
  $getFileHash = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($getFileHash) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $hasher.Dispose()
  }
}

function Get-ExpectedHash([string]$ChecksumFile, [string]$AssetName) {
  $match = Get-Content -LiteralPath $ChecksumFile | Where-Object { $_ -match "^[A-Fa-f0-9]{64}\s+\*?$([regex]::Escape($AssetName))$" } | Select-Object -First 1
  if (-not $match) { throw "SHA256SUMS does not contain $AssetName." }
  return ($match -split '\s+')[0].ToLowerInvariant()
}

$Version = Get-ReleaseVersion $Version $Repository
$SemVerPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'
if ($Version -notmatch $SemVerPattern) {
  throw "Invalid SemVer release: $Version"
}

# x64 binaries run under Windows-on-ARM emulation; a dedicated ARM64 release can be added later.
$AssetName = "agent-connect-v$Version-windows-x64.exe"
$ReleaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$InstallDir = if ($env:AGENT_CONNECT_BIN_DIR) { $env:AGENT_CONNECT_BIN_DIR } else { Join-Path $UserHome '.local\bin' }
$Destination = Join-Path $InstallDir 'agent-connect.exe'
$Stage = Join-Path $InstallDir ".agent-connect-$Version-$([Guid]::NewGuid().ToString('N')).exe"
$ChecksumFile = Join-Path ([IO.Path]::GetTempPath()) "agent-connect-$Version-$([Guid]::NewGuid().ToString('N'))-SHA256SUMS"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/SHA256SUMS" -OutFile $ChecksumFile
  Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/$AssetName" -OutFile $Stage
  $ExpectedHash = Get-ExpectedHash $ChecksumFile $AssetName
  $ActualHash = Get-Sha256 $Stage
  if ($ActualHash -ne $ExpectedHash) { throw "Checksum mismatch for $AssetName." }
  Move-Item -Force -LiteralPath $Stage -Destination $Destination
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Stage, $ChecksumFile
}

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$PathEntries = @($UserPath -split ';' | Where-Object { $_ })
if (-not $SkipPathUpdate -and -not ($PathEntries | Where-Object { $_.TrimEnd('\\') -ieq $InstallDir.TrimEnd('\\') })) {
  $NewUserPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
  $env:Path = "$InstallDir;$env:Path"
  Write-Host "Added $InstallDir to the user PATH. Open a new terminal after this session."
}

Write-Host "Installed Agent Connect $Version to $Destination"
Write-Host "Run: agent-connect --version"
