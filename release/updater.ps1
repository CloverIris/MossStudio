param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$SourceDir,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'

try {
  $deadline = (Get-Date).AddMinutes(3)
  while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -ge $deadline) {
      throw 'MossStudio did not exit within three minutes.'
    }
    Start-Sleep -Milliseconds 500
  }

  $expectedExecutable = Join-Path $InstallDir 'MossStudio.exe'
  if ([IO.Path]::GetFullPath($Executable) -ne [IO.Path]::GetFullPath($expectedExecutable)) {
    throw 'The target executable path is invalid.'
  }
  if (!(Test-Path -LiteralPath (Join-Path $SourceDir 'resources\app.asar') -PathType Leaf)) {
    throw 'The downloaded update is missing resources\app.asar.'
  }

  $logDir = Split-Path -Parent $LogPath
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  $backupDir = Join-Path $InstallDir ('data\updates\rollback-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  & $robocopy $InstallDir $backupDir /E /XD (Join-Path $InstallDir 'data') /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) {
    throw "Backing up the current application failed with robocopy exit code $LASTEXITCODE."
  }

  & $robocopy $SourceDir $InstallDir /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) {
    $copyCode = $LASTEXITCODE
    & $robocopy $backupDir $InstallDir /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) {
      throw "Update copy failed ($copyCode) and rollback failed ($LASTEXITCODE)."
    }
    throw "Copying update files failed with robocopy exit code $copyCode; the previous application was restored."
  }

  Remove-Item -LiteralPath $backupDir -Recurse -Force
  Add-Content -LiteralPath $LogPath -Value "Updated MossStudio at $(Get-Date -Format o)"
  Start-Process -FilePath $Executable -WorkingDirectory $InstallDir
} catch {
  $message = "MossStudio update failed: $($_.Exception.Message)"
  try {
    $logDir = Split-Path -Parent $LogPath
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Add-Content -LiteralPath $LogPath -Value "$((Get-Date).ToString('o')) $message"
  } catch {
    $LogPath = $null
  }
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "$message`n`nDetails: $LogPath",
      'MossStudio updater',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {
    Write-Error $message
  }
  exit 1
}
