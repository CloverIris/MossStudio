#requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$installerDir = $PSScriptRoot
$buildScript = Join-Path $installerDir 'build.ps1'
$script:passed = 0
$script:failed = 0
$script:failures = New-Object System.Collections.Generic.List[string]
$script:tempRoot = Join-Path $env:TEMP ("mossstudio-installer-selftest-" + [Guid]::NewGuid().ToString('N'))

function Write-CheckPass([string]$Name) {
  $script:passed++
  Write-Host "  PASS $Name"
}

function Write-CheckFail([string]$Name, [string]$Detail) {
  $script:failed++
  $script:failures.Add($Name)
  Write-Host "  FAIL $Name $Detail"
}

function Check([string]$Name, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) {
    Write-CheckPass $Name
  }
  else {
    Write-CheckFail $Name $Detail
  }
}

function Check-Equal([string]$Name, $Expected, $Actual) {
  if ([string]$Expected -ceq [string]$Actual) {
    Write-CheckPass $Name
  }
  else {
    Write-CheckFail $Name "(expected '$Expected', got '$Actual')"
  }
}

function Invoke-Build([string]$Version, [string]$PayloadZip, [string]$OutDir, [switch]$SkipPublish) {
  $buildArgs = @{
    Version = $Version
    Payload = $PayloadZip
    OutDir = $OutDir
  }
  if ($SkipPublish) {
    $buildArgs['SkipPublish'] = $true
  }

  $lines = @(& $buildScript @buildArgs 2>&1)
  $result = @{}
  foreach ($line in $lines) {
    $text = [string]$line
    if ($text -match '^(setup|sha256|size)=(.+)$') {
      $result[$matches[1]] = $matches[2].Trim()
    }
  }

  foreach ($key in @('setup', 'sha256', 'size')) {
    if (-not $result.ContainsKey($key)) {
      throw "build.ps1 did not print $key=...`n$($lines -join "`n")"
    }
  }

  if (-not (Test-Path -LiteralPath $result.setup -PathType Leaf)) {
    throw "Build reported a setup path that does not exist: $($result.setup)"
  }

  return [pscustomobject]@{
    Setup = $result.setup
    Sha256 = $result.sha256
    Size = [int64]$result.size
  }
}

function Invoke-Setup([string]$Exe, [string[]]$SetupArgs, [int]$TimeoutSeconds = 240) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Exe
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = Split-Path -Parent $Exe
  $startInfo.Arguments = (($SetupArgs | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' ')

  $process = [System.Diagnostics.Process]::Start($startInfo)
  $exited = $process.WaitForExit($TimeoutSeconds * 1000)
  if (-not $exited) {
    try { $process.Kill() } catch { }
    try { $process.WaitForExit() } catch { }
    throw "Setup timed out after $TimeoutSeconds seconds: $Exe $($SetupArgs -join ' ')"
  }

  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $exitCode = $process.ExitCode
  $process.Dispose()

  return [pscustomobject]@{
    ExitCode = $exitCode
    StdOut = $stdout
    StdErr = $stderr
  }
}

function New-FakePayload([string]$Root, [string]$Version, [switch]$AddNewFile) {
  $payloadRoot = Join-Path $Root 'payload'
  $releaseDir = Join-Path $payloadRoot 'resources\release'
  New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

  Set-Content -LiteralPath (Join-Path $payloadRoot 'MossStudio.exe') -Value "FAKE-EXE-$Version" -NoNewline -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $payloadRoot 'resources\app.asar') -Value "FAKE-ASAR-$Version" -NoNewline -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $releaseDir 'release.md') -Value "# MossStudio $Version" -NoNewline -Encoding ASCII
  if ($AddNewFile) {
    Set-Content -LiteralPath (Join-Path $payloadRoot 'resources\new-file.txt') -Value "NEW-$Version" -NoNewline -Encoding ASCII
  }

  $zipPath = Join-Path $Root "payload-$Version.zip"
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $payloadRoot,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false)

  return [pscustomobject]@{
    Zip = $zipPath
    Root = $payloadRoot
    Sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Get-TrailerInfo([string]$Path) {
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 96) {
      throw "File too short for trailer: $Path"
    }

    $trailer = New-Object byte[] 96
    $stream.Seek(-96, [System.IO.SeekOrigin]::End) | Out-Null
    $read = $stream.Read($trailer, 0, 96)
    if ($read -ne 96) {
      throw "Could not read the trailer: $Path"
    }

    return [pscustomobject]@{
      Magic = [System.Text.Encoding]::ASCII.GetString($trailer, 0, 8)
      Offset = [System.BitConverter]::ToInt64($trailer, 8)
      Size = [System.BitConverter]::ToInt64($trailer, 16)
      Sha256 = [System.Text.Encoding]::ASCII.GetString($trailer, 24, 64)
      Length = $stream.Length
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Get-EndedProcessId {
  $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList '/c', 'exit 0' -PassThru -WindowStyle Hidden
  $process.WaitForExit()
  return $process.Id
}

Write-Host '== MossStudio installer selftest =='

$fatalError = $null
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Force -Path $script:tempRoot | Out-Null
  Write-Host "temp: $script:tempRoot"

  $version1 = '0.0.1-selftest'
  $version2 = '0.0.2-selftest'
  $payload1 = New-FakePayload -Root (Join-Path $script:tempRoot 'payload1') -Version $version1
  $payload2 = New-FakePayload -Root (Join-Path $script:tempRoot 'payload2') -Version $version2 -AddNewFile

  Write-Host "-- build $version1"
  $setup1 = Invoke-Build -Version $version1 -PayloadZip $payload1.Zip -OutDir (Join-Path $script:tempRoot 'build1')
  Check 'build prints a payload trailer with the payload hash' ((Get-TrailerInfo $setup1.Setup).Sha256 -eq $payload1.Sha256)

  Write-Host "-- build $version2"
  $setup2 = Invoke-Build -Version $version2 -PayloadZip $payload2.Zip -OutDir (Join-Path $script:tempRoot 'build2')
  Check 'second setup artifact was produced' ($setup2.Size -gt 0)

  Write-Host '-- --version'
  $result = Invoke-Setup -Exe $setup1.Setup -SetupArgs @('--version')
  Check-Equal '--version exits with 0' 0 $result.ExitCode
  Check-Equal '--version prints the embedded version' $version1 $result.StdOut.Trim()

  Write-Host '-- fresh install'
  $appDir = Join-Path $script:tempRoot 'app'
  $result = Invoke-Setup -Exe $setup1.Setup -SetupArgs @(
    '--install', '--silent', '--dir', $appDir, '--skip-shortcuts', '--skip-registry')
  Check-Equal 'install exits with 0' 0 $result.ExitCode
  Check 'install creates MossStudio.exe' (Test-Path -LiteralPath (Join-Path $appDir 'MossStudio.exe') -PathType Leaf)
  Check-Equal 'install extracts the payload exe' "FAKE-EXE-$version1" (Get-Content -LiteralPath (Join-Path $appDir 'MossStudio.exe') -Raw)
  Check 'install extracts resources\app.asar' (Test-Path -LiteralPath (Join-Path $appDir 'resources\app.asar') -PathType Leaf)
  Check 'install extracts resources\release\release.md' (Test-Path -LiteralPath (Join-Path $appDir 'resources\release\release.md') -PathType Leaf)
  Check 'install copies the setup exe for uninstall' (Test-Path -LiteralPath (Join-Path $appDir 'MossStudio-Setup.exe') -PathType Leaf)
  Check 'install writes data\install.json' (Test-Path -LiteralPath (Join-Path $appDir 'data\install.json') -PathType Leaf)

  $record = Get-Content -LiteralPath (Join-Path $appDir 'data\install.json') -Raw | ConvertFrom-Json
  Check-Equal 'install.json records the installer version' $version1 $record.version
  Check-Equal 'install.json records the payload sha256' $payload1.Sha256 $record.payload_sha256
  Check 'install.json records installed_at' (-not [string]::IsNullOrWhiteSpace($record.installed_at))

  $sentinel = Join-Path $appDir 'data\user-sentinel.txt'
  Set-Content -LiteralPath $sentinel -Value 'KEEP-ME' -NoNewline -Encoding ASCII

  Write-Host '-- update'
  $endedPid = Get-EndedProcessId
  $result = Invoke-Setup -Exe $setup2.Setup -SetupArgs @(
    '--update', '--dir', $appDir, '--pid', [string]$endedPid, '--relaunch=false', '--silent')
  Check-Equal 'update exits with 0' 0 $result.ExitCode
  Check-Equal 'update overwrites MossStudio.exe' "FAKE-EXE-$version2" (Get-Content -LiteralPath (Join-Path $appDir 'MossStudio.exe') -Raw)
  Check 'update adds new payload files' (Test-Path -LiteralPath (Join-Path $appDir 'resources\new-file.txt') -PathType Leaf)
  Check 'update preserves user data' (Test-Path -LiteralPath $sentinel -PathType Leaf)

  $record = Get-Content -LiteralPath (Join-Path $appDir 'data\install.json') -Raw | ConvertFrom-Json
  Check-Equal 'update bumps install.json version' $version2 $record.version
  Check-Equal 'update records the new payload sha256' $payload2.Sha256 $record.payload_sha256
  Check 'update refreshes the installed setup copy' ((Get-TrailerInfo (Join-Path $appDir 'MossStudio-Setup.exe')).Sha256 -eq $payload2.Sha256)

  $backupDirs = @(Get-ChildItem -LiteralPath (Join-Path $appDir 'data\backups') -Directory -ErrorAction SilentlyContinue)
  Check-Equal 'update deletes its backup after success' 0 $backupDirs.Count

  $logPath = Join-Path $appDir "data\logs\update-$version2.log"
  Check 'update writes data\logs\update-<version>.log' (Test-Path -LiteralPath $logPath -PathType Leaf)
  if (Test-Path -LiteralPath $logPath -PathType Leaf) {
    Check 'update log reports success' ((Get-Content -LiteralPath $logPath -Raw) -match 'update succeeded')
  }
  else {
    Write-CheckFail 'update log reports success' '(log file missing)'
  }

  Write-Host '-- tampered payload is rejected'
  $trailer = Get-TrailerInfo $setup1.Setup
  $tampered = Join-Path $script:tempRoot 'tampered-setup.exe'
  Copy-Item -LiteralPath $setup1.Setup -Destination $tampered -Force
  $stream = [System.IO.File]::Open($tampered, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    $stream.Position = $trailer.Offset + 12
    $original = $stream.ReadByte()
    $stream.Position = $trailer.Offset + 12
    $stream.WriteByte($original -bxor 0xFF)
  }
  finally {
    $stream.Dispose()
  }

  $tamperedDir = Join-Path $script:tempRoot 'tampered-app'
  $result = Invoke-Setup -Exe $tampered -SetupArgs @(
    '--install', '--silent', '--dir', $tamperedDir, '--skip-shortcuts', '--skip-registry')
  Check 'tampered payload exits non-zero' ($result.ExitCode -ne 0)
  Check 'tampered payload extracts nothing' (-not (Test-Path -LiteralPath (Join-Path $tamperedDir 'MossStudio.exe') -PathType Leaf))

  Write-Host '-- uninstall (keep data)'
  $result = Invoke-Setup -Exe $setup2.Setup -SetupArgs @(
    '--uninstall', '--silent', '--dir', $appDir, '--keep-data', '--skip-shortcuts', '--skip-registry')
  Check-Equal 'uninstall exits with 0' 0 $result.ExitCode
  Check 'uninstall removes MossStudio.exe' (-not (Test-Path -LiteralPath (Join-Path $appDir 'MossStudio.exe') -PathType Leaf))
  Check 'uninstall removes resources' (-not (Test-Path -LiteralPath (Join-Path $appDir 'resources') -PathType Container))
  Check 'uninstall removes the installed setup copy' (-not (Test-Path -LiteralPath (Join-Path $appDir 'MossStudio-Setup.exe') -PathType Leaf))
  Check 'uninstall keeps data\install.json' (Test-Path -LiteralPath (Join-Path $appDir 'data\install.json') -PathType Leaf)
  Check 'uninstall keeps user data' (Test-Path -LiteralPath $sentinel -PathType Leaf)
  Check 'uninstall keeps update logs' (Test-Path -LiteralPath $logPath -PathType Leaf)

  Write-Host '-- uninstall (purge data)'
  $purgeDir = Join-Path $script:tempRoot 'app-purge'
  $result = Invoke-Setup -Exe $setup1.Setup -SetupArgs @(
    '--install', '--silent', '--dir', $purgeDir, '--skip-shortcuts', '--skip-registry')
  Check-Equal 'purge test install exits with 0' 0 $result.ExitCode
  $result = Invoke-Setup -Exe $setup1.Setup -SetupArgs @(
    '--uninstall', '--silent', '--dir', $purgeDir, '--purge-data', '--skip-shortcuts', '--skip-registry')
  Check-Equal '--purge-data uninstall exits with 0' 0 $result.ExitCode
  Check '--purge-data removes the install directory' (-not (Test-Path -LiteralPath $purgeDir))
}
catch {
  $fatalError = $_
  $script:failed++
  Write-Host "  FAIL unhandled error: $($_.Exception.Message)"
  if ($_.ScriptStackTrace) {
    Write-Host $_.ScriptStackTrace
  }
}
finally {
  if (-not $KeepTemp) {
    try {
      if (Test-Path -LiteralPath $script:tempRoot) {
        Remove-Item -LiteralPath $script:tempRoot -Recurse -Force
      }
    }
    catch {
      Write-Host "warning: could not remove temp directory $script:tempRoot"
    }
  }
  else {
    Write-Host "kept temp: $script:tempRoot"
  }
}

Write-Host ''
if ($script:failed -eq 0) {
  Write-Host "PASS: $($script:passed) checks passed, 0 failed."
  exit 0
}

Write-Host "FAIL: $($script:passed) passed, $($script:failed) failed."
if ($script:failures.Count -gt 0) {
  Write-Host "failed checks: $($script:failures -join '; ')"
}
if ($fatalError -ne $null) {
  Write-Host "fatal: $($fatalError.Exception.Message)"
}
exit 1
