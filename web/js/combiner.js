// Combine routes with routed connectors (port of combiner.py).
//
// All cutting happens on the full-resolution GPX points, in a metric projection. Positions
// along a route are distances in metres from its start ("at"), measured in that projection.
//
// A combination is a list of parts, each ridden from its start point to its end point along
// its route, joined by connectors (combineParts):
//     A1 -> A2  ->  connector  ->  B1 -> B2  [-> connector -> C1 -> C2 ...]  [-> back to A1]
// Riding direction follows the order of the two points; otherWay takes the other way round
// a loop route. Several parts may come from the same route. orderParts turns the user's
// "connect the end of this part to the start of that one" into the riding order.
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

// ------------------------------------------------------------------ stitching

/** The stretch of a route ridden from startAt to endAt (metres along the route). */
export const part = (track, startAt, endAt, otherWay = false) => ({ track, startAt, endAt, otherWay });

/** Leg kind of the i-th part: "a", "b", "c", ... */
export const partKey = (i) => String.fromCharCode(97 + i);

/** Is the part ridden in the route's own direction? */
export const withRoute = (p) => (p.otherWay ? p.startAt > p.endAt : p.startAt <= p.endAt);

/**
 * A connector from p to q ([x, y, ele]); `via`: [lat, lon] points it must pass (a place).
 * Gaps of directJoinM or less (without a via) are joined with a straight line.
 */
export async function routeConnector(p, q, router, directJoinM, via = []) {
  if (!via.length && hyp(p, q) <= directJoinM) return { kind: "connector", xyz: [p, q], routed: false };
  const routed = fromLatLon(await (via.length ? router(latLonOf(p), latLonOf(q), via) : router(latLonOf(p), latLonOf(q))));
  // BRouter snaps to the nearest way; keep the exact cut points at both ends.
  return { kind: "connector", xyz: join([[p], routed, [q]]), routed: true };
}

/** The gaps to bridge, in riding order: [[from, to], ...] as [x, y, ele] (and the one back if closed). */
export function connectorEnds(parts, closed = true) {
  const ends = parts.map((p) => [pointAt(p.track, p.startAt), pointAt(p.track, p.endAt)]);
  const gaps = [];
  for (let i = 1; i < ends.length; i++) gaps.push([ends[i - 1][1], ends[i][0]]);
  if (closed) gaps.push([ends[ends.length - 1][1], ends[0][0]]);
  return gaps;
}

const APPROVED_FIT_M = 1; // an approved connector must start and end this close to its gap

/**
 * A connector the user approved earlier: {from: [lat, lon], to: [lat, lon], points: [[lat, lon, ele], ...]}.
 * Used as it is (no routing), as long as it still bridges the gap from p to q.
 */
function approvedConnector(p, q, approved, k) {
  const isLatLon = (v) => Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
  if (!isLatLon(approved.from) || !isLatLon(approved.to)) throw new CombineError(`Connection ${k + 1} has no start or end point`);
  const [from, to] = [approved.from, approved.to].map(([lat, lon]) => toMetric(lat, lon));
  if (!(hyp(from, p) <= APPROVED_FIT_M && hyp(to, q) <= APPROVED_FIT_M)) {
    throw new CombineError(`Connection ${k + 1} no longer fits the parts it joins: route it again`);
  }
  if (!Array.isArray(approved.points) || approved.points.length < 2 || !approved.points.every(isLatLon)) {
    throw new CombineError(`Connection ${k + 1} has no route`);
  }
  return { kind: "connector", xyz: join([[p], fromLatLon(approved.points), [q]]), routed: true, approved: true };
}

/**
 * Legs in riding order: part, connector, part, ... (and a connector back if closed).
 * vias[k]: [lat, lon] points connector k must pass (k = 0 for the first connector).
 * approved[k]: a connector the user approved (see approvedConnector), used instead of routing.
 */
async function stitch(parts, router, closed, directJoinM, vias = [], approved = []) {
  const gaps = connectorEnds(parts, closed);
  const connectors = [];
  for (let k = 0; k < gaps.length; k++) {
    const [p, q] = gaps[k];
    connectors.push(approved[k] ? approvedConnector(p, q, approved[k], k) : await routeConnector(p, q, router, directJoinM, vias[k] || []));
  }
  const legs = [];
  parts.forEach((p, i) => {
    if (i) legs.push(connectors[i - 1]);
    legs.push({ kind: partKey(i), xyz: section(p.track, p.startAt, p.endAt, p.otherWay), routed: true });
  });
  if (closed) legs.push(connectors[connectors.length - 1]);
  return legs;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Ride each part from its start to its end point, joined by connectors.
 * closed: add a connector from the last part's end back to the first part's start; the
 * result then starts (and ends) at the first part's start point.
 * connectors[k]: an approved connector for gap k ({from, to, points}), used instead of routing.
 */
export async function combineParts(parts, router, { closed = true, reverse = false, directJoinM = 25, vias = [], connectors = [] } = {}) {
  if (parts.length < 2) throw new CombineError("Choose at least two routes");
  parts = parts.map((p) => part(p.track, clamp(p.startAt, 0, p.track.length), clamp(p.endAt, 0, p.track.length), p.otherWay));
  parts.forEach((p, i) => {
    if (Math.abs(p.endAt - p.startAt) < 1) {
      throw new CombineError(`The two points on route ${partKey(i).toUpperCase()} must be different`);
    }
  });
  const legs = await stitch(parts, router, closed, directJoinM, vias, connectors);
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
  const lines = connectorEnds(parts, closed).filter(([p, q]) => hyp(p, q) > 0);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (segmentsCross(lines[i][0], lines[i][1], lines[j][0], lines[j][1])) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ connecting parts

const partName = (i) => partKey(i).toUpperCase();

/**
 * The riding order from the user's connections between parts.
 * n: the number of parts; links: [{from: i, to: j}], "from the end of part i to the start of
 * part j". Returns {order: [part index, ...], closed}; a closed chain starts at part 0.
 * Throws a CombineError that says what is missing or wrong.
 */
export function orderParts(n, links) {
  if (n < 2) throw new CombineError("Mark at least two parts");
  const next = new Array(n).fill(-1), prev = new Array(n).fill(-1);
  for (const { from, to } of links) {
    if (![from, to].every((i) => Number.isInteger(i) && i >= 0 && i < n)) throw new CombineError("A connection joins a part that does not exist");
    if (from === to) throw new CombineError(`Part ${partName(from)} cannot be connected to itself`);
    if (next[from] >= 0) throw new CombineError(`The end of part ${partName(from)} is connected twice`);
    if (prev[to] >= 0) throw new CombineError(`The start of part ${partName(to)} is connected twice`);
    next[from] = to;
    prev[to] = from;
  }
  const loose = [...Array(n).keys()].filter((i) => next[i] < 0 && prev[i] < 0);
  if (loose.length === 1) throw new CombineError(`Part ${partName(loose[0])} is not connected yet`);
  if (loose.length) {
    const names = loose.map(partName);
    throw new CombineError(`Parts ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are not connected yet`);
  }
  const heads = [...Array(n).keys()].filter((i) => prev[i] < 0);
  if (heads.length > 1) throw new CombineError("The parts form separate chains: connect them into one");
  const first = heads.length ? heads[0] : 0;
  const order = [first];
  for (let i = next[first]; i >= 0 && i !== first; i = next[i]) order.push(i);
  if (order.length < n) throw new CombineError("The parts form separate chains: connect them into one");
  return { order, closed: heads.length === 0 };
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

const MAX_SUGGEST_PARTS = 8; // 8! orders is still quick; the service allows fewer

/**
 * Connections that join the parts (each ridden in its own direction) with the shortest total
 * of straight gaps: [{from, to}]. closed: also back from the last part to the first. For a
 * closed chain the order starts at part 0 (every rotation is the same loop).
 */
export function suggestOrder(parts, closed = true) {
  const n = parts.length;
  if (n < 2) throw new CombineError("Mark at least two parts");
  if (n > MAX_SUGGEST_PARTS) throw new CombineError(`Too many parts to suggest an order (at most ${MAX_SUGGEST_PARTS})`);
  const ends = parts.map((p) => [pointAt(p.track, p.startAt), pointAt(p.track, p.endAt)]);
  const gap = (i, j) => hyp(ends[i][1], ends[j][0]);
  const rest = [...Array(n).keys()].slice(closed ? 1 : 0);
  let best = Infinity, bestOrder = null;
  for (const perm of permutations(rest)) {
    const order = closed ? [0, ...perm] : perm;
    let total = 0;
    for (let k = 1; k < n; k++) total += gap(order[k - 1], order[k]);
    if (closed) total += gap(order[n - 1], order[0]);
    if (total < best) {
      best = total;
      bestOrder = order;
    }
  }
  const links = [];
  for (let k = 1; k < n; k++) links.push({ from: bestOrder[k - 1], to: bestOrder[k] });
  if (closed) links.push({ from: bestOrder[n - 1], to: bestOrder[0] });
  return links;
}

/** Fallback "router": straight lines (no elevation), through the via points if any. */
export async function straightRouter(p, q, via = []) {
  return [p, ...via, q].map(([lat, lon]) => [lat, lon, null]);
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
