<#
.SYNOPSIS
  Build the dsh-remote-deck distribution archive and sync it into <DSH_HOME>\plugins.

.EXAMPLE
  .\build.ps1
  .\build.ps1 -Install -Profile deskcheck
#>
param(
  [switch]$Install,
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$name = 'dsh-remote-deck'
$src = $PSScriptRoot
$pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $src 'package.json') | ConvertFrom-Json
$version = $pkg.version
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

$stage = Join-Path $env:TEMP "$name-package"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
$stagePkg = Join-Path $stage $name
New-Item -ItemType Directory -Force $stagePkg | Out-Null

$exclude = @('.git', 'node_modules', 'dist', 'docs', '.github', 'scripts', 'test')
Get-ChildItem $src -Force |
  Where-Object { $exclude -notcontains $_.Name -and $_.Extension -ne '.tgz' } |
  ForEach-Object { Copy-Item $_.FullName -Destination $stagePkg -Recurse -Force }

$dist = Join-Path $src 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist ("{0}-{1}.zip" -f $name, $version)
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stagePkg -DestinationPath $zip -CompressionLevel Optimal

$plugins = Join-Path $dshHome 'plugins'
New-Item -ItemType Directory -Force $plugins | Out-Null
Copy-Item $zip (Join-Path $plugins ("{0}-{1}.zip" -f $name, $version)) -Force
$dest = Join-Path $plugins $name
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive -Path $zip -DestinationPath $plugins -Force

Write-Host "built:  $zip"
Write-Host "synced: $dest"
Write-Host "version: $version"

if ($Install) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'install.ps1') -Profile $Profile
  Write-Host "installed into profile: $Profile (restart DSH or press Ctrl+R)"
}
