param(
  [string]$SourceUrl = "",
  [string]$Repo = "",
  [string]$InstallDir = "",
  [int]$Port = 3000,
  [string]$ServiceName = "ShopMediaShare",
  [string]$ConfigFile = "",
  [switch]$DryRun,
  [int]$KeepBackups = 3
)

$ErrorActionPreference = "Stop"

if (-not $InstallDir) { $InstallDir = Split-Path -Parent $PSScriptRoot }
if (-not $ConfigFile) { $ConfigFile = Join-Path $PSScriptRoot "config.json" }

$logFile = Join-Path $PSScriptRoot "update.log"
$serviceId = ($ServiceName -replace "[^\w]", "").ToLower() + ".exe"
$dirItems = @("public", "node_modules", "service", "scripts")
$fileItems = @("server.js", "package.json", "package-lock.json", "VERSION")
$appItems = $dirItems + $fileItems + @("updater")

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line
  try { Add-Content -Path $logFile -Value $line } catch {}
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

function Resolve-BaseUrl {
  if ($SourceUrl) { return $SourceUrl.TrimEnd("/") }
  if (Test-Path $ConfigFile) {
    $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
    if ($cfg.sourceUrl) { return $cfg.sourceUrl.TrimEnd("/") }
    if (-not $Repo -and $cfg.repo) { $Repo = $cfg.repo }
  }
  if (-not $Repo) { throw "No update source configured (set config.json repo or pass -Repo/-SourceUrl)." }
  return "https://github.com/$Repo/releases/latest/download"
}

function Get-RemoteFile($base, $name, $dest) {
  if ($base -match "^https?://") {
    Invoke-WebRequest -Uri "$base/$name" -OutFile $dest -UseBasicParsing -TimeoutSec 120
  } else {
    Copy-Item -Force (Join-Path $base $name) $dest
  }
}

function Get-RemoteJson($base, $name) {
  if ($base -match "^https?://") {
    return Invoke-RestMethod -Uri "$base/$name" -TimeoutSec 60
  }
  return (Get-Content (Join-Path $base $name) -Raw | ConvertFrom-Json)
}

function Stop-AppService {
  $s = Get-Service -Name $serviceId -ErrorAction SilentlyContinue
  if (-not $s) {
    $s = Get-Service -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq $ServiceName } | Select-Object -First 1
  }
  if ($s) {
    Stop-Service -Name $s.Name -Force -ErrorAction SilentlyContinue
    $s.WaitForStatus("Stopped", "00:00:30")
  }
}

function Start-AppService {
  $s = Get-Service -Name $serviceId -ErrorAction SilentlyContinue
  if (-not $s) {
    $s = Get-Service -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq $ServiceName } | Select-Object -First 1
  }
  if ($s) { Start-Service -Name $s.Name }
}

function Apply-Package($sourceDir) {
  foreach ($item in $dirItems) {
    $src = Join-Path $sourceDir $item
    if (-not (Test-Path $src)) { continue }
    $dest = Join-Path $InstallDir $item
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse -Force $src $dest
  }
  foreach ($item in $fileItems) {
    $src = Join-Path $sourceDir $item
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $InstallDir $item) }
  }
  # updater files, but never overwrite credentials, config, sessions, or the log
  $updSrc = Join-Path $sourceDir "updater"
  if (Test-Path $updSrc) {
    $updDest = Join-Path $InstallDir "updater"
    New-Item -ItemType Directory -Force -Path $updDest | Out-Null
    Copy-Item -Force -Path (Join-Path $updSrc "*") -Destination $updDest `
      -Exclude "share.cred", "admin.cred", "update.log", "admin.sessions.json", "config.json"
  }
}

function Wait-Healthy {
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $r = Invoke-RestMethod "http://localhost:$Port/api/version" -TimeoutSec 3
      if ($r.version) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 1000
  }
  return $false
}

$temp = $null

try {
  if (-not $DryRun -and -not (Test-Admin)) {
    throw "Administrator rights are required to apply updates."
  }

  $base = Resolve-BaseUrl
  $localVersionFile = Join-Path $InstallDir "VERSION"
  $localVersion = if (Test-Path $localVersionFile) { (Get-Content $localVersionFile -Raw).Trim() } else { "0.0.0" }

  Log "Checking for updates (installed: $localVersion) from $base"

  $latest = Get-RemoteJson $base "latest.json"
  if (-not $latest.version) { throw "latest.json is missing a version." }

  if ([version]$latest.version -le [version]$localVersion) {
    Log "Already up to date ($localVersion). Nothing to do."
    return
  }

  Log "New version available: $($latest.version)"

  $temp = Join-Path $env:TEMP ("ShopPhotosUpdate-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null

  $zipLocal = Join-Path $temp $latest.file
  Get-RemoteFile $base $latest.file $zipLocal

  $hash = (Get-FileHash -Path $zipLocal -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $latest.sha256.ToLower()) {
    throw "Checksum mismatch for $($latest.file). Update aborted."
  }
  Log "Downloaded and verified $($latest.file)"

  if ($DryRun) {
    Log "DryRun: skipping service stop and file replacement."
    return
  }

  # --- Back up the current version ---
  $backupRoot = Join-Path $InstallDir "backups"
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $backupZip = Join-Path $backupRoot "$localVersion.zip"
  $backupStage = Join-Path $temp "backup"
  New-Item -ItemType Directory -Force -Path $backupStage | Out-Null
  foreach ($item in $appItems) {
    $p = Join-Path $InstallDir $item
    if (Test-Path $p) { Copy-Item -Recurse -Force $p (Join-Path $backupStage $item) }
  }
  if (Test-Path $backupZip) { Remove-Item -Force $backupZip }
  Compress-Archive -Path (Join-Path $backupStage "*") -DestinationPath $backupZip -Force
  Log "Backed up $localVersion to $backupZip"

  # --- Apply ---
  $extract = Join-Path $temp "extract"
  Expand-Archive -Path $zipLocal -DestinationPath $extract -Force

  Stop-AppService
  Log "Service stopped."
  Apply-Package $extract
  Log "Files replaced with $($latest.version)."
  Start-AppService
  Log "Service started."

  if (Wait-Healthy) {
    Log "Update to $($latest.version) succeeded."
    Get-ChildItem $backupRoot -Filter *.zip | Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $KeepBackups | Remove-Item -Force -ErrorAction SilentlyContinue
  } else {
    Log "Health check FAILED. Rolling back to $localVersion ..."
    Stop-AppService
    $rollback = Join-Path $temp "rollback"
    Expand-Archive -Path $backupZip -DestinationPath $rollback -Force
    Apply-Package $rollback
    Start-AppService
    if (Wait-Healthy) {
      Log "Rollback to $localVersion succeeded."
    } else {
      Log "Rollback health check also failed. Manual attention needed."
    }
  }
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
} finally {
  if ($temp -and (Test-Path $temp)) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
}
