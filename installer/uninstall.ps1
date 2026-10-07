param(
  [string]$InstallDir = "C:\Program Files\ShopPhotos",
  [string]$ServiceName = "ShopMediaShare",
  [switch]$RemoveData,
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
    "-ServiceName", "`"$ServiceName`""
  )
  if ($RemoveData) { $psArgs += "-RemoveData" }
  if ($NoPause) { $psArgs += "-NoPause" }
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $psArgs
  exit 0
}

Write-Host ""
Write-Host "  Shop Photos uninstaller" -ForegroundColor Magenta
Write-Host "  -----------------------"
Write-Host "  Install folder : $InstallDir"
Write-Host "  Service name   : $ServiceName"
Write-Host ""

$env:SERVICE_NAME = $ServiceName
$existing = Get-Service -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq $ServiceId -or $_.DisplayName -eq $ServiceName } |
  Select-Object -First 1
if ($existing) {
  Write-Host "Stopping and removing service..."
  Stop-Service -Name $existing.Name -Force -ErrorAction SilentlyContinue
  $node = Join-Path $InstallDir "runtime\node\node.exe"
  $uninstall = Join-Path $InstallDir "service\uninstall-service.js"
  if ((Test-Path $uninstall) -and (Test-Path $node)) {
    & $node $uninstall
    Start-Sleep -Seconds 2
  }
  if (Get-Service -Name $existing.Name -ErrorAction SilentlyContinue) {
    & sc.exe delete $existing.Name | Out-Null
    Start-Sleep -Seconds 2
  }
} else {
  Write-Host "Service '$ServiceName' is not installed."
}

Write-Host "Removing firewall rule..."
Remove-NetFirewallRule -DisplayName $ServiceName -ErrorAction SilentlyContinue

if (Test-Path $InstallDir) {
  if ($RemoveData) {
    Write-Host "Removing $InstallDir (including photos)..."
    Remove-Item -Recurse -Force $InstallDir
  } else {
    Write-Host "Removing application files (keeping photos in $InstallDir\data)..."
    Get-ChildItem -Force $InstallDir |
      Where-Object { $_.Name -ne "data" } |
      Remove-Item -Recurse -Force
  }
}

Write-Host ""
Write-Host "  Uninstall complete." -ForegroundColor Green
if (-not $RemoveData -and (Test-Path (Join-Path $InstallDir "data"))) {
  Write-Host "  Your photos were kept in $InstallDir\data"
}
Write-Host ""

if (-not $NoPause) {
  Read-Host "Press Enter to close"
}
