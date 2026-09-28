// Elevation profile of a route: the data (pure functions, tested in Node) and an SVG chart.
// The profile uses the same distances and smoothing as the route stats (stats.js), so the
// chart matches the elevation gain shown next to it.

import { cumulativeDistance } from "./geo.js";
import { interp, smoothedProfile } from "./stats.js";

export const GRADE_STEP_M = 100; // slope bands are measured over this distance
// Slope classes for the bands under the line: [lower bound in %, colour].
export const GRADE_CLASSES = [
  [3, "#f2d27a"],
  [6, "#e8923a"],
  [9, "#c8412b"],
];

/**
 * Profile of a route from its points [[lat, lon, ele|null], ...]: elevation on a 10 m grid
 * with the position of every grid point. Returns null when the file has no elevation.
 */
export function buildProfile(points) {
  // Drop points that don't move, so distances strictly increase (needed for interpolation).
  const kept = [points[0]];
  const n0 = points.length;
  const la0 = new Float64Array(n0), lo0 = new Float64Array(n0);
  for (let i = 0; i < n0; i++) [la0[i], lo0[i]] = points[i];
  const d0 = cumulativeDistance(la0, lo0);
  const keptD = [0];
  for (let i = 1; i < n0; i++) {
    if (d0[i] > keptD[keptD.length - 1]) {
      kept.push(points[i]);
      keptD.push(d0[i]);
    }
  }
  const n = kept.length;
  if (n < 2) return null;
  const dist = Float64Array.from(keptD);
  const ele = new Float64Array(n), lats = new Float64Array(n), lons = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lats[i] = kept[i][0];
    lons[i] = kept[i][1];
    ele[i] = kept[i][2] == null ? NaN : kept[i][2];
  }
  const smooth = smoothedProfile(dist, ele);
  if (!smooth) return null;
  const { grid } = smooth;
  let lo = Infinity, hi = -Infinity;
  for (const v of smooth.ele) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return {
    dist: grid,
    ele: smooth.ele,
    lat: interp(grid, dist, lats),
    lon: interp(grid, dist, lons),
    total: grid[grid.length - 1],
    min: lo,
    max: hi,
  };
}

/** Index of the grid point nearest to distance `d` (metres). */
export function indexAt(profile, d) {
  const { dist } = profile;
  let lo = 0, hi = dist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid;
    else hi = mid;
  }
  return d - dist[lo] <= dist[hi] - d ? lo : hi;
}

/** Index of the grid point nearest to (lat, lon), and its distance from it in metres. */
export function nearestIndex(profile, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < profile.lat.length; i++) {
    const dy = profile.lat[i] - lat, dx = (profile.lon[i] - lon) * k;
    const d = dy * dy + dx * dx;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { index: best, metres: Math.sqrt(bestD) * 111320 };
}

/** Slope in % around grid point `i`, measured over GRADE_STEP_M. */
export function gradeAt(profile, i) {
  const { dist, ele } = profile;
  const half = GRADE_STEP_M / 2;
  const a = indexAt(profile, Math.max(0, dist[i] - half));
  const b = indexAt(profile, Math.min(profile.total, dist[i] + half));
  const run = dist[b] - dist[a];
  return run > 0 ? (100 * (ele[b] - ele[a])) / run : 0;
}

/** Slope class of a grade: -1 below the first class, else the index in GRADE_CLASSES. */
export function gradeClass(grade) {
  let c = -1;
  for (let i = 0; i < GRADE_CLASSES.length; i++) if (grade >= GRADE_CLASSES[i][0]) c = i;
  return c;
}

/**
 * Climbing stretches for the bands under the line: consecutive GRADE_STEP_M pieces of the
 * same class merged into [{from, to, cls}] (distances in metres). Flat and descending
 * pieces are left out.
 */
export function gradeBands(profile) {
  const { dist, ele, total } = profile;
  const bands = [];
  for (let from = 0; from < total; from += GRADE_STEP_M) {
    const to = Math.min(total, from + GRADE_STEP_M);
    const a = indexAt(profile, from), b = indexAt(profile, to);
    const run = dist[b] - dist[a];
    if (run <= 0) continue;
    const cls = gradeClass((100 * (ele[b] - ele[a])) / run);
    if (cls < 0) continue;
    const last = bands[bands.length - 1];
    if (last && last.cls === cls && last.to === from) last.to = to;
    else bands.push({ from, to, cls });
  }
  return bands;
}

/** A "nice" axis step (1, 2 or 5 × 10^n) so that `range` gets at most `maxTicks` ticks. */
export function niceStep(range, maxTicks) {
  if (!(range > 0)) return 1;
  const raw = range / Math.max(1, maxTicks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

/** Ticks from `lo` to `hi` (multiples of `step`, inside the range). */
export function ticks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6 + 0); // + 0 turns -0 into 0
  return out;
}

/**
 * Highest elevation per pixel column (x from 0 to width-1), so short steep bits stay
 * visible when a long route is drawn in a few hundred pixels.
 */
export function columns(profile, width) {
  const { dist, ele, total } = profile;
  const out = new Float64Array(width).fill(NaN);
  for (let i = 0; i < dist.length; i++) {
    const x = Math.min(width - 1, Math.floor((dist[i] / total) * width));
    if (!(out[x] >= ele[i])) out[x] = ele[i];
  }
  for (let x = 0; x < width; x++) if (Number.isNaN(out[x])) out[x] = x ? out[x - 1] : ele[0];
  return out;
}

// ------------------------------------------------------------------ chart (browser only)

const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1);

/**
 * Draw `profile` into `container` (an empty element) as an SVG chart that fills its width.
 * `onHover(index | null)` is called when the pointer moves over the chart. Returns
 * {highlight(index | null), destroy()} to show a position from elsewhere (the map).
 */
export function drawProfile(container, profile, { height = 130, onHover = () => {} } = {}) {
  const M = { left: 38, right: 8, top: 8, bottom: 20 };
  let width = 0, sx = null, sy = null, cursor = null, label = null, current = null;

  function render() {
    width = Math.max(200, Math.floor(container.clientWidth));
    const plotW = width - M.left - M.right, plotH = height - M.top - M.bottom;
    // Leave some room above and below, and never exaggerate a flat route to look hilly.
    const span = Math.max(profile.max - profile.min, 30);
    const yStep = niceStep(span, 3);
    const yLo = Math.floor((profile.min - span * 0.05) / yStep) * yStep;
    const yHi = Math.ceil((profile.max + span * 0.05) / yStep) * yStep;
    sx = (d) => M.left + (d / profile.total) * plotW;
    sy = (e) => M.top + plotH - ((e - yLo) / (yHi - yLo)) * plotH;

    const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "profile-svg", role: "img" });
    svg.setAttribute("aria-label", `Elevation profile, ${Math.round(profile.min)} to ${Math.round(profile.max)} m`);

    for (const t of ticks(yLo, yHi, yStep)) {
      svg.append(svgEl("line", { x1: M.left, x2: width - M.right, y1: sy(t), y2: sy(t), class: "profile-grid" }));
      const tx = svgEl("text", { x: M.left - 4, y: sy(t) + 3, "text-anchor": "end", class: "profile-axis" });
      tx.textContent = `${t}`;
      svg.append(tx);
    }
    const xStep = niceStep(profile.total / 1000, Math.max(2, Math.floor(plotW / 60))) * 1000;
    // Leave room for the "km" label at the right end.
    for (const t of ticks(0, profile.total, xStep).filter((t) => sx(t) < width - M.right - 24)) {
      const tx = svgEl("text", { x: sx(t), y: height - 5, "text-anchor": "middle", class: "profile-axis" });
      tx.textContent = `${t / 1000}`;
      svg.append(tx);
    }
    const unit = svgEl("text", { x: width - M.right, y: height - 5, "text-anchor": "end", class: "profile-axis" });
    unit.textContent = "km";
    svg.append(unit);

    // Area under the line (one value per pixel column), with the climbs coloured.
    const col = columns(profile, plotW);
    const top = Array.from(col, (e, x) => `${(M.left + x + 0.5).toFixed(1)},${sy(e).toFixed(1)}`);
    const base = sy(yLo);
    svg.append(svgEl("polygon", { points: `${M.left},${base} ${top.join(" ")} ${M.left + plotW},${base}`, class: "profile-area" }));
    for (const b of gradeBands(profile)) {
      const x0 = Math.floor(((b.from / profile.total) * plotW)), x1 = Math.min(plotW - 1, Math.ceil((b.to / profile.total) * plotW));
      const pts = [];
      for (let x = x0; x <= x1; x++) pts.push(`${(M.left + x + 0.5).toFixed(1)},${sy(col[x]).toFixed(1)}`);
      svg.append(svgEl("polygon", {
        points: `${M.left + x0 + 0.5},${base} ${pts.join(" ")} ${M.left + x1 + 0.5},${base}`,
        fill: GRADE_CLASSES[b.cls][1], class: "profile-band",
      }));
    }
    svg.append(svgEl("polyline", { points: top.join(" "), class: "profile-line" }));

    cursor = svgEl("line", { y1: M.top, y2: M.top + plotH, class: "profile-cursor", visibility: "hidden" });
    label = svgEl("text", { y: M.top + 10, class: "profile-label", visibility: "hidden" });
    svg.append(cursor, label);

    const hit = svgEl("rect", { x: M.left, y: 0, width: plotW, height, fill: "transparent" });
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const d = ((ev.clientX - r.left - M.left) / plotW) * profile.total;
      const i = indexAt(profile, Math.min(profile.total, Math.max(0, d)));
      highlight(i);
      onHover(i);
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", () => {
      highlight(null);
      onHover(null);
    });
    svg.append(hit);
    container.replaceChildren(svg);
    if (current != null) highlight(current);
  }

  function highlight(i) {
    current = i;
    if (!cursor) return;
    if (i == null) {
      cursor.setAttribute("visibility", "hidden");
      label.setAttribute("visibility", "hidden");
      return;
    }
    const x = sx(profile.dist[i]);
    cursor.setAttribute("x1", x);
    cursor.setAttribute("x2", x);
    cursor.setAttribute("visibility", "visible");
    const g = gradeAt(profile, i);
    label.textContent = `${fmtKm(profile.dist[i])} km · ${Math.round(profile.ele[i])} m · ${g >= 0 ? "+" : ""}${g.toFixed(1)} %`;
    const right = x > width / 2;
    label.setAttribute("x", right ? x - 6 : x + 6);
    label.setAttribute("text-anchor", right ? "end" : "start");
    label.setAttribute("visibility", "visible");
  }

  render();
  let lastW = width;
  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        if (Math.floor(container.clientWidth) !== lastW) {
          render();
          lastW = width;
        }
      })
    : null;
  ro?.observe(container);
  return { highlight, destroy: () => ro?.disconnect() };
}
