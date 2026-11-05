<#
.SYNOPSIS
  Install (or remove / roll back) the dsh-remote-deck plugin in a DSH profile.

.DESCRIPTION
  Copies this directory into <DSH_HOME>\profiles\<profile>\node_modules\dsh-remote-deck,
  then records the package in both dsh.profile.bundles and dependencies. Recording the
  dependency matters: the DSH plugin manager prunes node_modules entries that are not
  declared, which used to make hand-installed plugins disappear.

  The first install also saves package.json.bak-before-deck, which -Rollback restores.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile deskcheck
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Rollback
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
param(
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$Uninstall,
  [switch]$Rollback,
  [switch]$RemoveOld,
  [switch]$Doctor
)

$ErrorActionPreference = 'Stop'
$name = 'dsh-remote-deck'
$source = $PSScriptRoot
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$manifest = Join-Path $profileDir 'package.json'
$dest = Join-Path $profileDir (Join-Path 'node_modules' $name)

if (-not (Test-Path $manifest)) {
  throw "Profile manifest not found: $manifest (check -Profile / -DshHome)"
}

if ($Doctor) {
  $json = Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json
  $bundles = @()
  if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }
  $deckOn = $bundles -contains 'dsh-remote-deck'
  $oldOn = $bundles -contains 'dsh-remote-ssh'
  Write-Host "DSH_HOME:            $DshHome"
  Write-Host "profile:             $Profile"
  Write-Host "profile dir:         $profileDir"
  Write-Host "remote-deck bundle:  $deckOn"
  Write-Host "remote-ssh bundle:   $oldOn"
  if ($deckOn -and $oldOn) {
    Write-Warning "Both plugins are enabled. They both patch ctx.fs; keep only one (use -RemoveOld or uninstall remote-ssh)."
  }
  $deckDir = Join-Path $profileDir 'node_modules\dsh-remote-deck'
  if (Test-Path (Join-Path $deckDir 'package.json')) {
    $installed = (Get-Content -Raw -Encoding UTF8 (Join-Path $deckDir 'package.json') | ConvertFrom-Json).version
    $build = ''
    if (Test-Path (Join-Path $deckDir 'index.js')) {
      $m = [regex]::Match((Get-Content -Raw -Encoding UTF8 (Join-Path $deckDir 'index.js')), "const BUILD = '([^']+)'")
      if ($m.Success) { $build = $m.Groups[1].Value }
    }
    Write-Host "installed version:   $installed"
    Write-Host "host build:          $build"
    if ($build -ne '' -and $build -ne $installed) { Write-Warning "host build ($build) does not match package version ($installed); reinstall the plugin." }
  } else {
    Write-Host "installed version:   (not installed in this profile)"
  }
  if ($oldOn) {
    $oldDir = Join-Path $profileDir 'node_modules\dsh-remote-ssh'
    Write-Host "remote-ssh files:    $(Test-Path (Join-Path $oldDir 'package.json'))"
  }
  $dataDir = Join-Path $DshHome 'remote-deck'
  $connections = Join-Path $dataDir 'connections.json'
  if (Test-Path $connections) {
    $count = @((Get-Content -Raw -Encoding UTF8 $connections | ConvertFrom-Json).connections).Count
    Write-Host "connections:         $count"
  } else {
    Write-Host "connections:         (no data yet)"
  }
  $wsRoot = Join-Path $dataDir 'workspaces'
  $wsCount = 0
  if (Test-Path $wsRoot) {
    $wsCount = @(Get-ChildItem $wsRoot -Recurse -Filter '.dsh-remote.json' -ErrorAction SilentlyContinue).Count
  }
  $legacyWs = Join-Path $DshHome 'remote-ssh\workspaces'
  $legacyCount = 0
  if (Test-Path $legacyWs) {
    $legacyCount = @(Get-ChildItem $legacyWs -Recurse -Filter '.dsh-remote.json' -ErrorAction SilentlyContinue).Count
  }
  Write-Host "workspaces:          $wsCount (legacy remote-ssh: $legacyCount)"
  $fwd = Join-Path $dataDir 'forwards.json'
  if (Test-Path $fwd) {
    $fCount = @((Get-Content -Raw -Encoding UTF8 $fwd | ConvertFrom-Json).forwards).Count
    Write-Host "saved forwards:      $fCount"
  }
  return
}

function Remove-PluginDir([string]$target) {
  if (-not (Test-Path $target)) { return }
  $item = Get-Item $target -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    cmd /c rmdir "$target" | Out-Null
  } else {
    Remove-Item -Recurse -Force $target
  }
}

function Read-Manifest {
  return Get-Content -Raw -Encoding UTF8 $manifest | ConvertFrom-Json
}

function Write-Manifest($json) {
  $text = ($json | ConvertTo-Json -Depth 32)
  [IO.File]::WriteAllText($manifest, $text + "`n", (New-Object System.Text.UTF8Encoding -ArgumentList $false))
}

function Get-Bundles($json) {
  if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) { return @($json.dsh.profile.bundles) }
  return @()
}

function Get-Deps($json) {
  $deps = @{}
  if ($json.dependencies) { $json.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value } }
  return $deps
}

if ($Rollback) {
  $backup = "$manifest.bak-before-deck"
  if (Test-Path $backup) {
    Copy-Item $manifest "$manifest.bak-rollback" -Force
    Copy-Item $backup $manifest -Force
    Write-Host "restored profile manifest from $backup"
  } else {
    $json = Read-Manifest
    $bundles = @(Get-Bundles $json) | Where-Object { $_ -ne $name }
    $deps = Get-Deps $json
    $deps.Remove($name)
    Copy-Item $manifest "$manifest.bak-rollback" -Force
    $json.dsh.profile.bundles = @($bundles)
    $json.dependencies = [pscustomobject]$deps
    Write-Manifest $json
    Write-Host "removed $name from bundles/dependencies (no pre-install backup found)"
  }
  Remove-PluginDir $dest
  Write-Host "rollback done. Restart DSH. Data stays in $DshHome\remote-deck"
  return
}

$json = Read-Manifest
$bundles = @(Get-Bundles $json)

if ($Uninstall) {
  $deps = Get-Deps $json
  $deps.Remove($name)
  Copy-Item $manifest "$manifest.bak-uninstall" -Force
  $json.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $name })
  $json.dependencies = [pscustomobject]$deps
  Write-Manifest $json
  Remove-PluginDir $dest
  Write-Host "uninstalled $name from profile '$Profile'"
  Write-Host "plugin data stays in $DshHome\remote-deck"
  return
}

if (-not (Test-Path (Join-Path $source 'index.js'))) {
  throw "Not a plugin directory (index.js missing): $source"
}

New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
Remove-PluginDir $dest
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$exclude = @('.git', 'node_modules', 'dist', 'docs', '.github', 'scripts', 'test')
Get-ChildItem $source -Force |
  Where-Object { $exclude -notcontains $_.Name -and $_.Name -ne 'install.ps1' } |
  ForEach-Object { Copy-Item $_.FullName -Destination $dest -Recurse -Force }
Copy-Item $PSCommandPath (Join-Path $dest 'install.ps1') -Force -ErrorAction SilentlyContinue

$backupBefore = "$manifest.bak-before-deck"
if (-not (Test-Path $backupBefore)) { Copy-Item $manifest $backupBefore -Force }

$sourcePosix = ($source -replace '\\', '/')
$deps = Get-Deps $json
$deps[$name] = "file:$sourcePosix"
$newBundles = @($bundles | Where-Object { $_ -ne $name }) + $name

if ($bundles -ne $newBundles -or $deps[$name] -ne $json.dependencies.$name) {
  Copy-Item $manifest "$manifest.bak-install" -Force
}
$json.dsh.profile.bundles = @($newBundles)
$json.dependencies = [pscustomobject]$deps
Write-Manifest $json

if ($RemoveOld) {
  $legacy = 'dsh-remote-ssh'
  $json.dsh.profile.bundles = @($json.dsh.profile.bundles | Where-Object { $_ -ne $legacy })
  $deps.Remove($legacy)
  $json.dependencies = [pscustomobject]$deps
  Write-Manifest $json
  Write-Host "removed legacy $legacy from bundles/dependencies (plugin files kept for rollback)"
}

Write-Host ""
Write-Host "installed: $dest"
Write-Host "profile:   $profileDir"
Write-Host "data:      $DshHome\remote-deck"
Write-Host "restart DSH (or press Ctrl+R) to load the plugin"
Write-Host "rollback:  .\install.ps1 -Rollback"
