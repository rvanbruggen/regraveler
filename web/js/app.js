// rerouter, the static version: the UI of the server version, talking to the in-page service
// (js/service.js) instead of a JSON API. The library lives in the browser (IndexedDB).

import { addBackup, makeBackup, makeSelection, readBackup, restoreBackup } from "./backup.js";
import * as brouter from "./brouter.js";
import { USER_SETTINGS, VERSION, applySettings, config, defaultSetting, publicBRouter, useServerDefaults } from "./config.js";
import { Library } from "./db.js";
import { OSM_TAGS, isPlacesFileName, parsePlacesCsv, readPlacesFile, suggestCategory, waypointPlaces } from "./poi.js";
import { drawProfile, nearestIndex } from "./profile.js";
import { isTrackFileName } from "./trackfile.js";
import { LinkImportError, fetchRoute, parseRouteLink, serviceName } from "./linkimport.js";
import { RemoteBackend, detectServer } from "./remote.js";
import * as svc from "./service.js";
import * as weather from "./weather.js";
import { readZip } from "./zip.js";

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

/** Replace a node's children, skipping null / false ones (el() does that for its own children). */
const setChildren = (node, ...kids) => node.replaceChildren(...kids.flat().filter((c) => c !== null && c !== undefined && c !== false));

/** Let the browser paint (a status line) before a long computation starts. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** Save a Blob (or text) as a file. */
function downloadBlob(data, filename, type = "application/gpx+xml") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename.replace(/[\\/:*?"<>|]+/g, "_") });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const fmt = {
  km: (v) => (v == null ? "–" : `${v.toFixed(1)} km`),
  m: (v) => (v == null ? "–" : `${Math.round(v)} m`),
  pct: (v) => (v == null ? "–" : `${Math.round(v)}%`),
  stars: (v) => (v ? "★".repeat(v) + "☆".repeat(5 - v) : "–"),
  date: (v) => (v ? new Date(v).toLocaleDateString() : "–"),
};

// The library lives in this browser, or in the rerouter server that serves this page.
const onServer = () => config.MODE === "server";
// Safari (not the Chromium or Firefox browsers that also say "Safari" in their user agent)
// deletes a site's storage after 7 days of use without visiting the site.
const isSafari = () => /safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|fxios|edg|opr|android/i.test(navigator.userAgent);
/** What happens to the GPX files of removed routes. */
const filesFate = (n) => onServer()
  ? `${n === 1 ? "Its GPX file stays" : "Their GPX files stay"} in the server's GPX folder.`
  : `${n === 1 ? "Its GPX file is" : "Their GPX files are"} removed from this browser too.`;

const splitTags = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);

const ACTIVITY_LABELS = { gravel: "Gravel", road: "Road", mtb: "Mountain biking", hiking: "Hiking" };
const activityLabel = (a) => ACTIVITY_LABELS[a] || a || "–";
let activityProfiles = {};

/** Fill every activity <select> (class activity-select); data-any adds an empty first option. */
function fillActivitySelects(activities) {
  for (const sel of $$(".activity-select")) {
    const keep = sel.value;
    const any = sel.dataset.any;
    sel.replaceChildren(
      ...(any !== undefined ? [el("option", { value: "" }, any)] : []),
      ...activities.map((a) => el("option", { value: a }, activityLabel(a)))
    );
    if (keep && activities.includes(keep)) sel.value = keep;
    else sel.selectedIndex = 0; // "any" / "Set activity…", or the default activity
  }
}

// ------------------------------------------------------------------ tabs

let currentView = "library";

// Views reached through the Utilities menu.
const UTILITIES = ["combine", "restart", "weather", "link", "duplicates", "data"];
// Views a link (URL hash) can open.
const LINKABLE_VIEWS = ["library", "map", "places", "import", ...UTILITIES];

function showView(name) {
  currentView = name;
  $$("nav [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#utilities .menu-button").classList.toggle("active", UTILITIES.includes(name));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  // The filters apply to the library and the map, not to the import screen and the utilities.
  const noFilters = ["import", "rename", "places", ...UTILITIES].includes(name);
  $("#filters").hidden = noFilters;
  updateIdsNote();
  if (noFilters) closeDetail();
  if (name === "map") showOverview();
  if (name === "combine") showCombine();
  if (name === "restart") showRestart();
  if (name === "weather") showWeather();
  if (name === "duplicates") loadDuplicates();
  if (name === "data") showData();
  if (name === "places") renderPlaces();
  updateHash();
}
$$("nav [data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    toggleUtilities(false);
    showView(b.dataset.view);
  })
);

// Utilities dropdown
const utilitiesButton = $("#utilities .menu-button");
function toggleUtilities(open) {
  $("#utilities-menu").hidden = !open;
  utilitiesButton.setAttribute("aria-expanded", String(open));
}
utilitiesButton.addEventListener("click", () => {
  const open = $("#utilities-menu").hidden;
  toggleUtilities(open);
  if (open) $("#utilities-menu button").focus();
});
document.addEventListener("click", (e) => { if (!e.target.closest("#utilities")) toggleUtilities(false); });
$("#utilities").addEventListener("keydown", (e) => {
  const items = $$("#utilities-menu button");
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    toggleUtilities(false);
    utilitiesButton.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if ($("#utilities-menu").hidden) toggleUtilities(true);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});

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
    if (cb.mode !== "loop") p.set("pattern", cb.mode);
  }
  if (currentView === "restart" && rs.id) p.set("route", rs.id);
  if (currentView === "weather" && wx.id) {
    p.set("route", wx.id);
    if (wx.date) p.set("date", wx.date);
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
  const [f, cfg] = [svc.facets(), svc.clientConfig()];
  activityProfiles = cfg.activity_profiles || {};
  if (!$("#batch-activity").options.length) {
    fillActivitySelects(cfg.activities);
    filterForm.elements.activity.value = new URLSearchParams(location.hash.slice(1)).get("activity") || "";
  }
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
  // The library may have been reloaded (restore, clear, a set added): its places too.
  for (const e of layeredMaps) drawPlaces(e);
  if (currentView === "places") renderPlaces();
}

async function loadRoutes() {
  const params = filterParams();
  try {
    routes = svc.listRoutes(params);
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
  renderWelcome();
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
        el("td", {}, r.activity ? el("span", { class: `activity ${r.activity}` }, activityLabel(r.activity)) : "–"),
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
  if (n === 0) {
    toggleTagPanel(false);
    toggleExportPanel(false);
  }
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

$("#sel-download").addEventListener("click", async () => {
  const ids = [...checked];
  if (!ids.length) return;
  // One route: its original file; several: a zip of the original files.
  try {
    if (ids.length === 1) {
      const f = await svc.routeGpx(ids[0]);
      downloadBlob(f.data, f.filename);
    } else downloadBlob(await svc.exportZip(ids), "routes.zip");
  } catch (err) {
    alert(`Could not download: ${err.message}`);
  }
});

// A rerouter zip with the selected routes and their details, to add to another library
// (or to publish as an example set: web/data/seeds/).
function toggleExportPanel(open) {
  $("#export-panel").hidden = !open;
  $("#sel-export").setAttribute("aria-expanded", String(open));
  if (open) {
    toggleTagPanel(false);
    $("#export-status").textContent = "";
    $("#export-form").elements.title.focus();
  }
}

$("#sel-export").addEventListener("click", () => toggleExportPanel($("#export-panel").hidden));

$("#export-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ids = [...checked];
  if (!ids.length) return;
  const f = e.target.elements;
  const title = f.title.value.trim();
  const personal = !f.strip.checked;
  try {
    const blob = await makeSelection(svc.library(), ids, {
      title: title || null, description: f.description.value.trim() || null, personal, places: f.places.checked,
    });
    downloadBlob(blob, `rerouter-${svc.slugify(title || "routes")}.zip`);
    $("#export-status").textContent = `${ids.length} route${ids.length === 1 ? "" : "s"} exported` +
      (personal ? ", with your notes and ratings." : ", without your notes and ratings.");
  } catch (err) {
    $("#export-status").textContent = `Error: ${err.message}`;
  }
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
  if (!confirm(`Remove ${chosen.length} route${chosen.length === 1 ? "" : "s"} from the library?\n\n${names}\n\n${filesFate(chosen.length)}`)) return;
  try {
    await svc.deleteRoutes(chosen.map((r) => r.id));
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
  if (ids.length > 20 && publicBRouter() &&
      !confirm(`Estimate the surface of ${ids.length} routes? This asks the public BRouter server for every route, one after the other, and takes a while. Please don't do this for your whole library at once.`)) return;
  svc.surfaceJob.enqueue(ids, { force: true });
  watchSurfaceJob();
});

// Tags for the selected routes.

function toggleTagPanel(open) {
  $("#tag-panel").hidden = !open;
  $("#sel-tags").setAttribute("aria-expanded", String(open));
  if (open) {
    $("#export-panel").hidden = true;
    $("#sel-export").setAttribute("aria-expanded", "false");
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
    const res = await svc.changeTags(ids, add, remove);
    const what = add.length ? `added ${add.map((t) => `"${t}"`).join(", ")}` : `removed "${remove[0]}"`;
    await Promise.all([loadRoutes(), loadFacets()]); // keeps the selection (routes stay shown)
    $("#tag-status").textContent = `${what} · ${res.updated} route${res.updated === 1 ? "" : "s"} changed`;
    if (selectedId && checked.has(selectedId)) openDetail(selectedId);
  } catch (err) {
    $("#tag-status").textContent = `Error: ${err.message}`;
  }
}

$("#sel-tags").addEventListener("click", () => toggleTagPanel($("#tag-panel").hidden));

$("#sel-activity").addEventListener("change", async (e) => {
  const activity = e.target.value;
  const ids = [...checked];
  e.target.value = "";
  if (!activity || !ids.length) return;
  try {
    const res = await svc.setActivity(ids, activity);
    await loadRoutes();
    $("#surface-job").textContent = `· ${res.updated} route${res.updated === 1 ? "" : "s"} set to ${activityLabel(activity).toLowerCase()}`;
    if (selectedId && checked.has(selectedId)) openDetail(selectedId);
  } catch (err) {
    alert(`Could not change the activity: ${err.message}`);
  }
});
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
  const st = svc.surfaceJob.status();
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

// Map styles: every map gets a layer switcher with the styles and overlays of config.js. The
// choice is remembered in this browser and applied to all maps.
const MAP_STYLE_KEY = "rerouter.mapStyle";
const MAP_OVERLAYS_KEY = "rerouter.mapOverlays";
const layeredMaps = []; // { map, styles: {name: layer}, overlays: {name: layer} }

function readMapChoice() {
  let style = null;
  let overlays = [];
  try {
    style = localStorage.getItem(MAP_STYLE_KEY);
    overlays = JSON.parse(localStorage.getItem(MAP_OVERLAYS_KEY) || "[]");
  } catch { /* no storage: use the defaults */ }
  if (!config.MAP_STYLES.some((s) => s.name === style)) style = config.MAP_STYLES[0].name;
  if (!Array.isArray(overlays)) overlays = [];
  return { style, overlays: overlays.filter((n) => config.MAP_OVERLAYS.some((o) => o.name === n)) };
}

function saveMapChoice(choice) {
  try {
    localStorage.setItem(MAP_STYLE_KEY, choice.style);
    localStorage.setItem(MAP_OVERLAYS_KEY, JSON.stringify(choice.overlays));
  } catch { /* not important */ }
}

function tileLayer(def) {
  return L.tileLayer(def.url, {
    maxZoom: 19,
    maxNativeZoom: def.maxNativeZoom,
    subdomains: "abc",
    attribution: def.attribution,
  });
}

/** Show the chosen style and overlays on one map (without firing its switcher events). */
function applyMapChoice(entry, choice) {
  entry.applying = true;
  for (const [name, layer] of Object.entries(entry.styles)) {
    if (name === choice.style) { if (!entry.map.hasLayer(layer)) layer.addTo(entry.map); }
    else if (entry.map.hasLayer(layer)) entry.map.removeLayer(layer);
  }
  for (const [name, layer] of Object.entries(entry.overlays)) {
    if (choice.overlays.includes(name)) { if (!entry.map.hasLayer(layer)) layer.addTo(entry.map); }
    else if (entry.map.hasLayer(layer)) entry.map.removeLayer(layer);
  }
  entry.applying = false;
}

/** Add the base map and a layer switcher to a new map. */
function addMapLayers(map) {
  const entry = { map, styles: {}, overlays: {}, applying: false };
  for (const def of config.MAP_STYLES) entry.styles[def.name] = tileLayer(def);
  for (const def of config.MAP_OVERLAYS) entry.overlays[def.name] = tileLayer(def);
  applyMapChoice(entry, readMapChoice());
  const control = L.control.layers(entry.styles, entry.overlays, { position: "topright" }).addTo(map);
  // Your places (POIs), on every map; shown or hidden on all maps at once.
  entry.places = L.layerGroup();
  control.addOverlay(entry.places, "Places");
  entry.osm = L.layerGroup().addTo(map); // places from OpenStreetMap, when asked for
  if (placesShown()) entry.places.addTo(map);
  drawPlaces(entry);
  map.on("overlayadd overlayremove", (e) => {
    if (e.layer !== entry.places || entry.applying) return;
    setPlacesShown(e.type === "overlayadd");
  });
  const changed = () => {
    if (entry.applying) return;
    const choice = {
      style: Object.keys(entry.styles).find((n) => map.hasLayer(entry.styles[n])) || config.MAP_STYLES[0].name,
      overlays: Object.keys(entry.overlays).filter((n) => map.hasLayer(entry.overlays[n])),
    };
    saveMapChoice(choice);
    for (const other of layeredMaps) if (other !== entry) applyMapChoice(other, choice);
  };
  map.on("baselayerchange overlayadd overlayremove", changed);
  layeredMaps.push(entry);
}

function ensureMap() {
  if (map) return map;
  map = L.map("d-map");
  addMapLayers(map);
  map.on("mousemove", onDetailMapMove);
  map.on("mouseout", () => showProfilePoint(null, true));
  return map;
}

async function openDetail(id) {
  selectedId = id;
  $$("#routes tbody tr").forEach((tr) => tr.classList.toggle("selected", Number(tr.dataset.id) === id));
  const r = svc.library().get(id);
  if (!r) {
    alert("Route not found (it may have been removed).");
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
  f.activity.value = r.activity ?? "";
  f.paved_pct.value = r.paved_pct ?? "";
  detailRoute = r;
  renderSurface(r);
  f.tags.value = r.tags.join(", ");
  f.notes.value = r.notes ?? "";
  f.source_name.value = r.source_name ?? "";
  f.source_url.value = r.source_url ?? "";
  // TCX and FIT routes: "Download GPX" writes a GPX file; the original has its own button.
  $("#d-download").onclick = async (e) => {
    e.preventDefault();
    try {
      const f = await svc.routeAsGpx(r.id);
      downloadBlob(f.data, f.filename);
    } catch (err) {
      $("#d-status").textContent = `error: ${err.message}`;
    }
  };
  const original = $("#d-download-original");
  original.hidden = !svc.notGpx(r);
  original.textContent = `Original .${r.file_format || "gpx"}`;
  original.onclick = async (e) => {
    e.preventDefault();
    try {
      const f = await svc.routeGpx(r.id);
      downloadBlob(f.data, f.filename, "application/octet-stream");
    } catch (err) {
      $("#d-status").textContent = `error: ${err.message}`;
    }
  };
  const rides = r.rides || [];
  $("#d-rides").hidden = !rides.length;
  $("#d-rides").textContent = rides.length
    ? `Ridden ${rides.length === 1 ? "once" : `${rides.length} times`}: ${rides.map((x) => fmt.date(x.date)).join(", ")}`
    : "";
  $("#d-restart").hidden = !r.is_loop;
  $("#d-file").textContent =
    `File: ${r.original_filename}` + (r.track_name ? ` · track ${r.track_index + 1}: "${r.track_name}"` : "") +
    ` · imported ${fmt.date(r.imported_at)}`;
  const derived = $("#d-derived");
  derived.hidden = !r.derived_from.length;
  derived.replaceChildren();
  if (r.derived_from.length) {
    const parents = r.derived_from.map((pid) => svc.library().get(pid));
    derived.append(
      r.derived_from.length > 1 ? "Combined from: " : "Derived from: ",
      ...parents.flatMap((pr, i) => [
        i ? " + " : "",
        pr ? el("a", { class: "link", onclick: () => showRoute(pr.id) }, pr.name) : `#${r.derived_from[i]} (removed)`,
      ])
    );
  }

  drawDetailMap(r, true);

  loadProfile(r);
  loadPlacesAlong(r);
  offerRouteWaypoints(r);
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
  const estimateBtn = el("button", {
    type: "button", class: "secondary", onclick: () => estimateOne(r.id, false),
    title: "Matches the route to OpenStreetMap through the BRouter server (Utilities › Library & settings)",
  }, s ? "Estimate again" : "Estimate surface from OpenStreetMap");
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
  $("#d-surface-status").textContent = "estimating… (asking the BRouter server)";
  try {
    const r = await svc.estimateSurface(id, overwriteManual);
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

// ------------------------------------------------------------------ elevation profile

let profileChart = null; // {profile, chart} of the route in the detail panel
let profileMarker = null; // the position on the detail map while hovering the chart

function clearProfile() {
  profileChart?.chart.destroy();
  profileChart = null;
  profileMarker?.remove();
  profileMarker = null;
}

async function loadProfile(r) {
  const box = $("#d-profile");
  clearProfile();
  box.replaceChildren(el("div", { class: "muted small" }, "elevation profile…"));
  let profile;
  try {
    profile = await svc.routeProfile(r);
  } catch (err) {
    if (selectedId === r.id) box.replaceChildren(el("div", { class: "muted small" }, `elevation profile: ${err.message}`));
    return;
  }
  if (selectedId !== r.id) return;
  if (!profile) {
    box.replaceChildren(el("div", { class: "muted small" }, "No elevation in this file."));
    return;
  }
  box.replaceChildren();
  const chart = drawProfile(box, profile, { onHover: (i) => showProfilePoint(i, false) });
  profileChart = { profile, chart };
}

/** Show grid point `i` of the profile on the detail map (and on the chart when from the map). */
function showProfilePoint(i, fromMap) {
  if (!profileChart) return;
  if (fromMap) profileChart.chart.highlight(i);
  if (i == null) {
    profileMarker?.remove();
    profileMarker = null;
    return;
  }
  const ll = [profileChart.profile.lat[i], profileChart.profile.lon[i]];
  if (!profileMarker) {
    profileMarker = L.circleMarker(ll, { radius: 6, color: "#fff", weight: 2, fillColor: "#1a5fb4", fillOpacity: 1, interactive: false }).addTo(ensureMap());
  } else profileMarker.setLatLng(ll);
}

// Hovering near the route on the detail map shows that point on the chart.
let profileMoveQueued = null;
function onDetailMapMove(e) {
  if (!profileChart) return;
  const queued = !!profileMoveQueued;
  profileMoveQueued = e.latlng;
  if (queued) return;
  requestAnimationFrame(() => {
    const at = profileMoveQueued;
    profileMoveQueued = null;
    if (!profileChart || !at) return;
    const { index, metres } = nearestIndex(profileChart.profile, at.lat, at.lng);
    const m = ensureMap();
    // Within ~15 pixels of the route at the current zoom.
    const metresPerPixel = (40075016 * Math.cos((at.lat * Math.PI) / 180)) / 2 ** (m.getZoom() + 8);
    showProfilePoint(metres <= 15 * metresPerPixel ? index : null, true);
  });
}

// ------------------------------------------------------------------ places (POIs)

const PLACES_HIDDEN_KEY = "rerouter.hidePlaces";
const OSM_KINDS = Object.keys(OSM_TAGS);
const OTHER_CATEGORY = { id: "other", label: "Other", symbol: "📍", color: "#757575" };

function placesShown() {
  try {
    return localStorage.getItem(PLACES_HIDDEN_KEY) !== "1";
  } catch {
    return true;
  }
}

function setPlacesShown(on) {
  try {
    if (on) localStorage.removeItem(PLACES_HIDDEN_KEY);
    else localStorage.setItem(PLACES_HIDDEN_KEY, "1");
  } catch { /* private window: only for this page */ }
  for (const e of layeredMaps) {
    if (!e.places || e.map.hasLayer(e.places) === on) continue;
    e.applying = true;
    if (on) e.places.addTo(e.map);
    else e.places.remove();
    e.applying = false;
  }
}

const categoryOf = (id, cats = svc.placeCategories()) => cats.find((c) => c.id === id) || OTHER_CATEGORY;
const safeUrl = (u) => (u && /^https?:\/\//i.test(u) ? u : null);
const placeSymbol = (cat) => el("span", { class: "poi-sym", style: `background:${cat.color}` }, cat.symbol);

let editPlaceNext = null; // a place just added on the map opens in its editor

function drawPlaces(entry) {
  if (!entry.places) return;
  entry.places.clearLayers();
  if (!svc.library()) return;
  const cats = svc.placeCategories();
  for (const p of svc.visiblePlaces()) {
    const cat = categoryOf(p.category, cats);
    const icon = L.divIcon({
      className: "poi-icon", html: el("span", { style: `background:${cat.color}` }, cat.symbol),
      iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -11],
    });
    const marker = L.marker([p.lat, p.lon], { icon, title: p.name, riseOnHover: true });
    marker.placeId = p.id;
    marker.bindPopup(() => placePopup(p.id, marker));
    entry.places.addLayer(marker);
  }
}

/** Redraw the places everywhere after a change. */
function refreshPlaces() {
  for (const e of layeredMaps) drawPlaces(e);
  if (currentView === "places") renderPlaces();
  if (detailRoute && !detail.hidden) {
    loadPlacesAlong(detailRoute);
    if (osmShownFor === detailRoute.id) osmAlongRoute(detailRoute);
  }
}

/** The popup of a place: what it is, and an editor. */
function placePopup(id, marker) {
  const box = el("div", { class: "poi-popup" });
  // Buttons here replace the popup's content while they are clicked; the click must not reach
  // the map, which would take it (no longer inside the popup) for a click on the map and close it.
  const inPopup = (fn) => (e) => { e.stopPropagation(); fn(); };
  const p = svc.place(id);
  if (!p) return el("div", {}, "This place was removed.");
  const show = () => {
    const cat = categoryOf(p.category);
    const list = svc.library().getDoc("poi_list", p.list_id);
    const url = safeUrl(p.url);
    setChildren(box, 
      el("strong", {}, p.name),
      el("div", { class: "small muted" }, placeSymbol(cat), ` ${cat.label}`, list ? ` · ${list.name}` : ""),
      p.notes ? el("div", { class: "small", style: "white-space:pre-line;margin-top:4px" }, p.notes) : null,
      url ? el("div", { class: "small" }, el("a", { href: url, target: "_blank", rel: "noopener" }, "link ↗")) : null,
      el("div", { class: "actions" }, el("button", { type: "button", class: "secondary", onclick: inPopup(edit) }, "Edit")),
    );
  };
  const edit = () => {
    const cats = svc.placeCategories();
    const form = el("form", {},
      el("input", { name: "name", value: p.name, required: true, "aria-label": "Name" }),
      el("select", { name: "category", "aria-label": "Category" },
        cats.map((c) => el("option", { value: c.id, selected: c.id === p.category }, `${c.symbol} ${c.label}`))),
      el("textarea", { name: "notes", rows: 3, placeholder: "notes" }, p.notes || ""),
      el("input", { name: "url", type: "url", value: p.url || "", placeholder: "link (photo album, website)" }),
      el("div", { class: "actions" },
        el("button", { type: "submit" }, "Save"),
        el("button", { type: "button", class: "secondary", onclick: inPopup(show) }, "Cancel"),
        el("button", {
          type: "button", class: "danger",
          onclick: async () => {
            if (!confirm(`Remove the place "${p.name}"?`)) return;
            marker.closePopup();
            await svc.deletePlaces([p.id]);
            refreshPlaces();
          },
        }, "Remove")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      await svc.updatePlace(p.id, { name: f.name.value, category: f.category.value, notes: f.notes.value, url: f.url.value });
      marker.closePopup();
      refreshPlaces();
    });
    setChildren(box, form);
    setTimeout(() => form.elements.name.select(), 0);
  };
  if (editPlaceNext === id) {
    editPlaceNext = null;
    edit();
  } else show();
  return box;
}

// Adding a place: the ＋ Place button on the map, then a click where it is.
let addingPlace = null; // {map, button, handler}

function addPlaceControl(map) {
  const Control = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const b = el("button", { type: "button", class: "poi-add", title: "Add a place: click this, then on the map" }, "＋ Place");
      L.DomEvent.disableClickPropagation(b);
      b.addEventListener("click", () => (addingPlace ? stopAddingPlace() : startAddingPlace(map, b)));
      return b;
    },
  });
  new Control().addTo(map);
}

function startAddingPlace(map, button) {
  const handler = async (e) => {
    stopAddingPlace();
    const p = await svc.addPlace({ lat: e.latlng.lat, lon: e.latlng.lng });
    setPlacesShown(true);
    editPlaceNext = p.id;
    refreshPlaces();
    const entry = layeredMaps.find((x) => x.map === map);
    entry?.places.eachLayer((m) => m.placeId === p.id && m.openPopup());
  };
  addingPlace = { map, button, handler };
  button.classList.add("active");
  button.textContent = "Click on the map… (Esc)";
  map.getContainer().classList.add("adding-place");
  map.on("click", handler);
}

function stopAddingPlace() {
  if (!addingPlace) return;
  const { map, button, handler } = addingPlace;
  addingPlace = null;
  map.off("click", handler);
  button.classList.remove("active");
  button.textContent = "＋ Place";
  map.getContainer().classList.remove("adding-place");
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") stopAddingPlace(); });

// ---- places from OpenStreetMap

const osmOpts = () => ({ proxyUrl: onServer() ? new URL("api/overpass", document.baseURI).href : null });

/** Draw OpenStreetMap places on a map (as rings, to tell them from your own). */
function drawOsm(entry, found) {
  entry.osm.clearLayers();
  const cats = svc.placeCategories();
  for (const p of found) {
    const cat = categoryOf(p.category, cats);
    const icon = L.divIcon({
      className: "poi-icon osm", html: el("span", { style: `border-color:${cat.color}` }, cat.symbol),
      iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -11],
    });
    const marker = L.marker([p.lat, p.lon], { icon, title: `${p.name} (OpenStreetMap)` });
    marker.bindPopup(() => osmPopup(p, marker, entry));
    entry.osm.addLayer(marker);
  }
}

function osmPopup(p, marker, entry) {
  const cat = categoryOf(p.category);
  const box = el("div", { class: "poi-popup" });
  const url = safeUrl(p.url);
  setChildren(box,
    el("strong", {}, p.name),
    el("div", { class: "small muted" }, placeSymbol(cat), ` ${cat.label} · from OpenStreetMap`),
    p.notes ? el("div", { class: "small", style: "white-space:pre-line;margin-top:4px" }, p.notes) : null,
    el("div", { class: "small" },
      url && url !== p.osm_url ? [el("a", { href: url, target: "_blank", rel: "noopener" }, "website ↗"), " · "] : null,
      el("a", { href: p.osm_url, target: "_blank", rel: "noopener" }, "on OpenStreetMap ↗")),
    el("div", { class: "actions" }, el("button", {
      type: "button",
      onclick: async (e) => {
        e.stopPropagation();
        await svc.keepOsmPlace(p);
        entry.osm.removeLayer(marker);
        setPlacesShown(true);
        refreshPlaces();
      },
    }, "Keep as my place")));
  return box;
}

let osmShownFor = null; // the route whose OpenStreetMap places are in its panel
const osmSelected = new Set(); // osm ids ticked in the route panel
let osmKeepTarget = ""; // where "Keep selected" puts them: "" (From OpenStreetMap), a list id, or "new"
let osmKeepMessage = "";

/** "Also look on OpenStreetMap" in the route panel (again after a change: then from the cache). */
async function osmAlongRoute(r) {
  const link = $("#d-osm-link"), status = $("#d-osm-status");
  if (!link || !status) return;
  link.hidden = true;
  status.textContent = " asking OpenStreetMap… (this can take half a minute)";
  osmShownFor = r.id;
  let along;
  try {
    along = await svc.osmAlongRoute(r.id, osmOpts());
  } catch (err) {
    if (selectedId === r.id) {
      status.textContent = ` ${err.message}`;
      link.hidden = false;
      link.textContent = "Try OpenStreetMap again";
      osmShownFor = null;
    }
    return;
  }
  if (selectedId !== r.id) return;
  const cats = svc.placeCategories();
  status.textContent = along.length
    ? ` ${along.length} more on OpenStreetMap (rings on the map): tick the ones to keep, above the list.`
    : " nothing more on OpenStreetMap along this route.";
  const entry = layeredMaps.find((x) => x.map === ensureMap());
  drawOsm(entry, along.map((a) => a.place));
  const found = new Set(along.map((a) => a.place.osm_id));
  for (const id of [...osmSelected]) if (!found.has(id)) osmSelected.delete(id); // kept or gone
  const ul = $("#d-places");
  renderOsmTools(r, along);
  if (!along.length) return;
  if (ul.querySelector("li:not([data-kind])")?.textContent.startsWith("none")) ul.replaceChildren();
  for (const { place: p, km, off_m } of along) {
    ul.append(el("li", { "data-kind": "osm", "data-km": km },
      el("input", {
        type: "checkbox", class: "osm-pick", "data-osm": p.osm_id, checked: osmSelected.has(p.osm_id),
        title: "Select to keep as your place",
        onchange: (e) => {
          if (e.target.checked) osmSelected.add(p.osm_id);
          else osmSelected.delete(p.osm_id);
          updateOsmTools();
        },
      }),
      el("a", {
        title: "Show on the map",
        onclick: () => {
          const m = ensureMap();
          m.setView([p.lat, p.lon], Math.max(m.getZoom(), 15));
          entry.osm.eachLayer((mk) => mk.getLatLng().lat === p.lat && mk.getLatLng().lng === p.lon && mk.openPopup());
        },
      }, `km ${km.toFixed(1)} · `, placeSymbol(categoryOf(p.category, cats)), ` ${p.name}`),
      el("span", { class: "osm-badge", title: "From OpenStreetMap" }, "OSM"),
      off_m > 30 ? el("span", { class: "small" }, ` (${off_m} m from the route)`) : null));
  }
  // Riding order again, with your own places.
  const items = [...ul.children].sort((a, b) => Number(a.dataset.km ?? 0) - Number(b.dataset.km ?? 0));
  ul.replaceChildren(...items);
}

/**
 * Above the places along a route: select OpenStreetMap places (all, none, per category) and
 * keep the selection as your places in one go, into a list of your choice.
 */
function renderOsmTools(r, along) {
  $("#d-osm-tools")?.remove();
  if (!along.length && !osmKeepMessage) return;
  const cats = svc.placeCategories();
  const byCat = new Map();
  for (const a of along) byCat.set(a.place.category, [...(byCat.get(a.place.category) || []), a.place.osm_id]);
  const setAll = (ids, on) => {
    for (const id of ids) on ? osmSelected.add(id) : osmSelected.delete(id);
    for (const box of $$("#d-places .osm-pick")) box.checked = osmSelected.has(box.dataset.osm);
    updateOsmTools();
  };
  const lists = svc.placeLists().filter((l) => l.id !== "osm");
  const newName = r.name;
  if (osmKeepTarget && osmKeepTarget !== "new" && !lists.some((l) => l.id === osmKeepTarget)) osmKeepTarget = "";
  const target = el("select", { "aria-label": "Keep them in the list", onchange: (e) => (osmKeepTarget = e.target.value) },
    el("option", { value: "" }, "From OpenStreetMap"),
    lists.filter((l) => l.name !== newName).map((l) => el("option", { value: l.id, selected: osmKeepTarget === l.id }, l.name)),
    el("option", { value: "new", selected: osmKeepTarget === "new" }, lists.some((l) => l.name === newName) ? newName : `new list “${newName}”`));
  const keep = el("button", {
    type: "button", id: "d-osm-keep",
    onclick: async () => {
      const picked = along.map((a) => a.place).filter((p) => osmSelected.has(p.osm_id));
      if (!picked.length) return;
      keep.disabled = true;
      try {
        const res = await svc.keepOsmPlaces(picked, osmKeepTarget === "new" ? { listName: newName } : { listId: osmKeepTarget || null });
        osmKeepMessage = `Kept ${res.added} place${res.added === 1 ? "" : "s"} in “${res.list.name}”.`;
        osmSelected.clear();
        setPlacesShown(true);
        refreshPlaces(); // redraws the list; the kept ones are yours now
      } catch (err) {
        osmKeepMessage = `Error: ${err.message}`;
        keep.disabled = false;
        updateOsmTools();
      }
    },
  });
  const chips = [...byCat].sort((a, b) => b[1].length - a[1].length).map(([id, ids]) => {
    const c = categoryOf(id, cats);
    return el("button", {
      type: "button", class: "chip", title: `Select or unselect all ${ids.length} × ${c.label}`,
      onclick: () => setAll(ids, !ids.every((x) => osmSelected.has(x))),
    }, `${c.symbol} ${ids.length}`);
  });
  const tools = el("div", { id: "d-osm-tools", class: "osm-tools small" },
    along.length ? el("div", { class: "actions" },
      "Select: ", el("a", { class: "link", onclick: () => setAll(along.map((a) => a.place.osm_id), true) }, "all"),
      " · ", el("a", { class: "link", onclick: () => setAll([...osmSelected], false) }, "none"), " · ", ...chips) : null,
    along.length ? el("div", { class: "actions" }, keep, " into ", target) : null,
    el("div", { class: "muted", id: "d-osm-kept" }, osmKeepMessage));
  $("#d-places").before(tools);
  updateOsmTools();
}

function updateOsmTools() {
  const keep = $("#d-osm-keep");
  if (!keep) return;
  const n = [...$$("#d-places .osm-pick")].filter((b) => b.checked).length;
  keep.disabled = !n;
  keep.textContent = n ? `Keep ${n} selected as my places` : "Tick places to keep";
}

function addOsmControl(map) {
  const Control = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const b = el("button", { type: "button", class: "poi-add", title: "Look for places on OpenStreetMap in this part of the map" }, "OSM places here");
      L.DomEvent.disableClickPropagation(b);
      b.addEventListener("click", async () => {
        const entry = layeredMaps.find((x) => x.map === map);
        if (map.getZoom() < 12) {
          b.textContent = "Zoom in first";
          setTimeout(() => (b.textContent = "OSM places here"), 2500);
          return;
        }
        const bounds = map.getBounds();
        b.disabled = true;
        b.textContent = "Asking OpenStreetMap…";
        try {
          const found = await svc.osmInArea([bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()], osmOpts());
          drawOsm(entry, found);
          b.textContent = found.length ? `${found.length} found (rings)` : "Nothing found here";
        } catch (err) {
          b.textContent = "OpenStreetMap is busy";
          b.title = err.message;
        } finally {
          b.disabled = false;
          setTimeout(() => {
            b.textContent = "OSM places here";
            b.title = "Look for places on OpenStreetMap in this part of the map";
          }, 4000);
        }
      });
      return b;
    },
  });
  new Control().addTo(map);
}

/** Offer the waypoints in the route's own file as places, and places from OpenStreetMap. */
async function offerRouteWaypoints(r) {
  const more = $("#d-places-more");
  more.replaceChildren();
  layeredMaps.find((x) => x.map === ensureMap())?.osm.clearLayers();
  osmShownFor = null;
  osmSelected.clear();
  osmKeepMessage = "";
  $("#d-osm-tools")?.remove();
  const osmLink = el("a", { class: "link", id: "d-osm-link", title: `Look for ${svc.osmCategories().length} kinds of places (see the Places tab)` }, "Also look on OpenStreetMap");
  osmLink.addEventListener("click", () => osmAlongRoute(r));
  more.append(osmLink, el("span", { id: "d-osm-status", class: "muted" }));
  const wps = await svc.routeWaypoints(r);
  if (selectedId !== r.id || !wps.length) return;
  more.append(" · ", el("a", {
    class: "link",
    title: "The points of interest stored in this route's file",
    onclick: () => {
      placesImport = { parsed: waypointPlaces(wps, r.name), filename: r.original_filename || r.name };
      showView("places");
      renderPlacesPreview();
      $("#places-preview").scrollIntoView({ block: "start" });
    },
  }, `Add the ${wps.length} waypoint${wps.length === 1 ? "" : "s"} in its file to your places…`));
}

/** The places along the route in the route panel. */
function loadPlacesAlong(r) {
  const ul = $("#d-places");
  let along = [];
  try {
    along = svc.placesAlongRoute(r.id);
  } catch (err) {
    setChildren(ul, el("li", {}, `error: ${err.message}`));
    return;
  }
  const cats = svc.placeCategories();
  setChildren(ul, 
    ...(along.length
      ? along.map(({ place: p, km, off_m }) =>
          el("li", { "data-km": km },
            el("a", {
              title: "Show on the map",
              onclick: () => {
                const m = ensureMap();
                m.setView([p.lat, p.lon], Math.max(m.getZoom(), 15));
                layeredMaps.find((x) => x.map === m)?.places.eachLayer((mk) => mk.placeId === p.id && mk.openPopup());
              },
            }, `km ${km.toFixed(1)} · `, placeSymbol(categoryOf(p.category, cats)), ` ${p.name}`),
            off_m > 30 ? el("span", { class: "small" }, ` (${off_m} m from the route)`) : null))
      : [el("li", {}, svc.allPlaces().length
          ? `none within ${config.PLACES_NEAR_ROUTE_M} m`
          : "none yet (import or add places on the Places tab)")])
  );
}

// ---- the Places screen

let placesImport = null; // {parsed, filename} while the import preview is shown

async function openPlacesFile(file) {
  const status = $("#places-status");
  status.textContent = `reading ${file.name}…`;
  try {
    const parsed = await readPlacesFile(new Uint8Array(await file.arrayBuffer()), file.name);
    placesImport = { parsed, filename: file.name };
    status.textContent = "";
    renderPlacesPreview();
  } catch (err) {
    status.textContent = `${file.name}: ${err.message}`;
  }
}

function renderPlacesPreview() {
  const box = $("#places-preview");
  if (!placesImport) {
    box.hidden = true;
    setChildren(box, );
    return;
  }
  const { parsed, filename } = placesImport;
  const cats = svc.placeCategories();
  const total = parsed.layers.reduce((n, l) => n + l.places.length, 0);
  const rows = parsed.layers.map((layer) => {
    const sugg = {};
    for (const p of layer.places) {
      const id = suggestCategory(p, layer.name, cats);
      const label = id ? categoryOf(id, cats).label : `new: ${layer.name}`;
      sugg[label] = (sugg[label] || 0) + 1;
    }
    const summary = Object.entries(sugg).map(([k, n]) => (Object.keys(sugg).length > 1 ? `${n} ${k}` : k)).join(", ");
    // A layer of one place that is nothing we know (often a home address): left out unless ticked.
    const lonely = layer.places.length === 1 && !suggestCategory(layer.places[0], layer.name, cats);
    return {
      include: el("input", { type: "checkbox", checked: !lonely }),
      category: el("select", {},
        el("option", { value: "suggested" }, `suggested: ${summary}`),
        el("option", { value: "new" }, `new category “${layer.name}”`),
        cats.map((c) => el("option", { value: c.id }, `${c.symbol} ${c.label}`))),
      layer, lonely,
    };
  });
  const listName = el("input", { value: parsed.name || filename.replace(/\.\w+$/, ""), required: true });
  box.hidden = false;
  setChildren(box, 
    el("h3", {}, `${filename}: ${total} place${total === 1 ? "" : "s"} in ${parsed.layers.length} layer${parsed.layers.length === 1 ? "" : "s"}`),
    parsed.skipped ? el("p", { class: "small muted" }, `${parsed.skipped} line(s), area(s) or rows without coordinates left out: only points are places.`) : null,
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Import"), el("th", {}, "Layer"), el("th", {}, "Places"), el("th", {}, "Category"))),
      el("tbody", {}, rows.map((r) => el("tr", {},
        el("td", {}, r.include),
        el("td", {}, r.layer.name, r.lonely ? el("div", { class: "small muted" }, "one place, no known category (a home address?): left out unless you tick it") : null),
        el("td", {}, String(r.layer.places.length)),
        el("td", {}, r.category))))),
    el("div", { class: "actions" },
      el("label", {}, "Into the list ", listName),
      el("button", {
        type: "button",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const res = await svc.importPlaces(parsed, {
              listName: listName.value, source: filename,
              layers: rows.map((r) => ({ include: r.include.checked, category: r.category.value })),
            });
            $("#places-status").textContent = `Added ${res.added} place${res.added === 1 ? "" : "s"} to “${res.list.name}”` +
              (res.duplicates ? ` (${res.duplicates} already there)` : "") + ".";
            placesImport = null;
            renderPlacesPreview();
            refreshPlaces();
          } catch (err) {
            $("#places-status").textContent = `error: ${err.message}`;
            e.target.disabled = false;
          }
        },
      }, "Import"),
      el("button", { type: "button", class: "secondary", onclick: () => { placesImport = null; renderPlacesPreview(); } }, "Cancel")),
  );
}

function renderPlaces() {
  if (!svc.library()) return;
  const cats = svc.placeCategories();
  const lists = svc.placeLists();
  const all = svc.allPlaces();
  const countBy = (key) => all.reduce((m, p) => m.set(p[key], (m.get(p[key]) || 0) + 1), new Map());
  const perList = countBy("list_id"), perCat = countBy("category");

  $("#places-lists").replaceChildren(
    el("thead", {}, el("tr", {}, el("th", {}, "List"), el("th", {}, "Places"), el("th", {}, "Shown"), el("th", {}, ""))),
    el("tbody", {}, lists.length
      ? lists.map((l) => el("tr", {},
          el("td", {}, l.name, l.source ? el("div", { class: "small muted" }, l.source) : null),
          el("td", {}, String(perList.get(l.id) || 0)),
          el("td", {}, el("input", {
            type: "checkbox", checked: l.visible !== false, title: "Show on the maps and along the routes",
            onchange: async (e) => { await svc.setPlaceListVisible(l.id, e.target.checked); refreshPlaces(); },
          })),
          el("td", {}, el("a", {
            class: "link small",
            onclick: async () => {
              if (!confirm(`Remove the list “${l.name}” and its ${perList.get(l.id) || 0} places?`)) return;
              await svc.deletePlaceList(l.id);
              refreshPlaces();
            },
          }, "remove"))))
      : [el("tr", {}, el("td", { colspan: 4, class: "muted" }, "No places yet."))]));

  const builtIn = (c) => ["water", "toilet", "cafe", "food", "frituur", "bike", "station", "sight", "photo", "shelter", "lodging", "parking", "other"].includes(c.id);
  $("#places-cats").replaceChildren(
    el("tbody", {}, cats.map((c) => el("tr", {},
      el("td", {}, el("input", {
        class: "symbol-input", value: c.symbol, maxlength: 4, title: "Symbol on the map",
        onchange: async (e) => { await svc.saveCategory({ id: c.id, label: c.label, symbol: e.target.value.trim() || c.symbol }); refreshPlaces(); },
      })),
      el("td", {}, el("input", {
        value: c.label, "aria-label": "Category name",
        onchange: async (e) => { if (e.target.value.trim()) await svc.saveCategory({ id: c.id, label: e.target.value }); refreshPlaces(); },
      })),
      el("td", {}, el("input", {
        type: "color", value: c.color, title: "Colour",
        onchange: async (e) => { await svc.saveCategory({ id: c.id, label: c.label, color: e.target.value }); refreshPlaces(); },
      })),
      el("td", { class: "small muted" }, String(perCat.get(c.id) || 0)),
      el("td", {}, !builtIn(c) && !perCat.get(c.id)
        ? el("a", { class: "link small", onclick: async () => { await svc.deleteCategory(c.id); refreshPlaces(); } }, "remove")
        : ""))))
  );

  const osmCats = new Set(svc.osmCategories());
  $("#osm-cats").replaceChildren(...cats.filter((c) => OSM_KINDS.includes(c.id)).map((c) => el("label", { class: "check" },
    el("input", {
      type: "checkbox", checked: osmCats.has(c.id),
      onchange: async (e) => {
        if (e.target.checked) osmCats.add(c.id);
        else osmCats.delete(c.id);
        await svc.setOsmCategories([...osmCats]);
      },
    }), ` ${c.symbol} ${c.label}`)));

  // Filters keep their choice across redraws.
  const catSel = $("#places-cat-filter"), listSel = $("#places-list-filter");
  const keep = (sel, options) => {
    const v = sel.value;
    sel.replaceChildren(...options);
    if ([...sel.options].some((o) => o.value === v)) sel.value = v;
  };
  keep(catSel, [el("option", { value: "" }, "all categories"),
    ...cats.filter((c) => perCat.get(c.id)).map((c) => el("option", { value: c.id }, `${c.symbol} ${c.label} (${perCat.get(c.id)})`))]);
  keep(listSel, [el("option", { value: "" }, "all lists"),
    ...lists.map((l) => el("option", { value: l.id }, `${l.name} (${perList.get(l.id) || 0})`))]);
  renderPlacesTable();
  renderPlaceSets();
}

function renderPlacesTable() {
  const cats = svc.placeCategories();
  const q = $("#places-q").value.trim().toLowerCase();
  const cat = $("#places-cat-filter").value, list = $("#places-list-filter").value;
  const listName = new Map(svc.placeLists().map((l) => [l.id, l.name]));
  const all = svc.allPlaces();
  const shown = all.filter((p) =>
    (!cat || p.category === cat) && (!list || p.list_id === list) &&
    (!q || p.name.toLowerCase().includes(q) || (p.notes || "").toLowerCase().includes(q)));
  $("#places-count").textContent = shown.length === all.length ? `(${all.length})` : `(${shown.length} of ${all.length})`;
  const MAX = 500;
  setChildren($("#places-table"), 
    el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", {}, "Name"), el("th", {}, "Category"), el("th", {}, "List"), el("th", {}, ""))),
    el("tbody", {}, shown.slice(0, MAX).map((p) => el("tr", {},
      el("td", {}, placeSymbol(categoryOf(p.category, cats))),
      el("td", {}, p.name, p.notes ? el("div", { class: "small muted" }, p.notes.length > 80 ? `${p.notes.slice(0, 80)}…` : p.notes) : null),
      el("td", {}, el("select", {
        "aria-label": "Category",
        onchange: async (e) => { await svc.updatePlace(p.id, { category: e.target.value }); refreshPlaces(); },
      }, cats.map((c) => el("option", { value: c.id, selected: c.id === p.category }, c.label)))),
      el("td", { class: "small" }, listName.get(p.list_id) || ""),
      el("td", {},
        el("a", { class: "link small", onclick: () => showPlaceOnMap(p) }, "map"), " ",
        el("a", {
          class: "link small",
          onclick: async () => { if (confirm(`Remove “${p.name}”?`)) { await svc.deletePlaces([p.id]); refreshPlaces(); } },
        }, "remove"))))),
    shown.length > MAX ? el("tfoot", {}, el("tr", {}, el("td", { colspan: 5, class: "muted small" }, `… and ${shown.length - MAX} more: narrow the search`))) : null,
  );
}

// ---- example place sets: data/place-sets/index.json lists CSV files published with the site
// (the list is built by tools/build_place_sets.py; each set has a fixed category).

let placeSets = [];

async function loadPlaceSets() {
  try {
    const res = await fetch("data/place-sets/index.json", { cache: "no-cache" });
    placeSets = res.ok ? (await res.json()).sets || [] : [];
  } catch (_) {
    placeSets = [];
  }
  renderPlaceSets();
}

function renderPlaceSets() {
  const box = $("#place-sets");
  box.hidden = !placeSets.length;
  if (box.hidden) return;
  const status = box.querySelector(".seed-status");
  const cats = svc.library() ? svc.placeCategories() : [];
  box.querySelector(".seed-list").replaceChildren(...placeSets.map((s) => {
    const cat = categoryOf(s.category, cats);
    return el("div", { class: "seed" },
      el("div", {},
        el("p", {}, placeSymbol(cat), " ", el("strong", {}, s.title || s.file)),
        el("p", { class: "muted small" }, `${s.count} place${s.count === 1 ? "" : "s"} · ${cat.label}`)),
      el("button", { type: "button", class: "secondary", onclick: (e) => addPlaceSet(s, e.target, status) }, "Add"));
  }));
}

async function addPlaceSet(set, button, status) {
  button.disabled = true;
  status.textContent = `Adding “${set.title}”…`;
  try {
    const res = await fetch(`data/place-sets/${encodeURIComponent(set.file)}`);
    if (!res.ok) throw new Error(`could not download ${set.file} (${res.status})`);
    const parsed = parsePlacesCsv(await res.text(), set.file);
    const out = await svc.importPlaces(parsed, {
      listName: set.title, source: set.file,
      layers: parsed.layers.map(() => ({ include: true, category: set.category })),
    });
    status.textContent = out.added
      ? `Added ${out.added} place${out.added === 1 ? "" : "s"} to “${out.list.name}”` + (out.duplicates ? ` (${out.duplicates} already there).` : ".")
      : `“${out.list.name}” is already complete: nothing new to add.`;
    setPlacesShown(true);
    refreshPlaces();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

/** Show a place on the Map (its list is shown then too). */
async function showPlaceOnMap(p) {
  const list = svc.library().getDoc("poi_list", p.list_id);
  if (list && list.visible === false) await svc.setPlaceListVisible(list.id, true);
  setPlacesShown(true);
  showView("map");
  await showOverview();
  refreshPlaces();
  overview.map.setView([p.lat, p.lon], 16);
  layeredMaps.find((x) => x.map === overview.map)?.places.eachLayer((m) => m.placeId === p.id && m.openPopup());
}

for (const id of ["#places-q", "#places-cat-filter", "#places-list-filter"]) $(id).addEventListener("input", renderPlacesTable);
$("#places-file").addEventListener("change", async (e) => {
  if (e.target.files[0]) await openPlacesFile(e.target.files[0]);
  e.target.value = "";
});
{
  const drop = $("#places-drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = [...e.dataTransfer.files].find((f) => isPlacesFileName(f.name) || isTrackFileName(f.name));
    if (file) await openPlacesFile(file);
    else $("#places-status").textContent = "Drop a KML, KMZ or CSV file (or a GPX, TCX or FIT file with waypoints).";
  });
}
$("#places-cat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await svc.saveCategory({ label: f.label.value, symbol: f.symbol.value.trim() || null, color: f.color.value });
    e.target.reset();
    refreshPlaces();
  } catch (err) {
    $("#places-status").textContent = `error: ${err.message}`;
  }
});

async function loadSimilar(id) {
  const list = $("#d-similar");
  list.replaceChildren(el("li", {}, "checking…"));
  await nextFrame();
  try {
    const sims = svc.similarRoutes(id);
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
  clearProfile();
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
    activity: f.activity.value || undefined,
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
    const r = await svc.updateRoute(selectedId, body);
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
  if (!confirm(`Remove "${name}" from the library?\n\n${filesFate(1)}`)) return;
  try {
    await svc.deleteRoutes([selectedId]);
    closeDetail();
    await Promise.all([refresh(), loadFacets()]);
  } catch (err) {
    $("#d-status").textContent = `error: ${err.message}`;
  }
});

// ------------------------------------------------------------------ import

let pending = []; // [{name, path, size, data (bytes), folder, source_name, source_url, activity, tags}]

/**
 * Add files: route files (GPX, TCX, FIT, also .gz), zip files (their route files are added)
 * and files from folders.
 */
async function addFiles(fileList) {
  // diskPath: the file's path in the server's GPX folder, when it came from there.
  const add = (name, path, data, diskPath = null) => {
    if (pending.some((p) => p.path === path && p.size === data.length)) return;
    // Files in a subfolder: the subfolder's name is the default source name (like the CLI import).
    pending.push({ name, path, size: data.length, data, diskPath, folder: folderOf(path), source_name: "", source_url: "", activity: "", tags: "" });
  };
  const skipped = [];
  for (const item of fileList) {
    const file = item.file || item;
    const path = item.path || file.webkitRelativePath || file.name;
    const lower = file.name.toLowerCase();
    try {
      if (isTrackFileName(lower)) add(file.name, path, new Uint8Array(await file.arrayBuffer()), item.diskPath || null);
      else if (isPlacesFileName(lower) && !item.diskPath) {
        // A list of places (KML, KMZ, CSV): that's for the Places screen.
        showView("places");
        await openPlacesFile(file);
      }
      else if (lower.endsWith(".zip")) {
        for (const e of await readZip(await file.arrayBuffer())) {
          if (!isTrackFileName(e.name) || e.name.split("/").some((x) => x.startsWith("__MACOSX") || x.startsWith("._"))) continue;
          add(e.name.split("/").pop(), `${file.name.replace(/\.zip$/i, "")}/${e.name}`, e.data);
        }
      } else if (!file.name.startsWith(".")) skipped.push(file.name);
    } catch (err) {
      skipped.push(`${file.name} (${err.message})`);
    }
  }
  pending.sort((a, b) => svc.importOrder()(a.path, b.path));
  renderPending();
  if (skipped.length) $("#import-status").textContent += ` · skipped (not a GPX, TCX or FIT file): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`;
}

/** "Folder/Sub/route.gpx" -> "Sub" (the first folder below the chosen or dropped one). */
function folderOf(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 3 ? parts[1] : null;
}

/** Files from a drop, including the contents of dropped folders. */
async function droppedFiles(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: `${prefix}${file.name}` });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

function renderPending() {
  const table = $("#pending");
  table.hidden = pending.length === 0;
  $("#import-btn").disabled = pending.length === 0;
  $("#import-clear").hidden = pending.length === 0;
  $("#import-status").textContent = pending.length ? `${pending.length} file(s) ready` : "";
  $("#pending tbody").replaceChildren(
    ...pending.map((p, i) =>
      el("tr", {},
        el("td", { title: p.path }, p.name, p.folder ? el("div", { class: "muted small" }, `in ${p.folder}`) : null),
        el("td", {}, el("input", {
          value: p.source_name, list: "source-list", placeholder: p.folder ? `(batch value, or ${p.folder})` : "(batch value)",
          oninput: (e) => (p.source_name = e.target.value),
        })),
        el("td", {}, el("input", {
          type: "url", value: p.source_url, placeholder: "(batch value)",
          oninput: (e) => (p.source_url = e.target.value),
        })),
        el("td", {}, (() => {
          const sel = el("select", { onchange: (e) => (p.activity = e.target.value) },
            el("option", { value: "" }, "(batch value)"),
            ...[...$("#batch-activity").options].map((o) => el("option", { value: o.value }, o.textContent)));
          sel.value = p.activity;
          return sel;
        })()),
        el("td", {}, el("input", {
          value: p.tags, list: "tag-list", placeholder: "added to the batch tags",
          "aria-label": `Extra tags for ${p.name}`,
          oninput: (e) => (p.tags = e.target.value),
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
dropzone.addEventListener("drop", async (e) => addFiles(await droppedFiles(e.dataTransfer)));
$("#file-input").addEventListener("change", async (e) => { await addFiles([...e.target.files]); e.target.value = ""; });
$("#folder-input").addEventListener("change", async (e) => { await addFiles([...e.target.files]); e.target.value = ""; });
$("#import-clear").addEventListener("click", () => { pending = []; renderPending(); });

$("#import-btn").addEventListener("click", async () => {
  const batchSource = $("#batch-source-name").value.trim();
  const files = pending.map((p) => ({
    name: p.name,
    data: p.data,
    override: {
      // A subfolder's name is the source name, unless one is given for the batch or the file.
      source_name: p.source_name || (!batchSource && p.folder) || "",
      source_url: p.source_url, activity: p.activity, tags: p.tags,
    },
  }));
  $("#import-btn").disabled = true;
  $("#import-status").textContent = `importing ${pending.length} file(s)…`;
  try {
    const { results } = await svc.importFiles(files, {
      source_name: batchSource,
      source_url: $("#batch-source-url").value,
      activity: $("#batch-activity").value,
      tags: $("#batch-tags").value,
    }, (n, total, name) => ($("#import-status").textContent = `importing ${n + 1} of ${total}: ${name}…`));
    renderResults(results, $("#import-results"), files);
    const imported = pending;
    pending = [];
    renderPending();
    if (results.some((r) => r.routes.length)) requestPersistence();
    if (onServer()) {
      await ignoreSkippedDiskFiles(imported, results);
      checkDiskFiles();
    }
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

/**
 * The import results. `files` (the imported files, in the same order) lets recorded rides
 * that match a library route be logged on it or imported anyway.
 */
function renderResults(results, target = $("#import-results"), files = null) {
  const counts = results.reduce((c, r) => ((c[r.status] = (c[r.status] || 0) + 1), c), {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k === "ride" ? "recorded ride(s) of a route" : k}`).join(", ");
  const rides = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === "ride");
  const rideBoxes = new Map(); // result index -> the element with its buttons

  const logOne = async (r) => {
    await svc.logRide(r.ride.route_id, r.ride);
    rideBoxes.get(results.indexOf(r))?.replaceChildren("✓ Logged as ridden on ", routeLink(r.ride.route_id, r.ride.route_name),
      r.ride.date ? ` (${fmt.date(r.ride.date)})` : "");
  };
  const importOne = async (r, i) => {
    const box = rideBoxes.get(i);
    box.replaceChildren("importing…");
    const f = files[i];
    const { results: [res] } = await svc.importFiles([{ ...f, match_rides: false }], {
      source_name: $("#batch-source-name").value.trim(),
      source_url: $("#batch-source-url").value,
      activity: $("#batch-activity").value,
      tags: $("#batch-tags").value,
    });
    box.replaceChildren(res.routes.length ? "✓ Imported as " : `${res.status}: ${res.message}`,
      ...res.routes.flatMap((x, k) => [k ? ", " : "", routeLink(x.id, x.name)]));
    watchSurfaceJob();
    await Promise.all([refresh(), loadFacets()]);
  };
  const failed = (box) => (err) => box?.replaceChildren(`error: ${err.message}`);

  target.replaceChildren(el("div", {},
    el("h3", {}, `Import results: ${summary}`),
    rides.length > 1 && files
      ? el("p", { class: "actions" },
          el("button", {
            type: "button",
            onclick: async (e) => {
              e.target.disabled = true;
              for (const { r, i } of rides) if (rideBoxes.get(i)?.querySelector("button")) await logOne(r).catch(failed(rideBoxes.get(i)));
              await refresh();
            },
          }, `Log all ${rides.length} recorded rides as ridden`))
      : null,
    ...results.map((r, i) =>
      el("div", { class: `result ${r.status}` },
        el("strong", {}, r.filename), ` — ${r.status === "ride" ? "recorded ride" : r.status}`, r.message ? `: ${r.message}` : "",
        r.status === "ride" && files
          ? (() => {
              const box = el("div", { class: "actions" },
                el("span", { class: "small" },
                  r.ride.date ? `Ridden on ${fmt.date(r.ride.date)}, ` : "", `${fmt.km(r.ride.distance_km)} · `,
                  routeLink(r.ride.route_id, r.ride.route_name),
                  ` · ${Math.round(r.ride.on_route * 100)}% of the ride is on the route`),
                el("button", { type: "button", onclick: () => logOne(r).then(refresh).catch(failed(box)) }, "Log as ridden"),
                el("button", { type: "button", class: "secondary", onclick: () => importOne(r, i).catch(failed(box)) }, "Import as a new route"));
              rideBoxes.set(i, box);
              return box;
            })()
          : null,
        r.routes.length ? el("div", {}, "Created: ", r.routes.flatMap((x, i) => [i ? ", " : "", routeLink(x.id, x.name)])) : null,
        r.duplicates.length ? el("div", {}, "Already in library: ", r.duplicates.flatMap((x, i) => [i ? ", " : "", routeLink(x.id, x.name)])) : null,
        ...r.similar.map((s) =>
          el("div", { class: "warn" }, "⚠ ", routeLink(s.route_id, s.route_name),
            ` is very similar to `, routeLink(s.other_id, s.other_name), ` (${Math.round(s.overlap * 100)}% overlap)`))
      )
    )
  ));
}

// ------------------------------------------------------------------ import from a link

// The route being imported: {link, data (GPX bytes), filename, paved_pct}.
let linkRoute = null;

function resetLink(keepResults = false) {
  linkRoute = null;
  $("#link-details").hidden = true;
  $("#link-strava").hidden = true;
  $("#link-file").value = "";
  if (!keepResults) $("#link-results").replaceChildren();
}

/** Show the form for the route, pre-filled from what the link and the service tell. */
function showLinkDetails({ summary, activity = null, notes = "", pavedPct = null }) {
  const { link } = linkRoute;
  $("#link-summary").replaceChildren(...summary);
  $("#link-source-name").value = serviceName(link);
  $("#link-source-url").value = link.url;
  if (activity) $("#link-activity").value = activity;
  $("#link-tags").value = "";
  $("#link-notes").value = notes;
  $("#link-paved-row").hidden = pavedPct == null;
  $("#link-paved").checked = false;
  if (pavedPct != null) {
    $("#link-paved-text").textContent = `Use ${serviceName(link)}'s surface: ${pavedPct}% paved ` +
      "(otherwise rerouter estimates it from OpenStreetMap)";
  }
  $("#link-details").hidden = false;
}

$("#link-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  resetLink();
  const status = $("#link-status");
  let link;
  try {
    link = parseRouteLink($("#link-url").value);
    status.textContent = link.service === "web" ? `Fetching the file from ${serviceName(link)}…` : `Fetching the ${serviceName(link)} ${link.kind}…`;
    $("#link-fetch").disabled = true;
    // On a rerouter server, files other sites won't let the browser read are fetched by the server.
    const proxy = onServer() ? (url) => fetch(new URL(`api/fetch-gpx?url=${encodeURIComponent(url)}`, document.baseURI)) : null;
    const r = await fetchRoute(link, fetch, { proxy });
    linkRoute = { link, data: r.data, filename: r.filename, paved_pct: r.paved_pct };
    status.textContent = "";
    const facts = [r.distance_km != null ? fmt.km(r.distance_km) : null, r.tracks > 1 ? `${r.tracks} tracks` : null, `${r.points} points`];
    // A GPX file is named like any imported file (from its file name or track name).
    const name = link.service === "web" ? svc.routeName(r.filename, r.track_name, r.tracks, 0) : r.name;
    showLinkDetails({
      summary: [el("strong", {}, name), ` — ${facts.filter(Boolean).join(", ")}, from `,
        el("a", { href: link.url, target: "_blank", rel: "noopener" }, serviceName(link))],
      activity: r.activity, notes: r.description || "", pavedPct: r.paved_pct,
    });
  } catch (err) {
    if (!(err instanceof LinkImportError)) throw err;
    status.textContent = err.message;
    if (err.exportUrl) {
      // Strava: the user downloads the GPX, then picks the file here.
      linkRoute = { link };
      $("#link-strava-export").href = err.exportUrl;
      $("#link-strava").hidden = false;
    }
  } finally {
    $("#link-fetch").disabled = false;
  }
});

$("#link-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !linkRoute) return;
  linkRoute.data = new Uint8Array(await file.arrayBuffer());
  linkRoute.filename = file.name;
  $("#link-strava").hidden = true;
  $("#link-status").textContent = "";
  showLinkDetails({ summary: [el("strong", {}, file.name), " — the GPX from ",
    el("a", { href: linkRoute.link.url, target: "_blank", rel: "noopener" }, serviceName(linkRoute.link))] });
});

$("#link-cancel").addEventListener("click", () => {
  resetLink();
  $("#link-status").textContent = "";
});

$("#link-import").addEventListener("click", async () => {
  if (!linkRoute) return;
  const status = $("#link-status");
  const button = $("#link-import");
  button.disabled = true;
  status.textContent = "Importing…";
  try {
    const res = await svc.importGpx(linkRoute.data, linkRoute.filename, {
      source_name: $("#link-source-name").value.trim() || null,
      source_url: $("#link-source-url").value.trim() || null,
      activity: svc.checkActivity($("#link-activity").value),
      tags: splitTags($("#link-tags").value),
      notes: $("#link-notes").value.trim() || null,
    });
    const ids = res.routes.map((r) => r.id);
    if (ids.length && $("#link-paved").checked && linkRoute.paved_pct != null) {
      for (const id of ids) await svc.updateRoute(id, { paved_pct: linkRoute.paved_pct });
    } else if (ids.length && config.SURFACE_AUTO_ESTIMATE) {
      svc.surfaceJob.enqueue(ids);
      watchSurfaceJob();
    }
    if (ids.length) requestPersistence();
    status.textContent = "";
    renderResults([res], $("#link-results"));
    resetLink(true);
    $("#link-url").value = "";
    await Promise.all([refresh(), loadFacets()]);
  } catch (err) {
    status.textContent = `error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------------------ overview map

// Distinct colours that stay readable on OSM tiles. Yellow is reserved for shared stretches.
const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#0fa3b1", "#f032e6", "#9a6324", "#800000", "#000075"];
const SHARED_COLOR = "#ffcc00";
const FADED = { color: "#888", opacity: 0.25, weight: 2 };
const colorFor = (id) => PALETTE[id % PALETTE.length];

const overview = {
  map: null,
  loading: Promise.resolve(),
  routes: [], // from svc.mapRoutes
  byId: new Map(),
  lines: new Map(), // id -> L.Polyline
  pairs: [], // from svc.proximity
  selected: null, // selected route id
  activePair: null, // pair clicked in the list
  stale: true,
  lastFitKey: null,
  proxToken: 0,
};

function showOverview() {
  if (!overview.map) {
    const m = L.map("overview-map", { renderer: L.canvas({ tolerance: 6 }) }).setView([50.9, 4.5], 9);
    addMapLayers(m);
    // Shared stretches are drawn in their own pane, underneath the route lines.
    m.createPane("shared").style.zIndex = 390;
    overview.routeLayer = L.layerGroup().addTo(m);
    overview.proxLayer = L.layerGroup().addTo(m);
    overview.sharedRenderer = L.canvas({ pane: "shared" });
    m.on("click", () => { if (!addingPlace) clearFocus(); });
    addPlaceControl(m);
    addOsmControl(m);
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
    data = svc.mapRoutes(params);
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
    res = await svc.proximity(filterParams(), d);
  } catch (err) {
    if (err.superseded) return; // a newer request is on its way
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
  routes: [], // all routes, from svc.mapRoutes
  byId: new Map(),
  a: null,
  b: null,
  mode: "loop", // "outback" (out on A, back on B), "loop" (two crossings) or "open" (A then B)
  modeTouched: false, // pattern chosen by the user (otherwise picked from the routes' starts)
  points: { a1: null, a2: null, b1: null, b2: null }, // [lat, lon] each
  pointsTouched: false, // placed or moved by the user (not just suggested)
  placing: [], // point keys still to click, in order
  preview: null,
  token: 0,
  nameTouched: false,
  vias: [], // per connector: the id of a place it must pass, or null
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
    addMapLayers(m);
    cb.bgLayer = L.layerGroup().addTo(m);
    cb.routeLayer = L.layerGroup().addTo(m);
    cb.resultLayer = L.layerGroup().addTo(m);
    cb.markerLayer = L.layerGroup().addTo(m);
    m.on("click", (e) => { if (cb.placing.length) placeAt(e.latlng); });
    cb.map = m;
    const p = new URLSearchParams(location.hash.slice(1));
    const pattern = p.get("pattern") || (p.get("open") === "1" ? "open" : null);
    if (["outback", "loop", "open"].includes(pattern)) {
      setMode(pattern);
      cb.modeTouched = true;
    }
    cb.initial = { a: Number(p.get("a")) || null, b: Number(p.get("b")) || null };
  }
  setTimeout(() => cb.map.invalidateSize(), 0);
  if (!cb.loaded) cb.loading = loadCombineRoutes();
  return cb.loading;
}

async function loadCombineRoutes() {
  cb.loaded = true;
  try {
    cb.routes = svc.mapRoutes("", 15);
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
  cb.vias = [];
  stopPlacing();
  cb.preview = null;
  cb.nameTouched = false;
  cbEl.saved.textContent = "";
  syncSelects();
  // Connector profile that fits the activity (gravel -> gravel, road -> fastbike, mtb -> mtb,
  // hiking -> hiking-mountain).
  const acts = new Set([cb.a, cb.b].filter(Boolean).map((id) => cb.byId.get(id)?.activity));
  const profile = acts.size === 1 ? activityProfiles[[...acts][0]] : null;
  if (profile && [...cbEl.profile.options].some((o) => o.value === profile)) cbEl.profile.value = profile;
  updateHash();
  updateDirectionLabels();
  drawCombineRoutes();
  drawCombineResult();
  const lines = [cb.a, cb.b].filter(Boolean).map((id) => L.polyline(cb.byId.get(id).geometry));
  if (lines.length) cb.map.fitBounds(L.featureGroup(lines).getBounds(), { padding: [30, 30] });
  if (cb.a && cb.b) {
    // Routes that start in the same place: out on A, back on B; otherwise two crossings.
    if (!cb.modeTouched) setMode(startsNear(cb.a, cb.b) ? "outback" : "loop");
    updateHash();
    await suggestPoints();
  } else cbEl.status.textContent = cb.a ? "Now choose route B (or click it on the map)." : "Choose route A (or click it on the map).";
}

/** Do routes a and b start within 1 km of each other? */
function startsNear(a, b) {
  const [p, q] = [a, b].map((id) => cb.byId.get(id)?.geometry?.[0]);
  if (!p || !q) return false;
  const dy = (q[0] - p[0]) * 111320;
  const dx = (q[1] - p[1]) * 111320 * Math.cos((p[0] * Math.PI) / 180);
  return Math.hypot(dx, dy) <= 1000;
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
    const res = await svc.combineSuggest(cb.a, cb.b, cb.mode);
    const [pa, pb] = res.parts;
    cb.points = { a1: pa.start, a2: pa.end, b1: pb.start, b2: pb.end };
    // E.g. back on a loop B to its start = on to its end, "the other way round" to its start.
    if (!cbEl.revA.disabled) cbEl.revA.checked = !!pa.other_way;
    if (!cbEl.revB.disabled) cbEl.revB.checked = !!pb.other_way;
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
    closed: cb.mode !== "open",
    reverse: cbEl.rev.checked,
    profile: cbEl.profile.value,
    prefer_unpaved: cbEl.unpaved.checked,
    straight: cbEl.straight.checked,
    vias: cb.vias,
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
    res = await svc.combinePreview(combineRequest());
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

/** "Your ride": the combined route in words, step by step. */
function renderRide(res) {
  $("#cb-ride").hidden = !res;
  if (!res) return;
  const [pa, pb] = res.parts;
  const routeA = cb.byId.get(cb.a), routeB = cb.byId.get(cb.b);
  // Where a point lies on its route, in words: "the start", "km 37.6", ...
  const where = (route, km) => {
    const len = route?.distance_km ?? Infinity;
    if (km < 0.05) return route?.is_loop ? "the start/finish" : "the start";
    if (km > len - 0.05) return route?.is_loop ? "the start/finish" : "the end";
    return `km ${km.toFixed(1)}`;
  };
  const direction = (p, letter) => (p.with_route
    ? `in ${letter}'s own direction`
    : el("span", { class: "against" }, `against ${letter}'s direction (backwards)`));
  // A connector step: routed, a short straight join, or none at all (the points touch).
  const connector = (c, to, touching) => (!c ? null
    : !c.routed && c.distance_km < 0.03 && !c.via ? touching
    : `Connector to ${to}${c.via ? `, through ${c.via.name}` : ""}: ${fmt.km(c.distance_km)}` +
      `${c.routed ? ", routed along roads and paths" : ", joined in a straight line"}.`);
  const [c1, c2] = res.connectors;
  const steps = [
    [`Start at A1: ${where(routeA, pa.start_km)} of route A.`],
    [`Ride route A to A2 (${where(routeA, pa.end_km)}): ${fmt.km(pa.distance_km)}, `, direction(pa, "A"), "."],
    [connector(c1, `B1 (${where(routeB, pb.start_km)} of route B)`,
      `Switch to route B at B1 (${where(routeB, pb.start_km)} of route B): the routes touch there.`)],
    [`Ride route B to B2 (${where(routeB, pb.end_km)}): ${fmt.km(pb.distance_km)}, `, direction(pb, "B"), "."],
  ];
  if (cb.mode !== "open") {
    steps.push([connector(c2, "A1, where you started", "You're back at A1, where you started: no connector needed.")]);
  }
  steps.push([`${res.is_loop ? "A loop" : "Point to point"} of ${fmt.km(res.distance_km)} with ${fmt.m(res.elevation_gain_m)} of climbing.`]);
  $("#cb-steps").replaceChildren(...steps.map((parts) => el("li", {}, ...parts.filter((x) => x !== null && x !== ""))));
}

/** Per connector: ride it through one of your places (a café, water, a viewpoint, …). */
function renderVias(res) {
  const box = $("#cb-vias");
  box.hidden = !res || !svc.visiblePlaces().length;
  if (box.hidden) return box.replaceChildren();
  const cats = svc.placeCategories();
  setChildren(box, el("strong", {}, "Through a place"), ...res.connectors.map((c, k) => {
    const options = svc.placesForConnector(c.from, c.to);
    const chosen = cb.vias[k] ? svc.place(cb.vias[k]) : null;
    if (chosen && !options.some((o) => o.place.id === chosen.id)) options.unshift({ place: chosen, detour_km: null });
    const label = res.connectors.length > 1 ? (k === 0 ? "Connector 1 (to route B)" : "Connector 2 (back to A1)") : "Connector (to route B)";
    return el("label", {}, `${label}: `,
      el("select", {
        onchange: (e) => {
          cb.vias[k] = e.target.value || null;
          runPreview();
        },
      },
        el("option", { value: "" }, options.length ? "— straight to the next route —" : "— no places near this connector —"),
        options.map(({ place: p, detour_km }) => el("option", { value: p.id, selected: chosen?.id === p.id },
          `${categoryOf(p.category, cats).symbol} ${p.name}${detour_km != null ? ` (+${detour_km.toFixed(1)} km)` : ""}`))));
  }));
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
  renderRide(res);
  renderVias(res);
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
    cb.modeTouched = true;
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
    const res = await svc.combineSave(combineRequest({ name }));
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
    const f = await svc.combineGpx(combineRequest({ name }));
    downloadBlob(f.text, f.filename);
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

// ------------------------------------------------------------------ change start point (utility)
// A loop route ridden from a different point on the loop. The server cuts the full-resolution
// GPX track; here the start is placed on the (simplified) geometry and sent as [lat, lon].

const rs = {
  map: null, loaded: false, loading: null, initial: null,
  routes: [], byId: new Map(),
  id: null, route: null, cum: [], // chosen loop: detail, cumulative metres along its geometry
  start: null, preview: null, token: 0, nameTouched: false,
};
const rsEl = {
  route: $("#rs-route"), slider: $("#rs-slider"), km: $("#rs-km"), reverse: $("#rs-reverse"),
  status: $("#rs-status"), stats: $("#rs-stats"), save: $("#rs-save"), name: $("#rs-name"), saved: $("#rs-saved"),
};

function showRestart() {
  if (!rs.map) {
    const m = L.map("restart-map", { renderer: L.canvas({ tolerance: 6 }) }).setView([50.9, 4.5], 9);
    addMapLayers(m);
    rs.bgLayer = L.layerGroup().addTo(m);
    rs.routeLayer = L.layerGroup().addTo(m);
    rs.markerLayer = L.layerGroup().addTo(m);
    m.on("click", (e) => { if (rs.route) placeStart(e.latlng); });
    rs.map = m;
    rs.initial = Number(new URLSearchParams(location.hash.slice(1)).get("route")) || null;
  }
  setTimeout(() => rs.map.invalidateSize(), 0);
  if (!rs.loaded) rs.loading = loadRestartRoutes();
  return rs.loading;
}

async function loadRestartRoutes() {
  rs.loaded = true;
  try {
    rs.routes = svc.mapRoutes("loop=true", 15);
  } catch (err) {
    rsEl.status.textContent = `Error loading routes: ${err.message}`;
    rs.loaded = false;
    return;
  }
  rs.byId = new Map(rs.routes.map((r) => [r.id, r]));
  const sorted = [...rs.routes].sort((x, y) => x.name.localeCompare(y.name));
  rsEl.route.replaceChildren(
    el("option", { value: "" }, sorted.length ? "— choose a loop —" : "no loop routes in the library"),
    ...sorted.map((r) => el("option", { value: r.id }, `${r.name} (${fmt.km(r.distance_km)})`))
  );
  rs.bgLayer.clearLayers();
  for (const r of rs.routes) {
    L.polyline(r.geometry, { color: "#777", weight: 2, opacity: 0.35 })
      .bindTooltip(r.name, { sticky: true })
      .on("click", (e) => {
        if (r.id === rs.id) return; // clicks on the chosen loop place the start (map handler)
        L.DomEvent.stopPropagation(e);
        setRestartRoute(r.id);
      })
      .addTo(rs.bgLayer);
  }
  const initial = rs.initial;
  rs.initial = null;
  if (initial && rs.byId.has(initial)) return setRestartRoute(initial);
  if (rs.id && !rs.byId.has(rs.id)) return setRestartRoute(null); // removed meanwhile
  rsEl.route.value = rs.id ?? "";
  if (!rs.id && rs.routes.length) {
    rs.map.fitBounds(L.featureGroup(rs.bgLayer.getLayers()).getBounds(), { padding: [20, 20] });
  }
  renderRestart();
}

async function setRestartRoute(id) {
  rs.id = id || null;
  rs.route = null;
  rs.start = null;
  rs.preview = null;
  rs.nameTouched = false;
  rsEl.saved.textContent = "";
  rsEl.route.value = rs.id ?? "";
  updateHash();
  if (!rs.id) {
    renderRestart();
    rsEl.status.textContent = "Choose a loop route (or click one on the map).";
    return;
  }
  const r = svc.library().get(id);
  if (!r) {
    rsEl.status.textContent = "Route not found.";
    return;
  }
  if (rs.id !== id) return; // another route was chosen meanwhile
  rs.route = r;
  rs.cum = cumulativeMetres(r.geometry);
  rs.map.fitBounds([[r.min_lat, r.min_lon], [r.max_lat, r.max_lon]], { padding: [30, 30] });
  rs.map.getContainer().classList.add("placing");
  renderRestart();
  rsEl.status.textContent = "Click the new start on the loop (or use the slider).";
}

/** Cumulative distance in metres along a [lat, lon] polyline (local flat approximation). */
function cumulativeMetres(line) {
  const out = [0];
  for (let i = 1; i < line.length; i++) {
    const k = Math.cos((line[i][0] * Math.PI) / 180);
    const dy = (line[i][0] - line[i - 1][0]) * 110540;
    const dx = (line[i][1] - line[i - 1][1]) * k * 111320;
    out.push(out[i - 1] + Math.hypot(dx, dy));
  }
  return out;
}

/** The point at `at` metres along the chosen loop's geometry. */
function pointAlong(at) {
  const line = rs.route.geometry, cum = rs.cum;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < at) i++;
  const seg = cum[i] - cum[i - 1];
  const f = seg ? Math.max(0, Math.min(1, (at - cum[i - 1]) / seg)) : 0;
  return [line[i - 1][0] + f * (line[i][0] - line[i - 1][0]), line[i - 1][1] + f * (line[i][1] - line[i - 1][1])];
}

/** Metres along the chosen loop's geometry of the point on it nearest to [lat, lon]. */
function metresAlong(p) {
  const line = rs.route.geometry;
  let best = { d: Infinity, at: 0 };
  const k = Math.cos((p[0] * Math.PI) / 180);
  const toXY = (q) => [q[1] * k * 111320, q[0] * 110540];
  const [px, py] = toXY(p);
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toXY(line[i]), [bx, by] = toXY(line[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
    if (d < best.d) best = { d, at: rs.cum[i] + t * (rs.cum[i + 1] - rs.cum[i]) };
  }
  return best.at;
}

function placeStart(latlng) {
  const snap = snapToLine(rs.route.geometry, latlng);
  if (snap.d > MAX_SNAP_M) {
    rsEl.status.textContent = `That is ${(snap.d / 1000).toFixed(1)} km from the loop; click closer to it.`;
    return;
  }
  setStart(snap.p);
}

function setStart(p) {
  rs.start = p;
  const total = rs.cum[rs.cum.length - 1] || 1;
  rsEl.slider.value = Math.round((metresAlong(p) / total) * 1000);
  runRestartPreview();
}

function renderRestart() {
  const r = rs.route, res = rs.preview;
  rs.routeLayer.clearLayers();
  rs.markerLayer.clearLayers();
  rs.bgLayer.eachLayer((l) => l.setStyle({ opacity: r ? 0.2 : 0.35 }));
  rsEl.slider.disabled = !r;
  rsEl.reverse.disabled = !r;
  rsEl.stats.hidden = !res;
  rsEl.save.hidden = !res;
  if (!r) {
    rsEl.km.textContent = "";
    rs.map.getContainer().classList.remove("placing");
    return;
  }
  L.polyline(r.geometry, { color: COLOR_A, weight: 4, opacity: res ? 0.35 : 0.9 })
    .bindTooltip("Click to start here", { sticky: true })
    .on("click", (e) => { L.DomEvent.stopPropagation(e); placeStart(e.latlng); })
    .addTo(rs.routeLayer);
  if (res) {
    L.polyline(res.geometry, { color: COLOR_A, weight: 5, opacity: 0.9, interactive: false }).addTo(rs.routeLayer);
    // The first kilometre, so the riding direction is visible.
    const cum = cumulativeMetres(res.geometry);
    const n = Math.max(2, cum.findIndex((d) => d > 1000) + 1 || cum.length);
    L.polyline(res.geometry.slice(0, n), { color: "#2e7d32", weight: 7, opacity: 0.9, interactive: false })
      .bindTooltip("First kilometre").addTo(rs.routeLayer);
  }
  // Where the route started so far.
  L.circleMarker([r.start_lat, r.start_lon], { radius: 6, color: "#666", fillColor: "#fff", fillOpacity: 1, weight: 2 })
    .bindTooltip("Original start").addTo(rs.markerLayer);
  if (rs.start) {
    L.marker(rs.start, {
      draggable: true, zIndexOffset: 1000,
      icon: L.divIcon({ className: "cb-start", html: "Start", iconSize: [42, 20], iconAnchor: [21, 26] }),
    })
      .bindTooltip("New start (drag along the loop)")
      .on("dragend", (e) => placeStart(e.target.getLatLng()))
      .addTo(rs.markerLayer);
  }
  const total = r.distance_km;
  rsEl.km.textContent = res
    ? `${fmt.km(res.start_km)} of ${fmt.km(total)} along the original`
    : rs.start ? "" : "not placed yet";
  if (res) {
    const stats = [
      ["Distance", fmt.km(res.distance_km)],
      ["Elevation gain", fmt.m(res.elevation_gain_m)],
      ["Elevation loss", fmt.m(res.elevation_loss_m)],
      ["Starts at", res.start_place || fmt.km(res.start_km)],
      ["Direction", rsEl.reverse.checked ? "Reversed" : "As the original"],
    ];
    rsEl.stats.replaceChildren(...stats.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));
  }
}

function restartRequest(extra = {}) {
  return { route_id: rs.id, start: rs.start, reverse: rsEl.reverse.checked, ...extra };
}

async function runRestartPreview() {
  if (!rs.route || !rs.start) return renderRestart();
  const token = ++rs.token;
  rsEl.status.textContent = "Working…";
  renderRestart();
  let res;
  try {
    res = await svc.restartPreview(restartRequest());
  } catch (err) {
    if (token !== rs.token) return;
    rs.preview = null;
    renderRestart();
    rsEl.status.textContent = `Error: ${err.message}`;
    return;
  }
  if (token !== rs.token) return; // a newer preview is on its way
  rs.preview = res;
  rs.start = res.start; // snapped onto the full-resolution track
  if (!rs.nameTouched) {
    rsEl.name.value = `${rs.route.name} (start ${res.start_place || `km ${res.start_km.toFixed(1)}`})`;
  }
  rsEl.status.textContent = res.description;
  rsEl.saved.textContent = "";
  renderRestart();
}

rsEl.route.addEventListener("change", () => setRestartRoute(Number(rsEl.route.value) || null));
rsEl.slider.addEventListener("input", () => {
  // Move the marker while sliding; ask the server when the slider is released.
  if (!rs.route) return;
  rs.start = pointAlong((rsEl.slider.value / 1000) * rs.cum[rs.cum.length - 1]);
  rs.preview = null;
  renderRestart();
});
rsEl.slider.addEventListener("change", () => rs.route && runRestartPreview());
rsEl.reverse.addEventListener("change", runRestartPreview);
rsEl.name.addEventListener("input", () => (rs.nameTouched = true));

$("#rs-save-btn").addEventListener("click", async () => {
  const name = rsEl.name.value.trim();
  if (!name) return rsEl.name.focus();
  rsEl.saved.textContent = "saving…";
  try {
    const res = await svc.restartSave(restartRequest({ name }));
    rsEl.saved.replaceChildren("Saved as ", el("a", { onclick: () => { showView("library"); openDetail(res.id); } }, res.name));
    await Promise.all([refresh(), loadFacets()]);
    // Reload the list of loops (it now includes the new route); the chosen loop stays.
    rs.loaded = false;
    await showRestart();
  } catch (err) {
    rsEl.saved.textContent = `Error: ${err.message}`;
  }
});

$("#rs-download").addEventListener("click", async () => {
  const name = rsEl.name.value.trim() || rs.route.name;
  try {
    const f = await svc.restartGpx(restartRequest({ name }));
    downloadBlob(f.text, f.filename);
  } catch (err) {
    rsEl.saved.textContent = `Error: ${err.message}`;
  }
});

$("#d-restart").addEventListener("click", async () => {
  const id = selectedId;
  showView("restart");
  await rs.loading;
  if (rs.id !== id) await setRestartRoute(id);
});

// ------------------------------------------------------------------ ride weather

// The forecast along a route for a ride on a chosen day (js/weather.js does the sums). The
// calendar shows the daily forecast at the middle of the route for the days Open-Meteo covers;
// picking a day fetches the hourly forecast at points along the route.

const WIND_COLORS = { head: "#d62f4b", cross: "#e0a000", tail: "#2e7d32", calm: "#2f6fd6" };
const WIND_LABELS = { head: "Headwind", cross: "Crosswind", tail: "Tailwind", calm: "Calm" };
const WX_CACHE_MS = 30 * 60 * 1000; // forecasts are updated every hour or so

const wx = {
  map: null, loaded: false, loading: null, initial: null,
  routes: [], byId: new Map(),
  id: null, route: null, samples: null,
  daily: null, // {days, utcOffset, at (ms), routeId}
  date: null, hourly: null, // {samples, utcOffset, at, key}
  cache: new Map(), // "routeId|date" -> hourly, "daily|routeId" -> daily
  token: 0,
};
const wxEl = {
  route: $("#wx-route"), cal: $("#wx-cal"), time: $("#wx-time"), speed: $("#wx-speed"), reverse: $("#wx-reverse"),
  status: $("#wx-status"), advice: $("#wx-advice"), stats: $("#wx-stats"), legend: $("#wx-legend"),
  times: $("#wx-times"), npoints: $("#wx-npoints"),
};

/** A symbol for a WMO weather code (as Open-Meteo gives them). */
function weatherSymbol(code) {
  if (code == null) return "";
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 95) return "⛈️";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "❄️";
  if (code >= 80) return "🌦️";
  if (code >= 61) return "🌧️";
  if (code >= 51) return "🌦️";
  return "";
}

const fmtTemp = (t) => (t == null ? "–" : `${Math.round(t)} °C`);
const fmtHours = (h) => {
  const min = Math.round(h * 60);
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
};
/** "headwind 12 km/h", "tailwind 5 km/h" or "hardly any wind" for an average headwind component. */
const fmtHead = (h) => (Math.abs(h) < 2 ? "hardly any wind" : h > 0 ? `headwind ${Math.round(h)} km/h` : `tailwind ${Math.round(-h)} km/h`);

// The average speed is remembered per activity (in this browser).
const speedKey = (activity) => `rerouter.weatherSpeed.${activity || "gravel"}`;
function rememberedSpeed(activity) {
  try {
    const v = Number(localStorage.getItem(speedKey(activity)));
    if (v > 0) return v;
  } catch { /* storage not available: use the default */ }
  return config.WEATHER_SPEEDS[activity] ?? config.WEATHER_SPEEDS.gravel;
}
function rememberSpeed(activity, v) {
  try { localStorage.setItem(speedKey(activity), String(v)); } catch { /* not important */ }
}

function showWeather() {
  if (!wx.map) {
    const m = L.map("weather-map", { renderer: L.canvas({ tolerance: 6 }) }).setView([50.9, 4.5], 9);
    addMapLayers(m);
    wx.bgLayer = L.layerGroup().addTo(m);
    wx.routeLayer = L.layerGroup().addTo(m);
    wx.markerLayer = L.layerGroup().addTo(m);
    wx.map = m;
    const p = new URLSearchParams(location.hash.slice(1));
    wx.initial = { id: Number(p.get("route")) || null, date: p.get("date") };
  }
  setTimeout(() => wx.map.invalidateSize(), 0);
  if (!wx.loaded) wx.loading = loadWeatherRoutes();
  return wx.loading;
}

async function loadWeatherRoutes() {
  wx.loaded = true;
  try {
    wx.routes = svc.mapRoutes("", 15);
  } catch (err) {
    wxEl.status.textContent = `Error loading routes: ${err.message}`;
    wx.loaded = false;
    return;
  }
  wx.byId = new Map(wx.routes.map((r) => [r.id, r]));
  const sorted = [...wx.routes].sort((x, y) => x.name.localeCompare(y.name));
  wxEl.route.replaceChildren(
    el("option", { value: "" }, sorted.length ? "— choose a route —" : "no routes in the library"),
    ...sorted.map((r) => el("option", { value: r.id }, `${r.name} (${fmt.km(r.distance_km)})`))
  );
  wx.bgLayer.clearLayers();
  for (const r of wx.routes) {
    L.polyline(r.geometry, { color: "#777", weight: 2, opacity: 0.35 })
      .bindTooltip(r.name, { sticky: true })
      .on("click", () => { if (r.id !== wx.id) setWeatherRoute(r.id); })
      .addTo(wx.bgLayer);
  }
  const initial = wx.initial;
  wx.initial = null;
  if (initial?.id && wx.byId.has(initial.id)) return setWeatherRoute(initial.id, initial.date);
  if (wx.id && !wx.byId.has(wx.id)) return setWeatherRoute(null); // removed meanwhile
  wxEl.route.value = wx.id ?? "";
  if (!wx.id) {
    if (wx.routes.length) wx.map.fitBounds(L.featureGroup(wx.bgLayer.getLayers()).getBounds(), { padding: [20, 20] });
    wxEl.status.textContent = wx.routes.length ? "Choose a route (or click one on the map)." : "";
  }
}

async function setWeatherRoute(id, date = null) {
  wx.id = id || null;
  wx.route = null;
  wx.samples = null;
  wx.daily = null;
  wx.hourly = null;
  wx.date = date || wx.date;
  wxEl.reverse.checked = false;
  wxEl.route.value = wx.id ?? "";
  const token = ++wx.token;
  renderWeather();
  if (!wx.id) {
    wxEl.cal.hidden = true;
    wxEl.status.textContent = "Choose a route (or click one on the map).";
    updateHash();
    return;
  }
  const r = svc.library().get(id);
  if (!r) {
    wxEl.status.textContent = "Route not found.";
    return;
  }
  wx.route = r;
  wx.samples = weather.samplePoints(r.geometry);
  wxEl.npoints.textContent = wx.samples.length;
  wxEl.speed.value = rememberedSpeed(r.activity);
  wx.map.invalidateSize(); // the view may just have been shown
  wx.map.fitBounds([[r.min_lat, r.min_lon], [r.max_lat, r.max_lon]], { padding: [30, 30] });
  renderWeather();
  updateHash();
  wxEl.status.textContent = "Getting the forecast…";
  try {
    wx.daily = await cachedDaily(r.id, wx.samples[Math.floor(wx.samples.length / 2)]);
  } catch (err) {
    if (token !== wx.token) return;
    wxEl.cal.hidden = true;
    wxEl.status.textContent = `No forecast: ${err.message}.`;
    return;
  }
  if (token !== wx.token) return; // another route was chosen meanwhile
  const win = forecastDays();
  if (wx.date && !win.some((d) => d.date === wx.date && d.tmax != null)) {
    wxEl.status.textContent = `There is no forecast for ${fmtDay(wx.date)} (forecasts go up to 16 days ahead): pick a day in the calendar.`;
    wx.date = null;
    renderCalendar();
    updateHash();
    return;
  }
  renderCalendar();
  if (wx.date) return selectWeatherDate(wx.date);
  wxEl.status.textContent = "Pick the day of your ride in the calendar.";
}

async function cachedDaily(routeId, point) {
  const key = `daily|${routeId}`;
  const hit = wx.cache.get(key);
  if (hit && Date.now() - hit.at < WX_CACHE_MS) return hit;
  const res = { ...(await weather.fetchDaily(config.OPEN_METEO_URL, point)), at: Date.now() };
  wx.cache.set(key, res);
  return res;
}

async function cachedHourly(routeId, date) {
  const key = `${routeId}|${date}`;
  const hit = wx.cache.get(key);
  if (hit && Date.now() - hit.at < WX_CACHE_MS) return hit;
  // The day itself and the next (evening rides end after midnight), within the forecast.
  const last = forecastDays().filter((d) => d.tmax != null).at(-1).date;
  const end = weather.addDays(date, 1) > last ? last : weather.addDays(date, 1);
  const samples = wx.samples.map((s) => ({ ...s }));
  const res = { ...(await weather.fetchHourly(config.OPEN_METEO_URL, samples, date, end)), at: Date.now(), key };
  wx.cache.set(key, res);
  return res;
}

/** The forecast days, from today at the route. */
const forecastDays = () => wx.daily?.days ?? [];

const fmtDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** The calendar: whole weeks (Monday first) around the forecast days; other days can't be picked. */
function renderCalendar() {
  const days = forecastDays();
  if (!days.length) return;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = days[0].date, last = days.at(-1).date;
  const weekday = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
  const from = weather.addDays(first, -weekday(first));
  const to = weather.addDays(last, 6 - weekday(last));
  const month = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" });
  const months = month(first) === month(last) ? month(first) : `${month(first)} – ${month(last)}`;
  const cells = [];
  for (let date = from; date <= to; date = weather.addDays(date, 1)) {
    const d = byDate.get(date);
    const dayNum = Number(date.slice(8));
    if (!d || d.tmax == null) {
      const why = date < first ? "That day is past."
        : d ? "No forecast for this day yet." : "Forecasts go up to 16 days ahead; this day is further away.";
      cells.push(el("button", { type: "button", class: "wx-day off", disabled: true, title: why }, el("span", { class: "n" }, dayNum)));
      continue;
    }
    const title = `${fmtDay(date)}: ${Math.round(d.tmin)}–${Math.round(d.tmax)} °C, rain ${d.rain.toFixed(1)} mm` +
      `${d.prob != null ? ` (${d.prob}% chance)` : ""}, wind up to ${Math.round(d.wind)} km/h from ${weather.compass(d.dir)}`;
    const prob = d.prob ?? (d.rain > 0.2 ? 50 : 0);
    cells.push(el("button", {
      type: "button", class: `wx-day${date === wx.date ? " active" : ""}${date === first ? " today" : ""}`, title,
      style: `--rain:${Math.min(100, prob)}%`,
      onclick: () => selectWeatherDate(date),
    }, el("span", { class: "n" }, dayNum), el("span", { class: "sym" }, weatherSymbol(d.code)), el("span", { class: "t" }, `${Math.round(d.tmax)}°`)));
  }
  wxEl.cal.replaceChildren(
    el("div", { class: "wx-cal-head" }, el("strong", {}, months),
      el("span", { class: "muted small" }, "blue bar: chance of rain")),
    el("div", { class: "wx-grid" },
      ...["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((n) => el("span", { class: "wx-wd" }, n)),
      ...cells),
    el("p", { class: "muted small" }, "Forecasts reach 16 days ahead, so later days can't be picked yet."),
  );
  wxEl.cal.hidden = false;
}

async function selectWeatherDate(date) {
  if (!wx.route) return;
  wx.date = date;
  wx.hourly = null;
  renderCalendar();
  updateHash();
  const token = ++wx.token;
  wxEl.status.textContent = `Getting the forecast for ${fmtDay(date)}…`;
  renderWeather();
  let hourly;
  try {
    hourly = await cachedHourly(wx.route.id, date);
  } catch (err) {
    if (token !== wx.token) return;
    wxEl.status.textContent = `No forecast: ${err.message}.`;
    return;
  }
  if (token !== wx.token) return;
  wx.hourly = hourly;
  renderWeather();
}

/** The ride for the chosen day at `time` ("09:00"), in the chosen direction (or the other). */
function weatherRide(time = wxEl.time.value || "09:00", reverse = wxEl.reverse.checked) {
  const speed = Number(wxEl.speed.value);
  if (!(speed > 0) || !wx.hourly) return null;
  return weather.rideWeather({
    line: wx.route.geometry, samples: wx.hourly.samples, speed, reverse,
    start: weather.localToUnix(wx.date, time, wx.hourly.utcOffset),
  });
}

function renderWeather() {
  wx.routeLayer.clearLayers();
  wx.markerLayer.clearLayers();
  wx.bgLayer.eachLayer((l) => l.setStyle({ opacity: wx.route ? 0.15 : 0.35 }));
  const r = wx.route;
  const ride = r && wx.hourly ? weatherRide() : null;
  for (const e of [wxEl.stats, wxEl.legend, wxEl.times, wxEl.advice]) e.hidden = !ride;
  if (!r) return;
  if (!ride) {
    L.polyline(r.geometry, { color: COLOR_A, weight: 4, opacity: 0.8, interactive: false }).addTo(wx.routeLayer);
    return;
  }
  const s = ride.summary, off = wx.hourly.utcOffset;
  const time = (t) => weather.unixToLocalTime(t, off);

  // The route, coloured by the wind: a white casing so the colours read on any background.
  const path = wxEl.reverse.checked ? [...r.geometry].reverse() : r.geometry;
  L.polyline(path, { color: "#fff", weight: 9, opacity: 0.9, interactive: false }).addTo(wx.routeLayer);
  for (const st of ride.stretches) {
    L.polyline(st.line, { color: WIND_COLORS[st.effect], weight: 5, opacity: 0.95 })
      .bindTooltip(`${WIND_LABELS[st.effect]}${st.effect === "calm" ? "" : `: ${fmtHead(st.head)}`} · ${(st.m / 1000).toFixed(1)} km`, { sticky: true })
      .addTo(wx.routeLayer);
  }
  // Riding direction: small chevrons between the weather points.
  const pts = ride.points;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2];
    const deg = weather.bearing([a.lat, a.lon], [b.lat, b.lon]);
    L.marker(mid, {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: "wx-dir", html: `<span style="transform:rotate(${deg}deg)">▲</span>`, iconSize: [12, 12] }),
    }).addTo(wx.markerLayer);
  }
  // Wind arrows at the weather points: pointing where the wind blows to.
  for (const p of pts) {
    if (!p.w) continue;
    const w = p.w;
    const html = `<svg viewBox="0 0 24 24" style="transform:rotate(${(w.dir + 180) % 360}deg)"><path d="M12 1 L19 21 L12 16 L5 21 Z"/></svg><b>${Math.round(w.speed)}</b>`;
    const tip = `km ${(p.m / 1000).toFixed(1)} at ${time(p.time)}: ${fmtTemp(w.temp)}, ` +
      `${w.rain > 0.05 ? `rain ${w.rain.toFixed(1)} mm/h` : "dry"}${w.prob != null ? ` (${Math.round(w.prob)}% chance)` : ""}, ` +
      `wind ${Math.round(w.speed)} km/h from ${weather.compass(w.dir)}, gusts ${Math.round(w.gust ?? 0)} km/h ${weatherSymbol(w.code)}`;
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "wx-wind", html, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindTooltip(tip).addTo(wx.markerLayer);
  }
  const start = path[0], end = path.at(-1);
  L.marker(start, { zIndexOffset: 1000, icon: L.divIcon({ className: "cb-start", html: "Start", iconSize: [42, 20], iconAnchor: [21, 26] }) })
    .bindTooltip(`Start at ${time(s.start)}`).addTo(wx.markerLayer);
  if (!r.is_loop) {
    L.marker(end, { icon: L.divIcon({ className: "cb-start wx-finish", html: "Finish", iconSize: [42, 20], iconAnchor: [21, 26] }) })
      .bindTooltip(`Finish at ${time(s.end)}`).addTo(wx.markerLayer);
  }

  // The numbers.
  const share = (k) => `${Math.round(s.share[k] * 100)}%`;
  const rain = s.rainMm < 0.1 ? (s.rainProb >= 30 ? "probably dry" : "dry") : `${s.rainMm.toFixed(1)} mm`;
  const stats = [
    ["Ride", `${time(s.start)} → ${time(s.end)}`],
    ["Duration", fmtHours(s.hours)],
    ["Temperature", s.tempMin == null ? "–" : `${Math.round(s.tempMin)}–${Math.round(s.tempMax)} °C`],
    ["Rain on the way", rain],
    ["Chance of rain", s.rainProb == null ? "–" : `up to ${Math.round(s.rainProb)}%`],
    ["Wind", s.windMax == null ? "–" : `${Math.round(s.windMax)} km/h ${weather.compass(s.windDir)}`],
    ["Gusts", s.gustMax == null ? "–" : `up to ${Math.round(s.gustMax)} km/h`],
    ["Into the wind", `${s.headKm.toFixed(1)} km (${share("head")})`],
    ["Wind behind you", `${s.tailKm.toFixed(1)} km (${share("tail")})`],
    ["First half", fmtHead(s.firstHalfHead)],
    ["Second half", fmtHead(s.secondHalfHead)],
  ];
  wxEl.stats.replaceChildren(...stats.map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v))));

  wxEl.status.textContent = s.complete
    ? `${fmtDay(wx.date)}, starting at ${time(s.start)} at ${Number(wxEl.speed.value)} km/h.`
    : "The end of this ride is past the end of the forecast: the numbers only cover the part with a forecast.";

  // Would the other way round be easier?
  const other = weatherRide(undefined, !wxEl.reverse.checked);
  const better = other && weather.reverseAdvice(ride, other);
  wxEl.advice.hidden = !better;
  if (better) {
    const where = r.is_loop ? "" : " (starting at the other end)";
    wxEl.advice.replaceChildren(
      el("strong", {}, `Easier the other way round${where}. `),
      `${better.headKm.toFixed(1)} km into the wind instead of ${s.headKm.toFixed(1)} km; ` +
        `second half: ${fmtHead(better.secondHalfHead)} instead of ${fmtHead(s.secondHalfHead)}. `,
      el("button", { type: "button", class: "secondary", onclick: () => { wxEl.reverse.checked = !wxEl.reverse.checked; renderWeather(); } },
        wxEl.reverse.checked ? "Ride it the original way" : "Ride it the other way"),
    );
  }
  renderStartTimes();
}

/** The same ride at other start times: morning, midday, afternoon, evening. */
function renderStartTimes() {
  const current = wxEl.time.value;
  const off = wx.hourly.utcOffset;
  const rows = [];
  for (const t of weather.startTimes(6, 20, 2)) {
    const ride = weatherRide(t);
    if (!ride || !ride.summary.complete) continue;
    const s = ride.summary;
    const other = weatherRide(t, !wxEl.reverse.checked);
    const flip = other && weather.reverseAdvice(ride, other);
    const rain = s.rainMm < 0.1 ? `${Math.round(s.rainProb ?? 0)}%` : `${s.rainMm.toFixed(1)} mm`;
    rows.push(el("tr", {
      class: t === current ? "active" : null,
      title: `${t} → ${weather.unixToLocalTime(s.end, off)}${flip ? " · easier the other way round" : ""}`,
      onclick: () => { wxEl.time.value = t; renderWeather(); },
    },
    el("td", {}, t),
    el("td", {}, s.tempMin == null ? "–" : `${Math.round(s.tempMin)}–${Math.round(s.tempMax)}`),
    el("td", {}, rain),
    el("td", {}, `${s.headKm.toFixed(0)} km${flip ? " ⇄" : ""}`)));
  }
  $("tbody", wxEl.times).replaceChildren(...rows);
  wxEl.times.hidden = !rows.length;
}

wxEl.route.addEventListener("change", () => setWeatherRoute(Number(wxEl.route.value) || null));
wxEl.time.addEventListener("change", () => wx.hourly && renderWeather());
wxEl.speed.addEventListener("change", () => {
  const v = Number(wxEl.speed.value);
  if (!(v > 0)) {
    wxEl.status.textContent = "Fill in your average speed (km/h).";
    return;
  }
  if (wx.route) rememberSpeed(wx.route.activity, v);
  if (wx.hourly) renderWeather();
});
wxEl.reverse.addEventListener("change", () => wx.hourly && renderWeather());

$("#d-weather").addEventListener("click", async () => {
  const id = selectedId;
  showView("weather");
  await wx.loading;
  if (wx.id !== id) await setWeatherRoute(id);
});

// ------------------------------------------------------------------ duplicates

let dupData = null;

async function loadDuplicates() {
  $("#dup-status").textContent = "Looking for duplicates…";
  $("#dup-groups").replaceChildren();
  await nextFrame();
  try {
    dupData = svc.duplicates();
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
  if (!confirm(`Remove ${chosen.map((r) => `"${r.name}"`).join(", ")} from the library?\n\n${filesFate(chosen.length)}`)) return;
  try {
    await svc.deleteRoutes(chosen.map((r) => r.id));
  } catch (err) {
    alert(`Could not remove the routes: ${err.message}`);
    return;
  }
  await Promise.all([refresh(), loadFacets(), loadDuplicates()]);
}

async function ignoreDuplicates(ids) {
  await svc.ignoreDuplicates(ids);
  await loadDuplicates();
}

function showOnMap(ids) {
  state.ids = ids;
  showView("map");
  refresh();
}

$("#dup-reset").addEventListener("click", async () => {
  if (!confirm('Show all groups and variants again, including the ones you marked as "not duplicates"?')) return;
  await svc.resetIgnoredDuplicates();
  await loadDuplicates();
});

// ------------------------------------------------------------------ rename

let renameRows = []; // [{id, name, proposal, input, box}]

async function openRename(ids) {
  showView("rename");
  const tbody = $("#rn-table tbody");
  tbody.replaceChildren();
  $("#rn-status").textContent = "Looking up the places each route visits…";
  let proposals;
  try {
    proposals = await svc.renameProposals(ids, (n, total) => ($("#rn-status").textContent = `Looking up the places each route visits… ${n + 1} of ${total}`));
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
    (renameRows.some((r) => !r.proposal) ? " · some routes have no places nearby (outside Belgium, the Netherlands, Luxembourg, Germany, France, Italy and Romania)" : "");
}

$("#rn-apply").addEventListener("click", async () => {
  const items = renameRows
    .filter((r) => r.box.checked && r.input.value.trim() && r.input.value.trim() !== r.name)
    .map((r) => ({ id: r.id, name: r.input.value.trim() }));
  if (!items.length) return;
  if (!confirm(`Rename ${items.length} route${items.length === 1 ? "" : "s"}? The current names are kept in the notes.`)) return;
  try {
    const res = await svc.renameApply(items);
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

// ------------------------------------------------------------------ welcome, backups, settings

function renderWelcome() {
  const empty = svc.library().all().length === 0;
  $("#welcome").hidden = !empty;
  $(".table-head").hidden = empty;
  $("#view-library .table-wrap").hidden = empty;
  $("#welcome-safari").hidden = onServer() || !isSafari();
  const last = svc.library().settings.last_backup_at;
  const note = $("#backup-note");
  // Safari may delete the library after a week without a visit: remind sooner there.
  const days = isSafari() ? 7 : 30;
  const stale = !last || Date.now() - new Date(last).getTime() > days * 86400e3;
  // On a server the data is in its own folders (back those up as you do your server).
  note.hidden = empty || !stale || onServer();
  note.replaceChildren(
    last ? `Your last backup is from ${fmt.date(last)}. ` : "Your routes are only stored in this browser. ",
    el("a", { class: "link", onclick: () => showView("data") }, "Download a backup"),
    " to keep them safe, or to move them to another device.");
}
$("#welcome-import").addEventListener("click", () => showView("import"));
$("#welcome-restore").addEventListener("click", () => showView("data"));

/** Ask the browser to keep our storage when space runs low (not evicted automatically). */
async function requestPersistence() {
  if (onServer()) return;
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (_) {}
}

async function showData() {
  const lib = svc.library();
  const routes = lib.all();
  const km = routes.reduce((s, r) => s + r.distance_km, 0);
  $("#data-count").textContent = `${routes.length} route${routes.length === 1 ? "" : "s"}, ${Math.round(km)} km`;
  const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
  $$(".site-host").forEach((e) => (e.textContent = location.host || "this site"));
  $("#data-where-note").hidden = !onServer();
  if (onServer()) {
    $("#data-where").textContent = "Your library lives on the rerouter server that serves this page";
    $("#data-where-note").textContent = "The routes are in its database (the data/ folder) and the original GPX files in its gpx/ folder. " +
      "A backup zip moves the library to another server or to the browser version.";
    $("#data-usage").textContent = "";
    $("#data-persist").textContent = "";
  } else try {
    const est = await navigator.storage?.estimate?.();
    $("#data-usage").textContent = est ? `(using ${mb(est.usage || 0)} of the ${mb(est.quota || 0)} this browser allows)` : "";
    const persisted = await navigator.storage?.persisted?.();
    $("#data-persist").replaceChildren(persisted
      ? "✓ The browser has agreed to keep this storage (it won't be cleared to free up space)."
      : el("span", {}, "The browser may clear this storage when space runs low. ",
          el("a", { class: "link", onclick: async () => { await requestPersistence(); showData(); } }, "Ask it to keep it")));
  } catch (_) {
    $("#data-usage").textContent = "";
  }
  const last = lib.settings.last_backup_at;
  $("#data-last-backup").textContent = last ? `Last backup: ${new Date(last).toLocaleString()}` : `No backup made yet${onServer() ? "" : " in this browser"}.`;
  const f = $("#settings-form").elements;
  f.BROUTER_URL.value = lib.settings.BROUTER_URL || "";
  f.BROUTER_URL.placeholder = defaultSetting("BROUTER_URL");
  f.AUTO_RENAME_ON_IMPORT.checked = config.AUTO_RENAME_ON_IMPORT;
  f.SURFACE_AUTO_ESTIMATE.checked = config.SURFACE_AUTO_ESTIMATE;
  f.PROXIMITY_DISTANCE_M.value = config.PROXIMITY_DISTANCE_M;
}

$("#data-backup").addEventListener("click", async () => {
  const status = $("#data-status");
  status.textContent = "Packing the backup…";
  try {
    const blob = await makeBackup(svc.library());
    const day = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `rerouter-backup-${day}.zip`);
    await svc.library().setSetting("last_backup_at", new Date().toISOString());
    status.textContent = `Backup downloaded (${(blob.size / 1e6).toFixed(1)} MB).`;
    renderWelcome();
    showData();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

$("#data-restore").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("#data-status");
  try {
    status.textContent = "Reading the backup…";
    const buffer = new Uint8Array(await file.arrayBuffer());
    const data = await readBackup(buffer);
    // A set of routes (not a whole library) is added rather than restored.
    if (data.kind === "selection") return await addRoutes(data, status);
    const n = svc.library().all().length;
    const msg = `Restore ${data.routes.length} route${data.routes.length === 1 ? "" : "s"} from this backup` +
      (data.created_at ? ` (made ${new Date(data.created_at).toLocaleString()})` : "") + "?" +
      (n ? `\n\nThis REPLACES the ${n} route${n === 1 ? "" : "s"} now in ${onServer() ? "the library on the server" : "this browser"}.` : "");
    if (!confirm(msg)) return (status.textContent = "");
    status.textContent = "Restoring…";
    await restoreBackup(svc.library(), buffer);
    await afterLibraryChange();
    requestPersistence();
    status.textContent = `Restored ${data.routes.length} routes.`;
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

$("#data-add").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("#data-status");
  try {
    status.textContent = "Reading the zip…";
    await addRoutes(await readBackup(new Uint8Array(await file.arrayBuffer())), status);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

/** Add the routes of a backup or an exported set to the library (after asking). */
async function addRoutes(data, status, { ask = true } = {}) {
  const n = data.routes.length;
  const what = `${n} route${n === 1 ? "" : "s"}${data.title ? ` ("${data.title}")` : ""}`;
  if (ask && !confirm(`Add ${what} to ${onServer() ? "the library on the server" : "your library"}?\n\n` +
    "The routes already in the library stay; routes it already has are skipped.")) return (status.textContent = "");
  status.textContent = "Adding the routes…";
  const res = await addBackup(svc.library(), data);
  await afterLibraryChange();
  requestPersistence();
  status.textContent = `Added ${res.added} route${res.added === 1 ? "" : "s"}` +
    (res.skipped ? ` (${res.skipped} already in the library)` : "") +
    (res.places ? ` and ${res.places} place${res.places === 1 ? "" : "s"}` : "") + ".";
  return res;
}

// ------------------------------------------------------------------ example routes

// Sets of routes published with the site: data/seeds/index.json lists the zips in data/seeds/
// (made with "Export set…"; the list is built by tools/build_seeds.py).
let seeds = [];

async function loadSeeds() {
  try {
    const res = await fetch("data/seeds/index.json", { cache: "no-cache" });
    if (res.ok) seeds = (await res.json()).seeds || [];
  } catch (_) {
    seeds = [];
  }
  renderSeeds();
}

function renderSeeds() {
  $("#welcome-seeds").hidden = !seeds.length;
  $("#data-seeds").hidden = !seeds.length;
  for (const box of [$("#welcome-seeds"), $("#data-seeds")]) {
    const status = box.querySelector(".seed-status");
    box.querySelector(".seed-list").replaceChildren(...seeds.map((s) =>
      el("div", { class: "seed" },
        el("div", {},
          el("p", {}, el("strong", {}, s.title || s.file)),
          el("p", { class: "muted small" }, [
            `${s.routes} route${s.routes === 1 ? "" : "s"}`,
            s.km ? `${Math.round(s.km)} km` : null,
            s.description || null,
          ].filter(Boolean).join(" · "))),
        el("button", { type: "button", class: "secondary", onclick: (e) => loadSeed(s, e.target, status) }, "Add"))));
  }
}

async function loadSeed(seed, button, status) {
  button.disabled = true;
  try {
    status.textContent = `Loading "${seed.title || seed.file}"…`;
    const res = await fetch(`data/seeds/${encodeURIComponent(seed.file)}`);
    if (!res.ok) throw new Error(`could not download ${seed.file} (${res.status})`);
    const data = await readBackup(new Uint8Array(await res.arrayBuffer()));
    await addRoutes(data, status, { ask: false });
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

$("#data-clear").addEventListener("click", async () => {
  const n = svc.library().all().length;
  if (!confirm(onServer()
    ? `Remove all ${n} routes from the library on the server? The GPX files stay in its GPX folder. This cannot be undone.`
    : `Remove all ${n} routes and their GPX files from this browser? This cannot be undone.`)) return;
  if (!confirm("Really remove everything? Download a backup first if you might want the routes back.")) return;
  await svc.library().clear();
  await afterLibraryChange();
  $("#data-status").textContent = "Everything was removed.";
});

/** Reload everything after the whole library changed (restore, clear). */
async function afterLibraryChange() {
  svc.setLibrary(svc.library());
  applySettings(svc.library().settings);
  checked.clear();
  state.ids = [];
  closeDetail();
  cb.a = cb.b = null;
  rs.id = null;
  rs.loaded = false;
  await Promise.all([refresh(), loadFacets()]);
  showData();
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const lib = svc.library();
  const url = f.BROUTER_URL.value.trim();
  if (url && !/^https?:\/\//.test(url)) {
    $("#settings-status").textContent = "The BRouter server needs an address starting with http:// or https://";
    return;
  }
  const values = {
    BROUTER_URL: url,
    AUTO_RENAME_ON_IMPORT: f.AUTO_RENAME_ON_IMPORT.checked,
    SURFACE_AUTO_ESTIMATE: f.SURFACE_AUTO_ESTIMATE.checked,
    PROXIMITY_DISTANCE_M: Number(f.PROXIMITY_DISTANCE_M.value) || defaultSetting("PROXIMITY_DISTANCE_M"),
  };
  for (const key of Object.keys(USER_SETTINGS)) await lib.setSetting(key, values[key]);
  applySettings(lib.settings);
  $("#prox-distance").value = config.PROXIMITY_DISTANCE_M;
  $("#settings-status").textContent = "Saved.";
});

$("#settings-test").addEventListener("click", async () => {
  const status = $("#settings-status");
  const url = $("#settings-form").elements.BROUTER_URL.value.trim() || defaultSetting("BROUTER_URL");
  status.textContent = `Asking ${url} for a short route…`;
  try {
    // Two points in Antwerp, 1.5 km apart.
    const pts = await brouter.route([51.2194, 4.4025], [51.2108, 4.4215], "trekking", null, url.replace(/\/+$/, "").replace(/\/brouter$/, ""));
    status.textContent = `✓ The BRouter server works (${pts.length} points in the test route).`;
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
  }
});

// ------------------------------------------------------------------ server mode

function renderServerMode(info) {
  $("#version").textContent = `v${info.version || VERSION}`;
  // The notes about browser storage don't apply on a server.
  $$(".browser-only").forEach((e) => (e.hidden = true));
  $("#welcome-where").textContent = "The routes are stored on this rerouter server: its database in data/ and " +
    "the original GPX files in its gpx/ folder, which is never modified. GPX files already in that folder can be " +
    "added from the Import screen.";
  $("#welcome-restore").textContent = "Restore a backup";
  $("footer").textContent = "rerouter on your own server. Maps © OpenStreetMap contributors · routing by BRouter · " +
    "place names by GeoNames · weather by Open-Meteo";
}

/**
 * Files from the server's GPX folder that were skipped (a duplicate of a route in the library,
 * or not a usable GPX file) are not offered again.
 */
async function ignoreSkippedDiskFiles(imported, results) {
  const skipped = imported
    .map((p, i) => ({ p, r: results[i] }))
    .filter(({ p, r }) => p.diskPath && r && (r.status === "duplicate" || r.status === "error"))
    .map(({ p, r }) => ({ path: p.diskPath, reason: `${r.status}: ${r.message}` }));
  if (!skipped.length) return;
  try {
    await svc.library().backend.ignoreDiskFiles(skipped);
    $("#import-status").textContent = `${skipped.length} file${skipped.length === 1 ? "" : "s"} from the server's GPX folder ` +
      `${skipped.length === 1 ? "was" : "were"} skipped and won't be offered again.`;
  } catch (err) {
    console.warn("Could not ignore the skipped files:", err);
  }
}

/** GPX files in the server's GPX folder that are not in the library yet (the old CLI import). */
async function checkDiskFiles() {
  let files, ignored;
  try {
    ({ files, ignored } = await svc.library().backend.diskFiles());
  } catch (_) {
    return;
  }
  $("#disk-import").hidden = !files.length && !ignored;
  $("#disk-ignored").replaceChildren(ignored
    ? el("span", {}, `${ignored} ignored file${ignored === 1 ? "" : "s"} · `,
        el("a", { class: "link", onclick: async () => {
          await svc.library().backend.unignoreDiskFiles();
          checkDiskFiles();
        } }, "offer them again"))
    : "");
  $("#disk-import-btn").hidden = $("#disk-ignore-btn").hidden = !files.length;
  $("#disk-import-text").textContent = files.length
    ? `${files.length} GPX file${files.length === 1 ? " is" : "s are"} in the server's GPX folder but not in the library yet. ` +
      "They are referenced where they are (not copied); files in a subfolder get the subfolder's name as source name."
    : "All GPX files in the server's GPX folder are in the library.";
  if (!files.length) return;
  $("#disk-ignore-btn").onclick = async () => {
    const list = files.slice(0, 10).map((f) => `• ${f.path}`).join("\n") + (files.length > 10 ? `\n… and ${files.length - 10} more` : "");
    if (!confirm(`Don't offer these files for import again?\n\n${list}\n\nThey stay in the GPX folder; "offer them again" brings them back.`)) return;
    try {
      await svc.library().backend.ignoreDiskFiles(files.map((f) => ({ path: f.path, reason: "ignored by hand" })));
      pending = pending.filter((p) => !p.diskPath);
      renderPending();
      checkDiskFiles();
    } catch (err) {
      $("#import-status").textContent = `error: ${err.message}`;
    }
  };
  $("#disk-import-btn").onclick = async () => {
    const btn = $("#disk-import-btn");
    btn.disabled = true;
    try {
      const items = [];
      for (const [n, f] of files.entries()) {
        $("#import-status").textContent = `reading ${n + 1} of ${files.length} from the server…`;
        const data = await svc.library().backend.diskFile(f.path);
        items.push({ file: new File([data], f.path.split("/").pop()), path: `gpx/${f.path}`, diskPath: f.path });
      }
      await addFiles(items);
      $("#disk-import").hidden = true;
    } catch (err) {
      $("#import-status").textContent = `error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  };
}

async function start() {
  try {
    await startApp();
  } finally {
    // Now the texts match the mode (server or browser) and the library is on screen.
    document.body.classList.remove("starting");
  }
}

async function startApp() {
  $("#version").textContent = `v${VERSION}`;
  let lib;
  const server = await detectServer();
  if (server) {
    useServerDefaults(document.baseURI);
    try {
      lib = await Library.open(new RemoteBackend(document.baseURI));
    } catch (err) {
      $("#count").textContent = `Could not load the library from the server: ${err.message}`;
      return;
    }
    renderServerMode(server);
  } else try {
    lib = await Library.open();
  } catch (err) {
    $("#count").textContent = "";
    $("#welcome").hidden = false;
    $("#welcome").replaceChildren(el("h2", {}, "This browser does not let rerouter store data"),
      el("p", {}, `rerouter keeps your routes in the browser's storage (IndexedDB), which is not available here (${err.message}). ` +
        "Private windows and some privacy settings block it; try a normal window."));
    return;
  }
  svc.setLibrary(lib);
  applySettings(lib.settings);
  if (server) checkDiskFiles();
  restoreFilters();
  updateDirectionLabels();
  await loadFacets();
  const view = new URLSearchParams(location.hash.slice(1)).get("view");
  showView(LINKABLE_VIEWS.includes(view) ? view : "library");
  watchSurfaceJob();
  loadSeeds();
  loadPlaceSets();
  await loadRoutes();
  // Once, for libraries from before track hashes existed (in the background).
  svc.backfillTrackHashes().catch((err) => console.warn("Track hashes:", err));
}
start();
