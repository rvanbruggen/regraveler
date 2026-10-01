// The app's "backend", running in the page: what main.py and importer.py did on the server.
// Functions return the same shapes the old JSON API returned, so the UI stays close to the
// server version.

import * as brouter from "./brouter.js";
import * as cb from "./combiner.js";
import * as explorer from "./explorer.js";
import { VERSION, config } from "./config.js";
import { geodesicDistance, pointInPolygon, round, simplifyLatLon, toMetric } from "./geo.js";
import { GpxError, writeGpx } from "./gpx.js";
import * as places from "./places.js";
import * as osm from "./osm.js";
import * as poi from "./poi.js";
import * as share from "./share.js";
import * as trains from "./trains.js";
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

const SORTABLE = new Set(["name", "distance_km", "elevation_gain_m", "paved_pct", "quality_rating", "source_name", "imported_at", "is_loop", "activity", "new_tiles"]);

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
    coll: p.get("coll") || null, // a collection (with its sub-collections)
    region: p.get("region") || null, // a region or province code (of the start), e.g. BE.VLG or BE.VLG.VAN
    area: p.get("area") || null, // an area: routes that start inside it
  };
}

/** Shared filter logic for the library table, the map and proximity. */
export function filterRoutes(f = {}) {
  const ge = (v, min) => min == null || (v != null && v >= min);
  const le = (v, max) => max == null || (v != null && v <= max);
  const q = f.q ? f.q.toLowerCase() : null;
  const ids = f.ids?.length ? new Set(f.ids) : null;
  const wanted = normaliseTags(f.tags || []);
  const inColl = f.coll ? new Set(collectionRouteIds(f.coll)) : null;
  const area = f.area ? lib.getDoc("area", f.area) : null;
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
    (!inColl || inColl.has(r.id)) &&
    (!f.area || (area && startsIn(r, area))) &&
    (!f.region || r.region?.region === f.region || r.region?.province === f.region) &&
    wanted.every((t) => (r.tags || []).includes(t))
  );
  const sort = SORTABLE.has(f.sort) ? f.sort : "name";
  const lower = sort === "name" || sort === "source_name";
  const dir = f.order === "desc" ? -1 : 1;
  const val = (r) => {
    const v = sort === "new_tiles" ? newTiles(r) : r[sort];
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
    // The release in the URL, like the page's modules (workers don't use the import map).
    worker = new Worker(new URL(`./worker.js?v=${VERSION}`, import.meta.url), { type: "module" });
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
  const deleted = await lib.deleteRoutes(ids);
  // Out of the collections too.
  const gone = new Set(ids.map(Number));
  const changed = lib.docsOf("collection").filter((c) => c.route_ids.some((id) => gone.has(id)));
  for (const c of changed) c.route_ids = c.route_ids.filter((id) => !gone.has(id));
  await lib.saveDocs(changed);
  return { deleted };
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

/**
 * The region and province where a route starts (places.regionAt), null when there is none,
 * undefined when the place data could not be read (then it is tried again later).
 */
async function startRegion(lat, lon) {
  try {
    return await places.regionAt(lat, lon);
  } catch (err) {
    console.warn("Could not find the region of a route:", err); // never let this break an import
    return undefined;
  }
}

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
  match_rides = false, same_track_ok = false,
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
    // A variant on the same track (e.g. the route with places as waypoints) may be asked for.
    const twin = same_track_ok ? null : all.find((r) => r.track_hash === th);
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
    const region = await startRegion(st.start_lat, st.start_lon);
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
      ...(region !== undefined ? { region } : {}),
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

const MAX_ROUTES = 4; // different routes in one combination
const MAX_PARTS = 6; // parts in all (a route can give more than one)

const namesOf = (routes) => {
  const names = routes.map((r) => `'${r.name}'`);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};

/** Run fn, turning combiner and BRouter errors into ServiceErrors. */
async function combineErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof cb.CombineError) throw new ServiceError(err.message);
    if (err instanceof brouter.BRouterUnavailable) throw new ServiceError(err.message, 503);
    if (err instanceof brouter.BRouterError) throw new ServiceError(err.message, 502);
    throw err;
  }
}

/** The routes and full-resolution tracks of request parts: {routes, tracks} (maps by route id). */
async function partTracks(reqParts) {
  const routes = new Map(reqParts.map((p) => [p.route_id, getRoute(p.route_id)]));
  const tracks = new Map();
  for (const [id, r] of routes) tracks.set(id, await loadTrack(r));
  return { routes, tracks };
}

/** A request part {route_id, start, end, other_way} as a combiner part (points snapped onto the route). */
function trackPart(p, tracks) {
  if (!p || !Array.isArray(p.start) || !Array.isArray(p.end)) throw new ServiceError("A part needs a start and an end point");
  const t = tracks.get(p.route_id);
  return cb.part(t, cb.locate(t, ...p.start), cb.locate(t, ...p.end), !!p.other_way);
}

/**
 * The router for connectors: the profile asked for, else the one that fits the routes'
 * activity (when they share one). {router, how}; router(p, q, via) as the combiner expects.
 */
function connectorRouter(req, routes, alternative = 0) {
  const acts = new Set([...routes.values()].map((r) => r.activity));
  const byActivity = acts.size === 1 ? config.ACTIVITY_PROFILES[[...acts][0]] : null;
  const profile = req.profile || byActivity || config.BROUTER_PROFILES[0];
  if (!config.BROUTER_PROFILES.includes(profile)) throw new ServiceError(`Unknown profile '${profile}'`);
  const params = req.prefer_unpaved && profile === "gravel" ? { prefer_unpaved_paths: "1" } : null;
  if (req.straight) return { router: cb.straightRouter, how: "straight lines" };
  return {
    router: (p, q, via = []) => brouter.route(p, q, profile, params, null, via, alternative),
    how: `BRouter (${profile}${params ? ", prefer unpaved" : ""})`,
  };
}

/** A place to ride through, by id (null for none). */
function viaPlace(id) {
  if (!id) return null;
  const p = lib.getDoc("poi", id);
  if (!p) throw new ServiceError("A place to ride through was removed");
  return p;
}

/**
 * req: {parts: [{route_id, start: [lat, lon], end: [lat, lon], other_way}], closed, reverse,
 *       profile, prefer_unpaved, straight, vias: [place id | null per connector],
 *       connectors: [approved connector | null per connector]}
 * An approved connector is what combineConnector returned ({from, to, points}); it is used
 * as it is instead of routing again, as long as the parts it joins have not moved.
 */
async function runCombine(req) {
  const reqParts = req.parts || [];
  if (reqParts.length < 2 || reqParts.length > MAX_PARTS) throw new ServiceError(`Use 2 to ${MAX_PARTS} parts`);
  const ids = reqParts.map((p) => p.route_id);
  const distinct = new Set(ids).size;
  if (distinct < 2) throw new ServiceError("Choose at least two different routes");
  if (distinct > MAX_ROUTES) throw new ServiceError(`Combine at most ${MAX_ROUTES} routes`);
  const { routes, tracks } = await partTracks(reqParts);
  const { router, how } = connectorRouter(req, routes);
  // Connectors through a place: vias[k] is the id of a place connector k must pass.
  const viaPlaces = (req.vias || []).map(viaPlace);
  const vias = viaPlaces.map((p) => (p ? [[p.lat, p.lon]] : []));
  if (req.connectors != null && !Array.isArray(req.connectors)) throw new ServiceError("connectors must be a list");
  const result = await combineErrors(() => cb.combineParts(reqParts.map((p) => trackPart(p, tracks)), router, {
    closed: req.closed !== false, reverse: !!req.reverse, directJoinM: config.DIRECT_JOIN_M, vias, connectors: req.connectors || [],
  }));
  const used = [...new Map(ids.map((id) => [id, routes.get(id)])).values()];
  const through = viaPlaces.filter(Boolean).map((p) => p.name);
  // With approved connectors, say how those were made (they may differ from each other).
  const approved = cb.connectorsOf(result).filter((l) => l.approved);
  const hows = approved.length === cb.connectorsOf(result).length && approved.length
    ? [...new Set((req.connectors || []).map((c) => c?.how).filter((h) => typeof h === "string" && h))]
    : [];
  return {
    used, result, viaPlaces,
    description: `Combined from ${namesOf(used)} via ${hows.length ? hows.join(" and ") : how}${through.length ? `, through ${through.join(" and ")}` : ""}.`,
  };
}

/**
 * Route one connection, to show it before it is used: from the end of from_part to the start
 * of to_part (parts as in runCombine). req: {from_part, to_part, profile, prefer_unpaved,
 * straight, via: place id | null, alternative: 0 (BRouter's best route) to 3}.
 * Returns {from, to, points: [[lat, lon, ele], ...], distance_km, routed (false: a straight line),
 * how (e.g. "BRouter (gravel)"), alternative, via};
 * pass it back in runCombine's `connectors` to use exactly this route.
 */
export async function combineConnector(req) {
  const alternative = req.alternative ?? 0;
  if (!Number.isInteger(alternative) || alternative < 0 || alternative >= brouter.ALTERNATIVES) {
    throw new ServiceError(`Choose an alternative from 0 to ${brouter.ALTERNATIVES - 1}`);
  }
  const reqParts = [req.from_part, req.to_part];
  if (reqParts.some((p) => !p)) throw new ServiceError("A connection needs the part it leaves and the part it joins");
  const { routes, tracks } = await partTracks(reqParts);
  const { router, how } = connectorRouter(req, routes, alternative);
  const place = viaPlace(req.via);
  const [from, to] = reqParts.map((p) => trackPart(p, tracks));
  const p = cb.pointAt(from.track, from.endAt), q = cb.pointAt(to.track, to.startAt);
  const leg = await combineErrors(() => cb.routeConnector(p, q, router, config.DIRECT_JOIN_M, place ? [[place.lat, place.lon]] : []));
  return {
    from: ll(cb.latLonOf(p)),
    to: ll(cb.latLonOf(q)),
    points: cb.toLatLon(leg.xyz).map(([lat, lon, ele]) => [round(lat, 6), round(lon, 6), ele == null ? null : round(ele, 1)]),
    distance_km: round(cb.legLength(leg.xyz) / 1000, 2),
    routed: leg.routed && !req.straight, // false: a straight line
    how: leg.routed && !req.straight ? how : "straight lines",
    alternative,
    via: place ? { id: place.id, name: place.name } : null,
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
      distance_km: round(cb.legLength(l.xyz) / 1000, 2), routed: l.routed, approved: !!l.approved,
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
 * OpenStreetMap places within `rangeM` metres of a route (the categories of osmCategories):
 * [{place, km, off_m}] like placesAlongRoute. `opts` for osm.runQuery (proxyUrl on a server).
 * Slow: seconds, more for a wider range (bigger boxes to search).
 */
export async function osmAlongRoute(id, opts = {}, rangeM = config.PLACES_NEAR_ROUTE_M) {
  const r = getRoute(id);
  if (!(rangeM > 0 && rangeM <= 5000)) throw new ServiceError("Look for places within 5 km of the route at most");
  const found = await osm.placesAroundRoute(r.geometry, osmCategories(), osmLabels(), rangeM + 50, opts);
  return poi.placesAlong(r.geometry, r.distance_km, notMine(found), rangeM);
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

// ------------------------------------------------------------------ search for places (utility)

/**
 * Places along a route, from your places (the lists that are shown) and/or OpenStreetMap:
 * req {route_id, sources: ["mine", "osm"], range_m, categories}. Returns {found: [{place, km,
 * off_m, source: "mine" | "osm"}] in riding order, osm_error}: when OpenStreetMap doesn't
 * answer, your own places are still found (osm_error says why the others are missing).
 * OpenStreetMap only knows the kinds in OSM_TAGS.
 */
export async function findPlacesAlong(req, opts = {}) {
  const r = getRoute(req.route_id);
  const range = Number(req.range_m) || config.PLACES_NEAR_ROUTE_M;
  if (!(range > 0 && range <= 5000)) throw new ServiceError("Look for places within 5 km of the route at most");
  const cats = new Set(req.categories || []);
  if (!cats.size) throw new ServiceError("Choose at least one kind of place");
  const sources = new Set(req.sources || ["mine"]);
  if (!sources.size) throw new ServiceError("Choose where to look: your places and/or OpenStreetMap");
  const out = [];
  if (sources.has("mine")) {
    const mine = visiblePlaces().filter((p) => cats.has(p.category));
    for (const a of poi.placesAlong(r.geometry, r.distance_km, mine, range)) out.push({ ...a, source: "mine" });
  }
  const osmCats = [...cats].filter((c) => c in poi.OSM_TAGS);
  let osmError = null;
  if (sources.has("osm") && osmCats.length) {
    try {
      const found = await osm.placesAroundRoute(r.geometry, osmCats, osmLabels(), range + 50, opts);
      for (const a of poi.placesAlong(r.geometry, r.distance_km, notMine(found), range)) out.push({ ...a, source: "osm" });
    } catch (err) {
      if (!(err instanceof osm.OverpassUnavailable) || !sources.has("mine")) throw err;
      osmError = err.message;
    }
  }
  return { found: out.sort((a, b) => a.km - b.km), osm_error: osmError };
}

const DETOUR_MIN_OFF_M = 30; // places closer to the route than this are passed anyway

/**
 * The route with places: req {route_id, places: [{lat, lon, name, category, notes, url}],
 * waypoints (write them into the GPX), detours (ride to each place), straight}. A detour
 * leaves the route some way before the place and rejoins it after (BRouter through the
 * place); places close together share one detour.
 */
async function runWithPlaces(req) {
  const r = getRoute(req.route_id);
  const places = (req.places || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!places.length) throw new ServiceError("Select at least one place");
  if (!req.waypoints && !req.detours) throw new ServiceError("Choose waypoints, detours or both");
  const track = await loadTrack(r);
  const len = track.length;
  const located = places.map((p) => {
    const at = cb.locate(track, p.lat, p.lon);
    const q = cb.pointAt(track, at);
    const [x, y] = toMetric(p.lat, p.lon);
    return { p, at, off: Math.hypot(q[0] - x, q[1] - y) };
  }).sort((a, b) => a.at - b.at);

  let points = cb.toLatLon(track.xyz);
  const detours = [];
  if (req.detours) {
    // Leave the route about twice as far before the place as it lies off the route.
    const groups = [];
    for (const l of located.filter((x) => x.off > DETOUR_MIN_OFF_M)) {
      const w = Math.min(3000, Math.max(300, 2 * l.off));
      const from = Math.max(0, l.at - w), to = Math.min(len, l.at + w);
      const last = groups[groups.length - 1];
      if (last && from <= last.to) {
        last.to = Math.max(last.to, to);
        last.places.push(l);
      } else groups.push({ from, to, places: [l] });
    }
    if (groups.length) {
      const profile = config.ACTIVITY_PROFILES[r.activity] || config.BROUTER_PROFILES[0];
      const router = req.straight ? cb.straightRouter : (p, q, via = []) => brouter.route(p, q, profile, null, null, via);
      const parts = [];
      let at = 0;
      try {
        for (const g of groups) {
          if (g.from > at) parts.push(cb.section(track, at, g.from));
          const via = g.places.map((l) => [l.p.lat, l.p.lon]);
          const routed = await router(cb.latLonOf(cb.pointAt(track, g.from)), cb.latLonOf(cb.pointAt(track, g.to)), via);
          const xyz = routed.map(([lat, lon, e]) => [...toMetric(lat, lon), e == null ? NaN : e]);
          parts.push(xyz);
          detours.push({
            km: round(g.from / 1000, 1),
            places: g.places.map((l) => l.p.name),
            extra_km: round((cb.legLength(xyz) - (g.to - g.from)) / 1000, 2),
          });
          at = g.to;
        }
      } catch (err) {
        if (err instanceof brouter.BRouterUnavailable) throw new ServiceError(err.message, 503);
        if (err instanceof brouter.BRouterError) throw new ServiceError(err.message, 502);
        throw err;
      }
      if (at < len) parts.push(cb.section(track, at, len));
      points = cb.toLatLon(cb.join(parts));
    }
  }
  const cats = placeCategories();
  const waypoints = req.waypoints
    ? located.map(({ p }) => ({
        lat: p.lat, lon: p.lon, name: p.name,
        desc: [cats.find((c) => c.id === p.category)?.label, p.notes, p.url].filter(Boolean).join("\n") || null,
        type: cats.find((c) => c.id === p.category)?.label || null,
      }))
    : [];
  const names = located.map((l) => l.p.name);
  const description = `${r.name}` +
    (detours.length ? `, riding to ${detours.reduce((n, d) => n + d.places.length, 0)} place(s)` : "") +
    (waypoints.length ? `, with ${waypoints.length} place(s) as waypoints` : "") +
    `: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}.`;
  return { route: r, points, waypoints, detours, description };
}

export async function withPlacesPreview(req) {
  const { route: r, points, waypoints, detours, description } = await runWithPlaces(req);
  const stats = computeStats(points);
  return {
    description,
    distance_km: stats.distance_km,
    extra_km: round(stats.distance_km - r.distance_km, 2),
    elevation_gain_m: stats.elevation_gain_m,
    geometry: stats.geometry,
    detours,
    waypoints: waypoints.length,
  };
}

export async function withPlacesGpx(req) {
  const { points, waypoints, description } = await runWithPlaces(req);
  return { filename: `${req.name}.gpx`.replace(/"/g, ""), text: writeGpx(req.name, points, description, "rerouter", waypoints) };
}

/** Save the route with its places as a new route (the original is left as it is). */
export async function withPlacesSave(req) {
  const name = String(req.name || "").trim();
  if (!name) throw new ServiceError("Give the route a name");
  const { route: orig, points, waypoints, detours, description } = await runWithPlaces(req);
  const data = new TextEncoder().encode(writeGpx(name, points, description, "rerouter", waypoints));
  const notes = description + (orig.notes && orig.notes.trim() ? `\n\n${orig.notes.trim()}` : "");
  const res = await importGpx(data, `${slugify(name).slice(0, 150)}.gpx`, {
    source_name: orig.source_name, source_url: orig.source_url, derived_from: [orig.id],
    tags: [...(orig.tags || [])], notes, activity: orig.activity, name,
    same_track_ok: !detours.length, // only waypoints added: the same track, on purpose
  });
  if (res.status !== "imported") {
    if (res.status === "duplicate" && res.duplicates.length) {
      throw new ServiceError(`This route is already saved as '${res.duplicates[0].name}'`, 409);
    }
    throw new ServiceError(`Could not save the route: ${res.message}`, 500);
  }
  const created = lib.get(res.routes[0].id);
  created.quality_rating = orig.quality_rating;
  if (!detours.length) {
    // The same roads: the same surface too, and not a duplicate to clean up.
    created.paved_pct = orig.paved_pct;
    created.paved_source = orig.paved_source;
    created.surface = orig.surface;
    await lib.saveRoutes([created]);
    await lib.ignorePairs([[orig.id, created.id]]);
  } else {
    await lib.saveRoutes([created]);
    if (config.SURFACE_AUTO_ESTIMATE) surfaceJob.enqueue([created.id]);
  }
  return { id: created.id, name: created.name };
}

// ------------------------------------------------------------------ catalog
// Documents: "collection" {name, parent_id, route_ids} (made by hand, nestable), "smart"
// {name, query} (a saved filter), "area" {name, polygon: [[lat, lon], ...]} (routes that
// start inside it). The rest of the catalog (activity, source, tags, loop) comes from the
// routes themselves.

const byNameCi = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

export const collections = () => lib.docsOf("collection").sort(byNameCi);
export const smartCollections = () => lib.docsOf("smart").sort(byNameCi);
export const areas = () => lib.docsOf("area").sort(byNameCi);

function getColl(id) {
  const c = lib.getDoc("collection", id);
  if (!c) throw new ServiceError("Collection not found", 404);
  return c;
}

/** The ids of a collection and all collections below it. */
function collectionFamily(id) {
  const all = lib.docsOf("collection");
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) out.add(c.id), (grew = true);
  }
  return out;
}

/** Route ids in a collection or any collection below it (only routes that still exist). */
export function collectionRouteIds(id) {
  const fam = collectionFamily(id);
  const ids = new Set();
  for (const c of lib.docsOf("collection")) if (fam.has(c.id)) for (const r of c.route_ids) if (lib.get(r)) ids.add(r);
  return [...ids];
}

/** "Trips › Ardennes 2026" */
export function collectionPath(id) {
  const names = [];
  const seen = new Set();
  for (let c = lib.getDoc("collection", id); c && !seen.has(c.id); c = c.parent_id ? lib.getDoc("collection", c.parent_id) : null) {
    seen.add(c.id);
    names.unshift(c.name);
  }
  return names.join(" › ");
}

export async function createCollection({ name, parent_id = null }) {
  name = String(name || "").trim();
  if (!name) throw new ServiceError("A collection needs a name");
  if (parent_id) getColl(parent_id);
  const twin = lib.docsOf("collection").find((c) => (c.parent_id || null) === (parent_id || null) && c.name.toLowerCase() === name.toLowerCase());
  if (twin) return twin;
  const [c] = await lib.saveDocs([{ kind: "collection", name, parent_id: parent_id || null, route_ids: [] }]);
  return c;
}

/** Rename and/or move a collection (parent_id null: to the top). */
export async function updateCollection(id, { name, parent_id } = {}) {
  const c = getColl(id);
  if (name != null) {
    name = String(name).trim();
    if (!name) throw new ServiceError("A collection needs a name");
    c.name = name;
  }
  if (parent_id !== undefined) {
    if (parent_id && collectionFamily(id).has(parent_id)) throw new ServiceError("A collection can't go inside itself");
    if (parent_id) getColl(parent_id);
    c.parent_id = parent_id || null;
  }
  await lib.saveDocs([c]);
  return c;
}

/** Remove a collection; the collections below it move up a level; the routes stay. */
export async function deleteCollection(id) {
  const c = getColl(id);
  const kids = lib.docsOf("collection").filter((x) => x.parent_id === id);
  for (const k of kids) k.parent_id = c.parent_id || null;
  await lib.saveDocs(kids);
  await lib.deleteDocs([c]);
}

export async function addToCollection(id, routeIds) {
  const c = getColl(id);
  const have = new Set(c.route_ids);
  const add = routeIds.map(Number).filter((r) => lib.get(r) && !have.has(r));
  c.route_ids = [...c.route_ids, ...add];
  await lib.saveDocs([c]);
  return { added: add.length };
}

export async function removeFromCollection(id, routeIds) {
  const c = getColl(id);
  const out = new Set(routeIds.map(Number));
  const before = c.route_ids.length;
  c.route_ids = c.route_ids.filter((r) => !out.has(r));
  await lib.saveDocs([c]);
  return { removed: before - c.route_ids.length };
}

/** The collections a route is in (directly): [{id, path}]. */
export function collectionsOf(routeId) {
  return lib.docsOf("collection").filter((c) => c.route_ids.includes(Number(routeId)))
    .map((c) => ({ id: c.id, path: collectionPath(c.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// ---- smart collections: saved filters

const SMART_KEYS = ["q", "min_distance", "max_distance", "min_gain", "max_gain", "min_paved", "max_paved", "min_quality", "tags", "source", "loop", "activity", "coll", "area", "region"];

/** The filter part of a query string (no sorting, views or selections). */
export function filterQuery(params) {
  const p = new URLSearchParams(params);
  const out = new URLSearchParams();
  for (const k of SMART_KEYS) for (const v of p.getAll(k)) if (v !== "") out.append(k, v);
  return out.toString();
}

export async function saveSmart({ id = null, name, query }) {
  name = String(name || "").trim();
  if (!name) throw new ServiceError("A smart collection needs a name");
  const q = filterQuery(query);
  if (!q) throw new ServiceError("Set some filters first: a smart collection is a saved filter");
  const doc = id ? lib.getDoc("smart", id) : null;
  if (id && !doc) throw new ServiceError("Smart collection not found", 404);
  const [s] = await lib.saveDocs([{ ...(doc || { kind: "smart" }), name, query: q }]);
  return s;
}

export async function deleteSmart(id) {
  await lib.deleteDocs([`smart:${id}`]);
}

// ---- areas

function startsIn(r, area) {
  return pointInPolygon(r.start_lat, r.start_lon, area.polygon);
}

export async function saveArea({ id = null, name, polygon }) {
  name = String(name || "").trim();
  if (!name) throw new ServiceError("An area needs a name");
  const doc = id ? lib.getDoc("area", id) : null;
  if (id && !doc) throw new ServiceError("Area not found", 404);
  const poly = polygon ?? doc?.polygon;
  if (!Array.isArray(poly) || poly.length < 3 || poly.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    throw new ServiceError("An area needs at least three points");
  }
  const [a] = await lib.saveDocs([{ ...(doc || { kind: "area" }), name, polygon: poly.map(([la, lo]) => [round(la, 6), round(lo, 6)]) }]);
  return a;
}

export async function deleteArea(id) {
  await lib.deleteDocs([`area:${id}`]);
}

/** Import areas (polygons) from a KML/KMZ file read by poi.readAreasFile; same names are replaced. */
export async function importAreas(found) {
  const mine = lib.docsOf("area");
  let added = 0, replaced = 0;
  for (const a of found) {
    const same = mine.find((m) => m.name.toLowerCase() === a.name.toLowerCase());
    await saveArea({ id: same?.id || null, name: a.name, polygon: a.polygon });
    same ? replaced++ : added++;
  }
  return { added, replaced };
}

/** The areas a route starts in. */
export const areasOf = (routeId) => lib.docsOf("area").filter((a) => startsIn(getRoute(routeId), a)).sort(byNameCi);

// ---- VeloViewer explorer tiles
// Document "explorer_tiles" {name, mode: "explored" | "missing", tiles: [key, ...], active,
// source_file, imported_at}. The active set is the one on the maps and in the route stats.

export const tileSets = () => lib.docsOf("explorer_tiles").sort(byNameCi);
export const activeTileSet = () => {
  const all = tileSets();
  return all.find((t) => t.active) || all[0] || null;
};

const tileSetCache = new Map(); // id -> {source, set, square, cluster}
/** The tiles of a set as a Set, with its max square and max cluster (explored sets only). */
export function tileSetInfo(t) {
  const hit = tileSetCache.get(t.id);
  if (hit && hit.source === t.tiles) return hit;
  const set = new Set(t.tiles);
  const info = {
    source: t.tiles, set,
    square: t.mode === "explored" ? explorer.maxSquare(set) : null,
    cluster: t.mode === "explored" ? explorer.maxCluster(set) : null,
  };
  tileSetCache.set(t.id, info);
  return info;
}

/** Import a parsed export (explorer.readTilesFile); a set with the same name is replaced. */
export async function importTileSet(parsed, { name, source_file = null } = {}) {
  name = String(name || parsed.name || "").trim();
  if (!name) throw new ServiceError("Explorer tiles need a name");
  const same = tileSets().find((t) => t.name.toLowerCase() === name.toLowerCase());
  const [doc] = await lib.saveDocs([{
    ...(same || { kind: "explorer_tiles", active: !tileSets().length }),
    name, mode: parsed.mode, zoom: explorer.TILE_ZOOM, tiles: parsed.tiles, source_file, imported_at: new Date().toISOString(),
  }]);
  return { set: doc, replaced: !!same };
}

export async function updateTileSet(id, changes) {
  const t = lib.getDoc("explorer_tiles", id);
  if (!t) throw new ServiceError("Explorer tiles not found", 404);
  const next = { ...t };
  if (changes.name != null && String(changes.name).trim()) next.name = String(changes.name).trim();
  if (changes.mode === "explored" || changes.mode === "missing") next.mode = changes.mode;
  await lib.saveDocs([next]);
  tileSetCache.delete(id);
}

export async function setActiveTileSet(id) {
  await lib.saveDocs(tileSets().filter((t) => !!t.active !== (t.id === id)).map((t) => ({ ...t, active: t.id === id })));
}

export async function deleteTileSet(id) {
  await lib.deleteDocs([`explorer_tiles:${id}`]);
  tileSetCache.delete(id);
}

const routeTilesCache = new Map(); // route id -> {source, tiles}
/** The explorer tiles a route passes through (keys, in order). */
export function routeTiles(r) {
  const hit = routeTilesCache.get(r.id);
  if (hit && hit.source === r.geometry) return hit.tiles;
  const tiles = explorer.lineTiles(r.geometry);
  routeTilesCache.set(r.id, { source: r.geometry, tiles });
  return tiles;
}

/** How many new tiles a route gets you in the active set (null without one). */
export function newTiles(r) {
  const t = activeTileSet();
  return t ? explorer.routeGain(routeTiles(r), tileSetInfo(t).set, t.mode).fresh.length : null;
}

/**
 * A route against the active set: {set: {id, name, mode}, tiles, fresh: [key, ...], square,
 * squareAfter, cluster, clusterAfter} (the max square and cluster before and after riding it,
 * for an explored set), or null without a set.
 */
export function routeExplorer(id) {
  const t = activeTileSet();
  if (!t) return null;
  const info = tileSetInfo(t);
  const { tiles, fresh } = explorer.routeGain(routeTiles(getRoute(id)), info.set, t.mode);
  const out = { set: { id: t.id, name: t.name, mode: t.mode }, tiles, fresh };
  if (t.mode === "explored") {
    const after = new Set([...info.set, ...fresh]);
    Object.assign(out, {
      square: info.square.size, squareAfter: fresh.length ? explorer.maxSquare(after).size : info.square.size,
      cluster: info.cluster.size, clusterAfter: fresh.length ? explorer.maxCluster(after).size : info.cluster.size,
    });
  }
  return out;
}

// ---- the whole catalog, with counts (for the browse tree)

export function catalog() {
  const routes = lib.all();
  const count = (pred) => routes.filter(pred).length;
  const tally = (key) => {
    const m = new Map();
    for (const r of routes) for (const v of [].concat(r[key] ?? [])) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m].map(([value, n]) => ({ value, count: n }));
  };
  const colls = lib.docsOf("collection");
  const tree = (parent) => colls.filter((c) => (c.parent_id || null) === parent).sort(byNameCi)
    .map((c) => ({ id: c.id, name: c.name, count: collectionRouteIds(c.id).length, children: tree(c.id) }));
  return {
    total: routes.length,
    collections: tree(null),
    smart: smartCollections().map((s) => ({ id: s.id, name: s.name, query: s.query, count: filterRoutes(filtersFrom(s.query)).length })),
    areas: areas().map((a) => ({ id: a.id, name: a.name, count: count((r) => startsIn(r, a)) })),
    regions: regionTree(routes),
    activities: config.ACTIVITIES.map((a) => ({ value: a, count: count((r) => r.activity === a) })).filter((x) => x.count),
    sources: tally("source_name").sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    tags: tally("tags").sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    loops: [{ value: "true", count: count((r) => r.is_loop) }, { value: "false", count: count((r) => !r.is_loop) }],
  };
}

/** Regions › provinces of the routes' starts, with counts, most routes first. */
function regionTree(routes) {
  const regions = new Map();
  for (const r of routes) {
    const g = r.region;
    if (!g) continue;
    let reg = regions.get(g.region);
    if (!reg) regions.set(g.region, (reg = { code: g.region, name: g.region_name, count: 0, provinces: new Map() }));
    reg.count++;
    const p = reg.provinces.get(g.province) || { code: g.province, name: g.province_name, count: 0 };
    p.count++;
    reg.provinces.set(g.province, p);
  }
  const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  return [...regions.values()].sort(byCount).map((g) => ({ ...g, provinces: [...g.provinces.values()].sort(byCount) }));
}

/**
 * Routes that have no region yet (from before regions, or the place data could not be read
 * then) get one. Runs in the background after start-up; returns how many were looked up.
 */
export async function backfillRegions() {
  const missing = lib.all().filter((r) => r.region === undefined);
  const changed = [];
  for (const r of missing) {
    const region = await startRegion(r.start_lat, r.start_lon);
    if (region === undefined) break; // no place data now: try again next time
    r.region = region;
    changed.push(r);
  }
  for (let i = 0; i < changed.length; i += 50) await lib.saveRoutes(changed.slice(i, i + 50));
  return changed.length;
}

// ------------------------------------------------------------------ home and share links

/** Your home: {lat, lon, radius_m} (a setting, never shared), or null. */
export function home() {
  const h = lib.settings.HOME;
  return h && Number.isFinite(h.lat) && Number.isFinite(h.lon) ? { radius_m: config.HOME_PRIVACY_M, ...h } : null;
}

export async function setHome(h) {
  if (h == null) return lib.setSetting("HOME", null);
  const radius = Number(h.radius_m ?? home()?.radius_m ?? config.HOME_PRIVACY_M);
  if (!(Number.isFinite(h.lat) && Number.isFinite(h.lon))) throw new ServiceError("Home needs a position");
  if (!(radius >= 0 && radius <= 5000)) throw new ServiceError("The privacy zone is 0 to 5000 m");
  await lib.setSetting("HOME", { lat: round(h.lat, 5), lon: round(h.lon, 5), radius_m: Math.round(radius) });
  return home();
}

/**
 * A share link for a route: {link, chars, points, tolerance_m, cut_start_m, cut_end_m}.
 * opts: {privacy (leave out the start and end near home), notes, source, base (the site)}.
 */
export async function shareRoute(id, { privacy = true, notes = false, source = false, base = config.PUBLIC_SITE_URL } = {}) {
  const r = getRoute(id);
  const file = await lib.getFile(r.file_hash);
  if (!file) throw new ServiceError("The route's file was not found in the library", 404);
  let points = parseTrackFile(file.data).tracks[r.track_index || 0].points;
  let cut = { cut_start_m: 0, cut_end_m: 0 };
  const h = home();
  if (privacy && h) {
    try {
      ({ points, ...cut } = share.cutPrivacy(points, h, h.radius_m));
    } catch (err) {
      throw new ServiceError(err.message);
    }
  }
  const st = computeStats(points); // of what is shared
  const packed = await share.packShare({
    name: r.name, activity: r.activity, distance_km: st.distance_km, elevation_gain_m: st.elevation_gain_m,
    // The surface share of the whole route (a privacy cut of a few hundred metres hardly changes it).
    is_loop: r.is_loop && !cut.cut_start_m && !cut.cut_end_m, surface: r.surface,
    notes: notes ? r.notes : null, source_url: source ? r.source_url : null, points,
  });
  const link = `${base.replace(/#.*$/, "")}#share=${packed.packed}`;
  return { link, chars: link.length, points: packed.points, tolerance_m: packed.tolerance_m, ...cut };
}

/** A route read from a share link (share.unpackShare) as a GPX file: {filename, text}. */
export function sharedGpx(shared) {
  const name = shared.name || "Shared route";
  return { filename: `${slugify(name).slice(0, 150) || "route"}.gpx`, text: writeGpx(name, shared.points, shared.notes) };
}

/** Add a route from a share link to the library (source "shared link"). */
export async function addSharedRoute(shared) {
  const { filename, text } = sharedGpx(shared);
  const res = await importGpx(new TextEncoder().encode(text), filename, {
    source_name: "shared link", source_url: shared.source_url, notes: shared.notes,
    activity: shared.activity && config.ACTIVITIES.includes(shared.activity) ? shared.activity : null,
    name: shared.name, rename: false,
  });
  if (res.status === "duplicate") throw new ServiceError(`You already have this route: ${res.duplicates[0]?.name || "in your library"}`, 409);
  if (res.status !== "imported") throw new ServiceError(res.message || "Could not add the route", 422);
  return { id: res.routes[0].id, name: res.routes[0].name };
}

// ------------------------------------------------------------------ train rides

const TRAIN_BUFFER_MIN = 10; // from arriving at a station on the bike to the train leaving

/** Stations near home (for choosing the home station), nearest first. */
export async function homeStations(maxM = 15000) {
  const h = home();
  if (!h) return [];
  return trains.stationsNear(await trains.allStations(), h.lat, h.lon, maxM).slice(0, 12)
    .map((x) => ({ key: `${x.station.name}@${x.station.lat},${x.station.lon}`, name: x.station.name, km: round(x.m / 1000, 1), station: x.station }));
}

const addMin = (d, min) => new Date(d.getTime() + min * 60000);

/**
 * Days out with the train, with library routes as the riding part. req: {date "YYYY-MM-DD",
 * start "HH:MM" (leaving home), patterns, max_transfers, max_station_m, home_reach_m,
 * min_km, max_km, speed_kmh, activities, home_station (key from homeStations)}. Plans the
 * candidates offline, then asks the timetables for the best ones (config.TRAIN_TRIPS).
 * Returns {candidates, trips: [...], failed, home_station}; trips have legs of kind "ride"
 * and "train", leave and back (Date), day_hours, ride_km.
 */
export async function trainRides(req, { fetchFn = fetch, onProgress = null } = {}) {
  const h = home();
  if (!h) throw new ServiceError("Set your home first (⚙ Library & settings › Home): train rides start and end there");
  const list = await trains.allStations();
  const near = await homeStations();
  const chosen = near.find((x) => x.key === req.home_station) || near[0];
  if (!chosen) throw new ServiceError("There is no train station within 15 km of your home");
  const homeStation = chosen.station;
  const speed = Number(req.speed_kmh) || 20;
  const activities = new Set(req.activities?.length ? req.activities : ["gravel", "road", "mtb"]);
  const routes = lib.all().filter((r) => activities.has(r.activity));
  const cands = trains.planCandidates(routes, list, {
    patterns: req.patterns, home: h, homeStation,
    maxStationM: Number(req.max_station_m) || 3000, homeReachM: Number(req.home_reach_m) || 5000,
    minKm: Number(req.min_km) || 0, maxKm: Number(req.max_km) || Infinity,
  });
  const [y, mo, d] = String(req.date).split("-").map(Number);
  const [hh, mm] = String(req.start || "08:00").split(":").map(Number);
  const leave = new Date(y, mo - 1, d, hh, mm);
  if (Number.isNaN(leave.getTime())) throw new ServiceError("Choose a date and a start time");
  const homeLegKm = round((geodesicDistanceKm(h, homeStation) * 1.3), 1);
  const rideMin = (km) => Math.round((km / speed) * 60);
  const maxTransfers = Number(req.max_transfers ?? 2);
  const train = (from, to, after) => trains.connections(from, to, after, { maxTransfers, fetchFn }).then((l) => l.find((c) => c.dep >= after) || null);

  const trips = [], failed = [];
  // Each chosen pattern gets its turn (else loops next to a station would take every place).
  const byPattern = trains.PATTERNS.map((p) => cands.filter((c) => c.pattern === p)).filter((l) => l.length);
  const todo = [];
  for (let i = 0; todo.length < config.TRAIN_TRIPS && byPattern.some((l) => i < l.length); i++) {
    for (const l of byPattern) if (i < l.length && todo.length < config.TRAIN_TRIPS) todo.push(l[i]);
  }
  for (const [n, c] of todo.entries()) {
    onProgress?.(n, todo.length);
    const r = lib.get(c.route_id);
    try {
      const legs = [];
      let t = leave;
      const ride = (from, to, km) => {
        const end = addMin(t, rideMin(km));
        legs.push({ kind: "ride", from, to, km: round(km, 1), start: t, end });
        t = end;
      };
      const takeTrain = async (from, to) => {
        const conn = await train(from, to, addMin(t, TRAIN_BUFFER_MIN));
        if (!conn) throw new Error(`no train from ${from.name} to ${to.name} with at most ${maxTransfers} transfer(s) that day`);
        legs.push({ kind: "train", from: from.name, to: to.name, conn });
        t = conn.arr;
      };
      if (c.pattern === "ride-out") {
        ride("home", c.to.name, c.ride_km);
        await takeTrain(c.to, homeStation);
        if (homeLegKm > 0.3) ride(homeStation.name, "home", homeLegKm);
      } else {
        if (homeLegKm > 0.3) ride("home", homeStation.name, homeLegKm);
        await takeTrain(homeStation, c.from);
        if (c.pattern === "train-out") ride(c.from.name, "home", c.ride_km);
        else {
          ride(c.from.name, c.to.name, c.ride_km);
          await takeTrain(c.to, homeStation);
          if (homeLegKm > 0.3) ride(homeStation.name, "home", homeLegKm);
        }
      }
      trips.push({
        ...c, from: c.from === "home" ? "home" : c.from.name, to: c.to === "home" ? "home" : c.to.name,
        from_station: c.from === "home" ? null : c.from, to_station: c.to === "home" ? null : c.to,
        route_name: r.name, route_km: r.distance_km, elevation_gain_m: r.elevation_gain_m,
        legs, leave, back: t, day_hours: round((t - leave) / 3600000, 1),
        train_minutes: legs.filter((l) => l.kind === "train").reduce((s, l) => s + l.conn.minutes, 0),
      });
    } catch (err) {
      if (err instanceof trains.TrainsUnavailable && !trips.length && n === todo.length - 1) throw new ServiceError(err.message, 503);
      failed.push({ route_name: r.name, pattern: c.pattern, reason: err.message });
    }
  }
  trips.sort((a, b) => a.back - b.back || a.day_hours - b.day_hours);
  return { candidates: cands.length, asked: todo.length, trips, failed, home_station: chosen.name };
}

function geodesicDistanceKm(a, b) {
  return geodesicDistance(a.lat, a.lon, b.lat, b.lon) / 1000;
}

/**
 * The riding part of a train trip as a route: from the station (or home) to the route, the
 * route (the other way round, or a loop from the station), and on to the station (or home),
 * with connectors routed by BRouter (or straight, `straight`). {points, description}.
 */
async function trainTripRoute(trip, { straight = false } = {}) {
  const r = getRoute(trip.route_id);
  const h = home();
  const track = await loadTrack(r);
  let body;
  if (trip.pattern === "loop") body = cb.restartLoop(track, trip.start_at_m || 0);
  else body = trip.reversed ? cb.section(track, track.length, 0) : cb.section(track, 0, track.length);
  const place = (end) => (end === "home" ? [h.lat, h.lon] : null);
  const from = trip.from_station ? [trip.from_station.lat, trip.from_station.lon] : place(trip.from);
  const to = trip.to_station ? [trip.to_station.lat, trip.to_station.lon] : place(trip.to);
  const profile = config.ACTIVITY_PROFILES[r.activity] || config.BROUTER_PROFILES[0];
  const router = straight ? cb.straightRouter : (p, q) => brouter.route(p, q, profile);
  const xyz = (pts) => pts.map(([lat, lon, e]) => [...toMetric(lat, lon), e == null ? NaN : e]);
  const parts = [];
  try {
    const first = cb.latLonOf(body[0]), last = cb.latLonOf(body[body.length - 1]);
    if (from && geodesicDistance(from[0], from[1], first[0], first[1]) > 30) parts.push(xyz(await router(from, first)));
    parts.push(body);
    if (to && geodesicDistance(to[0], to[1], last[0], last[1]) > 30) parts.push(xyz(await router(last, to)));
  } catch (err) {
    if (err instanceof brouter.BRouterUnavailable) throw new ServiceError(err.message, 503);
    if (err instanceof brouter.BRouterError) throw new ServiceError(err.message, 502);
    throw err;
  }
  const trainsText = (trip.legs || []).filter((l) => l.kind === "train")
    .map((l) => `${l.conn.trains.join(" + ")} ${l.from} → ${l.to}`).join("; ");
  const description = `Train ride: ${r.name}, from ${trip.from} to ${trip.to}` + (trainsText ? ` (${trainsText})` : "") + ".";
  return { route: r, points: cb.toLatLon(cb.join(parts)), description };
}

export async function trainTripGpx(trip, name, opts = {}) {
  const { points, description } = await trainTripRoute(trip, opts);
  return { filename: `${name}.gpx`.replace(/"/g, ""), text: writeGpx(name, points, description) };
}

export async function trainTripSave(trip, name, opts = {}) {
  name = String(name || "").trim();
  if (!name) throw new ServiceError("Give the route a name");
  const { route: orig, points, description } = await trainTripRoute(trip, opts);
  const res = await importGpx(new TextEncoder().encode(writeGpx(name, points, description)), `${slugify(name).slice(0, 150)}.gpx`, {
    source_name: orig.source_name, source_url: orig.source_url, derived_from: [orig.id], tags: [...(orig.tags || []), "train"],
    notes: description, activity: orig.activity, name,
  });
  if (res.status !== "imported") {
    if (res.status === "duplicate" && res.duplicates.length) throw new ServiceError(`This route is already saved as '${res.duplicates[0].name}'`, 409);
    throw new ServiceError(`Could not save the route: ${res.message}`, 500);
  }
  return { id: res.routes[0].id, name: res.routes[0].name };
}
