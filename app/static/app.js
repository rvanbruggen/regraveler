"use strict";

// ------------------------------------------------------------------ helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element. Text children are inserted as text (never as HTML). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const body = await res.json(); if (body.detail) msg = JSON.stringify(body.detail); } catch (_) {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

const fmt = {
  km: (v) => (v == null ? "–" : `${v.toFixed(1)} km`),
  m: (v) => (v == null ? "–" : `${Math.round(v)} m`),
  pct: (v) => (v == null ? "–" : `${Math.round(v)}%`),
  stars: (v) => (v ? "★".repeat(v) + "☆".repeat(5 - v) : "–"),
  date: (v) => (v ? new Date(v).toLocaleDateString() : "–"),
};

const splitTags = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);

// ------------------------------------------------------------------ tabs

function showView(name) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
}
$$(".tab").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.view !== "library") closeDetail();
    showView(b.dataset.view);
  })
);

// ------------------------------------------------------------------ filters
// The filter state lives in the URL hash, so views can share it and links keep it.

const filterForm = $("#filters");
const state = { sort: "name", order: "asc" };

function filterParams() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(filterForm)) {
    if (!String(v).trim()) continue;
    if (k === "tags") splitTags(v).forEach((t) => p.append("tags", t));
    else p.set(k, String(v).trim());
  }
  if (state.sort !== "name") p.set("sort", state.sort);
  if (state.order !== "asc") p.set("order", state.order);
  return p;
}

function restoreFilters() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const input of filterForm.elements) {
    if (!input.name) continue;
    input.value = input.name === "tags" ? p.getAll("tags").join(", ") : p.get(input.name) ?? "";
  }
  state.sort = p.get("sort") || "name";
  state.order = p.get("order") || "asc";
}

let debounce;
filterForm.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(loadRoutes, 250);
});
filterForm.addEventListener("reset", () => setTimeout(loadRoutes, 0));
filterForm.addEventListener("submit", (e) => e.preventDefault());

$$("#routes th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sort === key) state.order = state.order === "asc" ? "desc" : "asc";
    else {
      state.sort = key;
      // Numbers are most interesting largest-first.
      state.order = ["name", "source_name"].includes(key) ? "asc" : "desc";
    }
    loadRoutes();
  })
);

// ------------------------------------------------------------------ library

let routes = [];
let selectedId = null;

async function loadFacets() {
  const f = await api("/api/facets");
  const sourceSel = filterForm.elements.source;
  const current = sourceSel.value || new URLSearchParams(location.hash.slice(1)).get("source") || "";
  sourceSel.replaceChildren(el("option", { value: "" }, "any"), ...f.sources.map((s) => el("option", { value: s }, s)));
  sourceSel.value = current;
  $("#source-list").replaceChildren(...f.sources.map((s) => el("option", { value: s })));
  $("#tag-list").replaceChildren(...f.tags.map(([t]) => el("option", { value: t })));
}

async function loadRoutes() {
  const params = filterParams();
  history.replaceState(null, "", params.toString() ? `#${params}` : location.pathname);
  try {
    routes = await api(`/api/routes?${params}`);
  } catch (err) {
    $("#count").textContent = `Error loading routes: ${err.message}`;
    return;
  }
  renderTable();
}

function renderTable() {
  $$("#routes th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted-asc", th.dataset.sort === state.sort && state.order === "asc");
    th.classList.toggle("sorted-desc", th.dataset.sort === state.sort && state.order === "desc");
  });
  const totalKm = routes.reduce((s, r) => s + r.distance_km, 0);
  $("#count").textContent = `${routes.length} route${routes.length === 1 ? "" : "s"} · ${Math.round(totalKm)} km total`;
  $("#routes tbody").replaceChildren(
    ...routes.map((r) =>
      el(
        "tr",
        { class: r.id === selectedId ? "selected" : null, onclick: () => openDetail(r.id), "data-id": r.id },
        el("td", { class: "name" }, r.name),
        el("td", { class: "num" }, fmt.km(r.distance_km)),
        el("td", { class: "num" }, fmt.m(r.elevation_gain_m)),
        el("td", {}, r.is_loop ? "loop" : "A→B"),
        el("td", { class: "num" }, fmt.pct(r.paved_pct)),
        el("td", { class: "stars" }, fmt.stars(r.quality_rating)),
        el("td", {}, r.tags.map((t) => el("span", { class: "tag" }, t))),
        el("td", {}, r.source_name || "–"),
        el("td", {}, fmt.date(r.imported_at))
      )
    )
  );
}

// ------------------------------------------------------------------ detail panel

const detail = $("#detail");
const detailForm = $("#d-form");
let map = null;
let mapLayer = null;

function ensureMap() {
  if (map) return map;
  map = L.map("d-map");
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  return map;
}

async function openDetail(id) {
  selectedId = id;
  $$("#routes tbody tr").forEach((tr) => tr.classList.toggle("selected", Number(tr.dataset.id) === id));
  let r;
  try {
    r = await api(`/api/routes/${id}`);
  } catch (err) {
    alert(`Could not load route: ${err.message}`);
    return;
  }
  detail.hidden = false;
  $("#d-title").textContent = r.name;
  $("#d-status").textContent = "";

  const stats = [
    ["Distance", fmt.km(r.distance_km)],
    ["Elevation gain", fmt.m(r.elevation_gain_m)],
    ["Elevation loss", fmt.m(r.elevation_loss_m)],
    ["Lowest", fmt.m(r.min_elevation_m)],
    ["Highest", fmt.m(r.max_elevation_m)],
    ["Type", r.is_loop ? "Loop" : "Point to point"],
  ];
  $("#d-stats").replaceChildren(...stats.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));

  const f = detailForm.elements;
  f.name.value = r.name;
  f.quality_rating.value = r.quality_rating ?? "";
  f.paved_pct.value = r.paved_pct ?? "";
  f.tags.value = r.tags.join(", ");
  f.notes.value = r.notes ?? "";
  f.source_name.value = r.source_name ?? "";
  f.source_url.value = r.source_url ?? "";
  $("#d-download").href = `/api/routes/${r.id}/gpx`;
  $("#d-file").textContent =
    `File: ${r.gpx_path}` + (r.track_name ? ` · GPX track ${r.track_index + 1}: "${r.track_name}"` : "") +
    ` · imported ${fmt.date(r.imported_at)}`;

  const m = ensureMap();
  m.invalidateSize();
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup([
    L.polyline(r.geometry, { color: "#b35c1e", weight: 4 }),
    L.circleMarker([r.start_lat, r.start_lon], { radius: 6, color: "#2e7d32", fillOpacity: 1 }).bindTooltip("Start"),
    r.is_loop ? null : L.circleMarker([r.end_lat, r.end_lon], { radius: 6, color: "#b3261e", fillOpacity: 1 }).bindTooltip("End"),
  ].filter(Boolean)).addTo(m);
  m.fitBounds([[r.min_lat, r.min_lon], [r.max_lat, r.max_lon]], { padding: [10, 10] });

  loadSimilar(r.id);
}

async function loadSimilar(id) {
  const list = $("#d-similar");
  list.replaceChildren(el("li", {}, "checking…"));
  try {
    const sims = await api(`/api/routes/${id}/similar`);
    if (selectedId !== id) return;
    list.replaceChildren(
      ...(sims.length
        ? sims.map((s) =>
            el("li", {},
              el("a", { onclick: () => openDetail(s.id) }, s.name),
              ` — ${s.this_covered_pct}% of this route on it, ${s.other_covered_pct}% of it on this`,
              s.very_similar ? " (very similar)" : ""))
        : [el("li", {}, "none")])
    );
  } catch (err) {
    list.replaceChildren(el("li", {}, `error: ${err.message}`));
  }
}

function closeDetail() {
  detail.hidden = true;
  selectedId = null;
  $$("#routes tbody tr.selected").forEach((tr) => tr.classList.remove("selected"));
}
$("#d-close").addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !detail.hidden) closeDetail(); });

detailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = detailForm.elements;
  const body = {
    name: f.name.value.trim(),
    quality_rating: f.quality_rating.value ? Number(f.quality_rating.value) : null,
    paved_pct: f.paved_pct.value === "" ? null : Number(f.paved_pct.value),
    tags: splitTags(f.tags.value),
    notes: f.notes.value,
    source_name: f.source_name.value,
    source_url: f.source_url.value,
  };
  $("#d-status").textContent = "saving…";
  try {
    const r = await api(`/api/routes/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("#d-title").textContent = r.name;
    f.tags.value = r.tags.join(", ");
    $("#d-status").textContent = "saved";
    await Promise.all([loadRoutes(), loadFacets()]);
  } catch (err) {
    $("#d-status").textContent = `error: ${err.message}`;
  }
});

$("#d-delete").addEventListener("click", async () => {
  const name = $("#d-title").textContent;
  if (!confirm(`Remove "${name}" from the library?\n\nThe GPX file on disk is not deleted.`)) return;
  try {
    await api(`/api/routes/${selectedId}`, { method: "DELETE" });
    closeDetail();
    await Promise.all([loadRoutes(), loadFacets()]);
  } catch (err) {
    $("#d-status").textContent = `error: ${err.message}`;
  }
});

// ------------------------------------------------------------------ import

let pending = []; // [{file, source_name, source_url}]

function addFiles(fileList) {
  for (const file of fileList) {
    if (!file.name.toLowerCase().endsWith(".gpx")) continue;
    if (pending.some((p) => p.file.name === file.name && p.file.size === file.size)) continue;
    pending.push({ file, source_name: "", source_url: "" });
  }
  renderPending();
}

function renderPending() {
  const table = $("#pending");
  table.hidden = pending.length === 0;
  $("#import-btn").disabled = pending.length === 0;
  $("#import-status").textContent = pending.length ? `${pending.length} file(s) ready` : "";
  $("#pending tbody").replaceChildren(
    ...pending.map((p, i) =>
      el("tr", {},
        el("td", {}, p.file.name),
        el("td", {}, el("input", {
          value: p.source_name, list: "source-list", placeholder: "(batch value)",
          oninput: (e) => (p.source_name = e.target.value),
        })),
        el("td", {}, el("input", {
          type: "url", value: p.source_url, placeholder: "(batch value)",
          oninput: (e) => (p.source_url = e.target.value),
        })),
        el("td", {}, el("button", {
          class: "icon", title: "Remove from list",
          onclick: () => { pending.splice(i, 1); renderPending(); },
        }, "✕"))
      )
    )
  );
}

const dropzone = $("#dropzone");
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); })
);
dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
$("#file-input").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

$("#import-btn").addEventListener("click", async () => {
  const fd = new FormData();
  pending.forEach((p) => fd.append("files", p.file, p.file.name));
  fd.append("source_name", $("#batch-source-name").value);
  fd.append("source_url", $("#batch-source-url").value);
  fd.append("overrides", JSON.stringify(pending.map((p) => ({ source_name: p.source_name, source_url: p.source_url }))));

  $("#import-btn").disabled = true;
  $("#import-status").textContent = `importing ${pending.length} file(s)…`;
  try {
    const { results } = await api("/api/import", { method: "POST", body: fd });
    renderResults(results);
    pending = [];
    renderPending();
    await Promise.all([loadRoutes(), loadFacets()]);
  } catch (err) {
    $("#import-status").textContent = `error: ${err.message}`;
    $("#import-btn").disabled = false;
  }
});

function routeLink(id, name) {
  return el("a", { onclick: () => { showView("library"); openDetail(id); } }, name);
}

function renderResults(results) {
  const counts = results.reduce((c, r) => ((c[r.status] = (c[r.status] || 0) + 1), c), {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
  $("#import-results").replaceChildren(
    el("h3", {}, `Import results: ${summary}`),
    ...results.map((r) =>
      el("div", { class: `result ${r.status}` },
        el("strong", {}, r.filename), ` — ${r.status}`, r.message ? `: ${r.message}` : "",
        r.routes.length ? el("div", {}, "Created: ", r.routes.flatMap((x, i) => [i ? ", " : "", routeLink(x.id, x.name)])) : null,
        r.duplicates.length ? el("div", {}, "Already in library: ", r.duplicates.flatMap((x, i) => [i ? ", " : "", routeLink(x.id, x.name)])) : null,
        ...r.similar.map((s) =>
          el("div", { class: "warn" }, "⚠ ", routeLink(s.route_id, s.route_name),
            ` is very similar to `, routeLink(s.other_id, s.other_name), ` (${Math.round(s.overlap * 100)}% overlap)`))
      )
    )
  );
}

// ------------------------------------------------------------------ start

restoreFilters();
loadFacets().then(loadRoutes);
api("/api/version").then((v) => ($("#version").textContent = `v${v.version}`)).catch(() => {});
