param(
  [string]$OutDir = "dist",
  [string]$NodeVersion = "",
  [switch]$SkipNode
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = Split-Path -Parent $PSScriptRoot
$OutRoot = Join-Path $Root $OutDir
$Stage = Join-Path $OutRoot "ShopPhotos-Setup"
$ZipPath = Join-Path $OutRoot "ShopPhotos-Setup.zip"
$Cache = Join-Path $OutRoot ".cache"

Write-Host "Building Shop Photos installer kit..." -ForegroundColor Magenta
Write-Host "  Source : $Root"
Write-Host "  Output : $Stage"

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
New-Item -ItemType Directory -Force -Path $Cache | Out-Null

# --- 1. Copy application files ---
$appItems = @(
  "server.js", "package.json", "package-lock.json", "README.md", "VERSION",
  "public", "service", "scripts", "updater", "node_modules"
)
foreach ($item in $appItems) {
  $src = Join-Path $Root $item
  if (-not (Test-Path $src)) { throw "Missing app item: $item" }
  if ($item -eq "updater") {
    $dest = Join-Path $Stage "updater"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Force -Path (Join-Path $src "*") -Destination $dest `
      -Exclude "share.cred", "admin.cred", "update.log", "admin.sessions.json", "config.json"
  } else {
    Copy-Item -Recurse -Force -Path $src -Destination $Stage
  }
}
Write-Host "  Copied application files."

# --- 2. Bundle portable Node.js ---
if (-not $SkipNode) {
  if (-not $NodeVersion) {
    Write-Host "  Resolving latest Node.js LTS..."
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    if (-not $lts) { throw "Could not determine the latest Node.js LTS." }
    $NodeVersion = $lts.version.TrimStart("v")
  }

  $zipName = "node-v$NodeVersion-win-x64.zip"
  $url = "https://nodejs.org/dist/v$NodeVersion/$zipName"
  $cacheFile = Join-Path $Cache $zipName

  if (-not (Test-Path $cacheFile)) {
    Write-Host "  Downloading Node.js v$NodeVersion ..."
    Invoke-WebRequest -Uri $url -OutFile $cacheFile
  } else {
    Write-Host "  Using cached Node.js v$NodeVersion"
  }

  $extractDir = Join-Path $Cache "extract"
  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
  Expand-Archive -Path $cacheFile -DestinationPath $extractDir -Force

  $exe = Join-Path $extractDir "node-v$NodeVersion-win-x64\node.exe"
  if (-not (Test-Path $exe)) { throw "node.exe not found after extracting $zipName" }

  $dest = Join-Path $Stage "runtime\node"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item $exe -Destination $dest
  Write-Host "  Bundled Node.js v$NodeVersion."
} else {
  Write-Host "  Skipping Node runtime (-SkipNode)." -ForegroundColor Yellow
}

# --- 3. Copy installer scripts ---
$installerItems = @(
  "install.ps1", "install.bat", "uninstall.ps1", "uninstall.bat", "README-INSTALL.txt"
)
foreach ($f in $installerItems) {
  $src = Join-Path $Root "installer\$f"
  if (-not (Test-Path $src)) { throw "Missing installer file: $f" }
  Copy-Item -Path $src -Destination $Stage -Force
}
Write-Host "  Added installer scripts."

# --- 4. Sanity checks ---
$dataLeak = Test-Path (Join-Path $Stage "data")
$daemonLeak = Test-Path (Join-Path $Stage "daemon")
if ($dataLeak -or $daemonLeak) { throw "Kit contains data/ or daemon/ - aborting." }

# --- 5. Zip ---
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Write-Host "  Compressing..."
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $ZipPath -Force

$zipMb = "{0:N1}" -f ((Get-Item $ZipPath).Length / 1MB)
Write-Host ""
Write-Host "  Kit built successfully." -ForegroundColor Green
Write-Host "  Folder : $Stage"
Write-Host "  Zip    : $ZipPath ($zipMb MB)"
Write-Host ""
Write-Host "  Copy the zip (or the folder) to the shop PC, extract, then"
Write-Host "  right-click install.bat -> Run as administrator."
