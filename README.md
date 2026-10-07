# Shop Photos — Local File Share

A small website that runs on a shop computer so phones and other computers on the
same Wi-Fi can upload and download photos and videos. Files are stored on the shop
computer's disk.

## Requirements

- Windows PC that stays on (the "server" PC).
- Node.js installed (already present: v24).
- Phones/computers on the same Wi-Fi network.

## Quick start (for testing)

```
npm install
npm start
```

Then open `http://localhost:3000` on the server PC. From a phone on the same
Wi-Fi, open `http://<server-ip>:3000` (the **Connect** tab shows the address and a
QR code).

Default port is `3000`. Change it with an environment variable, e.g.
`set PORT=8080 && npm start`.

## Install as a Windows service (always on)

This makes the site start automatically when the PC boots and restart if it
crashes.

1. Open an **Administrator** PowerShell window in this folder.
2. Install the service:

   ```
   node service\install-service.js
   ```

3. Add the firewall rule so phones can connect:

   ```
   powershell -ExecutionPolicy Bypass -File scripts\firewall-rule.ps1
   ```

To remove the service later:

```
node service\uninstall-service.js
```

Logs are written next to the service (see the `daemon` folder created in this
directory after install).

## Keeping the address stable

The address is based on the PC's LAN IP (currently `192.168.70.130`). To keep it
from changing:

- Set a **DHCP reservation** for this PC in your router, **or**
- Assign a **static IP** in Windows network settings.

The PC name usually also works: `http://DELL-LATITUDE-5:3000`.

## Using the site

1. Enter your employee ID once — it's remembered on that device.
2. **Upload** tab: choose photos/videos or use the camera button.
3. **Gallery** tab: browse, filter by employee/type, tap to view, download, delete.
4. **Connect** tab: shows the address + QR code to get other phones on board.

## Home-screen shortcut

Open the address in the phone browser, then:

- **iPhone (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** menu (⋮) → Add to Home screen.

Note: full "install as an app" with offline support requires HTTPS, which this
LAN setup does not use. The shortcut still gives a home-screen icon.

## Storage & limits

- Files live in `data\uploads\`.
- Metadata lives in `data\db.json`.
- Default max upload size: **2 GB per file**. Change with `MAX_UPLOAD_GB`
  (e.g. `set MAX_UPLOAD_GB=5`).

## Notes

Each photo/video can have an optional note. Open a photo in the viewer and add or
edit it with **Save note**. The gallery search matches notes too.

## SSSC-ready downloads

Uploads are unrestricted, but a converted copy is prepared for SSSC automatically
(photos ≤ 6 MB as JPG, videos ≤ 200 MB as MP4). Open a photo/video and use
**Download for SSSC**; the plain **Download** still gives the original.

- Conversion runs in the background right after upload (ffmpeg), so downloads
  are instant once ready.
- ffmpeg is bundled with the installer under `runtime\ffmpeg\`; if missing, the
  server downloads it once automatically.
- Tunable via environment variables: `SSSC_PHOTO_MAX_MB` (6),
  `SSSC_VIDEO_MAX_MB` (200), `SSSC_IMAGE_MAX_EDGE` (2560), `SSSC_JPEG_QUALITY`
  (4), `SSSC_ENABLED` (1), `FFMPEG_PATH`.

## Custom port & public address (`site.json`)

Create `site.json` in the install folder (next to `server.js`) to change the port
and set the address shown on the Connect tab:

```json
{ "port": 80, "publicUrl": "http://shopphotos.net" }
```

- `port` overrides the `PORT` env and the default `3000`. Restart the service
  after changing it.
- `publicUrl` is shown on the Connect tab (the QR still encodes the local IP).
- `site.json` is machine-specific and is preserved across updates.

To run on port 80, also allow it through the firewall:

```
powershell -ExecutionPolicy Bypass -File scripts\firewall-rule.ps1 -Port 80
```

Or set both at install time:

```
install.bat -Port 80 -PublicUrl http://shopphotos.net
```

## Deploy to another shop PC

Build a self-contained installer kit (bundles a portable Node runtime, so the
target PC needs nothing preinstalled):

```
powershell -ExecutionPolicy Bypass -File scripts\make-installer.ps1
```

This produces `dist\ShopPhotos-Setup\` and `dist\ShopPhotos-Setup.zip`. Copy the
zip to the shop PC, extract it, then right-click **`install.bat`** → **Run as
administrator**. It installs to `C:\Program Files\ShopPhotos`, registers the
auto-start service, opens the firewall port, and prints the LAN URL.

Options: `-NodeVersion <x.y.z>` to pin a Node version, `-SkipNode` to build a
tiny kit that requires Node already installed, `-OutDir <path>` to change output.

## Remote updates (via GitHub)

The code lives in a GitHub repo. Installed shop PCs pull new releases over HTTPS,
so updates no longer depend on this PC being on.

**One-time: put the code on GitHub**

```
git init -b main
git add -A
git commit -m "Initial commit"
gh auth login
gh repo create shop-photos --public --source=. --push
```

**One-time on each shop PC** — point it at the repo and set the admin password:

```
powershell -ExecutionPolicy Bypass -File updater\install-updater.ps1 -Repo <owner>/shop-photos
```

This writes `updater\config.json`, stores a PBKDF2 hash of the admin password in
`updater\admin.cred`, and registers the `ShopPhotosAutoUpdate` task (every 10 min).
`-ManualOnly` registers it on-demand only.

**Publish an update** — bump the version and release:

```
powershell -ExecutionPolicy Bypass -File scripts\make-release.ps1
```

It bumps `VERSION`, builds `ShopPhotos-app-<version>.zip` (bundling
`node_modules`) + `latest.json`, commits, tags, pushes, and creates a GitHub
release. Shop PCs pick it up within ~10 minutes. The updater verifies the
checksum, stops the service, backs up the old version, swaps files (keeping
`data\`), restarts, health-checks, and **rolls back automatically** on failure.
Logs are in `updater\update.log`.

**Manual button:** open the site's **Admin** tab, log in with the admin password,
and use **Check for updates** / **Update now**. It triggers the same task.

Test an update safely with `updater\update.ps1 -DryRun` (checks + verifies only).
Point `update.ps1` at a local folder with `-SourceUrl <path>` for offline testing.

## Important

The employee ID is just a label for attribution — it is **not** security. Anyone
on the Wi-Fi can enter any ID. Do not rely on it to keep sensitive content private.
