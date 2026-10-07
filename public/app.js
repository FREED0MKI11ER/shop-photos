"use strict";

const $ = (id) => document.getElementById(id);
const ID_KEY = "shop.employeeId";

const state = {
  employeeId: localStorage.getItem(ID_KEY) || "",
  media: [],
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  queue: [],
  current: null,
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(n) {
  if (!n && n !== 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

let toastTimer;
function toast(msg, isError) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/* ---------------- Gate ---------------- */
function showApp() {
  $("gate").hidden = true;
  $("app").hidden = false;
  $("whoChip").textContent = state.employeeId;
  loadMedia();
}

$("gateForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("gateInput").value.trim().replace(/[^\w .-]/g, "").slice(0, 40);
  if (!value) return;
  state.employeeId = value;
  localStorage.setItem(ID_KEY, value);
  showApp();
});

$("changeId").addEventListener("click", () => {
  $("gateInput").value = state.employeeId;
  $("gate").hidden = false;
  $("app").hidden = true;
  $("gateInput").focus();
});

/* ---------------- Tabs ---------------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $("view-" + tab.dataset.view).classList.add("active");
    if (tab.dataset.view === "connect") loadConnect();
    if (tab.dataset.view === "gallery") loadMedia();
    if (tab.dataset.view === "admin") initAdmin();
  });
});

/* ---------------- Upload ---------------- */
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const photoInput = $("photoInput");
const videoInput = $("videoInput");

$("pickBtn").addEventListener("click", () => fileInput.click());
$("shootPhotoBtn").addEventListener("click", () => photoInput.click());
$("shootVideoBtn").addEventListener("click", () => videoInput.click());
dropzone.addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  fileInput.click();
});

fileInput.addEventListener("change", () => addFiles(fileInput.files));
photoInput.addEventListener("change", () => addFiles(photoInput.files));
videoInput.addEventListener("change", () => addFiles(videoInput.files));

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
});

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  const note = ($("batchNote").value || "").trim();
  let added = 0;
  for (const file of files) {
    const isMedia = /^image\//.test(file.type) || /^video\//.test(file.type);
    if (!isMedia) {
      toast(`Skipped ${file.name}: not a photo or video`, true);
      continue;
    }
    state.queue.push({ file, note, status: "queued", progress: 0, error: null });
    added++;
  }
  fileInput.value = "";
  photoInput.value = "";
  videoInput.value = "";
  if (added && note) $("batchNote").value = "";
  renderQueue();
  if (state.queue.some((q) => q.status === "queued")) uploadQueue();
}

function renderQueue() {
  const wrap = $("queue");
  wrap.innerHTML = state.queue
    .map(
      (q, i) => `
    <div class="queue-item ${q.status}">
      <span class="name">${escapeHtml(q.file.name)}</span>
      <span class="size">${formatBytes(q.file.size)}</span>
      <span class="state">${
        q.status === "done"
          ? "Uploaded"
          : q.status === "error"
          ? escapeHtml(q.error || "Failed")
          : q.status === "uploading"
          ? q.progress + "%"
          : "Queued"
      }</span>
      ${
        q.status === "queued"
          ? `<button class="rm" data-i="${i}" title="Remove">✕</button>`
          : ""
      }
    </div>`
    )
    .join("");
  wrap.querySelectorAll(".rm").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.queue.splice(Number(btn.dataset.i), 1);
      renderQueue();
    })
  );
}

let uploading = false;
function uploadQueue() {
  if (uploading) return;
  const next = state.queue.find((q) => q.status === "queued");
  if (!next) {
    renderQueue();
    return;
  }
  uploading = true;
  $("uploadBar").hidden = false;

  if (next.file.size > state.maxUploadBytes) {
    next.status = "error";
    next.error = "Too large";
    uploading = false;
    renderQueue();
    return uploadQueue();
  }

  next.status = "uploading";
  renderQueue();

  const form = new FormData();
  form.append("employeeId", state.employeeId);
  if (next.note) form.append("note", next.note);
  form.append("files", next.file, next.file.name);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      next.progress = Math.round((e.loaded / e.total) * 100);
      updateOverall();
      renderQueue();
    }
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      next.status = "done";
      next.progress = 100;
    } else {
      next.status = "error";
      try {
        next.error = JSON.parse(xhr.responseText).error || "Failed";
      } catch {
        next.error = "Failed";
      }
    }
    finishOne();
  };
  xhr.onerror = () => {
    next.status = "error";
    next.error = "Network error";
    finishOne();
  };
  xhr.send(form);
}

function finishOne() {
  uploading = false;
  updateOverall();
  renderQueue();
  loadMedia();
  const remaining = state.queue.some((q) => q.status === "queued");
  if (remaining) {
    uploadQueue();
  } else {
    const failed = state.queue.filter((q) => q.status === "error").length;
    toast(failed ? `Finished with ${failed} error(s)` : "Upload complete", !!failed);
    setTimeout(() => {
      $("uploadBar").hidden = true;
      state.queue = state.queue.filter((q) => q.status !== "done");
      renderQueue();
    }, 1500);
  }
}

function updateOverall() {
  const total = state.queue.length || 1;
  const done = state.queue.filter((q) => q.status === "done").length;
  const partial = state.queue
    .filter((q) => q.status === "uploading")
    .reduce((sum, q) => sum + q.progress / 100, 0);
  const pct = Math.min(100, Math.round(((done + partial) / total) * 100));
  $("progressBar").style.width = pct + "%";
  $("uploadStatus").textContent = `Uploading… ${pct}%`;
}

/* ---------------- Gallery ---------------- */
async function loadMedia() {
  try {
    const res = await fetch("/api/media");
    const data = await res.json();
    state.media = data.media || [];
    populateEmployeeFilter();
    renderGallery();
  } catch (err) {
    toast("Could not load media", true);
  }
}

function populateEmployeeFilter() {
  const select = $("filterEmployee");
  const current = select.value;
  const ids = [...new Set(state.media.map((m) => m.employeeId))].sort();
  select.innerHTML =
    '<option value="">All employees</option>' +
    ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
  select.value = current;
}

function filteredMedia() {
  const emp = $("filterEmployee").value;
  const type = $("filterType").value;
  const search = $("searchBox").value.trim().toLowerCase();
  return state.media.filter((m) => {
    if (emp && m.employeeId !== emp) return false;
    if (type === "image" && !/^image\//.test(m.mime)) return false;
    if (type === "video" && !/^video\//.test(m.mime)) return false;
    if (search && !m.originalName.toLowerCase().includes(search) &&
        !(m.note || "").toLowerCase().includes(search)) return false;
    return true;
  });
}

function renderGallery() {
  const items = filteredMedia();
  const grid = $("gallery");
  $("galleryEmpty").hidden = state.media.length !== 0;
  if (state.media.length && !items.length) {
    grid.innerHTML = '<div class="empty">No matches for these filters.</div>';
    return;
  }
  grid.innerHTML = items
    .map((m) => {
      const isVideo = /^video\//.test(m.mime);
      const thumb = isVideo
        ? `<video class="thumb" src="/files/${encodeURIComponent(m.storedName)}" preload="metadata" muted></video>`
        : `<img class="thumb" loading="lazy" src="/files/${encodeURIComponent(m.storedName)}" alt="">`;
      return `
      <div class="card" data-id="${m.id}">
        ${thumb}
        ${isVideo ? '<span class="play">▶ Video</span>' : ""}
        <div class="info">
          <div class="who">${escapeHtml(m.employeeId)}</div>
          <div class="meta">${formatDate(m.uploadedAt)} · ${formatBytes(m.size)}</div>
        </div>
      </div>`;
    })
    .join("");
  grid.querySelectorAll(".card").forEach((card) =>
    card.addEventListener("click", () => openModal(card.dataset.id))
  );
}

["filterEmployee", "filterType"].forEach((id) =>
  $(id).addEventListener("change", renderGallery)
);
$("searchBox").addEventListener("input", renderGallery);
$("refreshBtn").addEventListener("click", loadMedia);

/* ---------------- Modal ---------------- */
function openModal(id) {
  const m = state.media.find((x) => x.id === id);
  if (!m) return;
  state.current = m;
  const url = "/files/" + encodeURIComponent(m.storedName);
  const isVideo = /^video\//.test(m.mime);
  $("modalMedia").innerHTML = isVideo
    ? `<video src="${url}" controls autoplay playsinline></video>`
    : `<img src="${url}" alt="">`;
  $("modalMeta").innerHTML = `
    <div><b>${escapeHtml(m.originalName)}</b></div>
    <div>Uploaded by <b>${escapeHtml(m.employeeId)}</b> · ${formatDate(m.uploadedAt)}</div>
    <div>${formatBytes(m.size)}</div>`;
  $("modalNote").value = m.note || "";
  $("modalDownload").href = url;
  $("modalDownload").setAttribute("download", m.originalName);
  renderSsscButton(m);
  $("modal").hidden = false;
}

let ssscPoll = null;
function stopSsscPoll() {
  if (ssscPoll) {
    clearInterval(ssscPoll);
    ssscPoll = null;
  }
}

function renderSsscButton(m) {
  const btn = $("modalSssc");
  const s = m.sssc || { status: "pending" };
  const id = encodeURIComponent(m.id);
  if (s.status === "ready") {
    btn.classList.remove("disabled");
    btn.href = `/api/media/${id}/sssc`;
    const base = (m.originalName || m.storedName || "file").replace(/\.[^.]+$/, "");
    btn.setAttribute("download", `${base}-sssc.${s.ext || "bin"}`);
    btn.textContent = "Download for SSSC";
    stopSsscPoll();
  } else if (s.status === "error") {
    btn.classList.add("disabled");
    btn.removeAttribute("href");
    btn.textContent = "SSSC conversion failed — click to retry";
    stopSsscPoll();
  } else if (s.status === "disabled") {
    btn.classList.add("disabled");
    btn.removeAttribute("href");
    btn.textContent = "SSSC conversion disabled";
    stopSsscPoll();
  } else {
    btn.classList.add("disabled");
    btn.removeAttribute("href");
    btn.textContent = "Preparing SSSC file…";
    startSsscPoll(m);
  }
}

function startSsscPoll(m) {
  if (ssscPoll) return;
  ssscPoll = setInterval(async () => {
    if (!state.current || state.current.id !== m.id || $("modal").hidden) {
      stopSsscPoll();
      return;
    }
    try {
      const res = await fetch("/api/media/" + encodeURIComponent(m.id), { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      Object.assign(m, data.media);
      const idx = state.media.findIndex((x) => x.id === m.id);
      if (idx >= 0) state.media[idx] = m;
      renderSsscButton(m);
      renderGallery();
    } catch {
      /* keep polling */
    }
  }, 3000);
}

$("modalSssc").addEventListener("click", async (e) => {
  const m = state.current;
  if (!m) return;
  const status = (m.sssc || {}).status;
  if (status === "ready") return;
  e.preventDefault();
  if (status === "error") {
    try {
      await fetch("/api/media/" + encodeURIComponent(m.id) + "/sssc", { method: "POST" });
      m.sssc = { status: "pending" };
      renderSsscButton(m);
    } catch {
      /* ignore */
    }
  }
});

$("modalSaveNote").addEventListener("click", async () => {
  const m = state.current;
  if (!m) return;
  try {
    const res = await fetch("/api/media/" + encodeURIComponent(m.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: $("modalNote").value }),
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    m.note = data.media.note;
    const idx = state.media.findIndex((x) => x.id === m.id);
    if (idx >= 0) state.media[idx].note = m.note;
    toast("Note saved");
  } catch {
    toast("Could not save note", true);
  }
});

function closeModal() {
  stopSsscPoll();
  $("modal").hidden = true;
  $("modalMedia").innerHTML = "";
  state.current = null;
}

$("modalClose").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("modal").hidden) closeModal();
});

$("modalDelete").addEventListener("click", async () => {
  const m = state.current;
  if (!m) return;
  if (!confirm(`Delete "${m.originalName}"?`)) return;
  try {
    const res = await fetch("/api/media/" + encodeURIComponent(m.id), { method: "DELETE" });
    if (!res.ok) throw new Error();
    closeModal();
    toast("Deleted");
    loadMedia();
  } catch {
    toast("Could not delete", true);
  }
});

/* ---------------- Connect ---------------- */
let connectLoaded = false;
async function loadConnect() {
  if (connectLoaded) return;
  try {
    const res = await fetch("/api/info");
    const info = await res.json();
    state.maxUploadBytes = info.maxUploadBytes || state.maxUploadBytes;
    const url = info.primaryUrl || window.location.origin;
    $("connectUrl").textContent = url;
    $("qrImg").src = "/api/qr?text=" + encodeURIComponent(url);
    if (info.version) $("versionLine").textContent = "Version " + info.version;
    connectLoaded = true;
  } catch {
    $("connectUrl").textContent = window.location.origin;
    $("qrImg").src = "/api/qr?text=" + encodeURIComponent(window.location.origin);
  }
}

$("copyUrl").addEventListener("click", async () => {
  const text = $("connectUrl").textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast("Address copied");
  } catch {
    toast("Copy failed — select the address manually", true);
  }
});

/* ---------------- Admin / updates ---------------- */
const ADMIN_KEY = "shop.adminToken";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showAdminLogin() {
  $("adminLogin").hidden = false;
  $("adminPanel").hidden = true;
}

function showAdminPanel() {
  $("adminLogin").hidden = true;
  $("adminPanel").hidden = false;
}

function setAdminResult(msg, kind) {
  const el = $("adminResult");
  el.textContent = msg || "";
  el.className = "admin-result" + (kind ? " " + kind : "");
}

async function adminFetch(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  const token = sessionStorage.getItem(ADMIN_KEY);
  if (token) headers["X-Admin-Token"] = token;
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    sessionStorage.removeItem(ADMIN_KEY);
    showAdminLogin();
    throw new Error("unauthorized");
  }
  return res;
}

async function getVersion() {
  const res = await fetch("/api/version", { cache: "no-store" });
  if (!res.ok) throw new Error("unavailable");
  return (await res.json()).version;
}

function initAdmin() {
  if (sessionStorage.getItem(ADMIN_KEY)) {
    showAdminPanel();
    loadAdminStatus();
  } else {
    showAdminLogin();
  }
}

async function loadAdminStatus() {
  try {
    const res = await adminFetch("/api/admin/status");
    const s = await res.json();
    $("adminStatus").innerHTML =
      `<div>Version: <b>${escapeHtml(s.version)}</b></div>` +
      `<div>Update source: <b>${escapeHtml(s.repo || "not configured")}</b></div>` +
      `<div>Auto-update: <b>${s.taskPresent ? "installed" : "not installed"}</b></div>`;
    $("adminLog").textContent = (s.log || []).join("\n") || "(no update log yet)";
    return s;
  } catch (err) {
    if (err.message !== "unauthorized") setAdminResult("Could not load status.", "err");
    return null;
  }
}

$("adminLoginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  setAdminResult("");
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("adminPassword").value }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAdminResult(data.error || "Login failed", "err");
      return;
    }
    sessionStorage.setItem(ADMIN_KEY, data.token);
    $("adminPassword").value = "";
    showAdminPanel();
    loadAdminStatus();
  } catch (err) {
    setAdminResult("Login failed", "err");
  }
});

$("adminLogout").addEventListener("click", () => {
  sessionStorage.removeItem(ADMIN_KEY);
  showAdminLogin();
});

$("adminCheckBtn").addEventListener("click", async () => {
  const btn = $("adminCheckBtn");
  btn.disabled = true;
  setAdminResult("Checking…");
  try {
    const res = await adminFetch("/api/admin/check", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setAdminResult(data.error || "Check failed", "err");
    } else if (data.upToDate) {
      setAdminResult("Already up to date.", "ok");
    } else if (data.availableVersion) {
      setAdminResult(`Version ${data.availableVersion} is available — click "Update now".`, "ok");
    } else {
      setAdminResult("Check finished. See the log below.", "ok");
    }
    await loadAdminStatus();
  } catch (err) {
    if (err.message !== "unauthorized") setAdminResult("Check failed", "err");
  } finally {
    btn.disabled = false;
  }
});

$("adminUpdateBtn").addEventListener("click", async () => {
  const btn = $("adminUpdateBtn");
  btn.disabled = true;
  setAdminResult("Starting update…");
  let before = null;
  try { before = await getVersion(); } catch {}

  try {
    const res = await adminFetch("/api/admin/update", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setAdminResult(data.error || "Could not start update", "err");
      btn.disabled = false;
      return;
    }
  } catch (err) {
    if (err.message !== "unauthorized") setAdminResult("Could not start update", "err");
    btn.disabled = false;
    return;
  }

  setAdminResult("Updating… the service will restart briefly.");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(2500);
    try {
      const v = await getVersion();
      if (v && v !== before) {
        setAdminResult("Updated to " + v + ".", "ok");
        await loadAdminStatus();
        btn.disabled = false;
        return;
      }
    } catch {}
    const s = await loadAdminStatus();
    if (s && (s.log || []).some((l) => /Already up to date/i.test(l))) {
      setAdminResult("Already up to date.", "ok");
      btn.disabled = false;
      return;
    }
    if (s && (s.log || []).some((l) => /Health check FAILED|ERROR:/i.test(l))) {
      setAdminResult("Update reported a problem — see the log.", "err");
      btn.disabled = false;
      return;
    }
  }
  setAdminResult("No new version detected. It may already be up to date.", "ok");
  await loadAdminStatus();
  btn.disabled = false;
});

/* ---------------- Boot ---------------- */
fetch("/api/info")
  .then((r) => r.json())
  .then((info) => {
    if (info.maxUploadBytes) state.maxUploadBytes = info.maxUploadBytes;
  })
  .catch(() => {});

if (state.employeeId) {
  showApp();
} else {
  $("gateInput").focus();
}
