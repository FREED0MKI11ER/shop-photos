param(
  [string]$Repo = "",
  [string]$AdminPassword = "",
  [string]$InstallDir = "",
  [int]$Port = 3000,
  [string]$ServiceName = "ShopMediaShare",
  [int]$IntervalMinutes = 10,
  [switch]$ManualOnly,
  [switch]$RunNow,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

if (-not $InstallDir) { $InstallDir = Split-Path -Parent $PSScriptRoot }

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
    "-ServiceName", "`"$ServiceName`"",
    "-IntervalMinutes", "$IntervalMinutes"
  )
  if ($Repo) { $psArgs += @("-Repo", "`"$Repo`"") }
  if ($ManualOnly) { $psArgs += "-ManualOnly" }
  if ($RunNow) { $psArgs += "-RunNow" }
  if ($NoPause) { $psArgs += "-NoPause" }
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $psArgs
  exit 0
}

Write-Host ""
Write-Host "  Shop Photos auto-updater setup" -ForegroundColor Magenta
Write-Host "  ------------------------------"
Write-Host "  Install folder : $InstallDir"
Write-Host "  Schedule       : $(if ($ManualOnly) { 'manual only' } else { "every $IntervalMinutes minutes" })"
Write-Host ""

if (-not $Repo) { $Repo = Read-Host "GitHub repo (owner/name, e.g. jake/shop-photos)" }
if (-not $Repo -or $Repo -notmatch "/") { throw "A repo in 'owner/name' form is required." }

# --- Update source config ---
$updaterDir = Join-Path $InstallDir "updater"
New-Item -ItemType Directory -Force -Path $updaterDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  (Join-Path $updaterDir "config.json"),
  ([ordered]@{ repo = $Repo } | ConvertTo-Json),
  $utf8
)
Write-Host "  Wrote config.json (repo: $Repo)"

# --- Admin password (PBKDF2-SHA256) ---
if (-not $AdminPassword) {
  $s1 = Read-Host "Choose an admin password for the web Update button" -AsSecureString
  $s2 = Read-Host "Confirm the admin password" -AsSecureString
  $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1)
  $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2)
  $p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b1)
  $p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b2)
  if ($p1 -ne $p2) { throw "Passwords did not match." }
  if (-not $p1) { throw "Password cannot be empty." }
  $AdminPassword = $p1
}

$iterations = 210000
$salt = New-Object byte[] 16
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($salt)
$kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
  $AdminPassword, $salt, $iterations, [System.Security.Cryptography.HashAlgorithmName]::SHA256
)
$hash = $kdf.GetBytes(32)

$credFile = Join-Path $updaterDir "admin.cred"
$credJson = [ordered]@{
  algorithm  = "pbkdf2-sha256"
  iterations = $iterations
  salt       = [Convert]::ToBase64String($salt)
  hash       = [Convert]::ToBase64String($hash)
} | ConvertTo-Json
[System.IO.File]::WriteAllText($credFile, $credJson, $utf8)

$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "Allow")))
Set-Acl -Path $credFile -AclObject $acl
Write-Host "  Saved admin credentials to $credFile"

# --- Scheduled task ---
$updateScript = Join-Path $updaterDir "update.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (
  "-NoProfile -ExecutionPolicy Bypass -File `"$updateScript`" " +
  "-InstallDir `"$InstallDir`" -Port $Port -ServiceName `"$ServiceName`""
)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

if ($ManualOnly) {
  Register-ScheduledTask -TaskName "ShopPhotosAutoUpdate" -Action $action `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "  Registered scheduled task 'ShopPhotosAutoUpdate' (manual/on-demand)."
} else {
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName "ShopPhotosAutoUpdate" -Action $action `
    -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "  Registered scheduled task 'ShopPhotosAutoUpdate' (every $IntervalMinutes min)."
}

if ($RunNow) {
  Start-ScheduledTask -TaskName "ShopPhotosAutoUpdate"
  Write-Host "  Started an update check now."
}

Write-Host ""
Write-Host "  Auto-update configured for $Repo." -ForegroundColor Green
Write-Host "  Open the site's Admin tab and log in with the admin password."
Write-Host ""

if (-not $NoPause) { Read-Host "Press Enter to close" }
