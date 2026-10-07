"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const PHOTO_MAX = (parseFloat(process.env.SSSC_PHOTO_MAX_MB) || 6) * 1024 * 1024;
const VIDEO_MAX = (parseFloat(process.env.SSSC_VIDEO_MAX_MB) || 200) * 1024 * 1024;
const IMAGE_MAX_EDGE = parseInt(process.env.SSSC_IMAGE_MAX_EDGE, 10) || 2560;
const JPEG_Q = parseInt(process.env.SSSC_JPEG_QUALITY, 10) || 4; // ffmpeg -q:v (2 best .. 31 worst)
const ENABLED = process.env.SSSC_ENABLED !== "0";
const DOWNLOAD_URL =
  process.env.FFMPEG_DOWNLOAD_URL ||
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs || 0, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
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

function findFile(dir, name) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function createConverter({ uploadDir, ssscDir, runtimeDir, onSave, log }) {
  fs.mkdirSync(ssscDir, { recursive: true });

  const queue = [];
  let running = false;
  let ffmpegPath = null;
  let ffmpegChecked = false;

  const say = (msg) => {
    if (log) log("[sssc] " + msg);
  };

  async function ensureFfmpeg() {
    if (ffmpegChecked) return ffmpegPath;
    ffmpegChecked = true;

    const candidates = [
      process.env.FFMPEG_PATH,
      path.join(runtimeDir, "ffmpeg", "ffmpeg.exe"),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        ffmpegPath = c;
        return c;
      }
    }

    try {
      say("ffmpeg not found, downloading...");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-"));
      const zip = path.join(tmp, "ffmpeg.zip");
      const dl = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${DOWNLOAD_URL}' -OutFile '${zip}'`,
        ],
        1800000
      );
      if (dl.code !== 0 || !fs.existsSync(zip)) throw new Error("download failed");
      const ex = path.join(tmp, "ex");
      const un = await run(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -Path '${zip}' -DestinationPath '${ex}' -Force`],
        900000
      );
      if (un.code !== 0) throw new Error("extract failed");
      const found = findFile(ex, "ffmpeg.exe");
      if (!found) throw new Error("ffmpeg.exe not in archive");
      const destDir = path.join(runtimeDir, "ffmpeg");
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(found, path.join(destDir, "ffmpeg.exe"));
      ffmpegPath = path.join(destDir, "ffmpeg.exe");
      say("ffmpeg installed to " + ffmpegPath);
      fs.rmSync(tmp, { recursive: true, force: true });
      return ffmpegPath;
    } catch (err) {
      say("ffmpeg download failed: " + err.message);
      return null;
    }
  }

  async function probeDuration(ff, input) {
    const r = await run(ff, ["-hide_banner", "-i", input], 30000);
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
  }

  async function convertImage(ff, input, outPath) {
    const attempts = [
      { edge: IMAGE_MAX_EDGE, q: JPEG_Q },
      { edge: Math.round(IMAGE_MAX_EDGE * 0.75), q: JPEG_Q + 2 },
      { edge: Math.round(IMAGE_MAX_EDGE * 0.5), q: JPEG_Q + 4 },
      { edge: 1280, q: 8 },
    ];
    let lastErr = new Error("image conversion failed");
    for (const a of attempts) {
      const vf = `scale='min(${a.edge},iw)':'min(${a.edge},ih)':force_original_aspect_ratio=decrease`;
      const r = await run(
        ff,
        ["-y", "-i", input, "-vf", vf, "-frames:v", "1", "-q:v", String(a.q), outPath],
        300000
      );
      if (r.code !== 0 || !fs.existsSync(outPath)) {
        lastErr = new Error("ffmpeg image failed: " + r.stderr.slice(-300));
        continue;
      }
      const size = fs.statSync(outPath).size;
      if (size <= PHOTO_MAX) return size;
      lastErr = new Error("image still too large (" + size + " bytes)");
    }
    throw lastErr;
  }

  async function convertVideo(ff, input, outPath) {
    const duration = await probeDuration(ff, input);
    const audioBits = 128000;
    let vb = 4000000;
    if (duration && duration > 0) {
      vb = Math.floor((VIDEO_MAX * 8) / duration - audioBits);
      vb = Math.max(300000, Math.min(vb, 25000000));
    }
    let lastErr = new Error("video conversion failed");
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await run(
        ff,
        [
          "-y", "-i", input,
          "-c:v", "libx264", "-preset", "veryfast",
          "-b:v", String(vb),
          "-maxrate", String(Math.round(vb * 1.5)),
          "-bufsize", String(Math.round(vb * 2)),
          "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart",
          outPath,
        ],
        3600000
      );
      if (r.code !== 0 || !fs.existsSync(outPath)) {
        throw new Error("ffmpeg video failed: " + r.stderr.slice(-300));
      }
      const size = fs.statSync(outPath).size;
      if (size <= VIDEO_MAX) return size;
      lastErr = new Error("video still too large (" + size + " bytes)");
      vb = Math.floor(vb * 0.7);
    }
    throw lastErr;
  }

  async function remux(ff, input, outPath) {
    const r = await run(
      ff,
      ["-y", "-i", input, "-c", "copy", "-movflags", "+faststart", outPath],
      600000
    );
    if (r.code !== 0 || !fs.existsSync(outPath)) return null;
    return fs.statSync(outPath).size;
  }

  async function convert(record) {
    record.sssc = { status: "converting", updatedAt: new Date().toISOString() };
    onSave();

    const ff = await ensureFfmpeg();
    if (!ff) throw new Error("ffmpeg is not available");

    const input = path.join(uploadDir, record.storedName);
    const isImage = /^image\//.test(record.mime);
    const isVideo = /^video\//.test(record.mime);
    const outBase = record.id;

    if (isImage) {
      if (record.mime === "image/jpeg" && record.size <= PHOTO_MAX) {
        record.sssc = {
          status: "ready",
          output: "original",
          ext: "jpg",
          size: record.size,
          updatedAt: new Date().toISOString(),
        };
        onSave();
        return;
      }
      const outPath = path.join(ssscDir, outBase + ".jpg");
      const size = await convertImage(ff, input, outPath);
      record.sssc = {
        status: "ready",
        output: "converted",
        file: outBase + ".jpg",
        ext: "jpg",
        size,
        updatedAt: new Date().toISOString(),
      };
      onSave();
      return;
    }

    if (isVideo) {
      const ext = path.extname(record.originalName || "").toLowerCase();
      if (ext === ".mp4" && record.size <= VIDEO_MAX) {
        record.sssc = {
          status: "ready",
          output: "original",
          ext: "mp4",
          size: record.size,
          updatedAt: new Date().toISOString(),
        };
        onSave();
        return;
      }
      if (record.size <= VIDEO_MAX && (ext === ".mov" || ext === ".m4v")) {
        const outPath = path.join(ssscDir, outBase + ".mp4");
        const size = await remux(ff, input, outPath);
        if (size && size <= VIDEO_MAX) {
          record.sssc = {
            status: "ready",
            output: "converted",
            file: outBase + ".mp4",
            ext: "mp4",
            size,
            updatedAt: new Date().toISOString(),
          };
          onSave();
          return;
        }
      }
      const outPath = path.join(ssscDir, outBase + ".mp4");
      const size = await convertVideo(ff, input, outPath);
      record.sssc = {
        status: "ready",
        output: "converted",
        file: outBase + ".mp4",
        ext: "mp4",
        size,
        updatedAt: new Date().toISOString(),
      };
      onSave();
      return;
    }

    record.sssc = {
      status: "skipped",
      reason: "unsupported type",
      updatedAt: new Date().toISOString(),
    };
    onSave();
  }

  async function processQueue() {
    if (running) return;
    running = true;
    while (queue.length) {
      const record = queue.shift();
      try {
        await convert(record);
        say("converted " + record.originalName + " -> " + (record.sssc && record.sssc.status));
      } catch (err) {
        record.sssc = {
          status: "error",
          error: String((err && err.message) || err),
          updatedAt: new Date().toISOString(),
        };
        onSave();
        say("error converting " + record.originalName + ": " + record.sssc.error);
      }
    }
    running = false;
  }

  function enqueue(record) {
    if (!ENABLED) {
      record.sssc = { status: "disabled", updatedAt: new Date().toISOString() };
      onSave();
      return;
    }
    record.sssc = { status: "pending", updatedAt: new Date().toISOString() };
    queue.push(record);
    onSave();
    processQueue();
  }

  function outputPathFor(record) {
    if (!record.sssc || record.sssc.status !== "ready") return null;
    if (record.sssc.output === "original") return path.join(uploadDir, record.storedName);
    if (record.sssc.file) return path.join(ssscDir, record.sssc.file);
    return null;
  }

  function removeOutput(record) {
    if (record.sssc && record.sssc.output === "converted" && record.sssc.file) {
      fs.unlink(path.join(ssscDir, record.sssc.file), () => {});
    }
  }

  return {
    config: { PHOTO_MAX, VIDEO_MAX, IMAGE_MAX_EDGE, JPEG_Q, ENABLED },
    enqueue,
    ensureFfmpeg,
    outputPathFor,
    removeOutput,
  };
}

module.exports = { createConverter };
