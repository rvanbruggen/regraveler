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
    try {
      const body = await res.json();
      if (body.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch (_) {}
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
  // The filters apply to the library and the map, not to the import and combine screens.
  const noFilters = ["import", "combine", "duplicates", "rename"].includes(name);
  $("#filters").hidden = noFilters;
  updateIdsNote();
  if (noFilters) closeDetail();
  if (name === "map") showOverview();
  if (name === "combine") showCombine();
  if (name === "duplicates") loadDuplicates();
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
// ids: "only these routes" (set by "Show on map" for a selection); shared by library and map.
const state = { sort: "name", order: "asc", ids: [] };

function filterParams() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData(filterForm)) {
    if (!String(v).trim()) continue;
    if (k === "tags") splitTags(v).forEach((t) => p.append("tags", t));
    else p.set(k, String(v).trim());
  }
  if (state.sort !== "name") p.set("sort", state.sort);
  if (state.order !== "asc") p.set("order", state.order);
  state.ids.forEach((id) => p.append("ids", id));
  return p;
}

/** URL hash = filters + view + proximity setting, so a link restores the whole screen. */
function updateHash() {
  const p = filterParams();
  if (currentView !== "library") p.set("view", currentView);
  if ($("#prox-on").checked) p.set("near", $("#prox-distance").value || "0");
  if (currentView === "combine") {
    if (cb.a) p.set("a", cb.a);
    if (cb.b) p.set("b", cb.b);
    if (cb.mode === "open") p.set("open", "1");
  }
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
  state.ids = p.getAll("ids").map(Number).filter(Boolean);
}

let debounce;
filterForm.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(refresh, 250);
});
filterForm.addEventListener("reset", () => {
  state.ids = [];
  setTimeout(refresh, 0);
});
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
let selectedId = null; // route open in the detail panel
const checked = new Set(); // routes ticked in the library table

async function loadFacets() {
  const [f, cfg] = await Promise.all([api("/api/facets"), api("/api/config")]);
  if (!cbEl.profile.options.length) {
    cbEl.profile.replaceChildren(...cfg.brouter_profiles.map((p) => el("option", { value: p }, p)));
  }
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
  cb.loaded = false;
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
  // Only routes that are shown can stay selected.
  const shown = new Set(routes.map((r) => r.id));
  [...checked].forEach((id) => shown.has(id) || checked.delete(id));
  updateIdsNote();
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
        {
          class: [r.id === selectedId ? "selected" : "", checked.has(r.id) ? "checked" : ""].join(" ").trim() || null,
          onclick: () => openDetail(r.id),
          "data-id": r.id,
        },
        el("td", { class: "sel", onclick: (e) => e.stopPropagation() },
          el("input", {
            type: "checkbox", checked: checked.has(r.id), "aria-label": `Select ${r.name}`,
            onchange: (e) => toggleChecked(r.id, e.target.checked),
          })),
        el("td", { class: "name" }, r.name),
        el("td", { class: "num" }, fmt.km(r.distance_km)),
        el("td", { class: "num" }, fmt.m(r.elevation_gain_m)),
        el("td", {}, r.is_loop ? "loop" : "A→B"),
        r.paved_source === "estimated"
          ? el("td", { class: "num est", title: "Estimated from OpenStreetMap" }, `≈${fmt.pct(r.paved_pct)}`)
          : el("td", { class: "num" }, fmt.pct(r.paved_pct)),
        el("td", { class: "stars" }, fmt.stars(r.quality_rating)),
        el("td", {}, r.tags.map((t) => el("span", { class: "tag" }, t))),
        el("td", {}, r.source_name || "–"),
        el("td", {}, fmt.date(r.imported_at))
      )
    )
  );
  renderSelection();
}

// ------------------------------------------------------------------ multi-select

function toggleChecked(id, on) {
  if (on) checked.add(id);
  else checked.delete(id);
  $(`#routes tbody tr[data-id="${id}"]`)?.classList.toggle("checked", on);
  renderSelection();
}

function renderSelection() {
  const n = checked.size;
  $("#sel-bar").hidden = n === 0;
  if (n === 0) toggleTagPanel(false);
  else if (!$("#tag-panel").hidden) renderTagPanel();
  $("#sel-count").textContent = `${n} selected`;
  const all = $("#sel-all");
  all.checked = n > 0 && n === routes.length;
  all.indeterminate = n > 0 && n < routes.length;
}

$("#sel-all").addEventListener("change", (e) => {
  checked.clear();
  if (e.target.checked) routes.forEach((r) => checked.add(r.id));
  renderTable();
});

$("#sel-clear").addEventListener("click", () => {
  checked.clear();
  renderTable();
});

$("#sel-download").addEventListener("click", () => {
  const ids = [...checked];
  if (!ids.length) return;
  // One route: its original file; several: a zip of the original files.
  const url = ids.length === 1
    ? `/api/routes/${ids[0]}/gpx`
    : `/api/export/gpx.zip?${ids.map((id) => `ids=${id}`).join("&")}`;
  const link = el("a", { href: url, download: "" });
  document.body.append(link);
  link.click();
  link.remove();
});

$("#sel-map").addEventListener("click", () => {
  if (!checked.size) return;
  state.ids = [...checked];
  showView("map");
  refresh();
});

$("#sel-remove").addEventListener("click", async () => {
  const chosen = routes.filter((r) => checked.has(r.id));
  if (!chosen.length) return;
  const names = chosen.slice(0, 8).map((r) => `• ${r.name}`).join("\n") + (chosen.length > 8 ? `\n… and ${chosen.length - 8} more` : "");
  if (!confirm(`Remove ${chosen.length} route${chosen.length === 1 ? "" : "s"} from the library?\n\n${names}\n\nThe GPX files on disk are not deleted.`)) return;
  try {
    await api("/api/routes/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chosen.map((r) => r.id) }),
    });
  } catch (err) {
    alert(`Could not remove the routes: ${err.message}`);
    return;
  }
  if (chosen.some((r) => r.id === selectedId)) closeDetail();
  checked.clear();
  state.ids = state.ids.filter((id) => !chosen.some((r) => r.id === id));
  await Promise.all([refresh(), loadFacets()]);
});

$("#sel-surface").addEventListener("click", async () => {
  const ids = [...checked];
  if (!ids.length) return;
  try {
    await api("/api/surface/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, force: true }),
    });
  } catch (err) {
    alert(`Could not start the surface estimate: ${err.message}`);
    return;
  }
  watchSurfaceJob();
});

// Tags for the selected routes.

function toggleTagPanel(open) {
  $("#tag-panel").hidden = !open;
  $("#sel-tags").setAttribute("aria-expanded", String(open));
  if (open) {
    renderTagPanel();
    $("#tag-add").focus();
  }
}

function renderTagPanel() {
  const selected = routes.filter((r) => checked.has(r.id));
  const counts = new Map();
  selected.forEach((r) => r.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $("#tag-current").replaceChildren(
    ...(sorted.length
      ? sorted.map(([t, n]) =>
          el("span", { class: "tag" }, `${t} `,
            el("span", { class: "muted" }, `${n}/${selected.length}`),
            el("button", { type: "button", title: `Remove "${t}" from the selected routes`, "aria-label": `Remove ${t}`, onclick: () => changeTags({ remove: [t] }) }, "×")))
      : [el("span", { class: "muted" }, " none")])
  );
}

async function changeTags({ add = [], remove = [] }) {
  const ids = [...checked];
  if (!ids.length || (!add.length && !remove.length)) return;
  try {
    const res = await api("/api/routes/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, add, remove }),
    });
    const what = add.length ? `added ${add.map((t) => `"${t}"`).join(", ")}` : `removed "${remove[0]}"`;
    await Promise.all([loadRoutes(), loadFacets()]); // keeps the selection (routes stay shown)
    $("#tag-status").textContent = `${what} · ${res.updated} route${res.updated === 1 ? "" : "s"} changed`;
    if (selectedId && checked.has(selectedId)) openDetail(selectedId);
  } catch (err) {
    $("#tag-status").textContent = `Error: ${err.message}`;
  }
}

$("#sel-tags").addEventListener("click", () => toggleTagPanel($("#tag-panel").hidden));
$("#tag-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tags = splitTags($("#tag-add").value);
  if (!tags.length) return $("#tag-add").focus();
  await changeTags({ add: tags });
  $("#tag-add").value = "";
});

/** Show progress of background surface estimates; refresh the table when they finish. */
let surfaceTimer = null;
async function watchSurfaceJob() {
  clearTimeout(surfaceTimer);
  let st;
  try {
    st = await api("/api/surface/status");
  } catch (_) {
    return;
  }
  const label = $("#surface-job");
  if (st.running) {
    label.textContent = `· estimating surface: ${st.done + st.failed} done, ${st.queued} to go…`;
    surfaceTimer = setTimeout(watchSurfaceJob, 1500);
  } else {
    label.textContent = st.done + st.failed
      ? `· surface estimated for ${st.done} route${st.done === 1 ? "" : "s"}` +
        (st.failed ? `, ${st.failed} failed (${st.last_error})` : "")
      : "";
    if (st.done) {
      await refresh();
      if (selectedId && currentView === "library") openDetail(selectedId);
    }
  }
}

/** Notice shown while the library/map are limited to a set of selected routes. */
function updateIdsNote() {
  const show = state.ids.length > 0 && (currentView === "library" || currentView === "map");
  $("#ids-note").hidden = !show;
  $("#ids-note-text").textContent = `Showing only the ${state.ids.length} selected route${state.ids.length === 1 ? "" : "s"}.`;
}

$("#ids-note-clear").addEventListener("click", () => {
  state.ids = [];
  refresh();
});

// ------------------------------------------------------------------ detail panel

const detail = $("#detail");
const detailForm = $("#d-form");
let map = null;
let mapLayer = null;
let detailRoute = null; // the route shown in the detail panel

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
  detailRoute = r;
  renderSurface(r);
  f.tags.value = r.tags.join(", ");
  f.notes.value = r.notes ?? "";
  f.source_name.value = r.source_name ?? "";
  f.source_url.value = r.source_url ?? "";
  $("#d-download").href = `/api/routes/${r.id}/gpx`;
  $("#d-file").textContent =
    `File: ${r.gpx_path}` + (r.track_name ? ` · GPX track ${r.track_index + 1}: "${r.track_name}"` : "") +
    ` · imported ${fmt.date(r.imported_at)}`;
  const derived = $("#d-derived");
  derived.hidden = !r.derived_from.length;
  derived.replaceChildren();
  if (r.derived_from.length) {
    const parents = await Promise.all(r.derived_from.map((pid) => api(`/api/routes/${pid}`).catch(() => null)));
    derived.append(
      "Combined from: ",
      ...parents.flatMap((pr, i) => [
        i ? " + " : "",
        pr ? el("a", { class: "link", onclick: () => showRoute(pr.id) }, pr.name) : `#${r.derived_from[i]} (removed)`,
      ])
    );
  }

  drawDetailMap(r, true);

  loadSimilar(r.id);
}

const SURFACE_COLORS = { paved: "#5f5e5a", cobbles: "#9a6324", unpaved: "#d4a017", unknown: "#c8c6bf" };
const SURFACE_LABELS = { paved: "Paved", cobbles: "Cobbles", unpaved: "Unpaved", unknown: "Unknown" };

function drawDetailMap(r, fit) {
  const m = ensureMap();
  m.invalidateSize();
  if (mapLayer) mapLayer.remove();
  const segments = r.surface?.segments;
  const bySurface = segments?.length && $("#d-surface-map").checked;
  $("#d-surface-toggle").hidden = !segments?.length;
  const lines = bySurface
    ? segments.map(([cat, pts]) => L.polyline(pts, { color: SURFACE_COLORS[cat] || "#888", weight: 5 }).bindTooltip(SURFACE_LABELS[cat] || cat))
    : [L.polyline(r.geometry, { color: "#b35c1e", weight: 4 })];
  mapLayer = L.layerGroup([
    ...lines,
    L.circleMarker([r.start_lat, r.start_lon], { radius: 6, color: "#2e7d32", fillOpacity: 1 }).bindTooltip("Start"),
    r.is_loop ? null : L.circleMarker([r.end_lat, r.end_lon], { radius: 6, color: "#b3261e", fillOpacity: 1 }).bindTooltip("End"),
  ].filter(Boolean)).addTo(m);
  if (fit) m.fitBounds([[r.min_lat, r.min_lon], [r.max_lat, r.max_lon]], { padding: [10, 10] });
}
$("#d-surface-map").addEventListener("change", () => detailRoute && drawDetailMap(detailRoute, false));

function renderSurface(r) {
  const box = $("#d-surface");
  const s = r.surface;
  $("#d-paved-src").textContent =
    r.paved_source === "estimated" ? "(estimated)" : r.paved_source === "manual" || r.paved_pct != null ? "(yours)" : "";
  const estimateBtn = el("button", { type: "button", class: "secondary", onclick: () => estimateOne(r.id, false) },
    s ? "Estimate again" : "Estimate surface from OpenStreetMap");
  if (!s) {
    box.replaceChildren(el("div", { class: "actions" }, estimateBtn, el("span", { class: "muted small", id: "d-surface-status" })));
    return;
  }
  const total = ["paved", "cobbles", "unpaved", "unknown"].reduce((t, c) => t + s[`${c}_km`], 0) || 1;
  const cats = ["paved", "cobbles", "unpaved", "unknown"].filter((c) => s[`${c}_km`] > 0);
  const pct = (c) => Math.round((100 * s[`${c}_km`]) / total);
  const manualDiffers = r.paved_source !== "estimated" && s.paved_pct != null && r.paved_pct !== s.paved_pct;
  box.replaceChildren(
    el("div", { class: "surface-bar", title: "Surface from OpenStreetMap" },
      cats.map((c) => el("span", { style: `width:${(100 * s[`${c}_km`]) / total}%;background:${SURFACE_COLORS[c]}`, title: `${SURFACE_LABELS[c]} ${s[`${c}_km`]} km` }))),
    el("div", { class: "surface-legend" },
      cats.map((c) => el("span", {}, el("i", { style: `background:${SURFACE_COLORS[c]}` }), `${SURFACE_LABELS[c]} ${pct(c)}% (${s[`${c}_km`].toFixed(1)} km)`))),
    el("div", { class: "muted small" },
      `From OpenStreetMap, ${fmt.date(s.estimated_at)}` +
      (s.inferred_km > 0.05 ? ` · ${s.inferred_km.toFixed(1)} km guessed from the road type` : "") +
      (s.match_ratio && Math.abs(s.match_ratio - 1) > 0.1 ? ` · rough match (${Math.round(s.match_ratio * 100)}% of the route length)` : "") +
      (s.top_surfaces?.length ? ` · mostly ${s.top_surfaces.slice(0, 3).map(([n]) => n).join(", ")}` : "")),
    el("div", { class: "actions" },
      estimateBtn,
      manualDiffers ? el("a", { class: "link small", onclick: () => estimateOne(r.id, true) }, `use the estimate (${s.paved_pct}%) instead of yours`) : null,
      el("span", { class: "muted small", id: "d-surface-status" }))
  );
}

async function estimateOne(id, overwriteManual) {
  $("#d-surface-status").textContent = "estimating…";
  try {
    const r = await api(`/api/routes/${id}/surface?overwrite_manual=${overwriteManual}`, { method: "POST" });
    if (selectedId !== id) return;
    detailRoute = r;
    detailForm.elements.paved_pct.value = r.paved_pct ?? "";
    renderSurface(r);
    drawDetailMap(r, false);
    await refresh();
  } catch (err) {
    const status = $("#d-surface-status");
    if (status) status.textContent = `error: ${err.message}`;
  }
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
    tags: splitTags(f.tags.value),
    notes: f.notes.value,
    source_name: f.source_name.value,
    source_url: f.source_url.value,
  };
  // Only send the paved % when it was changed, so saving other fields keeps it "estimated".
  const paved = f.paved_pct.value === "" ? null : Number(f.paved_pct.value);
  if (paved !== (detailRoute?.paved_pct ?? null)) body.paved_pct = paved;
  $("#d-status").textContent = "saving…";
  try {
    const r = await api(`/api/routes/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("#d-title").textContent = r.name;
    f.tags.value = r.tags.join(", ");
    f.paved_pct.value = r.paved_pct ?? "";
    detailRoute = r;
    renderSurface(r);
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
    watchSurfaceJob();
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
        el("div", { class: "pair-info" }, describePair(p), " · ",
          el("a", { class: "link", onclick: (e) => { e.stopPropagation(); openCombiner(p.a_id, p.b_id); } }, "combine")))
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

// ------------------------------------------------------------------ combiner

const COLOR_A = "#2f6fd6";
const COLOR_B = "#d62f4b";
const COLOR_CONNECTOR = "#b35c1e"; // the logo's "new line" orange

const cb = {
  map: null,
  loaded: false,
  loading: Promise.resolve(),
  routes: [], // all routes, from /api/map
  byId: new Map(),
  a: null,
  b: null,
  mode: "loop", // "loop" (back to A1) or "open" (point to point)
  points: { a1: null, a2: null, b1: null, b2: null }, // [lat, lon] each
  pointsTouched: false, // placed or moved by the user (not just suggested)
  placing: [], // point keys still to click, in order
  preview: null,
  token: 0,
  nameTouched: false,
};

const POINT_KEYS = ["a1", "a2", "b1", "b2"];
const POINT_HINTS = { a1: "join route A", a2: "leave route A", b1: "join route B", b2: "leave route B" };
const MAX_SNAP_M = 1500; // clicks further from the route than this are refused

const cbEl = {
  a: $("#cb-a"), b: $("#cb-b"), revA: $("#cb-rev-a"), revB: $("#cb-rev-b"), rev: $("#cb-rev"),
  profile: $("#cb-profile"), unpaved: $("#cb-unpaved"), straight: $("#cb-straight"),
  status: $("#cb-status"), stats: $("#cb-stats"), save: $("#cb-save"), name: $("#cb-name"), saved: $("#cb-saved"),
  points: $("#cb-points"),
};

function showCombine() {
  if (!cb.map) {
    const m = L.map("combine-map", { renderer: L.canvas({ tolerance: 6 }) }).setView([50.9, 4.5], 9);
    osmTiles().addTo(m);
    cb.bgLayer = L.layerGroup().addTo(m);
    cb.routeLayer = L.layerGroup().addTo(m);
    cb.resultLayer = L.layerGroup().addTo(m);
    cb.markerLayer = L.layerGroup().addTo(m);
    m.on("click", (e) => { if (cb.placing.length) placeAt(e.latlng); });
    cb.map = m;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get("open") === "1") setMode("open");
    cb.initial = { a: Number(p.get("a")) || null, b: Number(p.get("b")) || null };
  }
  setTimeout(() => cb.map.invalidateSize(), 0);
  if (!cb.loaded) cb.loading = loadCombineRoutes();
  return cb.loading;
}

async function loadCombineRoutes() {
  cb.loaded = true;
  try {
    cb.routes = await api("/api/map?tolerance_m=15");
  } catch (err) {
    cbEl.status.textContent = `Error loading routes: ${err.message}`;
    cb.loaded = false;
    return;
  }
  cb.byId = new Map(cb.routes.map((r) => [r.id, r]));
  const sorted = [...cb.routes].sort((x, y) => x.name.localeCompare(y.name));
  for (const sel of [cbEl.a, cbEl.b]) {
    sel.replaceChildren(el("option", { value: "" }, "— choose —"), ...sorted.map((r) => el("option", { value: r.id }, r.name)));
  }
  cb.bgLayer.clearLayers();
  for (const r of cb.routes) {
    L.polyline(r.geometry, { color: "#777", weight: 2, opacity: 0.35 })
      .bindTooltip(r.name, { sticky: true })
      .on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (cb.placing.length) placeAt(e.latlng);
        else pickRoute(r.id);
      })
      .addTo(cb.bgLayer);
  }
  if (cb.initial) {
    const { a, b } = cb.initial;
    cb.initial = null;
    if (a || b) return setRoutes(cb.byId.has(a) ? a : null, cb.byId.has(b) ? b : null);
  }
  if (!cb.a && !cb.b && cb.routes.length) {
    cb.map.fitBounds(L.featureGroup(cb.bgLayer.getLayers()).getBounds(), { padding: [20, 20] });
  }
  syncSelects();
  renderPoints();
}

function syncSelects() {
  cbEl.a.value = cb.a ?? "";
  cbEl.b.value = cb.b ?? "";
}

function pickRoute(id) {
  if (!cb.a) setRoutes(id, cb.b === id ? null : cb.b);
  else if (id !== cb.a) setRoutes(cb.a, id);
}

async function setRoutes(a, b) {
  cb.a = a || null;
  cb.b = b && b !== a ? b : null;
  cb.points = { a1: null, a2: null, b1: null, b2: null };
  cb.pointsTouched = false;
  stopPlacing();
  cb.preview = null;
  cb.nameTouched = false;
  cbEl.saved.textContent = "";
  syncSelects();
  updateHash();
  updateDirectionLabels();
  drawCombineRoutes();
  drawCombineResult();
  const lines = [cb.a, cb.b].filter(Boolean).map((id) => L.polyline(cb.byId.get(id).geometry));
  if (lines.length) cb.map.fitBounds(L.featureGroup(lines).getBounds(), { padding: [30, 30] });
  if (cb.a && cb.b) await suggestPoints();
  else cbEl.status.textContent = cb.a ? "Now choose route B (or click it on the map)." : "Choose route A (or click it on the map).";
}

function drawCombineRoutes() {
  cb.routeLayer.clearLayers();
  for (const [id, color] of [[cb.a, COLOR_A], [cb.b, COLOR_B]]) {
    if (!id) continue;
    L.polyline(cb.byId.get(id).geometry, { color, weight: 3, opacity: cb.preview ? 0.35 : 0.9, interactive: false })
      .addTo(cb.routeLayer);
  }
}

function setMode(mode) {
  cb.mode = mode;
  $$('input[name="cb-mode"]').forEach((r) => (r.checked = r.value === mode));
  updateDirectionLabels();
}

function updateDirectionLabels() {
  const a = cb.byId.get(cb.a), b = cb.byId.get(cb.b);
  const set = (input, label, text, enabled) => {
    label.querySelector("span").textContent = text;
    input.disabled = !enabled;
    if (!enabled) input.checked = false;
    label.classList.toggle("muted", !enabled);
  };
  set(cbEl.revA, $("#cb-rev-a-label"), a && !a.is_loop ? "Other way round A (A is not a loop)" : "Other way round A (through its start)", !!a?.is_loop);
  set(cbEl.revB, $("#cb-rev-b-label"), b && !b.is_loop ? "Other way round B (B is not a loop)" : "Other way round B (through its start)", !!b?.is_loop);
  const gravel = cbEl.profile.value === "gravel" && !cbEl.straight.checked;
  $("#cb-unpaved-label").hidden = !gravel;
  cbEl.profile.disabled = cbEl.straight.checked;
}

// ---- the four points

const routeOfPoint = (key) => (key[0] === "a" ? cb.a : cb.b);
const pointLabel = (key) => key.toUpperCase();

function renderPoints() {
  const parts = cb.preview?.parts || [];
  cbEl.points.replaceChildren(...POINT_KEYS.map((key) => {
    const part = parts[key[0] === "a" ? 0 : 1];
    let where;
    if (cb.placing[0] === key) where = "click it on the map…";
    else if (part && cb.points[key]) where = `${fmt.km(key[1] === "1" ? part.start_km : part.end_km)} along route ${key[0].toUpperCase()}`;
    else where = cb.points[key] ? "placed" : "not placed";
    return el("div", { class: `cb-point${cb.placing[0] === key ? " placing" : ""}` },
      el("span", { class: `cb-marker ${key[0]}` }, pointLabel(key)),
      el("span", { class: "where", title: POINT_HINTS[key] }, where),
      el("button", {
        type: "button", class: "secondary", disabled: !routeOfPoint(key),
        onclick: () => startPlacing([key]),
      }, "Place"));
  }));
  $("#cb-click-all").disabled = !(cb.a && cb.b);
  $("#cb-suggest").disabled = !(cb.a && cb.b);
  $("#cb-swap-a").disabled = !(cb.points.a1 && cb.points.a2);
  $("#cb-swap-b").disabled = !(cb.points.b1 && cb.points.b2);
}

function startPlacing(keys) {
  cb.placing = keys.filter((k) => routeOfPoint(k));
  if (!cb.placing.length) return;
  cb.map.getContainer().classList.add("placing");
  promptPlacing();
}

function stopPlacing() {
  cb.placing = [];
  cb.map?.getContainer().classList.remove("placing");
  renderPoints();
}

function promptPlacing() {
  const key = cb.placing[0];
  const route = key[0].toUpperCase();
  cbEl.status.textContent = `Click ${pointLabel(key)} on route ${route} (${route === "A" ? "blue" : "red"}): where you ${POINT_HINTS[key]}. Esc cancels.`;
  renderPoints();
}

/** Nearest point on a [lat, lon] polyline, with its distance in metres. */
function snapToLine(line, ll) {
  const k = Math.cos((ll.lat * Math.PI) / 180);
  const toXY = (p) => [p[1] * k * 111320, p[0] * 110540];
  const [px, py] = toXY([ll.lat, ll.lng]);
  let best = { d: Infinity, p: null };
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toXY(line[i]), [bx, by] = toXY(line[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
    if (d < best.d) {
      best = { d, p: [line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])] };
    }
  }
  return best;
}

function placeAt(latlng) {
  const key = cb.placing[0];
  const route = cb.byId.get(routeOfPoint(key));
  const snap = snapToLine(route.geometry, latlng);
  if (snap.d > MAX_SNAP_M) {
    cbEl.status.textContent = `That is ${(snap.d / 1000).toFixed(1)} km from route ${key[0].toUpperCase()}; click closer to it (or press Esc).`;
    return;
  }
  cb.points[key] = snap.p;
  cb.pointsTouched = true;
  cb.placing.shift();
  drawCombineResult();
  if (cb.placing.length) return promptPlacing();
  stopPlacing();
  runPreview();
}

function swapPoints(side) {
  const [p, q] = [`${side}1`, `${side}2`];
  [cb.points[p], cb.points[q]] = [cb.points[q], cb.points[p]];
  cb.pointsTouched = true;
  runPreview();
}

async function suggestPoints() {
  if (!cb.a || !cb.b) return;
  stopPlacing();
  cbEl.status.textContent = "Looking for the closest points…";
  try {
    const res = await api(`/api/combine/suggest?a_id=${cb.a}&b_id=${cb.b}&count=${cb.mode === "loop" ? 2 : 1}`);
    const [pa, pb] = res.parts;
    cb.points = { a1: pa.start, a2: pa.end, b1: pb.start, b2: pb.end };
    cb.pointsTouched = false;
  } catch (err) {
    cbEl.status.textContent = `Error: ${err.message}`;
    return;
  }
  await runPreview();
}

function combineRequest(extra = {}) {
  const p = cb.points;
  return {
    parts: [
      { route_id: cb.a, start: p.a1, end: p.a2, other_way: cbEl.revA.checked },
      { route_id: cb.b, start: p.b1, end: p.b2, other_way: cbEl.revB.checked },
    ],
    closed: cb.mode === "loop",
    reverse: cbEl.rev.checked,
    profile: cbEl.profile.value,
    prefer_unpaved: cbEl.unpaved.checked,
    straight: cbEl.straight.checked,
    ...extra,
  };
}

async function runPreview() {
  renderPoints();
  if (!cb.a || !cb.b) return;
  if (!POINT_KEYS.every((k) => cb.points[k])) {
    cb.preview = null;
    drawCombineRoutes();
    drawCombineResult();
    const missing = POINT_KEYS.filter((k) => !cb.points[k]).map(pointLabel).join(", ");
    cbEl.status.textContent = `Place ${missing} to see the combination.`;
    return;
  }
  const token = ++cb.token;
  cbEl.status.textContent = cbEl.straight.checked ? "Joining…" : "Routing the connectors…";
  let res;
  try {
    res = await api("/api/combine/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(combineRequest()),
    });
  } catch (err) {
    if (token !== cb.token) return;
    cb.preview = null;
    drawCombineRoutes();
    drawCombineResult();
    renderPoints();
    cbEl.status.textContent = `Error: ${err.message}`;
    return;
  }
  if (token !== cb.token) return; // a newer preview is on its way
  cb.preview = res;
  // Snapped onto the routes.
  const [pa, pb] = res.parts;
  cb.points = { a1: pa.start, a2: pa.end, b1: pb.start, b2: pb.end };
  if (!cb.nameTouched) cbEl.name.value = `${cb.byId.get(cb.a).name} + ${cb.byId.get(cb.b).name}`;
  cbEl.status.replaceChildren(
    res.description,
    ...(res.crossing
      ? [el("br"), el("span", { class: "cb-warn" }, "The connectors cross each other: try swapping B1 ↔ B2 (or A1 ↔ A2).")]
      : [])
  );
  drawCombineRoutes();
  drawCombineResult();
  renderPoints();
}

function markerIcon(label, cls) {
  return L.divIcon({ className: `cb-marker ${cls}`, html: label, iconSize: [28, 22], iconAnchor: [14, 11] });
}

function drawCombineResult() {
  cb.resultLayer.clearLayers();
  cb.markerLayer.clearLayers();
  const res = cb.preview;
  cbEl.stats.hidden = !res;
  cbEl.save.hidden = !res;
  if (res) {
    for (const leg of res.legs) {
      const color = leg.kind === "a" ? COLOR_A : leg.kind === "b" ? COLOR_B : COLOR_CONNECTOR;
      L.polyline(leg.geometry, {
        color, weight: leg.kind === "connector" ? 5 : 6, opacity: 0.9, interactive: false,
        dashArray: leg.kind === "connector" && !leg.routed ? "6 6" : null,
      }).addTo(cb.resultLayer);
    }
    L.marker(res.start, { icon: L.divIcon({ className: "cb-start", html: "Start", iconSize: [42, 20], iconAnchor: [21, 26] }), interactive: false })
      .addTo(cb.markerLayer);
    const connectors = res.connectors
      .map((c, i) => `${i + 1}: ${c.distance_km.toFixed(1)} km${c.routed ? "" : " (joined)"}`)
      .join(", ");
    const stats = [
      ["Distance", fmt.km(res.distance_km)],
      ["Elevation gain", fmt.m(res.elevation_gain_m)],
      ["Type", res.is_loop ? "Loop" : "Point to point"],
      ["On route A / B", res.parts.map((p) => fmt.km(p.distance_km)).join(" / ")],
      ["Connectors", connectors],
    ];
    cbEl.stats.replaceChildren(...stats.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));
  }
  // Draggable points (also shown before the first preview has succeeded).
  for (const key of POINT_KEYS) {
    if (!cb.points[key]) continue;
    const side = key[0];
    L.marker(cb.points[key], { draggable: true, icon: markerIcon(pointLabel(key), side), zIndexOffset: 1000 })
      .bindTooltip(`${pointLabel(key)}: ${POINT_HINTS[key]} (drag along route ${side.toUpperCase()})`)
      .on("dragend", (e) => {
        const ll = e.target.getLatLng();
        cb.points[key] = [ll.lat, ll.lng];
        cb.pointsTouched = true;
        runPreview();
      })
      .addTo(cb.markerLayer);
  }
}

cbEl.a.addEventListener("change", () => setRoutes(Number(cbEl.a.value) || null, cb.b));
cbEl.b.addEventListener("change", () => setRoutes(cb.a, Number(cbEl.b.value) || null));
$$('input[name="cb-mode"]').forEach((r) =>
  r.addEventListener("change", () => {
    setMode(r.value);
    updateHash();
    // Suggested points depend on the mode; points the user placed are kept.
    if (cb.pointsTouched) runPreview();
    else suggestPoints();
  })
);
$("#cb-suggest").addEventListener("click", suggestPoints);
$("#cb-click-all").addEventListener("click", () => startPlacing(POINT_KEYS));
$("#cb-swap-a").addEventListener("click", () => swapPoints("a"));
$("#cb-swap-b").addEventListener("click", () => swapPoints("b"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && cb.placing.length) {
    stopPlacing();
    runPreview();
  }
});
[cbEl.revA, cbEl.revB, cbEl.rev, cbEl.unpaved].forEach((c) => c.addEventListener("change", runPreview));
[cbEl.profile, cbEl.straight].forEach((c) =>
  c.addEventListener("change", () => {
    updateDirectionLabels();
    runPreview();
  })
);
cbEl.name.addEventListener("input", () => (cb.nameTouched = true));

$("#cb-save-btn").addEventListener("click", async () => {
  const name = cbEl.name.value.trim();
  if (!name) return cbEl.name.focus();
  cbEl.saved.textContent = "saving…";
  try {
    const res = await api("/api/combine/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(combineRequest({ name })),
    });
    cbEl.saved.replaceChildren(
      "Saved as ",
      el("a", { onclick: () => { showView("library"); openDetail(res.id); } }, res.name),
      res.similar.length ? ` (very similar to ${res.similar.map((s) => s.other_name).join(", ")})` : ""
    );
    const keep = { a: cb.a, b: cb.b };
    await Promise.all([refresh(), loadFacets()]);
    await showCombine();
    cb.a = keep.a;
    cb.b = keep.b;
    syncSelects();
  } catch (err) {
    cbEl.saved.textContent = `Error: ${err.message}`;
  }
});

$("#cb-download").addEventListener("click", async () => {
  const name = cbEl.name.value.trim() || "combined route";
  try {
    const res = await fetch("/api/combine/gpx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(combineRequest({ name })),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const url = URL.createObjectURL(await res.blob());
    const link = el("a", { href: url, download: `${name}.gpx` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    cbEl.saved.textContent = `Error: ${err.message}`;
  }
});

/** Open the combiner with the given routes (either may be null). */
async function openCombiner(a, b) {
  showView("combine");
  await cb.loading;
  await setRoutes(a, b);
}

$("#d-combine").addEventListener("click", () => {
  const id = selectedId;
  // Add to the current combination: as B if A is already chosen, otherwise as A.
  if (cb.a && cb.a !== id) openCombiner(cb.a, id);
  else openCombiner(id, cb.b !== id ? cb.b : null);
});

// ------------------------------------------------------------------ duplicates

let dupData = null;

async function loadDuplicates() {
  $("#dup-status").textContent = "Looking for duplicates…";
  try {
    dupData = await api("/api/duplicates");
  } catch (err) {
    $("#dup-status").textContent = `Error: ${err.message}`;
    return;
  }
  renderDuplicates();
}

function dupRouteCell(r) {
  return el("a", { class: "link", onclick: () => showRoute(r.id) }, r.name);
}

function renderDuplicates() {
  const { groups, variants } = dupData;
  $("#dup-status").textContent = groups.length
    ? `${groups.length} group${groups.length === 1 ? "" : "s"} of near-duplicate routes. The suggested route to keep has the most of your own ratings, tags and notes (then the oldest).`
    : "No near-duplicate routes found.";
  $("#dup-groups").replaceChildren(...groups.map(renderDupGroup));
  $("#dup-variants").replaceChildren(
    ...(variants.length
      ? variants.map((v) =>
          el("li", {},
            dupRouteCell(v.part), ` lies ${v.covered_pct}% on `, dupRouteCell(v.whole),
            v.reversed ? " (ridden the other way)" : "", " · ",
            el("a", { onclick: () => showOnMap([v.part.id, v.whole.id]) }, "show on map"), " · ",
            el("a", { onclick: () => ignoreDuplicates([v.part.id, v.whole.id]) }, "hide")))
      : [el("li", { class: "muted" }, "none")])
  );
}

function renderDupGroup(g) {
  const notes = [];
  if (g.pairs.some((p) => p.same_track)) notes.push("identical track");
  if (g.pairs.some((p) => p.reversed)) notes.push("some are ridden the other way");
  const boxes = new Map();
  const rows = g.routes.map((r) => {
    const box = el("input", { type: "checkbox", checked: r.id !== g.suggested_keep, "aria-label": `Remove ${r.name}` });
    boxes.set(r.id, box);
    return el("tr", {},
      el("td", { class: "sel" }, box),
      el("td", {}, dupRouteCell(r), r.id === g.suggested_keep ? el("span", { class: "keep" }, "  keep") : ""),
      el("td", { class: "num" }, fmt.km(r.distance_km)),
      el("td", { class: "num" }, fmt.m(r.elevation_gain_m)),
      el("td", {}, r.source_name || "–"),
      el("td", { class: "stars" }, fmt.stars(r.quality_rating)),
      el("td", {}, r.tags.map((t) => el("span", { class: "tag" }, t)), r.has_notes ? " (notes)" : ""),
      el("td", {}, fmt.date(r.imported_at)));
  });
  const ids = g.routes.map((r) => r.id);
  const overlaps = g.pairs.flatMap((p) => [p.a_in_b_pct, p.b_in_a_pct]);
  const lo = Math.min(...overlaps), hi = Math.max(...overlaps);
  return el("div", { class: "dup-group" },
    el("div", { class: "muted small" },
      (lo === hi ? `${lo}% overlap` : `${lo}–${hi}% overlap`) +
      (notes.length ? ` · ${notes.join(" · ")}` : "")),
    el("table", {},
      el("thead", {}, el("tr", {},
        el("th", { class: "sel" }, "remove"), el("th", {}, "Route"), el("th", { class: "num" }, "Distance"),
        el("th", { class: "num" }, "Gain"), el("th", {}, "Source"), el("th", {}, "Quality"), el("th", {}, "Tags"),
        el("th", {}, "Imported"))),
      el("tbody", {}, rows)),
    el("div", { class: "actions" },
      el("button", { type: "button", class: "danger", onclick: () => removeDuplicates(g, boxes) }, "Remove ticked"),
      el("button", { type: "button", class: "secondary", onclick: () => showOnMap(ids) }, "Show on map"),
      el("button", { type: "button", class: "secondary", onclick: () => ignoreDuplicates(ids) }, "Not duplicates")));
}

async function removeDuplicates(g, boxes) {
  const chosen = g.routes.filter((r) => boxes.get(r.id).checked);
  if (!chosen.length) return;
  if (chosen.length === g.routes.length && !confirm("This removes every route in the group. Continue?")) return;
  if (!confirm(`Remove ${chosen.map((r) => `"${r.name}"`).join(", ")} from the library?\n\nThe GPX files on disk are not deleted.`)) return;
  try {
    await api("/api/routes/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chosen.map((r) => r.id) }),
    });
  } catch (err) {
    alert(`Could not remove the routes: ${err.message}`);
    return;
  }
  await Promise.all([refresh(), loadFacets(), loadDuplicates()]);
}

async function ignoreDuplicates(ids) {
  await api("/api/duplicates/ignore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  await loadDuplicates();
}

function showOnMap(ids) {
  state.ids = ids;
  showView("map");
  refresh();
}

$("#dup-reset").addEventListener("click", async () => {
  if (!confirm('Show all groups and variants again, including the ones you marked as "not duplicates"?')) return;
  await api("/api/duplicates/reset", { method: "POST" });
  await loadDuplicates();
});

// ------------------------------------------------------------------ rename

let renameRows = []; // [{id, name, proposal, input, box}]

async function openRename(ids) {
  showView("rename");
  const tbody = $("#rn-table tbody");
  tbody.replaceChildren();
  $("#rn-status").textContent = "Looking up the places each route visits… (the first time this downloads GeoNames data)";
  let proposals;
  try {
    const q = ids?.length ? ids.map((id) => `ids=${id}`).join("&") : "";
    proposals = await api(`/api/rename/proposals${q ? `?${q}` : ""}`);
  } catch (err) {
    $("#rn-status").textContent = `Error: ${err.message}`;
    return;
  }
  renameRows = proposals.map((p) => {
    const changed = p.proposal && p.proposal !== p.name;
    const input = el("input", { value: p.proposal || "", placeholder: p.proposal ? "" : "no places found nearby", "aria-label": `New name for ${p.name}` });
    const box = el("input", { type: "checkbox", checked: !!changed && !p.is_derived, "aria-label": `Rename ${p.name}` });
    input.addEventListener("input", () => { box.checked = input.value.trim() !== "" && input.value.trim() !== p.name; updateRenameCount(); });
    box.addEventListener("change", updateRenameCount);
    return { ...p, input, box, changed };
  });
  tbody.replaceChildren(
    ...renameRows.map((r) =>
      el("tr", { class: r.changed ? null : "unchanged" },
        el("td", { class: "sel" }, r.box),
        el("td", { class: "current" }, r.name, el("div", { class: "muted small" },
          [r.source_name, r.is_derived ? "combined route" : null].filter(Boolean).join(" · "))),
        el("td", { class: "proposal" }, r.input),
        el("td", { class: "num" }, fmt.km(r.distance_km))))
  );
  updateRenameCount();
}

function updateRenameCount() {
  const n = renameRows.filter((r) => r.box.checked && r.input.value.trim()).length;
  $("#rn-apply").textContent = `Rename ticked (${n})`;
  $("#rn-status").textContent = `${renameRows.length} route${renameRows.length === 1 ? "" : "s"}` +
    (renameRows.some((r) => !r.proposal) ? " · some routes have no places nearby (outside the GeoNames countries)" : "");
}

$("#rn-apply").addEventListener("click", async () => {
  const items = renameRows
    .filter((r) => r.box.checked && r.input.value.trim() && r.input.value.trim() !== r.name)
    .map((r) => ({ id: r.id, name: r.input.value.trim() }));
  if (!items.length) return;
  if (!confirm(`Rename ${items.length} route${items.length === 1 ? "" : "s"}? The current names are kept in the notes.`)) return;
  try {
    const res = await api("/api/rename/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    checked.clear();
    showView("library");
    await Promise.all([refresh(), loadFacets()]);
    $("#surface-job").textContent = `· renamed ${res.renamed} route${res.renamed === 1 ? "" : "s"}`;
  } catch (err) {
    $("#rn-status").textContent = `Error: ${err.message}`;
  }
});
$("#rn-back").addEventListener("click", () => showView("library"));
$("#rn-all").addEventListener("click", () => { renameRows.forEach((r) => (r.box.checked = !!r.input.value.trim())); updateRenameCount(); });
$("#rn-none").addEventListener("click", () => { renameRows.forEach((r) => (r.box.checked = false)); updateRenameCount(); });
$("#suggest-names").addEventListener("click", () => openRename(routes.map((r) => r.id)));
$("#sel-rename").addEventListener("click", () => openRename([...checked]));

// ------------------------------------------------------------------ start

restoreFilters();
updateDirectionLabels();
loadFacets().then(() => {
  const view = new URLSearchParams(location.hash.slice(1)).get("view");
  showView(["map", "import", "combine", "duplicates"].includes(view) ? view : "library");
  watchSurfaceJob();
  return loadRoutes();
});
api("/api/version").then((v) => ($("#version").textContent = `v${v.version}`)).catch(() => {});
