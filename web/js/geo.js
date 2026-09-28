// Geometry basics: metric projection, geodesic distance, line helpers, simplification and a
// spatial grid index. Pure functions, no DOM, so they run in the browser and under Node tests.

// ------------------------------------------------------------------ projection
// ETRS89 / LAEA Europe (EPSG:3035): an equal-area projection that works well across Europe.
// Ellipsoidal Lambert azimuthal equal-area (Snyder, Map Projections - A Working Manual, p. 187).

const A = 6378137.0;
const E2 = 0.0066943800229; // GRS80
const E = Math.sqrt(E2);
const LAT0 = (52 * Math.PI) / 180;
const LON0 = (10 * Math.PI) / 180;
const FE = 4321000.0;
const FN = 3210000.0;

function q(phi) {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
}
const QP = q(Math.PI / 2);
const RQ = A * Math.sqrt(QP / 2);
const BETA1 = Math.asin(q(LAT0) / QP);
const SB1 = Math.sin(BETA1);
const CB1 = Math.cos(BETA1);
const D = (A * (Math.cos(LAT0) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2))) / (RQ * CB1);
const E4 = E2 * E2;
const E6 = E4 * E2;
const P1 = E2 / 3 + (31 * E4) / 180 + (517 * E6) / 5040;
const P2 = (23 * E4) / 360 + (251 * E6) / 3780;
const P3 = (761 * E6) / 45360;

/** [lat, lon] in degrees -> [x, y] in metres (EPSG:3035). */
export function toMetric(lat, lon) {
  const phi = (lat * Math.PI) / 180;
  const dl = (lon * Math.PI) / 180 - LON0;
  const beta = Math.asin(q(phi) / QP);
  const sb = Math.sin(beta);
  const cbeta = Math.cos(beta);
  const B = RQ * Math.sqrt(2 / (1 + SB1 * sb + CB1 * cbeta * Math.cos(dl)));
  return [FE + B * D * cbeta * Math.sin(dl), FN + (B / D) * (CB1 * sb - SB1 * cbeta * Math.cos(dl))];
}

/** [x, y] in metres (EPSG:3035) -> [lat, lon] in degrees. */
export function fromMetric(x, y) {
  const dx = x - FE;
  const dy = y - FN;
  const rho = Math.hypot(dx / D, D * dy);
  if (rho < 1e-9) return [(LAT0 * 180) / Math.PI, (LON0 * 180) / Math.PI];
  const C = 2 * Math.asin(rho / (2 * RQ));
  const sc = Math.sin(C);
  const cc = Math.cos(C);
  const beta = Math.asin(cc * SB1 + (D * dy * sc * CB1) / rho);
  const lon = LON0 + Math.atan2(dx * sc, D * rho * CB1 * cc - D * D * dy * SB1 * sc);
  const phi = beta + P1 * Math.sin(2 * beta) + P2 * Math.sin(4 * beta) + P3 * Math.sin(6 * beta);
  return [(phi * 180) / Math.PI, (lon * 180) / Math.PI];
}

/** [[lat, lon], ...] -> [[x, y], ...] */
export const lineToMetric = (line) => line.map((p) => toMetric(p[0], p[1]));
/** [[x, y], ...] -> [[lat, lon], ...], rounded */
export const lineFromMetric = (xy, digits = 6) =>
  xy.map((p) => {
    const [la, lo] = fromMetric(p[0], p[1]);
    return [round(la, digits), round(lo, digits)];
  });

export function round(v, digits = 0) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ------------------------------------------------------------------ geodesic distance
// Vincenty's inverse formula on WGS84: accurate to well under a millimetre for the
// distances between GPS points.

const WGS_A = 6378137.0;
const WGS_F = 1 / 298.257223563;
const WGS_B = WGS_A * (1 - WGS_F);

export function geodesicDistance(lat1, lon1, lat2, lon2) {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const rad = Math.PI / 180;
  const L = (lon2 - lon1) * rad;
  const U1 = Math.atan((1 - WGS_F) * Math.tan(lat1 * rad));
  const U2 = Math.atan((1 - WGS_F) * Math.tan(lat2 * rad));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma, cosSigma, sigma, cos2Alpha, cos2SigmaM;
  for (let iter = 0; iter < 100; iter++) {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    const C = (WGS_F / 16) * cos2Alpha * (4 + WGS_F * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda = L + (1 - C) * WGS_F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-12) break;
  }
  const u2 = (cos2Alpha * (WGS_A * WGS_A - WGS_B * WGS_B)) / (WGS_B * WGS_B);
  const Acoef = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const Bcoef = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma = Bcoef * sinSigma * (cos2SigmaM + (Bcoef / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
    (Bcoef / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return WGS_B * Acoef * (sigma - dSigma);
}

/** Cumulative geodesic distance along [lat, lon] pairs, starting at 0. */
export function cumulativeDistance(lats, lons) {
  const out = new Float64Array(lats.length);
  for (let i = 1; i < lats.length; i++) {
    out[i] = out[i - 1] + geodesicDistance(lats[i - 1], lons[i - 1], lats[i], lons[i]);
  }
  return out;
}

// ------------------------------------------------------------------ planar line helpers
// Lines are arrays of [x, y] (metres). Some helpers accept longer tuples and use [0], [1].

export function lineLength(xy) {
  let s = 0;
  for (let i = 1; i < xy.length; i++) s += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  return s;
}

export function cumulative(xy) {
  const out = new Float64Array(xy.length);
  for (let i = 1; i < xy.length; i++) out[i] = out[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
  return out;
}

/** Closest point on segment a-b to p: {t, x, y, d}. */
export function closestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx, y = ay + t * dy;
  return { t, x, y, d: Math.hypot(px - x, py - y) };
}

/** Distance along the line of the point on it nearest to (px, py) (like shapely's project). */
export function project(xy, cum, px, py) {
  let best = Infinity, at = 0;
  for (let i = 0; i < xy.length - 1; i++) {
    const c = closestOnSegment(px, py, xy[i][0], xy[i][1], xy[i + 1][0], xy[i + 1][1]);
    if (c.d < best) {
      best = c.d;
      at = cum[i] + c.t * (cum[i + 1] - cum[i]);
    }
  }
  return at;
}

/** Point at distance `at` along the line (like shapely's interpolate). */
export function interpolate(xy, cum, at) {
  const L = cum[cum.length - 1];
  at = Math.min(Math.max(at, 0), L);
  let i = upperBound(cum, at) - 1;
  i = Math.min(Math.max(i, 0), xy.length - 2);
  const seg = cum[i + 1] - cum[i];
  const f = seg ? (at - cum[i]) / seg : 0;
  return [xy[i][0] + f * (xy[i + 1][0] - xy[i][0]), xy[i][1] + f * (xy[i + 1][1] - xy[i][1])];
}

/** Index of the first element > v (numpy searchsorted side="right"). */
export function upperBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first element >= v (numpy searchsorted side="left"). */
export function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Do segments p1-p2 and q1-q2 properly cross (interiors intersect, not just touch)? */
export function segmentsCross(p1, p2, q1, q2) {
  const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const o1 = orient(p1, p2, q1), o2 = orient(p1, p2, q2), o3 = orient(q1, q2, p1), o4 = orient(q1, q2, p2);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Minimum distance between two segments. */
function segmentDistance(a1, a2, b1, b2) {
  if (segmentsCross(a1, a2, b1, b2)) return 0;
  return Math.min(
    closestOnSegment(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1]).d,
    closestOnSegment(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1]).d,
    closestOnSegment(b1[0], b1[1], a1[0], a1[1], a2[0], a2[1]).d,
    closestOnSegment(b2[0], b2[1], a1[0], a1[1], a2[0], a2[1]).d
  );
}

// ------------------------------------------------------------------ simplification

/** Douglas-Peucker (shapely's simplify with preserve_topology=False). Keeps both ends. */
export function simplify(xy, tolerance) {
  const n = xy.length;
  if (n <= 2 || tolerance <= 0) return xy.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, ay] = xy[s], [bx, by] = xy[e];
    for (let i = s + 1; i < e; i++) {
      const d = closestOnSegment(xy[i][0], xy[i][1], ax, ay, bx, by).d;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(xy[i]);
  return out;
}

/** Simplify a [[lat, lon], ...] line with a tolerance in metres. */
export function simplifyLatLon(geometry, toleranceM, digits = 6) {
  if (toleranceM <= 0 || geometry.length <= 2) return geometry;
  return lineFromMetric(simplify(lineToMetric(geometry), toleranceM), digits);
}

// ------------------------------------------------------------------ spatial index

/** Bounding box [minx, miny, maxx, maxy] of an xy line. */
export function bounds(xy) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of xy) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}

export function boundsNear(a, b, margin) {
  return !(a[2] + margin < b[0] || b[2] + margin < a[0] || a[3] + margin < b[1] || b[3] + margin < a[1]);
}

/**
 * A grid of cells, each listing the segments of one line that pass through it, for fast
 * "which segments are near this point" queries.
 */
export class SegmentGrid {
  constructor(xy, cell = 200) {
    this.xy = xy;
    this.cell = cell;
    this.cells = new Map();
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell);
      const y0 = Math.floor(Math.min(ay, by) / cell), y1 = Math.floor(Math.max(ay, by) / cell);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const key = gx * 1e6 + gy;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(i);
        }
      }
    }
  }

  /** Segment indices with a cell within `radius` of (x, y). */
  near(x, y, radius) {
    const c = this.cell;
    const x0 = Math.floor((x - radius) / c), x1 = Math.floor((x + radius) / c);
    const y0 = Math.floor((y - radius) / c), y1 = Math.floor((y + radius) / c);
    const out = new Set();
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const list = this.cells.get(gx * 1e6 + gy);
        if (list) for (const i of list) out.add(i);
      }
    }
    return out;
  }

  /** Distance from (x, y) to the line, or Infinity when further than `radius`. */
  distanceWithin(x, y, radius) {
    let best = Infinity;
    for (const i of this.near(x, y, radius)) {
      const [ax, ay] = this.xy[i], [bx, by] = this.xy[i + 1];
      const d = closestOnSegment(x, y, ax, ay, bx, by).d;
      if (d < best) best = d;
    }
    return best <= radius ? best : Infinity;
  }
}

/**
 * Exact minimum distance between two lines, with the closest point on each.
 * Uses the grid of `b` to limit the work to nearby segments when `maxD` is given.
 */
export function nearestPoints(a, b, gridB = null, maxD = Infinity) {
  let best = { d: Infinity, pa: null, pb: null };
  const consider = (i, j) => {
    const a1 = a[i], a2 = a[i + 1], b1 = b[j], b2 = b[j + 1];
    if (segmentsCross(a1, a2, b1, b2)) {
      const p = intersection(a1, a2, b1, b2);
      if (best.d > 0) best = { d: 0, pa: p, pb: p };
      return;
    }
    const cands = [
      [a1, closestOnSegment(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1])],
      [a2, closestOnSegment(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1])],
    ];
    for (const [p, c] of cands) if (c.d < best.d) best = { d: c.d, pa: [p[0], p[1]], pb: [c.x, c.y] };
    for (const p of [b1, b2]) {
      const c = closestOnSegment(p[0], p[1], a1[0], a1[1], a2[0], a2[1]);
      if (c.d < best.d) best = { d: c.d, pa: [c.x, c.y], pb: [p[0], p[1]] };
    }
  };
  if (gridB && Number.isFinite(maxD)) {
    for (let i = 0; i < a.length - 1; i++) {
      const [ax, ay] = a[i], [bx, by] = a[i + 1];
      const half = Math.hypot(bx - ax, by - ay) / 2;
      for (const j of gridB.near((ax + bx) / 2, (ay + by) / 2, half + maxD)) consider(i, j);
    }
  } else {
    for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) consider(i, j);
  }
  return best;
}

function intersection(p1, p2, q1, q2) {
  const d = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0]);
  const t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / d;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

/** Minimum distance between two lines (exact), limited to `maxD` when a grid is given. */
export function lineDistance(a, b, gridB = null, maxD = Infinity) {
  if (gridB && Number.isFinite(maxD)) {
    let best = Infinity;
    for (let i = 0; i < a.length - 1; i++) {
      const [ax, ay] = a[i], [bx, by] = a[i + 1];
      const half = Math.hypot(bx - ax, by - ay) / 2;
      for (const j of gridB.near((ax + bx) / 2, (ay + by) / 2, half + maxD)) {
        const d = segmentDistance(a[i], a[i + 1], b[j], b[j + 1]);
        if (d < best) best = d;
        if (best === 0) return 0;
      }
    }
    return best;
  }
  return nearestPoints(a, b).d;
}

/**
 * The part [t0, t1] (0..1) of segment p(t) = (ax, ay) + t (dx, dy) within `r` of the segment
 * s0-s1, or null. The area within r of a segment is convex (a "capsule": a rectangle plus two
 * discs), so this is one interval: the hull of the intervals with its three parts.
 */
function capsuleInterval(ax, ay, dx, dy, s0x, s0y, s1x, s1y, r) {
  let lo = Infinity, hi = -Infinity;
  const a = dx * dx + dy * dy;
  for (const [cx, cy] of [[s0x, s0y], [s1x, s1y]]) {
    const fx = ax - cx, fy = ay - cy;
    const b = 2 * (dx * fx + dy * fy);
    const c = fx * fx + fy * fy - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    lo = Math.min(lo, (-b - sq) / (2 * a));
    hi = Math.max(hi, (-b + sq) / (2 * a));
  }
  const ex = s1x - s0x, ey = s1y - s0y;
  const L = Math.hypot(ex, ey);
  if (L > 0) {
    const ux = ex / L, uy = ey / L; // along the segment
    const nx = -uy, ny = ux; // across it
    const u0 = (ax - s0x) * ux + (ay - s0y) * uy, du = dx * ux + dy * uy;
    const v0 = (ax - s0x) * nx + (ay - s0y) * ny, dv = dx * nx + dy * ny;
    let t0 = -Infinity, t1 = Infinity;
    const clip = (p, q) => {
      // Keep t where p * t <= q.
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p > 0) t1 = Math.min(t1, t);
      else t0 = Math.max(t0, t);
      return true;
    };
    if (clip(-du, u0) && clip(du, L - u0) && clip(-dv, v0 + r) && clip(dv, r - v0) && t0 <= t1) {
      lo = Math.min(lo, t0);
      hi = Math.max(hi, t1);
    }
  }
  lo = Math.max(lo, 0);
  hi = Math.min(hi, 1);
  return lo < hi ? [lo, hi] : null;
}

/**
 * The parts of line `a` that lie within `tol` of line `b` (b given by its grid index):
 * {length, runs: [[x, y], ...][]}. Exact: this plays the role of shapely's
 * a.intersection(b.buffer(tol)).
 */
export function partsWithin(a, gridB, tol) {
  const b = gridB.xy;
  let length = 0;
  const runs = [];
  let run = null; // the run still open at the end of the previous segment
  for (let i = 0; i < a.length - 1; i++) {
    const [ax, ay] = a[i], [bx, by] = a[i + 1];
    const dx = bx - ax, dy = by - ay;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) continue;
    const ivs = [];
    for (const j of gridB.near((ax + bx) / 2, (ay + by) / 2, segLen / 2 + tol)) {
      const iv = capsuleInterval(ax, ay, dx, dy, b[j][0], b[j][1], b[j + 1][0], b[j + 1][1], tol);
      if (!iv) continue;
      if (iv[0] === 0 && iv[1] === 1) {
        ivs.length = 0;
        ivs.push(iv);
        break; // the whole segment is within tol
      }
      ivs.push(iv);
    }
    if (!ivs.length) {
      run = null;
      continue;
    }
    ivs.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const iv of ivs) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    for (const [t0, t1] of merged) {
      length += (t1 - t0) * segLen;
      const p0 = [ax + t0 * dx, ay + t0 * dy], p1 = [ax + t1 * dx, ay + t1 * dy];
      if (run && t0 === 0) run.push(p1);
      else {
        run = [p0, p1];
        runs.push(run);
      }
      if (t1 !== 1) run = null;
    }
    if (merged[merged.length - 1][1] !== 1) run = null;
  }
  return { length, runs };
}

/** Is [lat, lon] inside the polygon [[lat, lon], ...] (closed or not; ray casting)? */
export function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
