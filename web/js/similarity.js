// Geometric comparison of routes: near-duplicates, proximity (map view) and library-wide
// duplicates (port of similarity.py). Shapely's buffer/intersection is replaced by walking
// along one line in small steps and checking the distance to the other through a grid index.

import {
  SegmentGrid, bounds, boundsNear, cumulative, interpolate, lineFromMetric, lineToMetric,
  nearestPoints, partsWithin, project, round, simplify, lineDistance,
} from "./geo.js";
import { config } from "./config.js";

// ~1 km in degrees latitude; used to grow bounding boxes before comparing.
const DEG_PER_M = 1 / 111000;

/** Bounding boxes (min_lat, min_lon, max_lat, max_lon) overlap, grown by margin_m. */
export function bboxesNear(a, b, marginM) {
  const m = marginM * DEG_PER_M;
  // Longitude degrees are shorter than latitude degrees: doubling the margin is a (safe)
  // overestimate at these latitudes.
  return !(a[2] + m < b[0] || b[2] + m < a[0] || a[3] + m * 2 < b[1] || b[3] + m * 2 < a[1]);
}

export const bboxOf = (r) => [r.min_lat, r.min_lon, r.max_lat, r.max_lon];

/** A route's geometry prepared for comparisons: metric line, length, bounds, grid. */
class Shape {
  constructor(geometry) {
    this.xy = lineToMetric(geometry);
    this.cum = cumulative(this.xy);
    this.length = this.cum[this.cum.length - 1];
    this.bounds = bounds(this.xy);
    this.grids = new Map();
  }
  /** Grid index with cells suited to queries within `radius` metres. */
  grid(radius = 50) {
    const cell = [250, 1000, 5000].find((c) => c >= radius) || 5000;
    let g = this.grids.get(cell);
    if (!g) this.grids.set(cell, (g = new SegmentGrid(this.xy, cell)));
    return g;
  }
}

const shapes = new WeakMap(); // geometry array -> Shape (cached per stored geometry)
function shapeOf(geometry) {
  let s = shapes.get(geometry);
  if (!s) shapes.set(geometry, (s = new Shape(geometry)));
  return s;
}

/** Fraction of line a's length that lies within tol of line b. */
function overlapFraction(a, b, tol) {
  if (!a.length) return 0;
  return partsWithin(a.xy, b.grid(tol), tol).length / a.length;
}

/**
 * Compare a route against candidate routes ({id, geometry, min_lat, ...}). Returns
 * candidates where at least `minOverlap` of either route lies within `tolerance` of the
 * other, most similar first: [{other_id, a_in_b, b_in_a, very_similar}].
 */
export function findSimilar(geometry, bbox, candidates, tolerance = config.SIMILAR_TOLERANCE_M, minOverlap = config.SIMILAR_MIN_OVERLAP) {
  let line = null;
  const results = [];
  for (const c of candidates) {
    if (!c.geometry || c.geometry.length < 2 || !bboxesNear(bbox, bboxOf(c), tolerance)) continue;
    line = line || shapeOf(geometry);
    const other = shapeOf(c.geometry);
    const aInB = overlapFraction(line, other, tolerance);
    if (aInB === 0) continue;
    const bInA = overlapFraction(other, line, tolerance);
    if (Math.max(aInB, bInA) >= minOverlap) {
      const s = { other_id: c.id, a_in_b: round(aInB, 3), b_in_a: round(bInA, 3) };
      s.very_similar = Math.min(s.a_in_b, s.b_in_a) >= config.SIMILAR_MIN_OVERLAP;
      results.push(s);
    }
  }
  results.sort((x, y) => Math.min(y.a_in_b, y.b_in_a) - Math.min(x.a_in_b, x.b_in_a));
  return results;
}

// ------------------------------------------------------------------ proximity (map view)

// Shared stretches are for display only; simplify them to keep them small.
const SEGMENT_SIMPLIFY_M = 20.0;

/** Candidate pairs (i < j) whose bounds come within `d` of each other (sweep over x). */
function candidatePairs(list, d) {
  const order = list.map((s, i) => i).sort((i, j) => list[i].bounds[0] - list[j].bounds[0]);
  const pairs = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const bi = list[i].bounds;
    for (let m = k + 1; m < order.length; m++) {
      const j = order[m];
      const bj = list[j].bounds;
      if (bj[0] > bi[2] + d) break;
      if (boundsNear(bi, bj, d)) pairs.push(i < j ? [i, j] : [j, i]);
    }
  }
  return pairs;
}

const runsToLatLon = (runs, tol, digits) =>
  runs.filter((r) => r.length >= 2).map((r) => lineFromMetric(simplify(r, tol), digits));

/**
 * All pairs of routes ({id, geometry}) that come within `distanceM` of each other, with
 * the shared stretches (each route's parts within the distance of the other).
 */
export function proximityPairs(routes, distanceM) {
  routes = routes.filter((r) => r.geometry && r.geometry.length >= 2);
  if (routes.length < 2) return [];
  const list = routes.map((r) => shapeOf(r.geometry));
  const d = Math.max(distanceM, 0);
  const pairs = [];
  for (const [i, j] of candidatePairs(list, d)) {
    const a = list[i], b = list[j];
    const np = nearestPoints(a.xy, b.xy, b.grid(d), Math.max(d, 1));
    if (!(np.d <= d)) continue;
    // Within 0 m means touching or crossing: use a hair of tolerance to get the shared bit.
    const tol = Math.max(d, 0.5);
    const aPart = partsWithin(a.xy, b.grid(tol), tol);
    const bPart = partsWithin(b.xy, a.grid(tol), tol);
    const [pa, pb] = [np.pa, np.pb].map((p) => lineFromMetric([p], 6)[0]);
    pairs.push({
      a_id: routes[i].id,
      b_id: routes[j].id,
      min_distance_m: round(np.d, 1),
      a_shared_km: round(aPart.length / 1000, 2),
      b_shared_km: round(bPart.length / 1000, 2),
      a_shared_pct: a.length ? round((100 * aPart.length) / a.length, 1) : 0,
      b_shared_pct: b.length ? round((100 * bPart.length) / b.length, 1) : 0,
      closest: [pa, pb],
      a_segments: runsToLatLon(aPart.runs, SEGMENT_SIMPLIFY_M, 5),
      b_segments: runsToLatLon(bPart.runs, SEGMENT_SIMPLIFY_M, 5),
    });
  }
  pairs.sort((p, q) => Math.max(q.a_shared_km, q.b_shared_km) - Math.max(p.a_shared_km, p.b_shared_km) || p.min_distance_m - q.min_distance_m);
  return pairs;
}

// ------------------------------------------------------------------ library-wide duplicates

/**
 * Does b run the opposite way along a? Projects points spread along a onto b and checks
 * whether their positions on b mostly decrease.
 */
function directionReversed(a, b) {
  const pos = [];
  for (let k = 0; k < 19; k++) {
    const f = 0.05 + (0.9 * k) / 18;
    const p = interpolate(a.xy, a.cum, f * a.length);
    pos.push(project(b.xy, b.cum, p[0], p[1]));
  }
  let up = 0, down = 0;
  for (let k = 1; k < pos.length; k++) {
    const s = pos[k] - pos[k - 1];
    if (Math.abs(s) >= 0.5 * b.length) continue; // loops wrap around at their start/end
    if (s < 0) down++;
    else if (s > 0) up++;
  }
  return up + down > 0 && down > up;
}

/**
 * Pairs of routes where at least `minOverlap` of one lies within `tolerance` of the other
 * (so this includes a short route contained in a longer one).
 */
export function duplicatePairs(routes, tolerance = config.SIMILAR_TOLERANCE_M, minOverlap = 0.9) {
  routes = routes.filter((r) => r.geometry && r.geometry.length >= 2);
  if (routes.length < 2) return [];
  const list = routes.map((r) => shapeOf(r.geometry));
  const covered = (i, j) => (list[i].length ? partsWithin(list[i].xy, list[j].grid(tolerance), tolerance).length / list[i].length : 0);
  const pairs = [];
  for (const [i, j] of candidatePairs(list, tolerance)) {
    if (lineDistance(list[i].xy, list[j].xy, list[j].grid(tolerance), tolerance) > tolerance) continue;
    const aInB = covered(i, j);
    const bInA = covered(j, i);
    if (Math.max(aInB, bInA) < minOverlap) continue;
    pairs.push({
      a_id: routes[i].id,
      b_id: routes[j].id,
      a_in_b: round(aInB, 3),
      b_in_a: round(bInA, 3),
      reversed: directionReversed(list[i], list[j]),
    });
  }
  return pairs;
}

/** Connected groups of routes that are near-duplicates of each other (both ways). */
export function groupPairs(pairs, minOverlap) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const p of pairs) {
    if (Math.min(p.a_in_b, p.b_in_a) >= minOverlap) parent.set(find(p.a_id), find(p.b_id));
  }
  const groups = new Map();
  for (const x of [...parent.keys()]) {
    const r = find(x);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(x);
  }
  return [...groups.values()].filter((g) => g.size > 1);
}
