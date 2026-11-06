# Installs SpanWall into Hermes Desktop's disk-plugin folder.
#   .\scripts\install.ps1          copy plugin.js (re-run after edits)
#   .\scripts\install.ps1 -Link    symlink instead, so every save hot-reloads (needs Developer Mode or admin)
param([switch]$Link)

$ErrorActionPreference = 'Stop'
$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:USERPROFILE '.hermes' }
$source = Resolve-Path (Join-Path $PSScriptRoot '..\plugin\spanwall\desktop\plugin.js')
$targetDir = Join-Path $hermesHome 'desktop-plugins\spanwall'
$target = Join-Path $targetDir 'plugin.js'

New-Item -ItemType Directory -Force $targetDir | Out-Null
if (Test-Path $target) { Remove-Item $target -Force }

if ($Link) {
    New-Item -ItemType SymbolicLink -Path $target -Target $source | Out-Null
    Write-Host "Linked $target -> $source"
} else {
    Copy-Item $source $target
    Write-Host "Copied to $target"
}
Write-Host 'In Hermes Desktop: Ctrl+K -> "Reload desktop plugins", then open "SpanWall" from the sidebar.'
