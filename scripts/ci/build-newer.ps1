<#
  Build a throwaway "newer" release (default 99.0.0) into its own folder, for
  update tests. package.json is restored afterwards.
  Usage: build-newer.ps1 [-Version 99.0.0] [-Out dist-new]
#>
param([string] $Version = '99.0.0', [string] $Out = 'dist-new')
$ErrorActionPreference = 'Stop'
$original = Get-Content package.json -Raw
try {
  npm pkg set "version=$Version"
  if ($LASTEXITCODE -ne 0) { throw 'npm pkg set failed' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  npx electron-builder --win nsis portable --x64 --publish never "--config.directories.output=$Out"
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
  node scripts/portable-feed.mjs "$Out/galleryLAB-$Version-portable.exe" $Out
  if ($LASTEXITCODE -ne 0) { throw 'portable feed failed' }
  if (-not (Test-Path "$Out/latest.yml")) { throw "electron-builder did not write $Out/latest.yml" }
}
finally {
  Set-Content -Path package.json -Value $original -NoNewline
  # Rebuild out/ at the real version so later steps don't pick up the throwaway one.
  npm run build | Out-Null
}
