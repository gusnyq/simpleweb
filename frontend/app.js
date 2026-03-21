const API = "";          // same origin — backend serves the frontend
const POLL_MS = 1000;    // detection label refresh interval

const grid = document.getElementById("grid");

// stream_id -> { card, img, detectionList, pollTimer }
const cameras = new Map();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  const ids = await apiFetch("GET", "/api/streams");
  // Re-add any streams that were already registered in the backend
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
      <img alt="${escapeHtml(id)}" />
      <div class="detection-list"></div>
    </div>`;

  const img = card.querySelector("img");
  const detectionList = card.querySelector(".detection-list");

  // MJPEG — browser handles it natively; reconnect on error
  function attachStream() {
    img.src = `${API}/stream/${encodeURIComponent(id)}?t=${Date.now()}`;
  }
  img.addEventListener("error", () => {
    setTimeout(attachStream, 2000);
  });
  attachStream();

  // Remove button
  card.querySelector(".btn-remove").addEventListener("click", () => removeCard(id));

  // Detection label polling
  const pollTimer = setInterval(() => pollDetections(id, detectionList), POLL_MS);

  grid.appendChild(card);
  cameras.set(id, { card, img, detectionList, pollTimer });
}

async function removeCard(id) {
  try {
    await apiFetch("DELETE", `/api/streams/${encodeURIComponent(id)}`);
  } catch (err) {
    // If already gone on the backend, still clean up the UI
    console.warn("Remove stream error:", err.message);
  }

  const cam = cameras.get(id);
  if (cam) {
    clearInterval(cam.pollTimer);
    cam.img.src = "";   // stop the MJPEG stream
    cam.card.remove();
    cameras.delete(id);
  }
  renderEmpty();
}

// ---------------------------------------------------------------------------
// Detection polling
// ---------------------------------------------------------------------------

async function pollDetections(id, listEl) {
  try {
    const detections = await apiFetch("GET", `/api/detections/${encodeURIComponent(id)}`);
    renderDetections(listEl, detections);
  } catch {
    // silently ignore — stream may be reconnecting
  }
}

function renderDetections(listEl, detections) {
  // Count occurrences of each label
  const counts = {};
  for (const d of detections) {
    counts[d.label] = (counts[d.label] ?? 0) + 1;
  }

  listEl.innerHTML = Object.entries(counts)
    .map(([label, n]) =>
      `<span class="detection-badge">${escapeHtml(label)}${n > 1 ? ` ×${n}` : ""}</span>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Helpers
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

init();
