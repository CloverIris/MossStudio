[CmdletBinding()]
param(
  [string]$Version,
  [string]$Payload,
  [string]$OutDir,
  [switch]$SkipPublish,
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$installerDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $installerDir
$projectDir = Join-Path $installerDir 'MossStudioSetup'

if ([string]::IsNullOrWhiteSpace($Version)) {
  $manifestPath = Join-Path $repoRoot 'release\manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Version was not supplied and $manifestPath does not exist."
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $Version = [string]$manifest.app.version
}

$semverPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
if ($Version -notmatch $semverPattern) {
  throw "Invalid version: $Version"
}

if ([string]::IsNullOrWhiteSpace($Payload)) {
  $Payload = Join-Path $repoRoot "release\artifacts\MossStudio-$Version-win32-x64.zip"
}

$payloadPath = [System.IO.Path]::GetFullPath($Payload)
if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
  throw "Payload ZIP not found: $payloadPath"
}

$payloadItem = Get-Item -LiteralPath $payloadPath
if ($payloadItem.Length -le 0) {
  throw "Payload ZIP is empty: $payloadPath"
}

if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path $installerDir 'out'
}
$outDirectory = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force -Path $outDirectory | Out-Null

$publishDir = Join-Path $outDirectory 'publish'
$setupSource = Join-Path $publishDir 'MossStudioSetup.exe'
$setupPath = Join-Path $outDirectory "MossStudio-Setup-$Version-x64.exe"

function Remove-Tree([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Read-PayloadTrailer([string]$Path) {
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 96) {
      throw "File is shorter than the 96-byte trailer: $Path"
    }

    $trailer = New-Object byte[] 96
    $stream.Seek(-96, [System.IO.SeekOrigin]::End) | Out-Null
    $read = 0
    while ($read -lt 96) {
      $chunk = $stream.Read($trailer, $read, 96 - $read)
      if ($chunk -le 0) {
        throw "Unexpected end of file while reading the trailer: $Path"
      }
      $read += $chunk
    }

    return @{
      FileLength = $stream.Length
      Magic = [System.Text.Encoding]::ASCII.GetString($trailer, 0, 8)
      Offset = [System.BitConverter]::ToInt64($trailer, 8)
      Size = [System.BitConverter]::ToInt64($trailer, 16)
      Sha256 = [System.Text.Encoding]::ASCII.GetString($trailer, 24, 64)
      Reserved = $trailer[88..95]
    }
  }
  finally {
    $stream.Dispose()
  }
}

if (-not $SkipPublish) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'MossStudioSetup.csproj') -PathType Leaf)) {
    throw "Setup project not found: $projectDir\MossStudioSetup.csproj"
  }

  Remove-Tree $publishDir
  New-Item -ItemType Directory -Force -Path $publishDir | Out-Null

  # Publish from a temp copy so `dotnet` never leaves obj/bin inside the repository.
  $stageRoot = Join-Path $env:TEMP ("mossstudio-setup-publish-" + [Guid]::NewGuid().ToString('N'))
  $stageProject = Join-Path $stageRoot 'MossStudioSetup'
  try {
    New-Item -ItemType Directory -Force -Path $stageProject | Out-Null
    Get-ChildItem -LiteralPath $projectDir -File |
      Where-Object { $_.Extension -eq '.cs' -or $_.Extension -eq '.csproj' } |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stageProject $_.Name) -Force }

    $dotnet = Get-Command dotnet -ErrorAction Stop
    $publishArgs = @(
      'publish',
      (Join-Path $stageProject 'MossStudioSetup.csproj'),
      '-c', $Configuration,
      '-r', 'win-x64',
      '--self-contained',
      '-p:PublishSingleFile=true',
      '-p:IncludeNativeLibrariesForSelfExtract=true',
      '-p:EnableCompressionInSingleFile=true',
      '-p:IncludeSourceRevisionInInformationalVersion=false',
      "-p:Version=$Version",
      "-p:InformationalVersion=$Version",
      '-o', $publishDir,
      '--nologo',
      '-v', 'minimal'
    )

    Write-Verbose ("dotnet " + ($publishArgs -join ' '))
    $publishOutput = & $dotnet.Source @publishArgs 2>&1
    $publishExitCode = $LASTEXITCODE
    if ($publishExitCode -ne 0) {
      $publishOutput | ForEach-Object { Write-Host $_ }
      throw "dotnet publish failed with exit code $publishExitCode."
    }
  }
  finally {
    Remove-Tree $stageRoot
  }
}

if (-not (Test-Path -LiteralPath $setupSource -PathType Leaf)) {
  throw "Published setup exe not found: $setupSource (pass -SkipPublish only after a successful publish)."
}

$publishedVersion = (Get-Item -LiteralPath $setupSource).VersionInfo.ProductVersion
if ($publishedVersion -and -not $publishedVersion.StartsWith($Version, [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Warning "Published exe reports version '$publishedVersion' but -Version is '$Version'. Re-run without -SkipPublish if this is unexpected."
}

$payloadSha256 = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
$payloadLength = [int64]$payloadItem.Length

if (Test-Path -LiteralPath $setupPath) {
  Remove-Item -LiteralPath $setupPath -Force
}
Copy-Item -LiteralPath $setupSource -Destination $setupPath -Force

$offset = [int64](Get-Item -LiteralPath $setupPath).Length
if ($offset -le 0) {
  throw "Published setup exe is empty: $setupSource"
}

# Append the payload ZIP verbatim.
$output = [System.IO.File]::Open($setupPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
$input = [System.IO.File]::Open($payloadPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  $input.CopyTo($output)
}
finally {
  $input.Dispose()
  $output.Dispose()
}

# Trailer: magic (8) | offset (int64 le) | size (int64 le) | sha256 hex (64) | reserved zeros (8)
$trailer = New-Object byte[] 96
[System.Text.Encoding]::ASCII.GetBytes('MSSTUDIO').CopyTo($trailer, 0)
[System.BitConverter]::GetBytes([int64]$offset).CopyTo($trailer, 8)
[System.BitConverter]::GetBytes([int64]$payloadLength).CopyTo($trailer, 16)
[System.Text.Encoding]::ASCII.GetBytes($payloadSha256).CopyTo($trailer, 24)
# reserved bytes 88..95 stay zero.

$trailerStream = [System.IO.File]::Open($setupPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
try {
  $trailerStream.Write($trailer, 0, 96)
}
finally {
  $trailerStream.Dispose()
}

# Read the finished artifact back and verify the trailer before reporting success.
$check = Read-PayloadTrailer $setupPath
if ($check.Magic -ne 'MSSTUDIO') {
  throw "Trailer verification failed: magic is '$($check.Magic)'."
}
if ($check.Offset -ne $offset -or $check.Size -ne $payloadLength) {
  throw "Trailer verification failed: offset/size mismatch."
}
if ($check.Sha256 -ne $payloadSha256) {
  throw "Trailer verification failed: sha256 mismatch."
}
if (($check.Offset + $check.Size + 96) -ne $check.FileLength) {
  throw "Trailer verification failed: artifact length mismatch."
}

$artifactItem = Get-Item -LiteralPath $setupPath
$artifactSha256 = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Output "setup=$setupPath"
Write-Output "sha256=$artifactSha256"
Write-Output "size=$([int64]$artifactItem.Length)"
