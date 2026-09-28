// The app's "backend", running in the page: what main.py and importer.py did on the server.
// Functions return the same shapes the old JSON API returned, so the UI stays close to the
// server version.

import * as brouter from "./brouter.js";
import * as cb from "./combiner.js";
import { config } from "./config.js";
import { round, simplifyLatLon } from "./geo.js";
import { GpxError, writeGpx } from "./gpx.js";
import * as places from "./places.js";
import * as osm from "./osm.js";
import * as poi from "./poi.js";
import { bboxOf, duplicatePairs, findSimilar, groupPairs, proximityPairs } from "./similarity.js";
import { buildProfile } from "./profile.js";
import { computeStats } from "./stats.js";
import { fileWaypoints, parseTrackFile, unwrapFile } from "./trackfile.js";
import * as surface from "./surface.js";
import { makeZip } from "./zip.js";
import { sha256 } from "./sha256.js";

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
  profileCache.clear();
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

// SHA-256 via the browser's crypto, or a JavaScript fallback on plain-HTTP pages (see sha256.js).
export { sha256 };

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
  ids.forEach((id) => {
    trackCache.delete(Number(id));
    profileCache.delete(Number(id));
  });
  return { deleted: await lib.deleteRoutes(ids) };
}

/** The original file of a route (GPX, TCX or FIT, never modified): {filename, data (bytes)}. */
export async function routeGpx(id) {
  const r = getRoute(id);
  const file = await lib.getFile(r.file_hash);
  if (!file) throw new ServiceError("GPX file not found in the library", 404);
  return { filename: r.original_filename || `${r.name}.gpx`, data: file.data };
}

/** Is the route's original file something other than GPX (TCX or FIT)? */
export const notGpx = (r) => !!r.file_format && r.file_format !== "gpx";

/**
 * The route as a GPX file: the original when it is GPX, else a GPX written from the route's
 * track in its TCX or FIT file. {filename, data (bytes or text)}.
 */
export async function routeAsGpx(id) {
  const r = getRoute(id);
  if (!notGpx(r)) return routeGpx(id);
  const file = await lib.getFile(r.file_hash);
  if (!file) throw new ServiceError("The route's file was not found in the library", 404);
  const track = parseTrackFile(file.data).tracks[r.track_index || 0];
  const stem = stemOf(baseName(r.original_filename || "")) || slugify(r.name);
  return { filename: `${stem}.gpx`, data: writeGpx(r.name, track.points, r.notes) };
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
    let data = file.data;
    if (notGpx(r)) {
      // A zip of GPX files: TCX and FIT routes are written as GPX (one file per route).
      seen.delete(r.file_hash);
      data = (await routeAsGpx(r.id)).data;
      name = `${stemOf(name)}${r.track_index ? ` (${r.track_index + 1})` : ""}.gpx`;
    }
    const stem = stemOf(name), suffix = name.slice(stem.length) || ".gpx";
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${stem} (${n++})${suffix}`;
    used.add(name.toLowerCase());
    entries.push({ name, data });
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
 * Import one route file (GPX, TCX or FIT; one route per track).
 * data: Uint8Array of the file. Returns {filename, status, message, routes, duplicates, similar,
 * ride} with status "imported", "duplicate", "partial" (some tracks duplicate), "ride" or "error".
 *
 * `activity` wins over what the file says (a FIT or TCX file knows running from cycling),
 * which wins over `default_activity`.
 *
 * A recorded ride (a FIT or TCX activity) that rides most of a route in the library is not
 * imported when `match_rides` is on: status "ride", with `ride` describing the match, so the
 * page can offer to log it on that route (logRide) or import it anyway.
 */
export async function importGpx(data, filename, {
  source_name = null, source_url = null, tags = [], notes = null, activity = null, default_activity = null,
  derived_from = [], check_similar = true, rename = config.AUTO_RENAME_ON_IMPORT, name: forcedName = null,
  match_rides = false,
} = {}) {
  const result = { filename, status: "imported", message: "", routes: [], duplicates: [], similar: [], ride: null };
  let parsed;
  try {
    parsed = parseTrackFile(data);
  } catch (err) {
    if (!(err instanceof GpxError)) throw err;
    return { ...result, status: "error", message: err.message };
  }
  const digest = await sha256(data);
  const all = lib.all();
  const logged = all.find((r) => (r.rides || []).some((x) => x.file_hash === digest));
  if (logged) {
    result.status = "duplicate";
    result.message = "This ride is already logged";
    result.duplicates.push({ id: logged.id, name: logged.name });
    return result;
  }
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
  if (match_rides && parsed.kind === "activity" && newTracks.length === 1) {
    const match = rideMatch(stats[0], all);
    if (match) {
      result.status = "ride";
      result.ride = {
        ...match,
        date: (parsed.started_at || "").slice(0, 10) || null,
        distance_km: stats[0].distance_km,
        file_hash: digest,
      };
      result.message = `Recorded ride of ${match.route_name} (${Math.round(match.covered * 100)}% of the route)`;
      return result;
    }
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
      file_format: parsed.format,
      track_hash: th,
      ...st,
      activity: activity || parsed.activity || default_activity || config.ACTIVITIES[0],
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
 * The library route a recorded ride rode (most of): the route with the largest share of its
 * length within SIMILAR_TOLERANCE_M of the ride, if that is at least RIDE_MATCH_MIN_COVERED.
 * The ride may have more (riding to the start, a detour): only the route's coverage counts.
 * `ride` is {geometry, min_lat, …} (route stats). Returns {route_id, route_name, covered,
 * on_route} or null.
 */
export function rideMatch(ride, routes = lib.all()) {
  let best = null;
  for (const s of findSimilar(ride.geometry, bboxOf(ride), routes, config.SIMILAR_TOLERANCE_M, config.RIDE_MATCH_MIN_COVERED)) {
    if (s.b_in_a < config.RIDE_MATCH_MIN_COVERED) continue;
    if (!best || s.b_in_a > best.b_in_a) best = s;
  }
  if (!best) return null;
  const r = routes.find((x) => x.id === best.other_id);
  return { route_id: r.id, route_name: r.name, covered: best.b_in_a, on_route: best.a_in_b };
}

/**
 * Log a ride on a route: {date (YYYY-MM-DD), distance_km, file_hash, note}. The route keeps
 * its rides in `rides`, oldest first; the same recorded file is logged only once.
 */
export async function logRide(id, { date = null, distance_km = null, file_hash = null, note = null } = {}) {
  const r = getRoute(id);
  const rides = [...(r.rides || [])];
  if (file_hash && rides.some((x) => x.file_hash === file_hash)) return r;
  rides.push({ date: date || new Date().toISOString().slice(0, 10), distance_km, file_hash, note: note || null });
  rides.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  r.rides = rides;
  await lib.saveRoutes([r]);
  return r;
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
      const { data, name } = await unwrapFile(f.data, f.name); // ride.fit.gz -> ride.fit
      res = await importGpx(data, name, {
        source_name: (ov.source_name || batch.source_name || "").trim() || null,
        source_url: (ov.source_url || batch.source_url || "").trim() || null,
        activity: ov.activity ? checkActivity(ov.activity) : null,
        default_activity: batchActivity,
        tags: [...batchTags, ...splitTags(ov.tags)],
        match_rides: f.match_rides ?? batch.match_rides ?? true,
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
      const track = file && parseTrackFile(file.data).tracks[r.track_index || 0];
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
  const tracks = parseTrackFile(file.data).tracks;
  const track = cb.makeTrack(tracks[r.track_index].points, r.is_loop);
  trackCache.set(r.id, { hash: r.file_hash, isLoop: r.is_loop, track });
  if (trackCache.size > 64) trackCache.delete(trackCache.keys().next().value);
  return track;
}

const profileCache = new Map(); // route id -> {hash, index, profile}

/** Elevation profile of a route (profile.js), or null when its file has no elevation. */
export async function routeProfile(r) {
  const hit = profileCache.get(r.id);
  if (hit && hit.hash === r.file_hash && hit.index === r.track_index) return hit.profile;
  const file = await lib.getFile(r.file_hash);
  if (!file) throw new ServiceError(`GPX file of '${r.name}' not found in the library`, 404);
  const profile = buildProfile(parseTrackFile(file.data).tracks[r.track_index].points);
  profileCache.set(r.id, { hash: r.file_hash, index: r.track_index, profile });
  if (profileCache.size > 32) profileCache.delete(profileCache.keys().next().value);
  return profile;
}

const ll = (p) => [round(p[0], 6), round(p[1], 6)];

// ------------------------------------------------------------------ combiner

/** Suggested points: where routes A and B come closest (count 1: point to point, 2: loop). */
/**
 * Suggested points for combining routes A and B. pattern: "loop" (two crossings, back to
 * A1), "open" (A then B, point to point) or "outback" (out on A, back on B to its start);
 * the old form 2 / 1 still means loop / open.
 */
export async function combineSuggest(aId, bId, pattern = "open") {
  if (aId === bId) throw new ServiceError("Choose two different routes");
  if (pattern === 2) pattern = "loop";
  if (pattern === 1) pattern = "open";
  if (!["loop", "open", "outback"].includes(pattern)) throw new ServiceError(`Unknown pattern '${pattern}'`);
  const [a, b] = await Promise.all([loadTrack(getRoute(aId)), loadTrack(getRoute(bId))]);
  let connections, parts;
  try {
    connections = pattern === "outback"
      ? [cb.suggestCrossover(a, b)]
      : cb.suggestConnections(a, b, pattern === "loop" ? 2 : 1);
    parts = cb.suggestParts(a, b, pattern);
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
    with_route: cb.withRoute(p),
  };
}

const MAX_PARTS = 6;

const namesOf = (routes) => {
  const names = routes.map((r) => `'${r.name}'`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/**
 * req: {parts: [{route_id, start: [lat, lon], end: [lat, lon], other_way}], closed, reverse,
 *       profile, prefer_unpaved, straight, vias: [place id | null per connector]}
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
  const router = req.straight ? cb.straightRouter : (p, q, via = []) => brouter.route(p, q, profile, params, null, via);
  // Connectors through a place: vias[k] is the id of a place connector k must pass.
  const viaPlaces = (req.vias || []).map((id) => (id ? lib.getDoc("poi", id) : null));
  if (viaPlaces.some((p, k) => req.vias[k] && !p)) throw new ServiceError("A place to ride through was removed");
  const vias = viaPlaces.map((p) => (p ? [[p.lat, p.lon]] : []));
  let result;
  try {
    const parts = reqParts.map((p) => {
      const t = tracks.get(p.route_id);
      return cb.part(t, cb.locate(t, ...p.start), cb.locate(t, ...p.end), !!p.other_way);
    });
    result = await cb.combineParts(parts, router, { closed: req.closed !== false, reverse: !!req.reverse, directJoinM: config.DIRECT_JOIN_M, vias });
  } catch (err) {
    if (err instanceof cb.CombineError) throw new ServiceError(err.message);
    if (err instanceof brouter.BRouterUnavailable) throw new ServiceError(err.message, 503);
    if (err instanceof brouter.BRouterError) throw new ServiceError(err.message, 502);
    throw err;
  }
  const how = req.straight ? "straight lines" : `BRouter (${profile}${params ? ", prefer unpaved" : ""})`;
  const used = [...new Map(ids.map((id) => [id, routes.get(id)])).values()];
  const through = viaPlaces.filter(Boolean).map((p) => p.name);
  return {
    used, result, viaPlaces,
    description: `Combined from ${namesOf(used)} via ${how}${through.length ? `, through ${through.join(" and ")}` : ""}.`,
  };
}

export async function combinePreview(req) {
  const { result, description, viaPlaces } = await runCombine(req);
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
      with_route: cb.withRoute(result.parts[i]),
    })),
    distance_km: stats.distance_km,
    elevation_gain_m: stats.elevation_gain_m,
    elevation_loss_m: stats.elevation_loss_m,
    is_loop: stats.is_loop,
    start: [stats.start_lat, stats.start_lon],
    end: [stats.end_lat, stats.end_lon],
    connectors: cb.connectorsOf(result).map((l, k) => ({
      distance_km: round(cb.legLength(l.xyz) / 1000, 2), routed: l.routed,
      from: ll(cb.latLonOf(l.xyz[0])), to: ll(cb.latLonOf(l.xyz[l.xyz.length - 1])),
      via: viaPlaces[k] ? { id: viaPlaces[k].id, name: viaPlaces[k].name } : null,
    })),
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

// ------------------------------------------------------------------ places (POIs)
// Documents in the library (db.js): "poi" {id, name, lat, lon, category, list_id, notes, url,
// source} and "poi_list" {id, name, source, visible}. Categories are a setting.

const MARKS_LIST = "marks"; // the list places added on the map go into

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** The place categories: the saved ones, plus built-in ones added in a later version. */
export function placeCategories() {
  const saved = Array.isArray(lib.settings.POI_CATEGORIES) ? lib.settings.POI_CATEGORIES : [];
  const ids = new Set(saved.map((c) => c.id));
  return [...saved, ...poi.DEFAULT_CATEGORIES.filter((c) => !ids.has(c.id)).map((c) => ({ ...c }))];
}

async function saveCategories(categories) {
  await lib.setSetting("POI_CATEGORIES", categories);
}

/** Add a category (or change one: same id). Returns it. */
export async function saveCategory({ id = null, label, symbol = null, color = null }) {
  label = String(label || "").trim();
  if (!label) throw new ServiceError("A category needs a name");
  const cats = placeCategories();
  let c = id && cats.find((x) => x.id === id);
  if (c) {
    c.label = label;
    if (symbol) c.symbol = symbol;
    if (color) c.color = color;
  } else {
    const same = cats.find((x) => x.label.toLowerCase() === label.toLowerCase());
    if (same) return same;
    let base = poi.categoryId(label), newId = base, n = 2;
    while (cats.some((x) => x.id === newId)) newId = `${base}-${n++}`;
    const custom = cats.filter((x) => !poi.DEFAULT_CATEGORIES.some((d) => d.id === x.id)).length;
    c = { id: newId, label, symbol: symbol || "📍", color: color || poi.EXTRA_COLORS[custom % poi.EXTRA_COLORS.length], words: [label] };
    cats.push(c);
  }
  await saveCategories(cats);
  return c;
}

/** Remove a category of your own that no place uses (the built-in ones stay). */
export async function deleteCategory(id) {
  if (poi.DEFAULT_CATEGORIES.some((c) => c.id === id)) throw new ServiceError("Built-in categories can't be removed");
  if (lib.docsOf("poi").some((p) => p.category === id)) throw new ServiceError("Places still use this category");
  await saveCategories(placeCategories().filter((c) => c.id !== id));
}

export const placeLists = () => lib.docsOf("poi_list").sort(byName);
export const allPlaces = () => lib.docsOf("poi").sort(byName);
export const place = (id) => lib.getDoc("poi", id);

/** Places of the lists that are shown on the maps. */
export function visiblePlaces() {
  const hidden = new Set(lib.docsOf("poi_list").filter((l) => l.visible === false).map((l) => l.id));
  return lib.docsOf("poi").filter((p) => !hidden.has(p.list_id));
}

async function ensureList(name, { id = null, source = null } = {}) {
  const lists = lib.docsOf("poi_list");
  const found = id ? lists.find((l) => l.id === id) : lists.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const [list] = await lib.saveDocs([{ kind: "poi_list", id, name, source, visible: true, created_at: new Date().toISOString() }]);
  return list;
}

/**
 * Import places read by poi.readPlacesFile. `layers`: per layer of `parsed`, {include,
 * category}: "suggested" (per place: its icon or the layer name; else a new category named
 * after the layer), "new" (a new category named after the layer) or a category id. Places
 * already in the list (same name within 25 m) are skipped. Returns {list, added, duplicates}.
 */
export async function importPlaces(parsed, { listName = null, source = null, layers = [] } = {}) {
  const list = await ensureList(String(listName || parsed.name || source || "Places").trim(), { source });
  const existing = lib.docsOf("poi").filter((p) => p.list_id === list.id);
  const docs = [];
  let duplicates = 0;
  for (const [i, layer] of parsed.layers.entries()) {
    const choice = layers[i] || { include: true, category: "suggested" };
    if (!choice.include) continue;
    let layerCategory = null; // made once per layer, when needed
    const newCategory = async () => (layerCategory ??= (await saveCategory({ label: layer.name })).id);
    for (const p of layer.places) {
      if (poi.isDuplicatePlace(p, [...existing, ...docs])) {
        duplicates++;
        continue;
      }
      let category = choice.category;
      if (category === "suggested") category = poi.suggestCategory(p, layer.name, placeCategories()) || (await newCategory());
      else if (category === "new") category = await newCategory();
      docs.push({
        kind: "poi", name: p.name, lat: p.lat, lon: p.lon, category,
        list_id: list.id, notes: p.description || null, url: p.url || null, source: source || null,
      });
    }
  }
  for (let i = 0; i < docs.length; i += 200) await lib.saveDocs(docs.slice(i, i + 200));
  return { list, added: docs.length, duplicates };
}

/** A place added on the map (goes into "My marks" unless a list is given). */
export async function addPlace({ lat, lon, name = "New place", category = "other", notes = null, url = null, list_id = null }) {
  if (!(Number.isFinite(lat) && Number.isFinite(lon))) throw new ServiceError("A place needs a position");
  const list = list_id ? lib.getDoc("poi_list", list_id) : await ensureList("My marks", { id: MARKS_LIST });
  if (!list) throw new ServiceError("No such place list");
  const [p] = await lib.saveDocs([{ kind: "poi", name, lat, lon, category, list_id: list.id, notes, url, source: null }]);
  return p;
}

export async function updatePlace(id, changes) {
  const p = place(id);
  if (!p) throw new ServiceError("Place not found", 404);
  for (const k of ["name", "category", "notes", "url", "lat", "lon", "list_id"]) {
    if (!(k in changes)) continue;
    let v = changes[k];
    if (typeof v === "string") v = v.trim() || null;
    if (k === "name" && !v) continue;
    p[k] = v;
  }
  await lib.saveDocs([p]);
  return p;
}

export async function deletePlaces(ids) {
  return lib.deleteDocs(ids.map((id) => place(id)).filter(Boolean));
}

/** Remove a list with all its places. */
export async function deletePlaceList(id) {
  const list = lib.getDoc("poi_list", id);
  if (!list) return 0;
  const n = await lib.deleteDocs(lib.docsOf("poi").filter((p) => p.list_id === id));
  await lib.deleteDocs([list]);
  return n;
}

export async function setPlaceListVisible(id, visible) {
  const list = lib.getDoc("poi_list", id);
  if (!list) throw new ServiceError("No such place list", 404);
  list.visible = !!visible;
  await lib.saveDocs([list]);
  return list;
}

/** Places near a route (of the lists that are shown): [{place, km, off_m}] in riding order. */
export function placesAlongRoute(id, maxM = config.PLACES_NEAR_ROUTE_M) {
  const r = getRoute(id);
  return poi.placesAlong(r.geometry, r.distance_km, visiblePlaces(), maxM);
}

/** The waypoints in a route's original file (GPX <wpt>, FIT/TCX course points). */
export async function routeWaypoints(r) {
  const file = await lib.getFile(r.file_hash);
  if (!file) return [];
  try {
    return fileWaypoints(file.data);
  } catch {
    return [];
  }
}

/**
 * Places a connector from `from` to `to` ([lat, lon]) could pass without a big detour:
 * [{place, detour_km}] (straight-line detour), fewest extra km first.
 */
export function placesForConnector(from, to, { maxDetourM = null, limit = 30 } = {}) {
  return poi.placesNearLeg(from, to, visiblePlaces(), maxDetourM).slice(0, limit);
}

// ---- places from OpenStreetMap (not stored, unless you keep one)

/** The categories looked up on OpenStreetMap (a setting). */
export const osmCategories = () =>
  (Array.isArray(lib.settings.OSM_CATEGORIES) ? lib.settings.OSM_CATEGORIES : poi.OSM_DEFAULT_CATEGORIES)
    .filter((c) => c in poi.OSM_TAGS);

export async function setOsmCategories(categories) {
  await lib.setSetting("OSM_CATEGORIES", categories.filter((c) => c in poi.OSM_TAGS));
}

const osmLabels = () => Object.fromEntries(placeCategories().map((c) => [c.id, c.label]));

/**
 * Leave out OSM places you already have: kept before (same OpenStreetMap id), the same name
 * within 25 m, or the same category within 10 m (a toilet next to a shelter stays).
 */
function notMine(found) {
  const mine = lib.docsOf("poi");
  const kept = new Set(mine.map((m) => m.osm_id).filter(Boolean));
  return found.filter((p) => !kept.has(p.osm_id) && !poi.isDuplicatePlace(p, mine) &&
    !poi.isDuplicatePlace(p, mine.filter((m) => m.category === p.category).map((m) => ({ ...m, name: p.name })), 10));
}

/**
 * OpenStreetMap places along a route (the categories of osmCategories): [{place, km, off_m}]
 * like placesAlongRoute. `opts` for osm.runQuery (proxyUrl on a server). Slow: seconds.
 */
export async function osmAlongRoute(id, opts = {}) {
  const r = getRoute(id);
  const found = await osm.placesAroundRoute(r.geometry, osmCategories(), osmLabels(), config.PLACES_NEAR_ROUTE_M + 50, opts);
  return poi.placesAlong(r.geometry, r.distance_km, notMine(found), config.PLACES_NEAR_ROUTE_M);
}

/** OpenStreetMap places in a map area [south, west, north, east]. */
export async function osmInArea(bbox, opts = {}) {
  const [s, w, n, e] = bbox;
  if ((n - s) * (e - w) > 0.25) throw new ServiceError("Zoom in further to look for places on OpenStreetMap");
  return notMine(await osm.placesInArea(bbox, osmCategories(), osmLabels(), opts));
}

/**
 * Keep several places found on OpenStreetMap as yours, in one go: into the list `listId`, or a
 * list called `listName` (made when there is none), else "From OpenStreetMap". Places you
 * already kept (same OpenStreetMap id) are skipped. Returns {list, added, skipped}.
 */
export async function keepOsmPlaces(found, { listId = null, listName = null } = {}) {
  const list = listId
    ? lib.getDoc("poi_list", listId)
    : listName && listName.trim()
      ? await ensureList(listName.trim(), { source: "OpenStreetMap" })
      : await ensureList("From OpenStreetMap", { id: "osm", source: "OpenStreetMap" });
  if (!list) throw new ServiceError("No such place list", 404);
  const kept = new Set(lib.docsOf("poi").map((x) => x.osm_id).filter(Boolean));
  const docs = [];
  for (const p of found) {
    if (!p.osm_id || kept.has(p.osm_id)) continue;
    kept.add(p.osm_id);
    docs.push({
      kind: "poi", name: p.name, lat: p.lat, lon: p.lon, category: p.category, list_id: list.id,
      notes: p.notes || null, url: p.url || null, source: "OpenStreetMap", osm_id: p.osm_id,
    });
  }
  for (let i = 0; i < docs.length; i += 200) await lib.saveDocs(docs.slice(i, i + 200));
  return { list, added: docs.length, skipped: found.length - docs.length };
}

/** Keep a place found on OpenStreetMap as one of yours (list "From OpenStreetMap"). */
export async function keepOsmPlace(p) {
  const list = await ensureList("From OpenStreetMap", { id: "osm", source: "OpenStreetMap" });
  const have = lib.docsOf("poi").find((x) => x.osm_id && x.osm_id === p.osm_id);
  if (have) return have;
  const [doc] = await lib.saveDocs([{
    kind: "poi", name: p.name, lat: p.lat, lon: p.lon, category: p.category, list_id: list.id,
    notes: p.notes || null, url: p.url || null, source: "OpenStreetMap", osm_id: p.osm_id,
  }]);
  return doc;
}
