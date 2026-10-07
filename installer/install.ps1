param(
  [string]$InstallDir = "C:\Program Files\ShopPhotos",
  [int]$Port = 0,
  [string]$ServiceName = "ShopMediaShare",
  [string]$Repo = "",
  [string]$AdminPassword = "",
  [string]$PublicUrl = "",
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

# node-windows registers the SCM service name as its id (name with non-word
# chars stripped, lowercased, plus ".exe"); the friendly name is the DisplayName.
$ServiceId = ($ServiceName -replace "[^\w]", "").ToLower() + ".exe"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
}

if (-not (Test-Admin)) {
  Write-Host "Administrator rights are required. Re-launching elevated..." -ForegroundColor Yellow
  $psArgs = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`"",
    "-InstallDir", "`"$InstallDir`"",
    "-Port", "$Port",
    "-ServiceName", "`"$ServiceName`""
  )
  if ($Repo) { $psArgs += @("-Repo", "`"$Repo`"") }
  if ($AdminPassword) { $psArgs += @("-AdminPassword", "`"$AdminPassword`"") }
  if ($PublicUrl) { $psArgs += @("-PublicUrl", "`"$PublicUrl`"") }
  if ($NoPause) { $psArgs += "-NoPause" }
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $psArgs
  exit 0
}

$effectivePort = if ($Port -gt 0) { $Port } else { 3000 }

$Source = Split-Path -Parent $PSCommandPath
$KitNode = Join-Path $Source "runtime\node\node.exe"
$InstallNode = Join-Path $InstallDir "runtime\node\node.exe"

Write-Host ""
Write-Host "  Shop Photos installer" -ForegroundColor Magenta
Write-Host "  ---------------------"
Write-Host "  Install folder : $InstallDir"
Write-Host "  Port           : $effectivePort"
Write-Host "  Service name   : $ServiceName"
if ($PublicUrl) { Write-Host "  Public URL     : $PublicUrl" }
Write-Host ""

if (-not (Test-Path $KitNode)) {
  throw "Bundled Node runtime not found at $KitNode. The kit may be incomplete."
}

# --- Remove any existing service with this name ---
$existing = Get-Service -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq $ServiceId -or $_.DisplayName -eq $ServiceName } |
  Select-Object -First 1
if ($existing) {
  Write-Host "Removing existing service..."
  Stop-Service -Name $existing.Name -Force -ErrorAction SilentlyContinue
  $env:SERVICE_NAME = $ServiceName
  $oldUninstall = Join-Path $InstallDir "service\uninstall-service.js"
  if ((Test-Path $oldUninstall) -and (Test-Path $InstallNode)) {
    & $InstallNode $oldUninstall
    Start-Sleep -Seconds 2
  }
  if (Get-Service -Name $existing.Name -ErrorAction SilentlyContinue) {
    & sc.exe delete $existing.Name | Out-Null
    Start-Sleep -Seconds 2
  }
}

# --- Copy application files (existing data\ is preserved) ---
Write-Host "Copying files to $InstallDir ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Remove-Item -Recurse -Force (Join-Path $InstallDir "daemon") -ErrorAction SilentlyContinue

$items = @(
  "server.js", "package.json", "package-lock.json", "VERSION",
  "public", "lib", "service", "scripts", "updater", "node_modules", "runtime"
)
foreach ($item in $items) {
  $src = Join-Path $Source $item
  if (-not (Test-Path $src)) { Write-Warning "Kit item missing: $item"; continue }
  if ($item -eq "updater") {
    $dest = Join-Path $InstallDir "updater"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Force -Path (Join-Path $src "*") -Destination $dest `
      -Exclude "share.cred", "admin.cred", "update.log", "admin.sessions.json", "config.json"
  } else {
    Copy-Item -Recurse -Force -Path $src -Destination $InstallDir
  }
}

# --- Write site.json (custom port / public URL) ---
if ($Port -gt 0 -or $PublicUrl) {
  $site = [ordered]@{}
  if ($Port -gt 0) { $site.port = $Port }
  if ($PublicUrl) { $site.publicUrl = $PublicUrl }
  [System.IO.File]::WriteAllText(
    (Join-Path $InstallDir "site.json"),
    ($site | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($false))
  )
  Write-Host "Wrote site.json (port $effectivePort, url $PublicUrl)"
}

# --- Install the service ---
Write-Host "Installing service..."
$env:SERVICE_NAME = $ServiceName
$env:PORT = "$effectivePort"
& $InstallNode (Join-Path $InstallDir "service\install-service.js")

# --- Firewall rule ---
Write-Host "Adding firewall rule..."
& (Join-Path $InstallDir "scripts\firewall-rule.ps1") -Port "$effectivePort" -RuleName $ServiceName

# --- Wait for the service to come up ---
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $s = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
  if ($s -and $s.Status -eq "Running") { break }
  Start-Sleep -Milliseconds 500
}

$running = (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue).Status -eq "Running"
$http = $false
try {
  Invoke-WebRequest -UseBasicParsing "http://localhost:$effectivePort/api/info" -TimeoutSec 5 | Out-Null
  $http = $true
} catch { $http = $false }

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.PrefixOrigin -ne "WellKnown"
  } | Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ""
if ($running -and $http) {
  Write-Host "  Installation complete!" -ForegroundColor Green
} elseif ($running) {
  Write-Host "  Service installed and running, but the web check failed." -ForegroundColor Yellow
  Write-Host "  Check the log in $InstallDir\daemon\ if the site does not load."
} else {
  Write-Host "  Service was installed but is not running yet." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Open on this PC  : http://localhost:$effectivePort"
if ($lanIp) {
  Write-Host "  Open on a phone  : http://${lanIp}:$effectivePort"
}
if ($PublicUrl) {
  Write-Host "  Public address   : $PublicUrl"
}
Write-Host ""
Write-Host "  The Connect tab in the site shows a QR code for phones."
Write-Host ""

# --- Configure auto-update from GitHub (optional) ---
if ($Repo) {
  Write-Host "Configuring auto-update from $Repo ..."
  $updaterArgs = @{
    Repo        = $Repo
    InstallDir  = $InstallDir
    Port        = $effectivePort
    ServiceName = $ServiceName
    NoPause     = $true
  }
  if ($AdminPassword) { $updaterArgs.AdminPassword = $AdminPassword }
  & (Join-Path $InstallDir "updater\install-updater.ps1") @updaterArgs
}

if (-not $NoPause) {
  Read-Host "Press Enter to close"
}
