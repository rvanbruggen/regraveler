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

let currentView = "library";

function showView(name) {
  currentView = name;
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  // The filters apply to the library and the map, not to the import screen.
  $("#filters").hidden = name === "import";
  if (name === "import") closeDetail();
  if (name === "map") showOverview();
  updateHash();
}
$$(".tab").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

/** Open a route in whichever view is active (map: select it there too). */
function showRoute(id) {
  if (currentView === "map") selectRoute(id, { fit: true });
  else {
    if (currentView !== "library") showView("library");
    openDetail(id);
  }
}

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

/** URL hash = filters + view + proximity setting, so a link restores the whole screen. */
function updateHash() {
  const p = filterParams();
  if (currentView !== "library") p.set("view", currentView);
  if ($("#prox-on").checked) p.set("near", $("#prox-distance").value || "0");
  history.replaceState(null, "", p.toString() ? `#${p}` : location.pathname);
}

function restoreFilters() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("near")) {
    $("#prox-on").checked = true;
    $("#prox-distance").value = p.get("near");
  }
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
  debounce = setTimeout(refresh, 250);
});
filterForm.addEventListener("reset", () => setTimeout(refresh, 0));
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
    refresh();
  })
);

// ------------------------------------------------------------------ library

let routes = [];
let selectedId = null;

async function loadFacets() {
  const f = await api("/api/facets");
  const prox = $("#prox-distance");
  prox.max = f.proximity_max_distance_m;
  if (!prox.value) prox.value = f.proximity_distance_m;
  const sourceSel = filterForm.elements.source;
  const current = sourceSel.value || new URLSearchParams(location.hash.slice(1)).get("source") || "";
  sourceSel.replaceChildren(el("option", { value: "" }, "any"), ...f.sources.map((s) => el("option", { value: s }, s)));
  sourceSel.value = current;
  $("#source-list").replaceChildren(...f.sources.map((s) => el("option", { value: s })));
  $("#tag-list").replaceChildren(...f.tags.map(([t]) => el("option", { value: t })));
}

/** Reload everything that depends on the filters or the route data. */
async function refresh() {
  updateHash();
  overview.stale = true;
  const jobs = [loadRoutes()];
  if (currentView === "map") jobs.push((overview.loading = loadMap()));
  await Promise.all(jobs);
}

async function loadRoutes() {
  const params = filterParams();
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

function osmTiles() {
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
}

function ensureMap() {
  if (map) return map;
  map = L.map("d-map");
  osmTiles().addTo(map);
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
              el("a", { onclick: () => showRoute(s.id) }, s.name),
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
  clearFocus({ keepDetail: true });
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
    await Promise.all([refresh(), loadFacets()]);
  } catch (err) {
    $("#d-status").textContent = `error: ${err.message}`;
  }
});

$("#d-showmap").addEventListener("click", async () => {
  const id = selectedId;
  showView("map");
  await overview.loading;
  selectRoute(id, { fit: true });
});

$("#d-delete").addEventListener("click", async () => {
  const name = $("#d-title").textContent;
  if (!confirm(`Remove "${name}" from the library?\n\nThe GPX file on disk is not deleted.`)) return;
  try {
    await api(`/api/routes/${selectedId}`, { method: "DELETE" });
    closeDetail();
    await Promise.all([refresh(), loadFacets()]);
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
    await Promise.all([refresh(), loadFacets()]);
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

// ------------------------------------------------------------------ overview map

// Distinct colours that stay readable on OSM tiles. Yellow is reserved for shared stretches.
const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#0fa3b1", "#f032e6", "#9a6324", "#800000", "#000075"];
const SHARED_COLOR = "#ffcc00";
const FADED = { color: "#888", opacity: 0.25, weight: 2 };
const colorFor = (id) => PALETTE[id % PALETTE.length];

const overview = {
  map: null,
  loading: Promise.resolve(),
  routes: [], // from /api/map
  byId: new Map(),
  lines: new Map(), // id -> L.Polyline
  pairs: [], // from /api/proximity
  selected: null, // selected route id
  activePair: null, // pair clicked in the list
  stale: true,
  lastFitKey: null,
  proxToken: 0,
};

function showOverview() {
  if (!overview.map) {
    const m = L.map("overview-map", { renderer: L.canvas({ tolerance: 6 }) }).setView([50.9, 4.5], 9);
    osmTiles().addTo(m);
    // Shared stretches are drawn in their own pane, underneath the route lines.
    m.createPane("shared").style.zIndex = 390;
    overview.routeLayer = L.layerGroup().addTo(m);
    overview.proxLayer = L.layerGroup().addTo(m);
    overview.sharedRenderer = L.canvas({ pane: "shared" });
    m.on("click", () => { clearFocus(); });
    overview.map = m;
  }
  // The container was hidden; let Leaflet measure it again.
  setTimeout(() => overview.map.invalidateSize(), 0);
  if (overview.stale) overview.loading = loadMap();
  return overview.loading;
}

async function loadMap() {
  const params = filterParams();
  overview.stale = false;
  let data;
  try {
    data = await api(`/api/map?${params}`);
  } catch (err) {
    $("#map-count").textContent = `Error loading map: ${err.message}`;
    return;
  }
  overview.routes = data;
  overview.byId = new Map(data.map((r) => [r.id, r]));
  if (overview.selected && !overview.byId.has(overview.selected)) overview.selected = null;
  overview.activePair = null;
  drawRoutes();

  const key = params.toString();
  // Zoom to all routes when the filters changed, unless a route is being shown.
  if (key !== overview.lastFitKey && data.length && !overview.selected) {
    overview.lastFitKey = key;
    overview.map.fitBounds(L.featureGroup([...overview.lines.values()]).getBounds(), { padding: [20, 20] });
  }
  const km = data.reduce((s, r) => s + r.distance_km, 0);
  $("#map-count").textContent = `${data.length} route${data.length === 1 ? "" : "s"} · ${Math.round(km)} km`;
  if ($("#prox-on").checked) await loadProximity();
  else renderProximity();
}

function drawRoutes() {
  overview.routeLayer.clearLayers();
  overview.lines.clear();
  for (const r of overview.routes) {
    const line = L.polyline(r.geometry, { color: colorFor(r.id), weight: 3, opacity: 0.85 })
      .bindTooltip(`${r.name} · ${fmt.km(r.distance_km)}`, { sticky: true })
      .on("mouseover", () => line.setStyle({ weight: 6 }))
      .on("mouseout", () => line.setStyle(styleFor(r.id)))
      .on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectRoute(r.id);
      });
    line.addTo(overview.routeLayer);
    overview.lines.set(r.id, line);
  }
  restyle();
}

/** Routes currently in focus: a clicked pair, or the selected route and its neighbours. */
function focusSet() {
  if (overview.activePair) return new Set([overview.activePair.a_id, overview.activePair.b_id]);
  if (overview.selected) {
    const ids = new Set([overview.selected]);
    visiblePairs().forEach((p) => { ids.add(p.a_id); ids.add(p.b_id); });
    return ids;
  }
  return null;
}

function styleFor(id) {
  const focus = focusSet();
  const base = { color: colorFor(id), opacity: 0.85, weight: 3 };
  if (focus) return focus.has(id) ? { ...base, weight: id === overview.selected ? 6 : 4, opacity: 1 } : FADED;
  if ($("#prox-on").checked && overview.pairs.length) {
    return overview.pairs.some((p) => p.a_id === id || p.b_id === id) ? base : FADED;
  }
  return base;
}

function restyle() {
  const focus = focusSet();
  for (const [id, line] of overview.lines) {
    line.setStyle(styleFor(id));
    if (focus && focus.has(id)) line.bringToFront();
  }
  if (overview.selected && overview.lines.has(overview.selected)) overview.lines.get(overview.selected).bringToFront();
}

function selectRoute(id, { fit = false } = {}) {
  overview.selected = id;
  overview.activePair = null;
  const r = overview.byId.get(id);
  $("#prox-focus").hidden = !r;
  $("#prox-focus-name").textContent = r ? r.name : "";
  restyle();
  renderProximity();
  if (fit && overview.lines.has(id)) {
    overview.map.fitBounds(overview.lines.get(id).getBounds(), { padding: [30, 30] });
  }
  if (selectedId !== id) openDetail(id);
}

function clearFocus({ keepDetail = false } = {}) {
  if (!overview.map) return;
  const hadFocus = overview.selected || overview.activePair;
  overview.selected = null;
  overview.activePair = null;
  $("#prox-focus").hidden = true;
  if (!keepDetail && !detail.hidden) closeDetail();
  if (hadFocus) {
    restyle();
    renderProximity();
  }
}
$("#prox-clear").addEventListener("click", () => clearFocus());

// ---------------------------------------------------------------- proximity

async function loadProximity() {
  const token = ++overview.proxToken;
  const d = Number($("#prox-distance").value || 0);
  $("#prox-status").textContent = "finding routes near each other…";
  let res;
  try {
    res = await api(`/api/proximity?${filterParams()}&distance_m=${d}`);
  } catch (err) {
    if (token === overview.proxToken) $("#prox-status").textContent = `error: ${err.message}`;
    return;
  }
  if (token !== overview.proxToken) return; // a newer request is on its way
  overview.pairs = res.pairs;
  overview.activePair = null;
  const involved = new Set(res.pairs.flatMap((p) => [p.a_id, p.b_id]));
  $("#prox-status").textContent =
    `${res.pairs.length} pair${res.pairs.length === 1 ? "" : "s"} within ${res.distance_m} m · ` +
    `${involved.size} of ${overview.routes.length} routes involved. Yellow = shared stretches.`;
  restyle();
  renderProximity();
}

function visiblePairs() {
  if (!$("#prox-on").checked) return [];
  if (overview.selected) return overview.pairs.filter((p) => p.a_id === overview.selected || p.b_id === overview.selected);
  return overview.pairs;
}

function describePair(p) {
  const shared = Math.max(p.a_shared_km, p.b_shared_km);
  if (shared >= 0.5) return `share ${shared.toFixed(1)} km (${Math.round(p.a_shared_pct)}% / ${Math.round(p.b_shared_pct)}% of each)`;
  if (p.min_distance_m < 1) return "cross or touch each other";
  return `${Math.round(p.min_distance_m)} m apart at the closest point`;
}

function renderProximity() {
  overview.proxLayer.clearLayers();
  const pairs = overview.activePair ? [overview.activePair] : visiblePairs();
  for (const p of pairs) {
    for (const seg of [...p.a_segments, ...p.b_segments]) {
      L.polyline(seg, { color: SHARED_COLOR, weight: 10, opacity: 0.6, interactive: false, renderer: overview.sharedRenderer, pane: "shared" })
        .addTo(overview.proxLayer);
    }
    if (p.min_distance_m >= 1) {
      L.polyline(p.closest, { color: "#222", weight: 2, dashArray: "4 4", interactive: false }).addTo(overview.proxLayer);
      p.closest.forEach((c) => L.circleMarker(c, { radius: 4, color: "#222", fillOpacity: 1, interactive: false }).addTo(overview.proxLayer));
    }
  }
  renderPairList();
}

function renderPairList() {
  const list = $("#prox-list");
  if (!$("#prox-on").checked) {
    list.replaceChildren();
    return;
  }
  const pairs = visiblePairs();
  const name = (id) => overview.byId.get(id)?.name ?? `#${id}`;
  if (!pairs.length) {
    list.replaceChildren(el("li", { class: "muted" }, overview.selected ? "No routes near this one." : "No routes near each other."));
    return;
  }
  list.replaceChildren(
    ...pairs.map((p) =>
      el("li", { class: p === overview.activePair ? "active" : null, onclick: () => focusPair(p) },
        el("div", { class: "pair-names" },
          el("span", { class: "swatch", style: `background:${colorFor(p.a_id)}` }), name(p.a_id),
          " ↔ ",
          el("span", { class: "swatch", style: `background:${colorFor(p.b_id)}` }), name(p.b_id)),
        el("div", { class: "pair-info" }, describePair(p)))
    )
  );
}

function focusPair(p) {
  overview.activePair = p;
  restyle();
  renderProximity();
  const bounds = L.latLngBounds([]);
  [p.a_id, p.b_id].forEach((id) => overview.lines.has(id) && bounds.extend(overview.lines.get(id).getBounds()));
  if (bounds.isValid()) overview.map.fitBounds(bounds, { padding: [30, 30] });
}

$("#prox-on").addEventListener("change", () => {
  updateHash();
  if ($("#prox-on").checked) loadProximity();
  else {
    overview.pairs = [];
    overview.activePair = null;
    $("#prox-status").textContent = "";
    restyle();
    renderProximity();
  }
});
let proxDebounce;
$("#prox-distance").addEventListener("input", () => {
  updateHash();
  clearTimeout(proxDebounce);
  if ($("#prox-on").checked) proxDebounce = setTimeout(loadProximity, 400);
});

// ------------------------------------------------------------------ start

restoreFilters();
loadFacets().then(() => {
  const view = new URLSearchParams(location.hash.slice(1)).get("view");
  showView(["map", "import"].includes(view) ? view : "library");
  return loadRoutes();
});
api("/api/version").then((v) => ($("#version").textContent = `v${v.version}`)).catch(() => {});
