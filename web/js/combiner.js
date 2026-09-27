// Combine routes with routed connectors (port of combiner.py).
//
// All cutting happens on the full-resolution GPX points, in a metric projection. Positions
// along a route are distances in metres from its start ("at"), measured in that projection.
//
// Point-to-point (one connection):
//     A from its start up to a1  ->  connector a1-b1  ->  B from b1 to its end
//     reverseA: arrive at a1 from A's end instead (A ridden backwards)
//     reverseB: leave b1 towards B's start instead (B ridden backwards)
//
// Loop (two connections):
//     A from a2 to a1  ->  connector a1-b1  ->  B from b1 to b2  ->  connector b2-a2
//     reverseA / reverseB: take the other way round a loop route (through its start/end)
//
// Parts (combineParts): the general form both of the above are built on. A list of parts,
// each ridden from its start point to its end point along its route, joined by connectors:
//     A1 -> A2  ->  connector  ->  B1 -> B2  [-> connector -> C1 -> C2 ...]  [-> back to A1]
// Riding direction follows the order of the two points; otherWay takes the other way round
// a loop route.
//
// A router is an async function ([lat, lon], [lat, lon]) -> [[lat, lon, ele|null], ...].
// A point here is [x, y, ele] with ele NaN when unknown.

import { fromMetric, lowerBound, project, segmentsCross, toMetric, upperBound } from "./geo.js";

export class CombineError extends Error {}

// ------------------------------------------------------------------ tracks

/** A route as metric points with cumulative distance. */
export class Track {
  constructor(xyz, cum, isLoop = false) {
    this.xyz = xyz; // [[x, y, ele], ...]
    this.cum = cum; // Float64Array, distance from the start in metres
    this.isLoop = isLoop;
  }
  get length() {
    return this.cum[this.cum.length - 1];
  }
}

const hyp = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

export function makeTrack(points, isLoop = false) {
  if (points.length < 2) throw new CombineError("A route needs at least two points");
  const all = points.map(([lat, lon, ele]) => {
    const [x, y] = toMetric(lat, lon);
    return [x, y, ele == null ? NaN : ele];
  });
  // Drop repeated points so every segment has a length.
  const xyz = [all[0]];
  for (let i = 1; i < all.length; i++) if (hyp(all[i - 1], all[i]) > 0.01) xyz.push(all[i]);
  if (xyz.length < 2) throw new CombineError("A route needs at least two distinct points");
  const cum = new Float64Array(xyz.length);
  for (let i = 1; i < xyz.length; i++) cum[i] = cum[i - 1] + hyp(xyz[i - 1], xyz[i]);
  return new Track(xyz, cum, isLoop);
}

/** Interpolated [x, y, ele] at distance `at` along the track. */
export function pointAt(track, at) {
  at = Math.min(Math.max(at, 0), track.length);
  const cum = track.cum;
  const i = Math.min(Math.max(upperBound(cum, at) - 1, 0), cum.length - 2);
  const seg = cum[i + 1] - cum[i];
  const f = seg === 0 ? 0 : (at - cum[i]) / seg;
  const p = track.xyz[i], q = track.xyz[i + 1];
  const ele = !(Number.isNaN(p[2]) || Number.isNaN(q[2])) ? p[2] + f * (q[2] - p[2]) : f < 0.5 ? p[2] : q[2];
  return [p[0] + f * (q[0] - p[0]), p[1] + f * (q[1] - p[1]), ele];
}

/** Points from d0 to d1 (d0 <= d1), with interpolated end points. */
function forward(track, d0, d1) {
  d0 = Math.min(Math.max(d0, 0), track.length);
  d1 = Math.min(Math.max(d1, 0), track.length);
  const i0 = upperBound(track.cum, d0);
  const i1 = lowerBound(track.cum, d1);
  return [pointAt(track, d0), ...track.xyz.slice(i0, Math.max(i0, i1)), pointAt(track, d1)];
}

const reversed = (pts) => pts.slice().reverse();

/**
 * The part of the track travelled from dFrom to dTo.
 * Direct: along the track between the two positions (backwards if dFrom > dTo).
 * otherWay: the complementary part, passing through the start/end point; only meaningful
 * for loop routes.
 */
export function section(track, dFrom, dTo, otherWay = false) {
  if (!otherWay) return dFrom <= dTo ? forward(track, dFrom, dTo) : reversed(forward(track, dTo, dFrom));
  const L = track.length;
  if (dFrom <= dTo) {
    // Backwards from dFrom to the start, continue from the end backwards to dTo.
    return join([reversed(forward(track, 0, dFrom)), reversed(forward(track, dTo, L))]);
  }
  // Forwards from dFrom to the end, continue from the start to dTo.
  return join([forward(track, dFrom, L), forward(track, 0, dTo)]);
}

/** Concatenate point arrays, dropping consecutive (near-)duplicate points. */
export function join(parts, minGapM = 0.5) {
  const pts = parts.flat();
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (i === pts.length - 1 || hyp(pts[i - 1], pts[i]) >= minGapM) out.push(pts[i]);
  }
  return out;
}

/** Distance along the track of the point nearest to (lat, lon). */
export function locate(track, lat, lon) {
  const [x, y] = toMetric(lat, lon);
  return project(track.xyz, track.cum, x, y);
}

export function toLatLon(xyz) {
  return xyz.map(([x, y, e]) => {
    const [lat, lon] = fromMetric(x, y);
    return [lat, lon, Number.isNaN(e) ? null : e];
  });
}

export const latLonOf = (p) => fromMetric(p[0], p[1]);

function fromLatLon(points) {
  return points.map(([lat, lon, ele]) => {
    const [x, y] = toMetric(lat, lon);
    return [x, y, ele == null ? NaN : ele];
  });
}

export function legLength(xyz) {
  let s = 0;
  for (let i = 1; i < xyz.length; i++) s += hyp(xyz[i - 1], xyz[i]);
  return s;
}

// ------------------------------------------------------------------ suggestions

function along(d, ref, length, loop) {
  const diff = Math.abs(d - ref);
  return loop ? Math.min(diff, length - diff) : diff;
}

function samples(track, stepM) {
  const ds = [];
  for (let d = 0; d < track.length; d += stepM) ds.push(d);
  ds.push(track.length);
  return { ds, xy: ds.map((d) => pointAt(track, d)) };
}

/**
 * Where the routes come closest: [{aAt, bAt}]. For count=2, the second pair is the closest
 * pair that is well away (along both routes) from the first, so a loop can be formed.
 */
export function suggestConnections(a, b, count = 1, stepM = 50) {
  // Coarser sampling for very long routes keeps the distance matrix small.
  const step = Math.max(stepM, Math.sqrt((a.length * b.length) / 4e6));
  const A = samples(a, step), B = samples(b, step);
  const dist = (i, j) => hyp(A.xy[i], B.xy[j]);
  let best = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < A.ds.length; i++) {
    for (let j = 0; j < B.ds.length; j++) {
      const d = dist(i, j);
      if (d < best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  }
  const result = [{ aAt: A.ds[bi], bAt: B.ds[bj] }];
  if (count >= 2) {
    const minLen = Math.min(a.length, b.length);
    const exclude = Math.min(Math.max(2000, 0.15 * minLen), 0.25 * minLen);
    const awayA = A.ds.map((d) => along(d, A.ds[bi], a.length, a.isLoop) > exclude);
    const awayB = B.ds.map((d) => along(d, B.ds[bj], b.length, b.isLoop) > exclude);
    let best2 = Infinity, k = -1, m = -1;
    for (let i = 0; i < A.ds.length; i++) {
      if (!awayA[i]) continue;
      for (let j = 0; j < B.ds.length; j++) {
        if (!awayB[j]) continue;
        const d = dist(i, j);
        if (d < best2) {
          best2 = d;
          k = i;
          m = j;
        }
      }
    }
    if (k < 0) throw new CombineError("The routes are too short to suggest a second connection");
    result.push({ aAt: A.ds[k], bAt: B.ds[m] });
  }
  return result;
}

// ------------------------------------------------------------------ stitching

/** The stretch of a route ridden from startAt to endAt (metres along the route). */
export const part = (track, startAt, endAt, otherWay = false) => ({ track, startAt, endAt, otherWay });

/** Leg kind of the i-th part: "a", "b", "c", ... */
export const partKey = (i) => String.fromCharCode(97 + i);

/**
 * Where to cross from A to B when riding "out on A, back on B": the closest pair of points
 * that is well away from both starts. (Routes that share a start are closest right there,
 * which is no use as a crossing.) Returns {aAt, bAt}.
 */
export function suggestCrossover(a, b, stepM = 50) {
  const step = Math.max(stepM, Math.sqrt((a.length * b.length) / 4e6));
  const A = samples(a, step), B = samples(b, step);
  // At least 20 % of the route (and 1 km) from its start; for a loop also from its end,
  // which is the same place.
  const away = (t) => Math.min(Math.max(1000, 0.2 * t.length), 0.4 * t.length);
  const exA = away(a), exB = away(b);
  let best = Infinity, bi = -1, bj = -1;
  for (let i = 0; i < A.ds.length; i++) {
    if (along(A.ds[i], 0, a.length, a.isLoop) <= exA) continue;
    for (let j = 0; j < B.ds.length; j++) {
      if (along(B.ds[j], 0, b.length, b.isLoop) <= exB) continue;
      const d = hyp(A.xy[i], B.xy[j]);
      if (d < best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  }
  if (bi < 0) throw new CombineError("The routes are too short to suggest where to cross over");
  return { aAt: A.ds[bi], bAt: B.ds[bj] };
}

/**
 * Four starting points (A1, A2, B1, B2) for combining A and B, for a pattern:
 * - "loop" (or true):  A1 -> A2 -> B1 -> B2 -> back to A1, using the two closest, well
 *                      separated pairs.
 * - "open" (or false): A from its start to where it comes closest to B, then B from there
 *                      to its end.
 * - "outback":         out on A, back on B: A from its start to a crossing (A2), over to B
 *                      (B1), then B back to its start (B2); the result returns to A1. B is
 *                      ridden in its own direction when it is a loop (on to its end, which is
 *                      its start), otherwise backwards.
 */
export function suggestParts(a, b, pattern = "loop", stepM = 50) {
  if (pattern === true) pattern = "loop";
  if (pattern === false) pattern = "open";
  if (pattern === "outback") {
    const c = suggestCrossover(a, b, stepM);
    // For a loop, "to its start" = on to its end: from bAt the other way round to 0.
    return [part(a, 0, c.aAt), part(b, c.bAt, 0, b.isLoop)];
  }
  if (pattern === "loop") {
    const [c1, c2] = suggestConnections(a, b, 2, stepM);
    return [part(a, c2.aAt, c1.aAt), part(b, c1.bAt, c2.bAt)];
  }
  const [c] = suggestConnections(a, b, 1, stepM);
  return [part(a, 0, c.aAt), part(b, c.bAt, b.length)];
}

/** Is the part ridden in the route's own direction? */
export const withRoute = (p) => (p.otherWay ? p.startAt > p.endAt : p.startAt <= p.endAt);

async function connector(p, q, router, directJoinM) {
  if (hyp(p, q) <= directJoinM) return { kind: "connector", xyz: [p, q], routed: false };
  const routed = fromLatLon(await router(latLonOf(p), latLonOf(q)));
  // BRouter snaps to the nearest way; keep the exact cut points at both ends.
  return { kind: "connector", xyz: join([[p], routed, [q]]), routed: true };
}

/** Legs in riding order: part, connector, part, ... (and a connector back if closed). */
async function stitch(parts, router, closed, directJoinM) {
  const ends = parts.map((p) => [pointAt(p.track, p.startAt), pointAt(p.track, p.endAt)]);
  const legs = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i) legs.push(await connector(ends[i - 1][1], ends[i][0], router, directJoinM));
    legs.push({ kind: partKey(i), xyz: section(p.track, p.startAt, p.endAt, p.otherWay), routed: true });
  }
  if (closed) legs.push(await connector(ends[ends.length - 1][1], ends[0][0], router, directJoinM));
  return legs;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Combine A and B with one or two connections [{aAt, bAt}]. */
export async function combine(a, b, connections, router, {
  reverseA = false, reverseB = false, reverse = false, startAtAStart = true, directJoinM = 25,
} = {}) {
  if (connections.length !== 1 && connections.length !== 2) throw new CombineError("Use one or two connections");
  const cons = connections.map((c) => ({ aAt: clamp(c.aAt, 0, a.length), bAt: clamp(c.bAt, 0, b.length) }));
  const pa = cons.map((c) => pointAt(a, c.aAt));
  const pb = cons.map((c) => pointAt(b, c.bAt));

  let legs;
  if (cons.length === 1) {
    const c = cons[0];
    const parts = [part(a, reverseA ? a.length : 0, c.aAt), part(b, c.bAt, reverseB ? 0 : b.length)];
    legs = await stitch(parts, router, false, directJoinM);
  } else {
    const [c1, c2] = cons;
    if (Math.abs(c1.aAt - c2.aAt) < 1 || Math.abs(c1.bAt - c2.bAt) < 1) {
      throw new CombineError("The two connection points on a route must be different");
    }
    legs = await stitch([part(a, c2.aAt, c1.aAt, reverseA), part(b, c1.bAt, c2.bAt, reverseB)], router, true, directJoinM);
  }
  let pts = join(legs.map((l) => l.xyz));

  if (cons.length === 2 && startAtAStart) {
    // A loop can start anywhere: start where route A starts, if that is on the loop.
    const start = a.xyz[0];
    let k = 0, best = Infinity;
    pts.forEach((p, i) => {
      const d = hyp(p, start);
      if (d < best) {
        best = d;
        k = i;
      }
    });
    if (best < 1 && k > 0 && k < pts.length - 1) pts = [...pts.slice(k), ...pts.slice(1, k + 1)];
  }
  if (reverse) pts = reversed(pts);
  return {
    points: toLatLon(pts),
    legs,
    connections: cons,
    connectionPoints: pa.map((p, i) => [latLonOf(p), latLonOf(pb[i])]),
    parts: [],
    partPoints: [],
  };
}

/**
 * Ride each part from its start to its end point, joined by connectors.
 * closed: add a connector from the last part's end back to the first part's start; the
 * result then starts (and ends) at the first part's start point.
 */
export async function combineParts(parts, router, { closed = true, reverse = false, directJoinM = 25 } = {}) {
  if (parts.length < 2) throw new CombineError("Choose at least two routes");
  parts = parts.map((p) => part(p.track, clamp(p.startAt, 0, p.track.length), clamp(p.endAt, 0, p.track.length), p.otherWay));
  parts.forEach((p, i) => {
    if (Math.abs(p.endAt - p.startAt) < 1) {
      throw new CombineError(`The two points on route ${partKey(i).toUpperCase()} must be different`);
    }
  });
  const legs = await stitch(parts, router, closed, directJoinM);
  let pts = join(legs.map((l) => l.xyz));
  if (reverse) pts = reversed(pts);
  return {
    points: toLatLon(pts),
    legs,
    connections: [],
    connectionPoints: [],
    parts,
    partPoints: parts.map((p) => [latLonOf(pointAt(p.track, p.startAt)), latLonOf(pointAt(p.track, p.endAt))]),
  };
}

export const connectorsOf = (result) => result.legs.filter((l) => l.kind === "connector");

/**
 * Whether the straight lines of the connectors cross each other: usually a sign that one
 * route should be ridden the other way (swap its two points).
 */
export function connectorsCross(parts, closed = true) {
  const ends = parts.map((p) => [pointAt(p.track, p.startAt), pointAt(p.track, p.endAt)]);
  const gaps = [];
  for (let i = 0; i < ends.length - 1; i++) gaps.push([ends[i][1], ends[i + 1][0]]);
  if (closed) gaps.push([ends[ends.length - 1][1], ends[0][0]]);
  const lines = gaps.filter(([p, q]) => hyp(p, q) > 0);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (segmentsCross(lines[i][0], lines[i][1], lines[j][0], lines[j][1])) return true;
    }
  }
  return false;
}

/** Fallback "router": a straight line (no elevation). */
export async function straightRouter(p, q) {
  return [[p[0], p[1], null], [q[0], q[1], null]];
}

// ------------------------------------------------------------------ new start point

/**
 * A loop route ridden once round from `at` (metres along it) back to `at`. The original
 * start and end (at most a couple of hundred metres apart for a loop) are joined directly.
 * reverse: ride it the other way round.
 */
export function restartLoop(track, at, reverse = false) {
  if (!track.isLoop) throw new CombineError("Only a loop route can start somewhere else");
  at = clamp(at, 0, track.length);
  const pts = join([forward(track, at, track.length), forward(track, 0, at)]);
  return reverse ? reversed(pts) : pts;
}
