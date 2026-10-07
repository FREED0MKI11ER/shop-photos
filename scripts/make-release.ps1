param(
  [string]$Version = "",
  [string]$Repo = "",
  [switch]$NoBump,
  [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = Split-Path -Parent $PSScriptRoot
$ReleaseDir = Join-Path $Root "dist\releases"

# Make the portable Git/gh tools available if they were installed there.
$tools = Join-Path $env:LOCALAPPDATA "ShopPhotosTools"
foreach ($sub in @("git\cmd", "gh\bin")) {
  $p = Join-Path $tools $sub
  if (Test-Path $p) { $env:Path = "$p;$env:Path" }
}

function Get-RepoFromGit {
  try {
    $url = (git -C $Root remote get-url origin 2>$null).Trim()
  } catch { return "" }
  if (-not $url) { return "" }
  if ($url -match "github\.com[:/](?<owner>[^/]+)/(?<repo>[^/]+?)(\.git)?$") {
    return "$($Matches.owner)/$($Matches.repo)"
  }
  return ""
}

if (-not $Repo) { $Repo = Get-RepoFromGit }

$versionFile = Join-Path $Root "VERSION"
if (-not (Test-Path $versionFile)) { throw "VERSION file not found at $versionFile" }
$current = (Get-Content $versionFile -Raw).Trim()

if ($Version) {
  $newVersion = $Version
} elseif ($NoBump) {
  $newVersion = $current
} else {
  $parts = @($current.Split("."))
  while ($parts.Count -lt 3) { $parts += "0" }
  $parts[2] = [string]([int]$parts[2] + 1)
  $newVersion = ($parts -join ".")
}

Write-Host "Building release $newVersion ..." -ForegroundColor Magenta

# --- Stage the app files ---
$stage = Join-Path $env:TEMP ("ShopPhotosRelease-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$appItems = @(
  "server.js", "package.json", "package-lock.json",
  "public", "node_modules", "service", "scripts", "updater"
)
$exclude = @("share.cred", "admin.cred", "update.log", "admin.sessions.json")

foreach ($item in $appItems) {
  $src = Join-Path $Root $item
  if (-not (Test-Path $src)) { throw "Missing app item: $item" }
  if ($item -eq "updater") {
    $dest = Join-Path $stage "updater"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Force -Path (Join-Path $src "*") -Destination $dest -Exclude $exclude
  } else {
    Copy-Item -Recurse -Force -Path $src -Destination $stage
  }
}
Set-Content -Path (Join-Path $stage "VERSION") -Value $newVersion -NoNewline

# --- Create the zip + manifest ---
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
$zipName = "ShopPhotos-app-$newVersion.zip"
$zipPath = Join-Path $ReleaseDir $zipName
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $stage

$hash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
$latest = [ordered]@{
  version = $newVersion
  file    = $zipName
  sha256  = $hash
  created = (Get-Date).ToUniversalTime().ToString("o")
}
$latestPath = Join-Path $ReleaseDir "latest.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json), $utf8)

# --- Update local VERSION + package.json ---
Set-Content -Path $versionFile -Value $newVersion -NoNewline
$pkgPath = Join-Path $Root "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.version = $newVersion
[System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 10), $utf8)

$sizeMb = "{0:N1}" -f ((Get-Item $zipPath).Length / 1MB)
Write-Host "  Zip    : $zipPath ($sizeMb MB)"
Write-Host "  sha256 : $hash"

if ($SkipPublish) {
  Write-Host "  -SkipPublish set: not committing or releasing." -ForegroundColor Yellow
  return
}

if (-not $Repo) {
  throw "Could not determine GitHub repo. Pass -Repo owner/name or set a git 'origin' remote."
}

# --- Commit, tag, push ---
$tag = "v$newVersion"
Write-Host "Publishing to $Repo ..."
git -C $Root add -A
$changes = (git -C $Root status --porcelain)
if ($changes) {
  git -C $Root commit -m "Release $tag" | Out-Null
}
$existingTag = (git -C $Root tag -l $tag)
if (-not $existingTag) { git -C $Root tag $tag }
git -C $Root push origin HEAD
git -C $Root push origin $tag

# --- Create the GitHub release with assets ---
$hasRelease = $false
try {
  gh release view $tag --repo $Repo *> $null
  $hasRelease = ($LASTEXITCODE -eq 0)
} catch {}
if ($hasRelease) {
  gh release upload $tag $zipPath $latestPath --repo $Repo --clobber
} else {
  gh release create $tag $zipPath $latestPath --repo $Repo --title $tag --notes "Shop Photos $newVersion"
}

Write-Host ""
Write-Host "  Release $newVersion published." -ForegroundColor Green
Write-Host "  Update URL : https://github.com/$Repo/releases/latest/download/latest.json"
Write-Host "  Shop PCs pick it up within ~10 minutes (or via the Update now button)."
