#Requires -Version 5.1
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
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-ProxyArguments([string]$Uri) {
  # Windows PowerShell 5.1 only honors the system (WinINET) proxy, so terminal-style
  # HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY variables must be applied explicitly.
  $TargetHost = ([Uri]$Uri).Host
  $NoProxy = if ($env:NO_PROXY) { $env:NO_PROXY } else { '' }
  foreach ($Entry in ($NoProxy -split '[,\s]+' | Where-Object { $_ })) {
    $Suffix = $Entry.TrimStart('*').TrimStart('.')
    if ($Entry -eq '*' -or $TargetHost -ieq $Suffix -or $TargetHost.EndsWith(".$Suffix", [StringComparison]::OrdinalIgnoreCase)) { return @{} }
  }
  $ProxyUrl = $null
  foreach ($Name in 'HTTPS_PROXY', 'ALL_PROXY', 'HTTP_PROXY') {
    $Value = [Environment]::GetEnvironmentVariable($Name)
    if ($Value) { $ProxyUrl = $Value; break }
  }
  if (-not $ProxyUrl) { return @{} }
  $Parsed = [Uri]$ProxyUrl
  $Arguments = @{ Proxy = "$($Parsed.Scheme)://$($Parsed.Authority)" }
  if ($Parsed.UserInfo) {
    $Parts = $Parsed.UserInfo.Split(':', 2)
    $ProxyPassword = if ($Parts.Length -gt 1) { [Uri]::UnescapeDataString($Parts[1]) } else { '' }
    $Arguments.ProxyCredential = New-Object System.Management.Automation.PSCredential(
      [Uri]::UnescapeDataString($Parts[0]),
      (ConvertTo-SecureString $ProxyPassword -AsPlainText -Force))
  }
  return $Arguments
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
  $ProxyArguments = Get-ProxyArguments $Uri
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile @ProxyArguments
  } catch {
    throw "Download failed for ${Uri}: $(Get-HttpErrorMessage $_)"
  }
}

function Get-HttpErrorMessage($ErrorRecord) {
  $Body = $null
  if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
    $Body = $ErrorRecord.ErrorDetails.Message
  } elseif ($ErrorRecord.Exception.Response -is [System.Net.HttpWebResponse]) {
    try {
      $Reader = New-Object IO.StreamReader($ErrorRecord.Exception.Response.GetResponseStream())
      $Body = $Reader.ReadToEnd()
      $Reader.Dispose()
    } catch { }
  }
  if ($Body) {
    # GitHub API errors are JSON with \uXXXX escapes; surface the decoded human-readable message.
    try {
      $Message = (ConvertFrom-Json $Body).message
      if ($Message) { return $Message }
    } catch { }
    return $Body
  }
  return $ErrorRecord.Exception.Message
}

function Get-LatestVersionFromRedirect([string]$Repo) {
  # github.com/<repo>/releases/latest answers with a redirect to /releases/tag/v<version>
  # and is not subject to the GitHub API rate limit.
  $Uri = "https://github.com/$Repo/releases/latest"
  $Arguments = @{ UseBasicParsing = $true; Uri = $Uri; MaximumRedirection = 0; Headers = @{ 'User-Agent' = 'agent-connect-installer' } }
  $ProxyArguments = Get-ProxyArguments $Uri
  $Location = $null
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    try {
      $Response = Invoke-WebRequest @Arguments @ProxyArguments -ErrorAction Stop
      if ($Response -and $Response.Headers) { $Location = @($Response.Headers['Location'])[0] }
    } catch {
      $Response = $_.Exception.Response
      if ($Response -and $Response.Headers -and $Response.Headers.Location) { $Location = $Response.Headers.Location.ToString() }
    }
  } else {
    # Windows PowerShell returns the 3xx response alongside a non-terminating redirect error.
    $Response = Invoke-WebRequest @Arguments @ProxyArguments -ErrorAction SilentlyContinue
    if ($Response -and $Response.Headers) { $Location = @($Response.Headers['Location'])[0] }
  }
  if ($Location -and $Location -match '/releases/tag/v([^/?#]+)$') { return [Uri]::UnescapeDataString($Matches[1]) }
  return $null
}

function Get-ReleaseVersion([string]$RequestedVersion, [string]$Repo) {
  if ($RequestedVersion -ne 'latest') {
    if ($RequestedVersion.StartsWith('v')) { return $RequestedVersion.Substring(1) }
    return $RequestedVersion
  }
  $FromRedirect = Get-LatestVersionFromRedirect $Repo
  if ($FromRedirect) { return $FromRedirect }
  # Fallback: the GitHub API, which is rate limited per IP for anonymous callers.
  $ApiUri = "https://api.github.com/repos/$Repo/releases/latest"
  $Headers = @{ 'User-Agent' = 'agent-connect-installer'; 'Accept' = 'application/vnd.github+json' }
  if ($env:GITHUB_TOKEN) { $Headers.Authorization = "Bearer $($env:GITHUB_TOKEN)" }
  $ProxyArguments = Get-ProxyArguments $ApiUri
  try {
    $release = Invoke-RestMethod -Uri $ApiUri -Headers $Headers @ProxyArguments
  } catch {
    $Detail = Get-HttpErrorMessage $_
    $Hint = if ($Detail -match 'rate limit') { 'Set GITHUB_TOKEN for a higher limit, pass -Version x.y.z to skip the lookup, or retry later.' }
            else { 'Pass -Version x.y.z to skip the lookup, or retry later.' }
    throw "Could not resolve the latest release: $Detail $Hint"
  }
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
$Backup = $null

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
try {
  Invoke-Download "$ReleaseUrl/SHA256SUMS" $ChecksumFile
  Invoke-Download "$ReleaseUrl/$AssetName" $Stage
  $ExpectedHash = Get-ExpectedHash $ChecksumFile $AssetName
  $ActualHash = Get-Sha256 $Stage
  if ($ActualHash -ne $ExpectedHash) { throw "Checksum mismatch for $AssetName." }
  if (Test-Path -LiteralPath $Destination) {
    # Renaming works even while the binary is running; deleting it in place does not.
    $Backup = "$Destination.old-$PID"
    try {
      Move-Item -Force -LiteralPath $Destination -Destination $Backup
    } catch {
      throw "Could not replace $Destination while it is in use. Close agent-connect and retry the installer. ($_)"
    }
  }
  try {
    Move-Item -Force -LiteralPath $Stage -Destination $Destination
  } catch {
    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
      Move-Item -Force -LiteralPath $Backup -Destination $Destination -ErrorAction SilentlyContinue
    }
    throw
  }
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Stage, $ChecksumFile
}
if ($Backup) {
  # Best effort: a still-running old binary keeps its .old file until the next install.
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $Backup
}

if (-not $SkipPathUpdate) {
  $EnvironmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $EnvironmentKey) { throw 'Could not open the HKCU\Environment registry key.' }
  try {
    # Read the raw value so %USERPROFILE%-style entries are not expanded and flattened on rewrite.
    $UserPath = [string]$EnvironmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $PathKind = if ($EnvironmentKey.GetValueNames() -contains 'Path') { $EnvironmentKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $PathEntries = @($UserPath -split ';' | Where-Object { $_ })
    $AlreadyOnPath = $PathEntries | Where-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -ieq $InstallDir.TrimEnd('\\') }
    if (-not $AlreadyOnPath) {
      $NewUserPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
      $EnvironmentKey.SetValue('Path', $NewUserPath, $PathKind)
      try {
        # Broadcast WM_SETTINGCHANGE like [Environment]::SetEnvironmentVariable does, so open shells learn about the change.
        $Signature = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
        $Broadcaster = Add-Type -MemberDefinition $Signature -Name 'PathBroadcast' -Namespace 'AgentConnectInstaller' -PassThru
        [UIntPtr]$BroadcastResult = [UIntPtr]::Zero
        [void]$Broadcaster::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$BroadcastResult)
      } catch {
        Write-Verbose "PATH change broadcast failed: $_"
      }
      $env:Path = "$InstallDir;$env:Path"
      Write-Host "Added $InstallDir to the user PATH. Open a new terminal after this session."
    }
  } finally {
    $EnvironmentKey.Dispose()
  }
}

Write-Host "Installed Agent Connect $Version to $Destination"
Write-Host "Run: agent-connect --version"
