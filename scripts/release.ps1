<#
.SYNOPSIS
  Verify the tree, run checks and tests, build the offline package, optionally tag.

.DESCRIPTION
  The script never pushes and never publishes. It refuses to run on a dirty tree.
  With -Tag it creates the annotated tag for the current package version.

.EXAMPLE
  .\scripts\release.ps1
  .\scripts\release.ps1 -Tag
#>
param(
  [switch]$Tag
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  $dirty = git status --porcelain
  if ($dirty) {
    throw "Working tree is not clean:`n$dirty"
  }

  $pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $repo 'package.json') | ConvertFrom-Json
  $version = $pkg.version
  Write-Host "version: $version"

  npm run check
  if ($LASTEXITCODE -ne 0) { throw 'check failed' }
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
  npm run pack:dry
  if ($LASTEXITCODE -ne 0) { throw 'pack dry-run failed' }

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'build.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  $zip = Join-Path $repo ("dist\dsh-remote-deck-{0}.zip" -f $version)
  if (-not (Test-Path $zip)) { throw "missing build output: $zip" }
  Write-Host ("offline package: {0} ({1:N0} bytes)" -f $zip, (Get-Item $zip).Length)

  $tagName = "v$version"
  if ($Tag) {
    $existing = git tag --list $tagName
    if ($existing) {
      Write-Host "tag $tagName already exists; leaving it untouched"
    } else {
      git tag -a $tagName -m "Remote Deck $tagName"
      Write-Host "tag created: $tagName"
    }
  }

  Write-Host ''
  Write-Host 'next steps (not run by this script):'
  Write-Host '  git push origin main'
  Write-Host "  git push origin $tagName"
  Write-Host '  # GitHub Actions release.yml attaches the npm tarball to the release'
} finally {
  Pop-Location
}
