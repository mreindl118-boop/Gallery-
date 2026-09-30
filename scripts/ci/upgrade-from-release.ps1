<#
  Upgrade test from a real published release: download that release's
  installer from this repo's GitHub Releases, install it into a custom folder
  (with spaces), then run the new setup over it without choosing a folder.
  The new version must replace the old one in the same folder, leave exactly
  one Apps & features entry, and start with the old settings.

  Usage: upgrade-from-release.ps1 -FromVersion 0.1.0 -NewDist dist -NewVersion 0.1.1
#>
param(
  [Parameter(Mandatory)] [string] $FromVersion,
  [Parameter(Mandatory)] [string] $NewDist,
  [Parameter(Mandatory)] [string] $NewVersion,
  [string] $Repo = $env:GITHUB_REPOSITORY
)
$ErrorActionPreference = 'Stop'
$NewDist = (Resolve-Path $NewDist).Path

function Wait-Until([scriptblock] $Condition, [int] $Seconds, [string] $What) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { if (& $Condition) { Write-Host "ok: $What"; return } } catch { }
    Start-Sleep -Milliseconds 750
  }
  throw "Timed out after $Seconds s waiting for: $What"
}
function Assert([bool] $Condition, [string] $What) {
  if (-not $Condition) { throw "Failed: $What" }
  Write-Host "ok: $What"
}
function Version-Core([string] $Version) { ($Version -split '-', 2)[0] }
function Get-Version([string] $Exe) { (Get-Item -LiteralPath $Exe).VersionInfo.ProductVersion }
function Stop-Gallery {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'galleryLAB*' } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
function Uninstall-From([string] $Dir) {
  $u = Get-ChildItem -LiteralPath $Dir -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($u) {
    Start-Process -FilePath $u.FullName -ArgumentList '/S' -Wait
    Wait-Until { -not (Test-Path -LiteralPath (Join-Path $Dir 'galleryLAB.exe')) } 60 "uninstalled from $Dir"
  }
}

$root = Join-Path $env:RUNNER_TEMP 'glab upgrade test'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $root | Out-Null
$defaultInstall = Join-Path $env:LOCALAPPDATA 'Programs\galleryLAB'
Stop-Gallery
Uninstall-From $defaultInstall
Remove-Item -LiteralPath $defaultInstall -Recurse -Force -ErrorAction SilentlyContinue

# The released installer, exactly as users downloaded it.
$oldSetup = Join-Path $root "galleryLAB-$FromVersion-setup.exe"
$url = "https://github.com/$Repo/releases/download/v$FromVersion/galleryLAB-$FromVersion-setup.exe"
Write-Host "Downloading $url"
Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $oldSetup

$dir = Join-Path $root 'My Programs\galleryLAB old'
$exe = Join-Path $dir 'galleryLAB.exe'
$userData = Join-Path $root 'userData'
$library = Join-Path $root 'Library'
New-Item -ItemType Directory -Force -Path $userData, $library | Out-Null
# Settings as the old version wrote them (0.1.0 had no autoUpdate field).
@{ schemaVersion = 1; libraryPath = $library; theme = 'dark'; defaultImportMode = 'copy'; units = 'auto'; centerlineCm = 145 } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $userData 'settings.json') -Encoding utf8

try {
  Start-Process -FilePath $oldSetup -ArgumentList '/S', "/D=$dir" -Wait
  Assert (Test-Path -LiteralPath $exe) "galleryLAB $FromVersion installed into $dir"
  Assert ((Get-Version $exe) -like "$(Version-Core $FromVersion)*") "installed version is $FromVersion"

  Start-Process -FilePath (Join-Path $NewDist "galleryLAB-$NewVersion-setup.exe") -ArgumentList '/S' -Wait
  Wait-Until { (Get-Version $exe) -like "$(Version-Core $NewVersion)*" } 120 "the $NewVersion setup replaced $FromVersion in the same folder"
  Assert (-not (Test-Path -LiteralPath $defaultInstall)) 'no second copy in the default location'
  $entries = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -like 'galleryLAB*' })
  Assert ($entries.Count -eq 1) 'exactly one galleryLAB entry in Apps & features'
  Assert ($entries[0].DisplayVersion -eq $NewVersion) "Apps & features shows $NewVersion"
  Assert (([string]$entries[0].UninstallString).StartsWith('"' + $dir + '\Uninstall galleryLAB.exe"')) 'the uninstall entry points at the same folder'

  # The upgraded app starts with the old settings and turns automatic updates on.
  $env:GALLERYLAB_USER_DATA = $userData
  $env:GALLERYLAB_HIDDEN = '1'
  $env:GALLERYLAB_UPDATE_CHECK_DELAY_MS = '3600000'
  Start-Process -FilePath $exe
  Wait-Until { Test-Path -LiteralPath (Join-Path $userData 'logs\updates.log') } 60 'the upgraded app started its updater'
  $log = Get-Content -LiteralPath (Join-Path $userData 'logs\updates.log') -Raw
  Assert ($log -match "start: installer $([regex]::Escape($NewVersion)), auto true") 'the upgraded app updates automatically from now on'
  Stop-Gallery
  $s = Get-Content -LiteralPath (Join-Path $userData 'settings.json') -Raw | ConvertFrom-Json
  Assert ($s.libraryPath -eq $library -and $s.theme -eq 'dark') 'the old settings were kept'
  Write-Host "Upgrade from $FromVersion passed."
}
finally {
  Stop-Gallery
  Uninstall-From $dir
}
