<#
  End-to-end update test on Windows. Proves that updates keep galleryLAB where
  the user put it, and never touch the Library or settings.

    1. Installer, automatic update: install the old build into a custom folder
       (with spaces), let it find the new build on a local feed, download it,
       install it and restart. The new version must be in the same folder, with
       no second copy in the default location.
    2. Installer, manual upgrade: install the old build into another custom
       folder, then run the new setup without choosing a folder. It must land in
       the existing folder (the 0.1.0 → 0.1.1 path, before auto-update existed).
    3. Portable: run the old portable exe from a fixed path; it must replace
       itself with the new build at exactly that path and start again.

  Usage: update-test.ps1 -OldDist dist -OldVersion 0.1.1 -NewDist dist-new -NewVersion 99.0.0
#>
param(
  [Parameter(Mandatory)] [string] $OldDist,
  [Parameter(Mandatory)] [string] $OldVersion,
  [Parameter(Mandatory)] [string] $NewDist,
  [Parameter(Mandatory)] [string] $NewVersion
)
$ErrorActionPreference = 'Stop'
$OldDist = (Resolve-Path $OldDist).Path
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

function Stop-Gallery {
  Get-Process -Name 'galleryLAB' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function Get-Version([string] $Exe) { (Get-Item -LiteralPath $Exe).VersionInfo.ProductVersion }

function Uninstall-Gallery([string] $Dir) {
  $u = Get-ChildItem -LiteralPath $Dir -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($u) {
    Start-Process -FilePath $u.FullName -ArgumentList '/S' -Wait
    Wait-Until { -not (Test-Path -LiteralPath (Join-Path $Dir 'galleryLAB.exe')) } 60 "uninstalled from $Dir"
  }
}

$defaultInstall = Join-Path $env:LOCALAPPDATA 'Programs\galleryLAB'
# Start from a machine with no galleryLAB installed (earlier CI steps may have installed one).
Stop-Gallery
Uninstall-Gallery $defaultInstall
Remove-Item -LiteralPath $defaultInstall -Recurse -Force -ErrorAction SilentlyContinue
$root = Join-Path $env:RUNNER_TEMP 'glab update test'
Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
$userData = Join-Path $root 'userData'
$library = Join-Path $root 'My Library'
$project = Join-Path $library 'Kept project'
New-Item -ItemType Directory -Force -Path $userData, $project | Out-Null

# A Library and settings as a real user would have them.
@{ schemaVersion = 1; libraryPath = $library; theme = 'dark'; defaultImportMode = 'copy'; units = 'auto'; centerlineCm = 145; autoUpdate = $true } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $userData 'settings.json') -Encoding utf8
$stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
@{ schemaVersion = 1; id = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'; name = 'Kept project'; created = $stamp; updated = $stamp; seed = 42; settings = @{ centerlineCm = 145 }; importMode = 'copy' } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $project 'project.json') -Encoding utf8
$projectHash = (Get-FileHash -LiteralPath (Join-Path $project 'project.json')).Hash

function Assert-UserDataKept {
  Assert (Test-Path -LiteralPath (Join-Path $project 'project.json')) 'the Library project is still there'
  Assert ((Get-FileHash -LiteralPath (Join-Path $project 'project.json')).Hash -eq $projectHash) 'project.json is unchanged'
  $s = Get-Content -LiteralPath (Join-Path $userData 'settings.json') -Raw | ConvertFrom-Json
  Assert ($s.libraryPath -eq $library) 'settings still point at the same Library'
  Assert ($s.theme -eq 'dark') 'settings kept the chosen theme'
}

# Serve the new build as the update feed.
$port = 8765
$feed = "http://127.0.0.1:$port/"
$server = Start-Process -FilePath 'python' -ArgumentList '-m', 'http.server', "$port", '--bind', '127.0.0.1', '--directory', "`"$NewDist`"" -PassThru -WindowStyle Hidden
function Show-Diagnostics {
  Write-Host '--- diagnostics'
  foreach ($d in @($tools, $dir1, $dir2)) {
    if ($d -and (Test-Path -LiteralPath $d)) {
      Write-Host "contents of ${d}:"
      Get-ChildItem -LiteralPath $d -Force | ForEach-Object { Write-Host ("  {0,12}  {1}" -f $_.Length, $_.Name) }
    }
  }
  foreach ($log in @((Join-Path $userData 'logs\updates.log'), (Join-Path $userData 'logs\updates.log.1'))) {
    if (Test-Path -LiteralPath $log) { Write-Host "${log}:"; Get-Content -LiteralPath $log | ForEach-Object { Write-Host "  $_" } }
  }
  Get-Process -Name 'galleryLAB', 'cmd' -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("process {0} {1} {2}" -f $_.Id, $_.Name, $_.Path) }
}

$tools = $null; $dir1 = $null; $dir2 = $null
try {
  Wait-Until { (Invoke-WebRequest -UseBasicParsing "${feed}latest.yml").StatusCode -eq 200 } 30 'feed serves latest.yml'
  Wait-Until { (Invoke-WebRequest -UseBasicParsing "${feed}latest-portable.json").StatusCode -eq 200 } 10 'feed serves latest-portable.json'

  $env:GALLERYLAB_USER_DATA = $userData
  $env:GALLERYLAB_UPDATE_FEED = $feed
  $env:GALLERYLAB_UPDATE_AUTO_APPLY = '1'
  $env:GALLERYLAB_UPDATE_CHECK_DELAY_MS = '1500'
  $env:GALLERYLAB_HIDDEN = '1'

  # 1. Installer, automatic update.
  Write-Host '--- 1. installer: automatic update keeps a custom install folder'
  $dir1 = Join-Path $root 'Apps\galleryLAB here'
  Start-Process -FilePath (Join-Path $OldDist "galleryLAB-$OldVersion-setup.exe") -ArgumentList '/S', "/D=$dir1" -Wait
  $exe1 = Join-Path $dir1 'galleryLAB.exe'
  Assert (Test-Path -LiteralPath $exe1) "old build installed into $dir1"
  Assert ((Get-Version $exe1) -like "$OldVersion*") "installed version is $OldVersion"
  Assert (-not (Test-Path -LiteralPath $defaultInstall)) 'nothing installed in the default location'

  Start-Process -FilePath $exe1
  Wait-Until { (Get-Version $exe1) -like "$NewVersion*" } 300 "the app updated itself to $NewVersion in $dir1"
  Wait-Until { @(Get-Process -Name 'galleryLAB' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe1 }).Count -gt 0 } 90 'the updated app started again from the same folder'
  Assert (-not (Test-Path -LiteralPath $defaultInstall)) 'the update did not create a second copy in the default location'
  $entries = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -like 'galleryLAB*' })
  Assert ($entries.Count -eq 1) 'exactly one galleryLAB entry in Apps & features'
  Assert ($entries[0].DisplayVersion -eq $NewVersion) "Apps & features shows $NewVersion"
  $uninstall = [string]$entries[0].UninstallString
  Write-Host "UninstallString: $uninstall"
  Assert ($uninstall.StartsWith('"' + $dir1 + '\Uninstall galleryLAB.exe"')) 'the uninstall entry points exactly at the same folder'
  $locations = @(Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).InstallLocation } | Where-Object { $_ -like '*galleryLAB*' })
  Write-Host "InstallLocation: $($locations -join ' | ')"
  Assert ($locations.Count -ge 1 -and ($locations | Where-Object { $_ -ne $dir1 }).Count -eq 0) 'the recorded install location is exactly the same folder'
  Stop-Gallery
  Assert-UserDataKept
  Uninstall-Gallery $dir1

  # 2. Installer, manual upgrade over an existing install.
  Write-Host '--- 2. installer: manual upgrade lands in the existing folder'
  $dir2 = Join-Path $root 'Other place\galleryLAB'
  Start-Process -FilePath (Join-Path $OldDist "galleryLAB-$OldVersion-setup.exe") -ArgumentList '/S', "/D=$dir2" -Wait
  $exe2 = Join-Path $dir2 'galleryLAB.exe'
  Assert ((Get-Version $exe2) -like "$OldVersion*") "old build installed into $dir2"
  Start-Process -FilePath (Join-Path $NewDist "galleryLAB-$NewVersion-setup.exe") -ArgumentList '/S' -Wait
  Wait-Until { (Get-Version $exe2) -like "$NewVersion*" } 120 "manual upgrade installed $NewVersion into $dir2"
  Assert (-not (Test-Path -LiteralPath $defaultInstall)) 'the manual upgrade did not create a second copy in the default location'
  Stop-Gallery
  Assert-UserDataKept
  Uninstall-Gallery $dir2

  # 3. Portable replaces itself at the same path.
  Write-Host '--- 3. portable: replaces itself at the same path'
  $tools = Join-Path $root 'Tools folder'
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $portable = Join-Path $tools "galleryLAB-$OldVersion-portable.exe"
  Copy-Item -LiteralPath (Join-Path $OldDist "galleryLAB-$OldVersion-portable.exe") -Destination $portable
  $newHash = (Get-FileHash -LiteralPath (Join-Path $NewDist "galleryLAB-$NewVersion-portable.exe")).Hash
  Start-Process -FilePath $portable
  Wait-Until { (Get-FileHash -LiteralPath $portable).Hash -eq $newHash } 300 'the portable exe was replaced by the new build at the same path'
  Wait-Until { @(Get-Process -Name 'galleryLAB' -ErrorAction SilentlyContinue).Count -gt 0 } 90 'the new portable build started'
  Wait-Until { @(Get-ChildItem -LiteralPath $tools -Force | Where-Object { $_.Name -ne (Split-Path $portable -Leaf) }).Count -eq 0 } 150 'no leftover update files beside the portable exe'
  Stop-Gallery
  Assert-UserDataKept
  Show-Diagnostics
  Write-Host 'All update tests passed.'
}
catch {
  Show-Diagnostics
  throw
}
finally {
  Stop-Gallery
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
