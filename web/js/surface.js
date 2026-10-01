// Estimate the surface (paved %) of a route from OpenStreetMap data (port of surface.py).
//
// The route is "map matched" with BRouter: we route through waypoints taken every
// SURFACE_WAYPOINT_SPACING_M metres along the GPX track, with the `shortest` profile, so
// BRouter follows the track itself. With processUnusedTags=1 BRouter reports all OSM tags of
// every way it used, per segment, which gives the surface along the route.
//
// Categories: paved, cobbles (sett/cobblestone: paved, but worth knowing), unpaved, unknown.
// When a way has no `surface` tag, its type decides (a residential street is paved, a grade 3
// track is not); that share is reported as "inferred".
//
// BRouter's path does not always follow the track: a waypoint next to a dead end makes it ride
// out and back, a way missing from OSM (or closed to bikes) makes it detour. Only the parts of
// the path that run along the track count, measured along the track and each stretch once, so
// the categories add up to the track length; what BRouter did not follow counts as unknown.

import * as brouter from "./brouter.js";
import { latLonOf, pointAt } from "./combiner.js";
import { config, publicBRouter } from "./config.js";
import { closestOnSegment, geodesicDistance, round, simplifyLatLon, toMetric, upperBound } from "./geo.js";

const PAVED = new Set([
  "paved", "asphalt", "chipseal", "concrete", "concrete:lanes", "concrete:plates",
  "paving_stones", "paving_stones:lanes", "bricks", "brick", "metal", "metal_grid",
  "wood", "rubber", "tartan", "acrylic",
]);
const COBBLES = new Set(["sett", "cobblestone", "unhewn_cobblestone", "cobblestone:flattened"]);
const UNPAVED = new Set([
  "unpaved", "compacted", "fine_gravel", "gravel", "shells", "rock", "pebblestone", "ground",
  "dirt", "earth", "grass", "grass_paver", "mud", "sand", "woodchips", "snow", "ice", "salt",
  "soil", "clay",
]);
// Roads that are paved unless tagged otherwise.
const PAVED_HIGHWAYS = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified", "residential",
  "living_street", "service", "pedestrian", "cycleway", "busway", "road",
]);
const UNPAVED_HIGHWAYS = new Set(["path", "bridleway"]);

export const CATEGORIES = ["paved", "cobbles", "unpaved", "unknown"];

/** [category, inferred] for a way's OSM tags. */
export function classify(tags) {
  const surface = (tags.surface || "").split(";")[0].trim();
  if (PAVED.has(surface)) return ["paved", false];
  if (COBBLES.has(surface)) return ["cobbles", false];
  if (UNPAVED.has(surface)) return ["unpaved", false];
  const highway = tags.highway || "";
  if (highway === "track") return [tags.tracktype === "grade1" ? "paved" : "unpaved", true];
  if (PAVED_HIGHWAYS.has(highway)) return ["paved", true];
  if (UNPAVED_HIGHWAYS.has(highway)) return ["unpaved", true];
  return ["unknown", true];
}

/** Default matcher: BRouter with all OSM tags. waypoints -> {length, rows, coords}. */
export const brouterMatcher = (waypoints) =>
  brouter.wayTags(waypoints, config.SURFACE_MATCH_PROFILE, { processUnusedTags: "1" });

/** Distances along the track of the match waypoints: every spacingM metres, and the end. */
export function waypointDistances(track, spacingM) {
  const ds = [];
  for (let d = 0; d < track.length; d += spacingM) ds.push(d);
  ds.push(track.length);
  return ds;
}

export function matchWaypoints(track, spacingM) {
  return waypointDistances(track, spacingM).map((d) => latLonOf(pointAt(track, d)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Surface breakdown of a route (km per category) and the resulting paved %.
 * matcher: async (waypoints) -> {length, rows: [[distance_m, tags], ...], coords}
 */
export async function estimate(track, { matcher = brouterMatcher, spacingM = null, chunk = 60, pauseMs = null, onProgress = null } = {}) {
  const spacing = spacingM || config.SURFACE_WAYPOINT_SPACING_M;
  const pause = pauseMs ?? (matcher === brouterMatcher && publicBRouter() ? config.SURFACE_REQUEST_PAUSE_MS : 0);
  const dists = waypointDistances(track, spacing);
  const waypoints = dists.map((d) => latLonOf(pointAt(track, d)));
  const km = { paved: 0, cobbles: 0, unpaved: 0, unknown: 0 };
  let inferred = 0, matched = 0, covered = 0;
  const surfaces = new Map();
  const segments = []; // [[category, [[lat, lon], ...]], ...] for colouring the map
  // Requests with a limited number of waypoints; consecutive chunks share an end point.
  const starts = [];
  for (let i = 0; i < waypoints.length - 1; i += chunk - 1) starts.push(i);
  for (let n = 0; n < starts.length; n++) {
    const part = waypoints.slice(starts[n], starts[n] + chunk);
    if (part.length < 2) break;
    if (n && pause) await sleep(pause);
    onProgress?.(n, starts.length);
    const { length, rows, coords } = await matcher(part);
    matched += length;
    const cover = trackCover(track, coords, rows, part, dists.slice(starts[n], starts[n] + chunk));
    rows.forEach(([, tags], r) => {
      const m = cover.rows[r];
      if (!m) return;
      const [cat, wasInferred] = classify(tags);
      km[cat] += m;
      covered += m;
      if (wasInferred) inferred += m;
      const name = tags.surface || `(${tags.highway || "unknown"})`;
      surfaces.set(name, (surfaces.get(name) || 0) + m);
    });
    addSegments(segments, coords, rows.map(([d, tags]) => [d, classify(tags)[0]]), cover.edges);
  }
  // The part of the track BRouter did not follow: we don't know its surface.
  const unmatched = Math.max(0, track.length - covered);
  km.unknown += unmatched;
  // Display only: simplify each run to keep the stored estimate small.
  const simple = segments.map(([cat, line]) => [cat, simplifyLatLon(line, 4)]);

  const total = track.length;
  const known = km.paved + km.cobbles + km.unpaved;
  const pavedPct = known && known >= 0.5 * total ? Math.round((100 * (km.paved + km.cobbles)) / known) : null;
  const top = [...surfaces].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {
    ...Object.fromEntries(CATEGORIES.map((c) => [`${c}_km`, round(km[c] / 1000, 2)])),
    inferred_km: round(inferred / 1000, 2),
    unmatched_km: round(unmatched / 1000, 2),
    matched_km: round(matched / 1000, 2), // length of BRouter's path, detours included
    route_km: round(track.length / 1000, 2),
    match_ratio: track.length ? round(covered / track.length, 3) : null, // share of the track followed
    paved_pct: pavedPct,
    top_surfaces: top.map(([name, m]) => [name, round(m / 1000, 2)]),
    segments: simple,
    estimated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

/**
 * The message row of every edge of the routed geometry (edge k runs from point k-1 to k).
 * BRouter's message rows give the length of each stretch in order; walk along the geometry by
 * distance and give every edge the row of the stretch it ends in.
 */
export function edgeRows(along, rows) {
  const out = new Array(along.length).fill(0);
  if (!rows.length) return out;
  let bounds = [];
  let s = 0;
  for (const [d] of rows) bounds.push((s += d));
  // Scale: the message distances and our geometry lengths differ slightly.
  const last = bounds[bounds.length - 1];
  if (last > 0) bounds = bounds.map((b) => (b * along[along.length - 1]) / last);
  for (let k = 1; k < along.length; k++) {
    // searchsorted(bounds, along - 1e-9, side="left"): first bound >= value
    const v = along[k] - 1e-9;
    const idx = bounds.findIndex((b) => b >= v);
    out[k] = idx < 0 ? rows.length - 1 : Math.min(idx, rows.length - 1);
  }
  return out;
}

/**
 * Split the routed geometry into runs of one surface category. cats: [[distance_m, category],
 * ...] per message row; keep (optional): per edge, whether to draw it (off-track detours not).
 */
export function addSegments(segments, coords, cats, keep = null) {
  if (coords.length < 2 || !cats.length) return;
  const along = [0];
  for (let k = 1; k < coords.length; k++) {
    along.push(along[k - 1] + geodesicDistance(coords[k - 1][0], coords[k - 1][1], coords[k][0], coords[k][1]));
  }
  const rowOf = edgeRows(along, cats);
  const r5 = (c) => [round(c[0], 5), round(c[1], 5)];
  for (let k = 1; k < coords.length; k++) {
    if (keep && !keep[k]) continue;
    const cat = cats[rowOf[k]][1];
    const prev = r5(coords[k - 1]), point = r5(coords[k]);
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && lastSeg[0] === cat && sameXY(lastSeg[1][lastSeg[1].length - 1], prev)) lastSeg[1].push(point);
    else segments.push([cat, [prev, point]]);
  }
}

const sameXY = (p, q) => p[0] === q[0] && p[1] === q[1];

// A point of BRouter's path within this distance of the track is on the track (GPS error, a
// cycle path beside the road).
const ON_TRACK_M = 40;
// How far along BRouter's path to look for the point where it passes a waypoint.
const ANCHOR_SEARCH_LEGS = 20;

/**
 * How many metres of the track each message row covers, for one request.
 * waypoints/dists: the request's waypoints and their distances along the track.
 * Returns {rows: metres per row, edges: per edge of coords, whether it runs along the track}.
 *
 * The path is cut into legs at the points where it passes each waypoint. Within a leg, an edge
 * counts if both ends lie on the track (projected onto the leg's own stretch of track, so a
 * route that rides a road twice is not confused) and it moves forward; it covers the stretch
 * of track it advances past the furthest point reached so far. Riding out and back to a
 * waypoint, or a detour, therefore adds nothing, and a leg covers at most its own stretch.
 */
export function trackCover(track, coords, rows, waypoints, dists) {
  const rowM = new Array(rows.length).fill(0);
  const edges = new Array(coords.length).fill(false);
  if (coords.length < 2 || !rows.length) return { rows: rowM, edges };
  const xy = coords.map(([la, lo]) => toMetric(la, lo));
  const along = [0];
  for (let k = 1; k < xy.length; k++) along.push(along[k - 1] + Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]));
  const rowOf = edgeRows(along, rows);

  // Where the path passes each waypoint, as [waypoint index, coords index]: of the points
  // where it comes close, the one whose distance from the previous waypoint best fits the
  // spacing (a route that turns around passes the same spot twice). A waypoint it never comes
  // close to is skipped; its two legs become one.
  const anchors = [[0, 0]];
  for (let j = 1; j < waypoints.length - 1; j++) {
    const [wx, wy] = toMetric(...waypoints[j]);
    const [i, from] = anchors[anchors.length - 1];
    const leg = Math.max(dists[j] - dists[i], 100);
    const reach = along[from] + ANCHOR_SEARCH_LEGS * leg;
    let best = -1, bestFit = Infinity;
    let before = Infinity, d = Math.hypot(xy[from][0] - wx, xy[from][1] - wy);
    for (let k = from; k < xy.length && along[k] <= reach; k++) {
      const next = k + 1 < xy.length ? Math.hypot(xy[k + 1][0] - wx, xy[k + 1][1] - wy) : Infinity;
      const fit = Math.abs(along[k] - along[from] - leg);
      const closest = d <= before && d <= next; // a local minimum
      if (d <= ON_TRACK_M && closest && fit < bestFit) (bestFit = fit), (best = k);
      (before = d), (d = next);
    }
    if (best >= 0) anchors.push([j, best]);
  }
  anchors.push([waypoints.length - 1, xy.length - 1]);

  for (let n = 1; n < anchors.length; n++) {
    const [[i, kFrom], [j, kTo]] = [anchors[n - 1], anchors[n]];
    const lo = dists[i], hi = dists[j];
    // Project onto the leg's stretch of track, with some margin.
    const margin = Math.max(hi - lo, 100);
    const i0 = Math.max(upperBound(track.cum, lo - margin) - 1, 0);
    const i1 = Math.min(upperBound(track.cum, hi + margin), track.cum.length - 1);
    // Where the track passes a spot twice (a turnaround), prefer the pass in the leg's stretch.
    const proj = ([px, py]) => {
      let best = Infinity, at = lo, d = Infinity;
      for (let i = i0; i < i1; i++) {
        const a = track.xyz[i], b = track.xyz[i + 1];
        const c = closestOnSegment(px, py, a[0], a[1], b[0], b[1]);
        const pos = track.cum[i] + c.t * (track.cum[i + 1] - track.cum[i]);
        const score = c.d + Math.max(0, lo - pos, pos - hi);
        if (score < best) (best = score), (at = pos), (d = c.d);
      }
      return { at, d };
    };
    let reached = lo;
    let prev = proj(xy[kFrom]);
    for (let k = kFrom + 1; k <= kTo; k++) {
      const cur = proj(xy[k]);
      const step = along[k] - along[k - 1];
      // Both ends on the track, and the track advance fits the edge (no jump between passes).
      if (prev.d <= ON_TRACK_M && cur.d <= ON_TRACK_M && cur.at - prev.at <= 1.2 * step + 2 * ON_TRACK_M) {
        // From where this edge starts: after a detour the path rejoins further along.
        const from = Math.max(reached, prev.at), to = Math.min(cur.at, hi);
        if (to > from) rowM[rowOf[k]] += to - from;
        reached = Math.max(reached, to);
        edges[k] = cur.at >= prev.at;
      }
      prev = cur;
    }
  }
  return { rows: rowM, edges };
}

/**
 * Store the estimate on the route. The paved % is only replaced if it was not entered by
 * hand (or overwriteManual). Returns true if paved_pct was set from the estimate.
 */
export function applyEstimate(route, result, overwriteManual = false) {
  route.surface = result;
  const manual = route.paved_source === "manual" || (route.paved_pct != null && route.paved_source == null);
  if (manual && !overwriteManual) return false;
  route.paved_pct = result.paved_pct;
  route.paved_source = result.paved_pct != null ? "estimated" : null;
  return true;
}
