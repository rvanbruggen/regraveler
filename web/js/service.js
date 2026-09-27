// The app's "backend", running in the page: what main.py and importer.py did on the server.
// Functions return the same shapes the old JSON API returned, so the UI stays close to the
// server version.

import * as brouter from "./brouter.js";
import * as cb from "./combiner.js";
import { config } from "./config.js";
import { round, simplifyLatLon } from "./geo.js";
import { GpxError, parseGpx, writeGpx } from "./gpx.js";
import * as places from "./places.js";
import { bboxOf, duplicatePairs, findSimilar, groupPairs, proximityPairs } from "./similarity.js";
import { computeStats } from "./stats.js";
import * as surface from "./surface.js";
import { makeZip } from "./zip.js";

export class ServiceError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

let lib = null;
export const setLibrary = (library) => {
  lib = library;
  trackCache.clear();
  mapCache.clear();
};
export const library = () => lib;

function getRoute(id) {
  const r = lib.get(id);
  if (!r) throw new ServiceError("Route not found", 404);
  return r;
}

// ------------------------------------------------------------------ helpers

export function slugify(text) {
  text = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x00-\x7f]/g, "");
  text = text.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return text || "route";
}

function uniqueSlug(name, exceptId = null) {
  const base = slugify(name).slice(0, 200);
  const existing = new Set(lib.all().filter((r) => r.id !== exceptId).map((r) => r.slug));
  let slug = base, n = 2;
  while (existing.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function normaliseTags(tags) {
  const out = [];
  for (let t of tags || []) {
    t = String(t).trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Tags given as "a, b" or ["a", "b"]. */
const splitTags = (v) => (!v ? [] : (typeof v === "string" ? v.split(",") : v.map(String)).filter((t) => t.trim()));

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash of a track's coordinates rounded to ~1 m, ignoring elevation, time and the file
 * format: detects the same track saved as a different file (other name, encoding, ...).
 */
export async function trackHash(points) {
  const s = points.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)};`).join("");
  return sha256(new TextEncoder().encode(s));
}

// File names that describe the start rather than the route ("Start.gpx", "Start (48).gpx",
// "Start Aarschot.gpx"): the track name inside the file is the better route name.
const GENERIC_STEM = /^\s*(start\b.*|route|track|export|gpx)?\s*(\(\d+\))?\s*$/i;
// Web-download style names ("sportvlaanderen-gravelroute-mol"): the track name is nicer.
const SLUG_STEM = /^[a-z0-9]+(-[a-z0-9]+)+$/;
// Browser copy suffix: "Route (1).gpx"
const COPY_SUFFIX = /\s*\(\d+\)$/;

const baseName = (path) => path.split(/[\\/]/).pop();
const stemOf = (filename) => baseName(filename).replace(/\.[^.]*$/, "");

export function routeName(filename, trackName, trackCount, index) {
  const stem = stemOf(filename).trim();
  if (trackCount > 1) return trackName || `${stem} #${index + 1}`;
  if (trackName && (GENERIC_STEM.test(stem) || SLUG_STEM.test(stem.replace(COPY_SUFFIX, "")))) return trackName;
  return stem || trackName || "Unnamed route";
}

/** Import order: "Route.gpx" before its copy "Route (1).gpx", so the original is kept. */
export function importOrder(names) {
  const key = (n) => {
    const parts = n.split("/");
    const file = parts.pop();
    return [parts.join("/"), stemOf(file).replace(COPY_SUFFIX, "").toLowerCase(), file.length, file];
  };
  return (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
}

// ------------------------------------------------------------------ filters

const SORTABLE = new Set(["name", "distance_km", "elevation_gain_m", "paved_pct", "quality_rating", "source_name", "imported_at", "is_loop", "activity"]);

/** Filters from URLSearchParams (the same parameters the old API took). */
export function filtersFrom(params) {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const num = (k) => (p.has(k) && p.get(k) !== "" && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : null);
  return {
    q: p.get("q") || null,
    min_distance: num("min_distance"), max_distance: num("max_distance"),
    min_gain: num("min_gain"), max_gain: num("max_gain"),
    min_paved: num("min_paved"), max_paved: num("max_paved"),
    min_quality: num("min_quality"),
    tags: p.getAll("tags"),
    source: p.get("source") || null,
    loop: p.get("loop") === "true" ? true : p.get("loop") === "false" ? false : null,
    sort: p.get("sort") || "name",
    order: p.get("order") || "asc",
    ids: p.getAll("ids").map(Number).filter(Boolean),
    activity: p.get("activity") || null,
  };
}

/** Shared filter logic for the library table, the map and proximity. */
export function filterRoutes(f = {}) {
  const ge = (v, min) => min == null || (v != null && v >= min);
  const le = (v, max) => max == null || (v != null && v <= max);
  const q = f.q ? f.q.toLowerCase() : null;
  const ids = f.ids?.length ? new Set(f.ids) : null;
  const wanted = normaliseTags(f.tags || []);
  let routes = lib.all().filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || (r.notes || "").toLowerCase().includes(q)) &&
    ge(r.distance_km, f.min_distance) && le(r.distance_km, f.max_distance) &&
    ge(r.elevation_gain_m, f.min_gain) && le(r.elevation_gain_m, f.max_gain) &&
    ge(r.paved_pct, f.min_paved) && le(r.paved_pct, f.max_paved) &&
    ge(r.quality_rating, f.min_quality) &&
    (!f.source || r.source_name === f.source) &&
    (f.loop == null || r.is_loop === f.loop) &&
    (!f.activity || r.activity === f.activity) &&
    (!ids || ids.has(r.id)) &&
    wanted.every((t) => (r.tags || []).includes(t))
  );
  const sort = SORTABLE.has(f.sort) ? f.sort : "name";
  const lower = sort === "name" || sort === "source_name";
  const dir = f.order === "desc" ? -1 : 1;
  const val = (r) => {
    const v = r[sort];
    if (v == null) return null;
    return lower ? String(v).toLowerCase() : typeof v === "boolean" ? Number(v) : v;
  };
  routes = routes.sort((a, b) => {
    const va = val(a), vb = val(b);
    // Empty values last, whatever the direction.
    if (va == null || vb == null) {
      if (va == null && vb != null) return 1;
      if (vb == null && va != null) return -1;
    } else if (va !== vb) return (va < vb ? -1 : 1) * dir;
    const na = a.name.toLowerCase(), nb = b.name.toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  return routes;
}

export const listRoutes = (params) => filterRoutes(filtersFrom(params));

// Simplified geometries for the overview maps, per route and tolerance.
const mapCache = new Map(); // `${id}:${tol}` -> {geometry, source}

function mapGeometry(r, tol) {
  const key = `${r.id}:${tol}`;
  const hit = mapCache.get(key);
  if (hit && hit.source === r.geometry) return hit.geometry;
  const geometry = simplifyLatLon(r.geometry, tol);
  mapCache.set(key, { geometry, source: r.geometry });
  return geometry;
}

/** Filtered routes with a (further simplified) geometry, for the overview map. */
export function mapRoutes(params, toleranceM = 10) {
  return filterRoutes(filtersFrom(params)).map((r) => ({
    id: r.id, name: r.name, distance_km: r.distance_km, elevation_gain_m: r.elevation_gain_m,
    is_loop: r.is_loop, activity: r.activity, quality_rating: r.quality_rating, tags: r.tags,
    source_name: r.source_name, geometry: mapGeometry(r, toleranceM),
  }));
}

// The proximity search runs in a Web Worker when there is one (the browser); a newer
// request cancels the one still running.
let worker = null;
let workerJob = null; // {id, resolve, reject}
let jobId = 0;

function inWorker(routes, distanceM) {
  if (typeof Worker === "undefined") return Promise.resolve(proximityPairs(routes, distanceM));
  if (workerJob) {
    worker.terminate(); // stop the outdated computation
    worker = null;
    workerJob.reject(Object.assign(new Error("Superseded by a newer request"), { superseded: true }));
    workerJob = null;
  }
  if (!worker) {
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const job = workerJob;
      if (!job || e.data.id !== job.id) return;
      workerJob = null;
      if (e.data.error) job.reject(new Error(e.data.error));
      else job.resolve(e.data.pairs);
    };
    worker.onerror = (e) => {
      const job = workerJob;
      workerJob = null;
      worker = null;
      job?.reject(new Error(e.message || "The background computation failed"));
    };
  }
  return new Promise((resolve, reject) => {
    workerJob = { id: ++jobId, resolve, reject };
    worker.postMessage({ id: jobId, routes: routes.map((r) => ({ id: r.id, geometry: r.geometry })), distanceM });
  });
}

/** Pairs of (filtered) routes that overlap or come within distanceM of each other. */
export async function proximity(params, distanceM = null) {
  const d = distanceM == null ? config.PROXIMITY_DISTANCE_M : distanceM;
  if (d > config.PROXIMITY_MAX_DISTANCE_M) throw new ServiceError(`The distance can be at most ${config.PROXIMITY_MAX_DISTANCE_M} m`);
  return { distance_m: d, pairs: await inWorker(filterRoutes(filtersFrom(params)), d) };
}

export function facets() {
  const routes = lib.all();
  const counts = new Map();
  for (const r of routes) for (const t of r.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return {
    count: routes.length,
    proximity_distance_m: config.PROXIMITY_DISTANCE_M,
    proximity_max_distance_m: config.PROXIMITY_MAX_DISTANCE_M,
    sources: [...new Set(routes.map((r) => r.source_name).filter(Boolean))].sort(),
    tags: [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  };
}

export const clientConfig = () => ({
  proximity_distance_m: config.PROXIMITY_DISTANCE_M,
  proximity_max_distance_m: config.PROXIMITY_MAX_DISTANCE_M,
  brouter_profiles: config.BROUTER_PROFILES,
  activities: config.ACTIVITIES,
  activity_profiles: config.ACTIVITY_PROFILES,
});

// ------------------------------------------------------------------ single routes

export const route = (id) => getRoute(id);

export function checkActivity(value) {
  value = String(value).trim().toLowerCase();
  if (!config.ACTIVITIES.includes(value)) throw new ServiceError(`activity must be one of ${config.ACTIVITIES.join(", ")}`);
  return value;
}

/** Editable metadata. Only fields that are given are changed. */
export async function updateRoute(id, changes) {
  const r = getRoute(id);
  const c = { ...changes };
  if ("name" in c && (c.name == null || !String(c.name).trim())) delete c.name;
  if (c.name != null && String(c.name).trim().length > 300) throw new ServiceError("The name is too long");
  if (c.activity != null) c.activity = checkActivity(c.activity);
  if (c.quality_rating != null && !(Number.isInteger(c.quality_rating) && c.quality_rating >= 1 && c.quality_rating <= 5)) {
    throw new ServiceError("Quality must be 1 to 5");
  }
  if (c.paved_pct != null && !(c.paved_pct >= 0 && c.paved_pct <= 100)) throw new ServiceError("Paved % must be 0 to 100");
  if (c.tags) c.tags = normaliseTags(c.tags);
  for (let [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    if (typeof v === "string") v = v.trim() || null;
    r[k] = v;
  }
  if (c.name) r.slug = uniqueSlug(r.name, r.id);
  if ("paved_pct" in c) {
    // A value typed by the user wins over the estimate; clearing it falls back to the estimate.
    if (c.paved_pct != null) r.paved_source = "manual";
    else if (r.surface && r.surface.paved_pct != null) {
      r.paved_pct = r.surface.paved_pct;
      r.paved_source = "estimated";
    } else r.paved_source = null;
  }
  await lib.saveRoutes([r]);
  return r;
}

/** Add and/or remove tags on several routes at once. */
export async function changeTags(ids, add = [], remove = []) {
  add = normaliseTags(add);
  const rm = new Set(normaliseTags(remove));
  if (!add.length && !rm.size) throw new ServiceError("Give at least one tag to add or remove");
  const changed = [];
  for (const id of ids) {
    const r = lib.get(id);
    if (!r) continue;
    const tags = (r.tags || []).filter((t) => !rm.has(t));
    for (const t of add) if (!tags.includes(t)) tags.push(t);
    if (JSON.stringify(tags) !== JSON.stringify(r.tags || [])) {
      r.tags = tags;
      changed.push(r);
    }
  }
  await lib.saveRoutes(changed);
  return { updated: changed.length };
}

export async function setActivity(ids, activity) {
  activity = checkActivity(activity);
  const changed = ids.map((id) => lib.get(id)).filter((r) => r && r.activity !== activity);
  changed.forEach((r) => (r.activity = activity));
  await lib.saveRoutes(changed);
  return { updated: changed.length };
}

/** Remove routes from the library (with their stored GPX files when nothing else uses them). */
export async function deleteRoutes(ids) {
  ids.forEach((id) => trackCache.delete(Number(id)));
  return { deleted: await lib.deleteRoutes(ids) };
}

/** The original GPX file of a route: {filename, data (bytes)}. */
export async function routeGpx(id) {
  const r = getRoute(id);
  const file = await lib.getFile(r.file_hash);
  if (!file) throw new ServiceError("GPX file not found in the library", 404);
  return { filename: r.original_filename || `${r.name}.gpx`, data: file.data };
}

/**
 * The original GPX files of the given routes as one zip file. Routes that come from the
 * same multi-track file share one entry.
 */
export async function exportZip(ids) {
  const routes = ids.map((id) => lib.get(id)).filter(Boolean).sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
  if (!routes.length) throw new ServiceError("No routes found", 404);
  const seen = new Set(), used = new Set(), entries = [];
  for (const r of routes) {
    if (seen.has(r.file_hash)) continue;
    const file = await lib.getFile(r.file_hash);
    if (!file) continue;
    seen.add(r.file_hash);
    let name = baseName(r.original_filename || "") || `route-${r.id}.gpx`;
    const stem = stemOf(name), suffix = name.slice(stem.length) || ".gpx";
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${stem} (${n++})${suffix}`;
    used.add(name.toLowerCase());
    entries.push({ name, data: file.data });
  }
  if (!entries.length) throw new ServiceError("GPX files not found", 404);
  return makeZip(entries);
}

/** Routes that overlap strongly with this one (either direction). */
export function similarRoutes(id) {
  const r = getRoute(id);
  const others = lib.all().filter((o) => o.id !== r.id);
  const byId = new Map(others.map((o) => [o.id, o]));
  return findSimilar(r.geometry, bboxOf(r), others).map((s) => ({
    id: s.other_id,
    name: byId.get(s.other_id).name,
    this_covered_pct: Math.round(s.a_in_b * 100),
    other_covered_pct: Math.round(s.b_in_a * 100),
    very_similar: s.very_similar,
  }));
}

// ------------------------------------------------------------------ import

async function generatedName(geometry, isLoop) {
  try {
    return (await places.generateName(geometry, isLoop)).name;
  } catch (err) {
    console.warn("Could not generate a route name:", err); // never let naming break an import
    return null;
  }
}

/**
 * Import one GPX file (one route per track).
 * data: Uint8Array of the file. Returns {filename, status, message, routes, duplicates, similar}
 * with status "imported", "duplicate", "partial" (some tracks duplicate) or "error".
 */
export async function importGpx(data, filename, {
  source_name = null, source_url = null, tags = [], notes = null, activity = null,
  derived_from = [], check_similar = true, rename = config.AUTO_RENAME_ON_IMPORT, name: forcedName = null,
} = {}) {
  const result = { filename, status: "imported", message: "", routes: [], duplicates: [], similar: [] };
  let parsed;
  try {
    parsed = parseGpx(data);
  } catch (err) {
    if (!(err instanceof GpxError)) throw err;
    return { ...result, status: "error", message: err.message };
  }
  const digest = await sha256(data);
  const all = lib.all();
  const existing = new Map(all.filter((r) => r.file_hash === digest).map((r) => [r.track_index, r]));
  const newTracks = [];
  let sameTrack = false;
  for (const [i, track] of parsed.tracks.entries()) {
    if (existing.has(i)) {
      result.duplicates.push({ id: existing.get(i).id, name: existing.get(i).name });
      continue;
    }
    const th = await trackHash(track.points);
    const twin = all.find((r) => r.track_hash === th);
    if (twin) {
      result.duplicates.push({ id: twin.id, name: twin.name });
      sameTrack = true;
    } else newTracks.push({ i, track, th });
  }
  if (!newTracks.length) {
    result.status = "duplicate";
    result.message = sameTrack ? "Same track already imported (from a different file)" : "Identical file already imported";
    return result;
  }
  let stats;
  try {
    stats = newTracks.map((t) => computeStats(t.track.points));
  } catch (err) {
    if (!(err instanceof GpxError)) throw err;
    return { ...result, status: "error", message: err.message };
  }

  const taken = new Set(all.map((r) => r.name.toLowerCase()));
  const created = [];
  const now = new Date().toISOString();
  const slugs = new Set(all.map((r) => r.slug));
  for (const [k, { i, track, th }] of newTracks.entries()) {
    const st = stats[k];
    let name = forcedName || routeName(filename, track.name, parsed.tracks.length, i);
    let routeNotes = notes;
    if (rename && !derived_from.length && !forcedName) {
      const generated = await generatedName(st.geometry, st.is_loop);
      if (generated) {
        routeNotes = places.notesWithOriginal(notes, name);
        name = places.disambiguate(generated, st.distance_km, taken);
      }
    }
    taken.add(name.toLowerCase());
    const base = slugify(name).slice(0, 200);
    let slug = base, n = 2;
    while (slugs.has(slug)) slug = `${base}-${n++}`;
    slugs.add(slug);
    created.push({
      name, slug,
      original_filename: baseName(filename),
      track_index: i,
      track_name: track.name,
      file_hash: digest,
      track_hash: th,
      ...st,
      activity: activity || config.ACTIVITIES[0],
      quality_rating: null,
      paved_pct: null,
      paved_source: null,
      surface: null,
      tags: normaliseTags(tags),
      notes: routeNotes || null,
      source_name: source_name || null,
      source_url: source_url || parsed.link || null,
      imported_at: now,
      derived_from: [...derived_from],
    });
  }
  // The file first, so a route never points at a missing file. (A server keeps uploads in
  // uploads/<source>/ and new routes made here in derived/, like the old server version.)
  const folder = derived_from.length ? "derived" : `uploads/${slugify(source_name || "unsorted")}`;
  await lib.putFile(digest, baseName(filename), data, folder);
  await lib.saveRoutes(created);

  if (check_similar) {
    for (const r of created) {
      const others = lib.all().filter((o) => o.id !== r.id);
      for (const s of findSimilar(r.geometry, bboxOf(r), others)) {
        if (!s.very_similar) continue;
        const other = lib.get(s.other_id);
        result.similar.push({
          route_id: r.id, route_name: r.name, other_id: other.id, other_name: other.name,
          overlap: Math.min(s.a_in_b, s.b_in_a),
        });
      }
    }
  }
  result.routes = created.map((r) => ({ id: r.id, name: r.name }));
  if (result.duplicates.length) {
    result.status = "partial";
    result.message = `${result.duplicates.length} track(s) already imported`;
  }
  return result;
}

/**
 * Import a batch: files [{name, data, override: {source_name, source_url, activity, tags}}].
 * Batch values apply to every file; per-file values override them (per-file tags are added).
 */
export async function importFiles(files, batch = {}, onProgress = null) {
  const batchActivity = batch.activity ? checkActivity(batch.activity) : null;
  const batchTags = splitTags(batch.tags);
  const results = [];
  for (const [n, f] of files.entries()) {
    const ov = f.override || {};
    onProgress?.(n, files.length, f.name);
    let res;
    try {
      res = await importGpx(f.data, f.name, {
        source_name: (ov.source_name || batch.source_name || "").trim() || null,
        source_url: (ov.source_url || batch.source_url || "").trim() || null,
        activity: (ov.activity ? checkActivity(ov.activity) : null) || batchActivity,
        tags: [...batchTags, ...splitTags(ov.tags)],
      });
    } catch (err) {
      res = { filename: f.name, status: "error", message: err.message, routes: [], duplicates: [], similar: [] };
    }
    results.push(res);
  }
  const newIds = results.flatMap((r) => r.routes.map((x) => x.id));
  if (newIds.length && config.SURFACE_AUTO_ESTIMATE) surfaceJob.enqueue(newIds);
  return { results };
}

/**
 * Routes without a track hash (moved from an early version of the server, which didn't have
 * them) get one from their GPX file, so the same track in another file is recognised as a
 * duplicate. Returns how many routes were updated.
 */
export async function backfillTrackHashes() {
  const missing = lib.all().filter((r) => !r.track_hash);
  const changed = [];
  for (const r of missing) {
    try {
      const file = await lib.getFile(r.file_hash);
      const track = file && parseGpx(file.data).tracks[r.track_index || 0];
      if (!track) continue;
      r.track_hash = await trackHash(track.points);
      changed.push(r);
    } catch (err) {
      console.warn(`No track hash for '${r.name}':`, err);
    }
  }
  for (let i = 0; i < changed.length; i += 50) await lib.saveRoutes(changed.slice(i, i + 50));
  return changed.length;
}

// ------------------------------------------------------------------ tracks (full resolution)

const trackCache = new Map(); // route id -> {hash, track}

/** Full-resolution track of a route, read from its (never modified) GPX file. */
export async function loadTrack(r) {
  const hit = trackCache.get(r.id);
  if (hit && hit.hash === r.file_hash && hit.isLoop === r.is_loop) return hit.track;
  const file = await lib.getFile(r.file_hash);
  if (!file) throw new ServiceError(`GPX file of '${r.name}' not found in the library`, 404);
  const tracks = parseGpx(file.data).tracks;
  const track = cb.makeTrack(tracks[r.track_index].points, r.is_loop);
  trackCache.set(r.id, { hash: r.file_hash, isLoop: r.is_loop, track });
  if (trackCache.size > 64) trackCache.delete(trackCache.keys().next().value);
  return track;
}

const ll = (p) => [round(p[0], 6), round(p[1], 6)];

// ------------------------------------------------------------------ combiner

/** Suggested points: where routes A and B come closest (count 1: point to point, 2: loop). */
export async function combineSuggest(aId, bId, count = 1) {
  if (aId === bId) throw new ServiceError("Choose two different routes");
  const [a, b] = await Promise.all([loadTrack(getRoute(aId)), loadTrack(getRoute(bId))]);
  let connections, parts;
  try {
    connections = cb.suggestConnections(a, b, count);
    parts = cb.suggestParts(a, b, count === 2);
  } catch (err) {
    if (err instanceof cb.CombineError) throw new ServiceError(err.message);
    throw err;
  }
  return {
    connections: connections.map((c) => {
      const pa = cb.pointAt(a, c.aAt), pb = cb.pointAt(b, c.bAt);
      return { a: ll(cb.latLonOf(pa)), b: ll(cb.latLonOf(pb)), distance_m: Math.round(Math.hypot(pa[0] - pb[0], pa[1] - pb[1])) };
    }),
    parts: parts.map((p, i) => partOut(p, [aId, bId][i])),
  };
}

function partOut(p, routeId) {
  return {
    route_id: routeId,
    start: ll(cb.latLonOf(cb.pointAt(p.track, p.startAt))),
    end: ll(cb.latLonOf(cb.pointAt(p.track, p.endAt))),
    start_km: round(p.startAt / 1000, 2),
    end_km: round(p.endAt / 1000, 2),
    other_way: p.otherWay,
  };
}

const MAX_PARTS = 6;

const namesOf = (routes) => {
  const names = routes.map((r) => `'${r.name}'`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/**
 * req: {parts: [{route_id, start: [lat, lon], end: [lat, lon], other_way}], closed, reverse,
 *       profile, prefer_unpaved, straight}
 */
async function runCombine(req) {
  const reqParts = req.parts || [];
  if (reqParts.length < 2 || reqParts.length > MAX_PARTS) throw new ServiceError(`Use 2 to ${MAX_PARTS} routes`);
  const ids = reqParts.map((p) => p.route_id);
  if (new Set(ids).size < 2) throw new ServiceError("Choose at least two different routes");
  const routes = new Map(ids.map((id) => [id, getRoute(id)]));
  const tracks = new Map();
  for (const [id, r] of routes) tracks.set(id, await loadTrack(r));
  const acts = new Set([...routes.values()].map((r) => r.activity));
  const byActivity = acts.size === 1 ? config.ACTIVITY_PROFILES[[...acts][0]] : null;
  const profile = req.profile || byActivity || config.BROUTER_PROFILES[0];
  if (!config.BROUTER_PROFILES.includes(profile)) throw new ServiceError(`Unknown profile '${profile}'`);
  const params = req.prefer_unpaved && profile === "gravel" ? { prefer_unpaved_paths: "1" } : null;
  const router = req.straight ? cb.straightRouter : (p, q) => brouter.route(p, q, profile, params);
  let result;
  try {
    const parts = reqParts.map((p) => {
      const t = tracks.get(p.route_id);
      return cb.part(t, cb.locate(t, ...p.start), cb.locate(t, ...p.end), !!p.other_way);
    });
    result = await cb.combineParts(parts, router, { closed: req.closed !== false, reverse: !!req.reverse, directJoinM: config.DIRECT_JOIN_M });
  } catch (err) {
    if (err instanceof cb.CombineError) throw new ServiceError(err.message);
    if (err instanceof brouter.BRouterUnavailable) throw new ServiceError(err.message, 503);
    if (err instanceof brouter.BRouterError) throw new ServiceError(err.message, 502);
    throw err;
  }
  const how = req.straight ? "straight lines" : `BRouter (${profile}${params ? ", prefer unpaved" : ""})`;
  const used = [...new Map(ids.map((id) => [id, routes.get(id)])).values()];
  return { used, result, description: `Combined from ${namesOf(used)} via ${how}.` };
}

export async function combinePreview(req) {
  const { result, description } = await runCombine(req);
  const stats = computeStats(result.points);
  const partLegs = result.legs.filter((l) => l.kind !== "connector");
  return {
    description,
    crossing: result.parts.length > 0 && cb.connectorsCross(result.parts, req.closed !== false),
    parts: req.parts.map((p, i) => ({
      route_id: p.route_id,
      start: ll(result.partPoints[i][0]),
      end: ll(result.partPoints[i][1]),
      start_km: round(result.parts[i].startAt / 1000, 2),
      end_km: round(result.parts[i].endAt / 1000, 2),
      distance_km: round(cb.legLength(partLegs[i].xyz) / 1000, 2),
    })),
    distance_km: stats.distance_km,
    elevation_gain_m: stats.elevation_gain_m,
    elevation_loss_m: stats.elevation_loss_m,
    is_loop: stats.is_loop,
    start: [stats.start_lat, stats.start_lon],
    end: [stats.end_lat, stats.end_lon],
    connectors: cb.connectorsOf(result).map((l) => ({ distance_km: round(cb.legLength(l.xyz) / 1000, 2), routed: l.routed })),
    legs: result.legs.filter((l) => l.xyz.length >= 2).map((l) => ({
      kind: l.kind,
      routed: l.routed,
      geometry: simplifyLatLon(cb.toLatLon(l.xyz).map(ll), 5),
    })),
  };
}

/** The combined route as a GPX file, without saving it: {filename, text}. */
export async function combineGpx(req) {
  const { result, description } = await runCombine(req);
  return { filename: `${req.name}.gpx`.replace(/"/g, ""), text: writeGpx(req.name, result.points, description) };
}

/** Save the combination as a new route (a new GPX file in the library). */
export async function combineSave(req) {
  const name = String(req.name || "").trim();
  if (!name) throw new ServiceError("Give the route a name");
  const { used, result, description } = await runCombine(req);
  const text = writeGpx(name, result.points, description);
  const data = new TextEncoder().encode(text);
  const hash = await sha256(data);
  const existing = lib.all().find((r) => r.file_hash === hash);
  if (existing) throw new ServiceError(`This combination is already saved as '${existing.name}'`, 409);
  const notes = description + (req.notes && req.notes.trim() ? `\n\n${req.notes.trim()}` : "");
  const res = await importGpx(data, `${slugify(name).slice(0, 150)}.gpx`, {
    source_name: "combined",
    derived_from: used.map((r) => r.id),
    tags: normaliseTags(used.flatMap((r) => r.tags || [])),
    notes,
    activity: used[0].activity,
    name,
  });
  if (res.status !== "imported") throw new ServiceError(`Could not save the combined route: ${res.message}`, 500);
  const created = lib.get(res.routes[0].id);
  if (config.SURFACE_AUTO_ESTIMATE) surfaceJob.enqueue([created.id]);
  return { id: created.id, name: created.name, similar: res.similar };
}

// ------------------------------------------------------------------ new start point

async function runRestart(req) {
  const r = getRoute(req.route_id);
  if (!r.is_loop) throw new ServiceError(`'${r.name}' is not a loop: only a loop can start somewhere else`);
  const track = await loadTrack(r);
  const at = cb.locate(track, ...req.start);
  let xyz;
  try {
    xyz = cb.restartLoop(track, at, !!req.reverse);
  } catch (err) {
    if (err instanceof cb.CombineError) throw new ServiceError(err.message);
    throw err;
  }
  const description = `'${r.name}' starting ${(at / 1000).toFixed(1)} km along the original` +
    (req.reverse ? ", ridden the other way round." : ".");
  return { route: r, points: cb.toLatLon(xyz), at, description };
}

async function startPlace(geometry) {
  try {
    return (await places.generateName(geometry, true)).start;
  } catch (_) {
    return null; // no place data: the name is only a suggestion
  }
}

export async function restartPreview(req) {
  const { points, at, description } = await runRestart(req);
  const stats = computeStats(points);
  return {
    description,
    start: ll(points[0]),
    start_km: round(at / 1000, 2),
    start_place: await startPlace(stats.geometry),
    distance_km: stats.distance_km,
    elevation_gain_m: stats.elevation_gain_m,
    elevation_loss_m: stats.elevation_loss_m,
    geometry: stats.geometry,
  };
}

export async function restartGpx(req) {
  const { points, description } = await runRestart(req);
  return { filename: `${req.name}.gpx`.replace(/"/g, ""), text: writeGpx(req.name, points, description) };
}

/** Save the loop with its new start as a new route; the original is left as it is. */
export async function restartSave(req) {
  const name = String(req.name || "").trim();
  if (!name) throw new ServiceError("Give the route a name");
  const { route: orig, points, description } = await runRestart(req);
  const data = new TextEncoder().encode(writeGpx(name, points, description));
  const notes = description + (orig.notes && orig.notes.trim() ? `\n\n${orig.notes.trim()}` : "");
  const res = await importGpx(data, `${slugify(name).slice(0, 150)}.gpx`, {
    source_name: orig.source_name,
    source_url: orig.source_url,
    derived_from: [orig.id],
    tags: [...(orig.tags || [])],
    notes,
    activity: orig.activity,
    name,
  });
  if (res.status !== "imported") {
    if (res.status === "duplicate" && res.duplicates.length) {
      throw new ServiceError(`This route is already saved as '${res.duplicates[0].name}'`, 409);
    }
    throw new ServiceError(`Could not save the route: ${res.message}`, 500);
  }
  const created = lib.get(res.routes[0].id);
  // Same roads, so the same personal rating and surface.
  created.quality_rating = orig.quality_rating;
  created.paved_pct = orig.paved_pct;
  created.paved_source = orig.paved_source;
  await lib.saveRoutes([created]);
  // It lies on the same roads as the original (and the original's other new starts): a
  // deliberate variant, so keep them out of the duplicates list.
  const siblings = lib.all().filter((x) => x.id !== created.id && x.derived_from?.length === 1 && x.derived_from[0] === orig.id);
  await lib.ignorePairs([orig.id, ...siblings.map((x) => x.id)].map((o) => [o, created.id]));
  if (config.SURFACE_AUTO_ESTIMATE && orig.paved_source !== "manual") surfaceJob.enqueue([created.id]);
  return { id: created.id, name: created.name };
}

// ------------------------------------------------------------------ surface

/** Estimate the surface of one route now (map matching through BRouter). */
export async function estimateSurface(id, overwriteManual = false) {
  const r = getRoute(id);
  let result;
  try {
    result = await surface.estimate(await loadTrack(r));
  } catch (err) {
    if (err instanceof brouter.BRouterUnavailable) throw new ServiceError(err.message, 503);
    if (err instanceof brouter.BRouterError) throw new ServiceError(err.message, 502);
    throw err;
  }
  surface.applyEstimate(r, result, overwriteManual);
  await lib.saveRoutes([r]);
  return r;
}

/** Estimates routes one by one in the background. */
class SurfaceJob {
  constructor() {
    this.queue = [];
    this.pending = new Set();
    this.done = 0;
    this.failed = 0;
    this.current = null;
    this.lastError = null;
    this.running = false;
  }

  enqueue(ids, { force = false, overwriteManual = false } = {}) {
    if (!this.pending.size) {
      this.done = this.failed = 0;
      this.lastError = null;
    }
    let added = 0;
    for (const id of ids) {
      if (this.pending.has(id)) continue;
      this.pending.add(id);
      this.queue.push({ id, force, overwriteManual });
      added++;
    }
    if (!this.running) this.run();
    return added;
  }

  status() {
    return {
      running: this.pending.size > 0,
      queued: this.pending.size,
      done: this.done,
      failed: this.failed,
      current: this.current,
      last_error: this.lastError,
    };
  }

  async run() {
    this.running = true;
    while (this.queue.length) {
      const { id, force, overwriteManual } = this.queue.shift();
      this.current = id;
      try {
        const r = lib.get(id);
        if (r && (force || !r.surface)) {
          const result = await surface.estimate(await loadTrack(r));
          if (lib.get(id)) {
            surface.applyEstimate(r, result, overwriteManual);
            await lib.saveRoutes([r]);
          }
        }
        this.done++;
      } catch (err) {
        console.warn(`Surface estimate for route ${id} failed:`, err);
        this.failed++;
        this.lastError = err.message;
      } finally {
        this.pending.delete(id);
        this.current = null;
      }
    }
    this.running = false;
  }
}

export const surfaceJob = new SurfaceJob();

// ------------------------------------------------------------------ duplicates

/** Groups of near-duplicate routes, and variants (a route lying on another route). */
export function duplicates() {
  const routes = lib.all();
  const byId = new Map(routes.map((r) => [r.id, r]));
  const pairs = duplicatePairs(routes, config.SIMILAR_TOLERANCE_M, Math.min(config.VARIANT_MIN_OVERLAP, config.SIMILAR_MIN_OVERLAP))
    .filter((p) => !lib.isIgnored(p.a_id, p.b_id));
  const groups = groupPairs(pairs, config.SIMILAR_MIN_OVERLAP);

  const summary = (r) => ({
    id: r.id, name: r.name, source_name: r.source_name, distance_km: r.distance_km,
    elevation_gain_m: r.elevation_gain_m, quality_rating: r.quality_rating, tags: r.tags,
    has_notes: !!r.notes, imported_at: r.imported_at, is_derived: !!r.derived_from?.length,
  });
  // Suggest keeping the route with the most personal metadata, then the oldest import.
  const keepScore = (r) => [
    -(r.quality_rating != null) - !!r.tags?.length - !!r.notes - (r.paved_source === "manual"),
    r.imported_at, r.id,
  ];
  const cmp = (a, b) => {
    const ka = keepScore(a), kb = keepScore(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  };
  const outGroups = groups.map((g) => {
    const members = [...g].map((id) => byId.get(id)).sort(cmp);
    return {
      routes: members.map(summary),
      suggested_keep: members[0].id,
      pairs: pairs.filter((p) => g.has(p.a_id) && g.has(p.b_id)).map((p) => ({
        a: p.a_id, b: p.b_id, a_in_b_pct: Math.round(p.a_in_b * 100), b_in_a_pct: Math.round(p.b_in_a * 100),
        reversed: p.reversed, same_track: byId.get(p.a_id).track_hash === byId.get(p.b_id).track_hash,
      })),
    };
  });
  outGroups.sort((a, b) => a.routes[0].name.toLowerCase().localeCompare(b.routes[0].name.toLowerCase()));

  const variants = [];
  for (const p of pairs) {
    if (Math.min(p.a_in_b, p.b_in_a) >= config.SIMILAR_MIN_OVERLAP) continue; // already in a group
    const [part, whole] = p.a_in_b >= p.b_in_a ? [p.a_id, p.b_id] : [p.b_id, p.a_id];
    const covered = Math.max(p.a_in_b, p.b_in_a);
    if (covered < config.VARIANT_MIN_OVERLAP) continue;
    variants.push({ part: summary(byId.get(part)), whole: summary(byId.get(whole)), covered_pct: Math.round(covered * 100), reversed: p.reversed });
  }
  variants.sort((a, b) => a.whole.name.toLowerCase().localeCompare(b.whole.name.toLowerCase()) || a.part.name.toLowerCase().localeCompare(b.part.name.toLowerCase()));
  return { groups: outGroups, variants };
}

/** Mark routes as "not duplicates" of each other (every pair among the given ids). */
export async function ignoreDuplicates(ids) {
  const u = [...new Set(ids)].sort((a, b) => a - b);
  const pairs = [];
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) pairs.push([u[i], u[j]]);
  return { ignored_pairs: await lib.ignorePairs(pairs) };
}

export const resetIgnoredDuplicates = async () => ({ reset: await lib.resetIgnored() });

// ------------------------------------------------------------------ route names

/** Generated names (start town + places visited) for the given routes, or all routes. */
export async function renameProposals(ids = null, onProgress = null) {
  let routes = lib.all().sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (ids?.length) {
    const want = new Set(ids);
    routes = routes.filter((r) => want.has(r.id));
  }
  const chosen = new Set(lib.all().map((r) => r.name.toLowerCase()));
  const out = [];
  for (const [n, r] of routes.entries()) {
    onProgress?.(n, routes.length);
    let proposal = (await places.generateName(r.geometry, r.is_loop)).name;
    if (proposal && proposal.toLowerCase() !== r.name.toLowerCase()) {
      const others = new Set(chosen);
      others.delete(r.name.toLowerCase());
      proposal = places.disambiguate(proposal, r.distance_km, others);
      chosen.add(proposal.toLowerCase());
    }
    out.push({
      id: r.id, name: r.name, proposal, distance_km: r.distance_km, source_name: r.source_name,
      is_derived: !!r.derived_from?.length, original_name_in_notes: (r.notes || "").startsWith(places.ORIGINAL_PREFIX),
    });
  }
  return out;
}

/** Rename routes; the original name is kept at the top of the notes. items: [{id, name}] */
export async function renameApply(items) {
  const changed = [];
  for (const item of items) {
    const r = lib.get(item.id);
    const name = String(item.name || "").trim();
    if (!r || !name || name === r.name) continue;
    r.notes = places.notesWithOriginal(r.notes, r.name);
    r.name = name;
    r.slug = uniqueSlug(name, r.id);
    changed.push(r);
  }
  await lib.saveRoutes(changed);
  return { renamed: changed.length };
}
