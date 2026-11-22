<#
.SYNOPSIS
  Builds the Firefox (desktop and Android) package of Essence Extractor.

.DESCRIPTION
  manifest.json is the Chrome manifest and is left untouched. This script
  builds the Firefox manifest by taking manifest.json and replacing/adding the
  top-level keys found in manifest.firefox.json, then writes:

    dist\firefox\                              unpacked build (for web-ext run / lint)
    dist\essence-extractor-<version>-firefox.zip   upload this to addons.mozilla.org

  The zip has manifest.json at its root and contains only the files the
  extension needs.

.PARAMETER Lint
  Also run Mozilla's validator (web-ext lint) on the build. Needs Node.js.

.PARAMETER Sign
  Also submit the build to addons.mozilla.org for unlisted (self-distributed)
  signing and download the signed .xpi into dist\. Needs Node.js and your AMO
  API credentials in the WEB_EXT_API_KEY and WEB_EXT_API_SECRET environment
  variables (Developer Hub > Tools > Manage API Keys). Each version number can
  only be signed once, so bump "version" in manifest.json first.

.EXAMPLE
  .\package-firefox.ps1
  .\package-firefox.ps1 -Lint
  .\package-firefox.ps1 -Lint -Sign
#>
[CmdletBinding()]
param(
  [switch]$Lint,
  [switch]$Sign
)

$ErrorActionPreference = 'Stop'

# Files that make up the extension, besides manifest.json and the icons
# (icons are taken from the manifest). Add new scripts/pages here.
$extensionFiles = @(
  'background.js',
  'themes.js',
  'essence.js',
  'options.html',
  'options.js'
)

$root  = $PSScriptRoot
$dist  = Join-Path $root 'dist'
$stage = Join-Path $dist 'firefox'

function Read-JsonFile([string]$path) {
  Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

# ---------- build the Firefox manifest ----------

$manifest = Read-JsonFile (Join-Path $root 'manifest.json')
$overlay  = Read-JsonFile (Join-Path $root 'manifest.firefox.json')
foreach ($prop in $overlay.PSObject.Properties) {
  $manifest | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value -Force
}
$version = $manifest.version

# ---------- work out what goes in the package ----------

$iconFiles = @($manifest.icons.PSObject.Properties | ForEach-Object { $_.Value })
$packageFiles = @($extensionFiles + $iconFiles | Select-Object -Unique)

# Everything the manifest points at must be in the package.
$referenced = @($manifest.background.scripts) + @($manifest.options_ui.page)
foreach ($cs in $manifest.content_scripts) { $referenced += @($cs.js) }
$missing = @($referenced | Where-Object { $packageFiles -notcontains $_ })
if ($missing.Count -gt 0) {
  throw "The manifest refers to files that are not in `$extensionFiles: $($missing -join ', ')"
}
foreach ($rel in $packageFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $rel) -PathType Leaf)) {
    throw "File not found: $rel"
  }
}

# ---------- write the unpacked build ----------

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($rel in $packageFiles) {
  $target = Join-Path $stage $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $rel) -Destination $target
}

# Windows PowerShell escapes < > & ' in JSON; put them back so the manifest
# stays readable. Written as UTF-8 without a byte-order mark.
$json = ConvertTo-Json -InputObject $manifest -Depth 20
$json = [regex]::Replace($json, '\\u00(3c|3e|26|27)', {
  param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16)
})
[System.IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

# ---------- zip it ----------

# Built entry by entry so paths inside the zip use forward slashes; AMO rejects
# the backslash paths that older Compress-Archive versions write.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipPath = Join-Path $dist "essence-extractor-$version-firefox.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($rel in @('manifest.json') + $packageFiles) {
    $entryName = $rel.Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $stage $rel), $entryName)
  }
} finally {
  $zip.Dispose()
}

Write-Host "Firefox build $version"
Write-Host "  Unpacked: $stage"
Write-Host "  Zip:      $zipPath"

# ---------- optional: validate and sign ----------

# npx.cmd, not npx: npm's PowerShell shim (npx.ps1) garbles its arguments when
# called from inside a script.
if ($Lint -or $Sign) {
  if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
    throw '-Lint and -Sign need Node.js (npx) on the PATH.'
  }
}

if ($Lint) {
  Write-Host ''
  Write-Host 'Running web-ext lint...'
  & npx.cmd --yes web-ext lint --source-dir $stage
  if ($LASTEXITCODE -ne 0) { throw 'web-ext lint reported errors.' }
}

if ($Sign) {
  if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) {
    throw 'Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET first (AMO Developer Hub > Tools > Manage API Keys).'
  }
  Write-Host ''
  Write-Host 'Submitting to addons.mozilla.org for unlisted signing...'
  & npx.cmd --yes web-ext sign --channel unlisted --source-dir $stage --artifacts-dir $dist
  if ($LASTEXITCODE -ne 0) { throw 'web-ext sign failed.' }
  Write-Host "Signed .xpi saved in $dist"
} else {
  Write-Host ''
  Write-Host 'To sign: upload the zip at https://addons.mozilla.org/developers/ (Submit a New Add-on > On your own),'
  Write-Host 'or run this script again with -Sign.'
}
