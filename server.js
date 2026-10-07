"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_UPLOAD_BYTES =
  (parseInt(process.env.MAX_UPLOAD_GB, 10) || 2) * 1024 * 1024 * 1024;

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(ROOT, "public");

const UPDATER_DIR = path.join(ROOT, "updater");
const ADMIN_CRED_FILE = path.join(UPDATER_DIR, "admin.cred");
const ADMIN_SESSIONS_FILE = path.join(UPDATER_DIR, "admin.sessions.json");
const UPDATE_CONFIG_FILE = path.join(UPDATER_DIR, "config.json");
const UPDATE_SCRIPT = path.join(UPDATER_DIR, "update.ps1");
const UPDATE_LOG = path.join(UPDATER_DIR, "update.log");
const UPDATE_TASK_NAME = "ShopPhotosAutoUpdate";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

let APP_VERSION = "0.0.0";
try {
  APP_VERSION =
    fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").replace(/^\uFEFF/, "").trim() ||
    "0.0.0";
} catch (err) {
  // VERSION file is optional; fall back to a placeholder.
}

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function readDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.media)) return parsed;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("db.json unreadable, starting fresh:", err.message);
    }
  }
  return { media: [] };
}

let db = readDb();

function writeDb() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function safeExtension(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : "";
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}-${id}${safeExtension(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 60 },
  fileFilter: (req, file, cb) => {
    const ok =
      /^image\//.test(file.mimetype) || /^video\//.test(file.mimetype);
    if (ok) return cb(null, true);
    cb(new Error("Only image and video files are allowed"));
  },
});

const app = express();
app.disable("x-powered-by");
app.use(express.json());

function cleanEmployeeId(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w .-]/g, "")
    .slice(0, 40);
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === "IPv4" && !addr.internal) {
        out.push({ iface: name, address: addr.address });
      }
    }
  }
  return out;
}

app.get("/api/info", (req, res) => {
  const addrs = lanAddresses();
  res.json({
    hostname: os.hostname(),
    port: PORT,
    version: APP_VERSION,
    addresses: addrs,
    primaryUrl: addrs.length ? `http://${addrs[0].address}:${PORT}` : null,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    count: db.media.length,
  });
});

app.get("/api/version", (req, res) => {
  res.json({ version: APP_VERSION });
});

/* ---------------- Admin / updates ---------------- */

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function verifyPassword(password, cred) {
  try {
    const salt = Buffer.from(cred.salt, "base64");
    const expected = Buffer.from(cred.hash, "base64");
    const derived = crypto.pbkdf2Sync(
      String(password),
      salt,
      cred.iterations || 210000,
      expected.length,
      "sha256"
    );
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch (err) {
    return false;
  }
}

let sessions = new Map();
try {
  for (const s of readJsonSafe(ADMIN_SESSIONS_FILE) || []) {
    if (s.token && s.expires > Date.now()) sessions.set(s.token, s.expires);
  }
} catch (err) {
  sessions = new Map();
}

function saveSessions() {
  try {
    const arr = [...sessions.entries()].map(([token, expires]) => ({ token, expires }));
    fs.writeFileSync(ADMIN_SESSIONS_FILE, JSON.stringify(arr));
  } catch (err) {
    /* sessions are best-effort */
  }
}

function createSession() {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  saveSessions();
  return token;
}

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token") || req.query.token;
  const expires = token && sessions.get(token);
  if (!expires || expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Not authorized" });
  }
  next();
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeout || 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

function powershellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function schtasksPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "schtasks.exe");
}

function readLogTail(maxLines) {
  try {
    const lines = fs.readFileSync(UPDATE_LOG, "utf8").trimEnd().split(/\r?\n/);
    return lines.slice(-maxLines);
  } catch (err) {
    return [];
  }
}

let adminBusy = false;

app.post("/api/admin/login", (req, res) => {
  const cred = readJsonSafe(ADMIN_CRED_FILE);
  if (!cred || !cred.hash) {
    return res.status(503).json({ error: "Admin is not configured. Run install-updater.ps1." });
  }
  const password = req.body && req.body.password;
  if (!password || !verifyPassword(password, cred)) {
    return res.status(401).json({ error: "Incorrect password" });
  }
  res.json({ token: createSession(), expiresInMs: SESSION_TTL_MS });
});

app.get("/api/admin/status", requireAdmin, async (req, res) => {
  const cfg = readJsonSafe(UPDATE_CONFIG_FILE) || {};
  const task = await run(schtasksPath(), ["/query", "/tn", UPDATE_TASK_NAME], 15000);
  res.json({
    version: APP_VERSION,
    repo: cfg.repo || null,
    updaterPresent: fs.existsSync(UPDATE_SCRIPT),
    taskPresent: task.code === 0,
    log: readLogTail(20),
  });
});

app.post("/api/admin/check", requireAdmin, async (req, res) => {
  if (adminBusy) return res.status(409).json({ error: "An update check is already running." });
  if (!fs.existsSync(UPDATE_SCRIPT)) {
    return res.status(503).json({ error: "Updater not found. Run install-updater.ps1." });
  }
  adminBusy = true;
  try {
    const r = await run(
      powershellPath(),
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        UPDATE_SCRIPT,
        "-InstallDir",
        ROOT,
        "-Port",
        String(PORT),
        "-DryRun",
      ],
      90000
    );
    const text = r.stdout + r.stderr;
    const upToDate = /Already up to date/i.test(text);
    const match = text.match(/New version available:\s*([0-9.]+)/i);
    res.json({
      upToDate,
      availableVersion: match ? match[1] : null,
      ok: r.code === 0,
      output: text.trim().split(/\r?\n/).slice(-15),
    });
  } finally {
    adminBusy = false;
  }
});

app.post("/api/admin/update", requireAdmin, async (req, res) => {
  const cfg = readJsonSafe(UPDATE_CONFIG_FILE) || {};
  if (!cfg.repo) {
    return res.status(503).json({ error: "No update source configured. Run install-updater.ps1." });
  }
  const r = await run(schtasksPath(), ["/run", "/tn", UPDATE_TASK_NAME], 20000);
  if (r.code !== 0) {
    return res.status(503).json({
      error: "Could not start the update task. Run install-updater.ps1 on the shop PC.",
    });
  }
  res.json({ started: true, from: APP_VERSION });
});

app.get("/api/media", (req, res) => {
  const media = db.media
    .slice()
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  res.json({ media });
});

app.get("/api/qr", async (req, res) => {
  const text = String(req.query.text || "").slice(0, 500);
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    const png = await QRCode.toBuffer(text, {
      type: "png",
      width: 360,
      margin: 1,
      color: { dark: "#0a0c0f", light: "#ffffff" },
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: "Could not generate QR code" });
  }
});

app.post("/api/upload", (req, res) => {
  upload.array("files", 60)(req, res, (err) => {
    if (err) {
      const msg =
        err.code === "LIMIT_FILE_SIZE"
          ? "One of the files is larger than the upload limit"
          : err.message || "Upload failed";
      return res.status(400).json({ error: msg });
    }

    const employeeId = cleanEmployeeId(req.body.employeeId);
    if (!employeeId) {
      for (const f of req.files || []) fs.unlink(f.path, () => {});
      return res.status(400).json({ error: "An employee ID is required" });
    }

    const saved = (req.files || []).map((f) => {
      const record = {
        id: crypto.randomUUID(),
        originalName: f.originalname,
        storedName: f.filename,
        mime: f.mimetype,
        size: f.size,
        employeeId,
        uploadedAt: new Date().toISOString(),
      };
      db.media.push(record);
      return record;
    });

    if (saved.length) writeDb();
    res.json({ uploaded: saved, count: saved.length });
  });
});

app.delete("/api/media/:id", (req, res) => {
  const idx = db.media.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  const [record] = db.media.splice(idx, 1);
  writeDb();
  fs.unlink(path.join(UPLOAD_DIR, record.storedName), () => {});
  res.json({ deleted: record.id });
});

app.use(
  "/files",
  express.static(UPLOAD_DIR, {
    index: false,
    setHeaders: (res) => res.setHeader("Accept-Ranges", "bytes"),
  })
);

app.use(express.static(PUBLIC_DIR));

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, HOST, () => {
  const addrs = lanAddresses();
  console.log(`Shop Media Share running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const a of addrs) console.log(`  Network: http://${a.address}:${PORT}`);
});
