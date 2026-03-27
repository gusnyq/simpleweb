const API          = "";     // same origin
const POLL_DET_MS  = 1000;   // detection label refresh
const POLL_TELE_MS = 3000;   // telemetry refresh

const grid  = document.getElementById("grid");
const modal = document.getElementById("modal");

// stream_id -> { card, img, detectionList, batEl, podsEl, dotEl, detTimer, teleTimer, telemetry }
const cameras = new Map();

let modalStreamId = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  const ids = await apiFetch("GET", "/api/streams");
  for (const id of ids) addCard(id);
  renderEmpty();

  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id  = document.getElementById("input-id").value.trim();
    const url = document.getElementById("input-url").value.trim();
    if (!id || !url) return;
    try {
      await apiFetch("POST", "/api/streams", { id, url });
      addCard(id);
      renderEmpty();
      e.target.reset();
    } catch (err) {
      alert(`Failed to add stream: ${err.message}`);
    }
  });

  // Modal close actions
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.querySelector(".modal-backdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  document.getElementById("modal-waypoints-btn").addEventListener("click", uploadWaypoints);
}

// ---------------------------------------------------------------------------
// Card lifecycle
// ---------------------------------------------------------------------------

function addCard(id) {
  if (cameras.has(id)) return;

  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = id;
  card.innerHTML = `
    <div class="card-header">
      <span class="card-title">${escapeHtml(id)}</span>
      <button class="btn-remove">Remove</button>
    </div>
    <div class="card-stream">
      <img alt="${escapeHtml(id)}" title="Click to expand" />
      <div class="detection-list"></div>
    </div>
    <div class="card-telemetry">
      <div class="tele-item">
        <span class="tele-label">Battery</span>
        <span class="tele-value bat-el">—</span>
      </div>
      <div class="tele-item">
        <span class="tele-label">Pods</span>
        <span class="tele-value pods-el">—</span>
      </div>
      <div class="tele-item">
        <span class="tele-label">GPS</span>
        <span class="tele-value gps-el">—</span>
      </div>
      <div class="tele-item tele-status-item">
        <span class="status-dot dot-el"></span>
        <span class="tele-value status-el">—</span>
      </div>
    </div>`;

  const img           = card.querySelector("img");
  const detectionList = card.querySelector(".detection-list");
  const batEl         = card.querySelector(".bat-el");
  const podsEl        = card.querySelector(".pods-el");
  const gpsEl         = card.querySelector(".gps-el");
  const dotEl         = card.querySelector(".dot-el");
  const statusEl      = card.querySelector(".status-el");

  // MJPEG stream — reconnect on error
  function attachStream() {
    img.src = `${API}/stream/${encodeURIComponent(id)}?t=${Date.now()}`;
  }
  img.addEventListener("error", () => setTimeout(attachStream, 2000));
  attachStream();

  // Click to expand
  img.addEventListener("click", () => openModal(id));

  // Remove button
  card.querySelector(".btn-remove").addEventListener("click", () => removeCard(id));

  // Polling
  const detTimer  = setInterval(() => pollDetections(id, detectionList), POLL_DET_MS);
  const teleTimer = setInterval(() => pollTelemetry(id), POLL_TELE_MS);
  pollTelemetry(id); // immediate first fetch

  grid.appendChild(card);
  cameras.set(id, { card, img, detectionList, batEl, podsEl, gpsEl, dotEl, statusEl, detTimer, teleTimer, telemetry: null });
}

async function removeCard(id) {
  try {
    await apiFetch("DELETE", `/api/streams/${encodeURIComponent(id)}`);
  } catch (err) {
    console.warn("Remove stream error:", err.message);
  }

  const cam = cameras.get(id);
  if (cam) {
    clearInterval(cam.detTimer);
    clearInterval(cam.teleTimer);
    cam.img.src = "";
    cam.card.remove();
    cameras.delete(id);
  }

  if (modalStreamId === id) closeModal();
  renderEmpty();
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openModal(id) {
  const cam = cameras.get(id);
  if (!cam) return;

  modalStreamId = id;
  document.getElementById("modal-title").textContent = id;
  document.getElementById("modal-img").src =
    `${API}/stream/${encodeURIComponent(id)}?t=${Date.now()}`;

  applyTelemetryToModal(cam.telemetry);
  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
  document.getElementById("modal-img").src = "";
  modalStreamId = null;
}

async function uploadWaypoints() {
  const fileInput  = document.getElementById("modal-waypoints-input");
  const statusEl   = document.getElementById("modal-waypoints-status");
  const file = fileInput.files[0];
  if (!file) { statusEl.textContent = "No file selected."; return; }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    statusEl.textContent = "Invalid JSON.";
    return;
  }

  statusEl.textContent = "Uploading…";
  try {
    await apiFetch("POST", "/api/waypoints", parsed);
    statusEl.textContent = "Uploaded.";
    fileInput.value = "";
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

function applyTelemetryToModal(data) {
  document.getElementById("modal-battery").textContent  = formatBattery(data?.battery);
  document.getElementById("modal-pods").textContent     = formatPods(data?.pods, true);
  document.getElementById("modal-gps").textContent      = formatGps(data?.gps, true);
  document.getElementById("modal-status").textContent   = data?.status ?? "—";
  applyStatusDot(document.getElementById("modal-status-dot"), data?.status);
}

// ---------------------------------------------------------------------------
// Detection polling
// ---------------------------------------------------------------------------

async function pollDetections(id, listEl) {
  try {
    const detections = await apiFetch("GET", `/api/detections/${encodeURIComponent(id)}`);
    const counts = {};
    for (const d of detections) counts[d.label] = (counts[d.label] ?? 0) + 1;
    listEl.innerHTML = Object.entries(counts)
      .map(([label, n]) =>
        `<span class="detection-badge">${escapeHtml(label)}${n > 1 ? ` ×${n}` : ""}</span>`)
      .join("");
  } catch { /* silently ignore — stream may be reconnecting */ }
}

// ---------------------------------------------------------------------------
// Telemetry polling
// ---------------------------------------------------------------------------

async function pollTelemetry(id) {
  try {
    const data = await apiFetch("GET", `/api/telemetry/${encodeURIComponent(id)}`);
    const cam = cameras.get(id);
    if (!cam) return;

    cam.telemetry = data;

    // Update card
    cam.batEl.textContent    = formatBattery(data.battery);
    cam.batEl.className      = "tele-value bat-el " + batteryClass(data.battery);
    cam.podsEl.textContent   = formatPods(data.pods, false);
    cam.gpsEl.textContent    = formatGps(data.gps, false);
    cam.statusEl.textContent = data.status ?? "—";
    applyStatusDot(cam.dotEl, data.status);

    // Keep modal in sync
    if (modalStreamId === id) applyTelemetryToModal(data);
  } catch { /* silently ignore */ }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBattery(val) {
  return val != null ? `${val}%` : "—";
}

function batteryClass(val) {
  if (val == null) return "";
  if (val >= 60)   return "bat-high";
  if (val >= 20)   return "bat-medium";
  return "bat-low";
}

function formatPods(pods, full) {
  if (!pods || pods.length === 0) return "—";
  if (full) return pods.join(", ");
  if (pods.length <= 2) return pods.join(", ");
  return `${pods.length} pods`;
}

function formatGps(gps, full) {
  if (!gps || gps.lat == null || gps.lon == null) return "—";
  const precision = full ? 6 : 4;
  return `${gps.lat.toFixed(precision)}, ${gps.lon.toFixed(precision)}`;
}

function applyStatusDot(el, status) {
  el.className = "status-dot" + (status === "online" ? " online" : status === "offline" ? " offline" : "");
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function renderEmpty() {
  const existing = document.getElementById("empty");
  if (cameras.size === 0) {
    if (!existing) {
      const el = document.createElement("p");
      el.id = "empty";
      el.textContent = "No streams added yet. Use the form above to add one.";
      grid.appendChild(el);
    }
  } else {
    existing?.remove();
  }
}

async function apiFetch(method, path, body) {
  const opts = {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// World map background
// ---------------------------------------------------------------------------

async function initWorldMap() {
  const canvas = document.getElementById("world-canvas");
  const ctx    = canvas.getContext("2d");

  function setSize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  setSize();

  if (typeof d3 === "undefined" || typeof topojson === "undefined") {
    console.error("World map: D3 or TopoJSON failed to load from CDN.");
    drawFallbackGrid(ctx);
    window.addEventListener("resize", () => { setSize(); drawFallbackGrid(ctx); });
    return;
  }

  let world;
  try {
    world = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");
  } catch (e) {
    console.error("World map: failed to fetch world-atlas data:", e);
    drawFallbackGrid(ctx);
    window.addEventListener("resize", () => { setSize(); drawFallbackGrid(ctx); });
    return;
  }

  const countries = topojson.feature(world, world.objects.countries);
  const borders   = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
  const graticule = d3.geoGraticule()();
  const sphere    = { type: "Sphere" };

  function draw() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width  = w;
    canvas.height = h;

    const projection = d3.geoNaturalEarth1()
      .scale(w / 6.1)
      .translate([w / 2, h / 2]);

    const path = d3.geoPath(projection, ctx);

    // Ocean
    ctx.beginPath();
    path(sphere);
    ctx.fillStyle = "#0b0b0b";
    ctx.fill();

    // Graticule
    ctx.beginPath();
    path(graticule);
    ctx.strokeStyle = "#1a221a";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Land
    ctx.beginPath();
    path(countries);
    ctx.fillStyle = "#253525";
    ctx.fill();

    // Country borders
    ctx.beginPath();
    path(borders);
    ctx.strokeStyle = "#3a503a";
    ctx.lineWidth = 0.6;
    ctx.stroke();

    // Sphere outline
    ctx.beginPath();
    path(sphere);
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  draw();
  window.addEventListener("resize", draw);
}

function drawFallbackGrid(ctx) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#1e2e1e";
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < w; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

// ---------------------------------------------------------------------------

initWorldMap();
init();
