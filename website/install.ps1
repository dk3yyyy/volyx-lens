# Volyx Lens installer for Windows.
#
#   irm https://volyxlens.pages.dev/install.ps1 | iex
#
# Resolves the newest GitHub release, downloads the x64 installer, verifies the
# published SHA-256, clears the Mark-of-the-Web, and runs the per-user installer.
#
# Options:
#   -Version vX.Y.Z   install a specific release
#   -NoLaunch         do not open the app after installing
[CmdletBinding()]
param(
  [string]$Version = "",
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$Repo = "dk3yyyy/volyx-lens"

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "Volyx Lens currently ships a 64-bit Windows installer."
}

if (-not $Version) {
  Write-Host "Finding the latest Volyx Lens release..."
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
  $Version = $release.tag_name
}
if (-not $Version.StartsWith("v")) { $Version = "v$Version" }
$number = $Version.TrimStart("v")

$asset = "volyx-lens-$number-win-x64.exe"
$base = "https://github.com/$Repo/releases/download/$Version"
$work = Join-Path $env:TEMP ("volyx-lens-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
$installer = Join-Path $work $asset
$checksumFile = "$installer.sha256"

try {
  Write-Host "Downloading Volyx Lens $Version..."
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $installer -UseBasicParsing
  Invoke-WebRequest -Uri "$base/$asset.sha256" -OutFile $checksumFile -UseBasicParsing

  $expected = ((Get-Content -Raw $checksumFile) -split "\s+")[0].Trim().ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "The installer checksum did not match the published SHA-256."
  }

  Write-Host "Running the installer..."
  # The build is unsigned; removing the download marker lets the verified
  # installer run without Explorer's extra SmartScreen step. The publisher is
  # still unknown, so Windows may warn once.
  Unblock-File -Path $installer
  Start-Process -FilePath $installer -ArgumentList "/S" -Wait

  $exe = Join-Path $env:LOCALAPPDATA "Programs\Volyx Lens\Volyx Lens.exe"
  if (-not (Test-Path $exe)) {
    $found = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Programs") -Filter "Volyx Lens.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) { $exe = $found.FullName }
  }

  if (-not (Test-Path $exe)) {
    throw "The installer finished, but Volyx Lens.exe was not found. Open it from the Start menu."
  }

  Write-Host "Installed Volyx Lens $Version at $exe"
  if (-not $NoLaunch) { Start-Process -FilePath $exe }
} finally {
  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
}
