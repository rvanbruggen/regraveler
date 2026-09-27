// Route statistics. Pure functions, easy to test (port of gpxstats.py).

import { cumulativeDistance, geodesicDistance, lineFromMetric, simplify, round, toMetric } from "./geo.js";
import { GpxError } from "./gpx.js";
import { config } from "./config.js";

// Elevation processing parameters. Calibrated against the "NNkm-NNNhm" values in the track
// names of the gravelroutedatabase.be files (median ratio ~0.95).
export const RESAMPLE_STEP_M = 10.0; // resample the profile at a fixed distance step
export const SMOOTH_WINDOW_M = 50.0; // moving-average window over distance
export const GAIN_THRESHOLD_M = 1.0; // hysteresis: ignore up/down changes smaller than this
export const SIMPLIFY_TOLERANCE_M = 5.0; // tolerance for the simplified display geometry

/** Linear interpolation like numpy.interp (xp increasing). */
export function interp(x, xp, fp) {
  const out = new Float64Array(x.length);
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v <= xp[0]) out[i] = fp[0];
    else if (v >= xp[xp.length - 1]) out[i] = fp[fp.length - 1];
    else {
      while (j < xp.length - 2 && xp[j + 1] < v) j++;
      while (j > 0 && xp[j] > v) j--;
      const f = (v - xp[j]) / (xp[j + 1] - xp[j]);
      out[i] = fp[j] + f * (fp[j + 1] - fp[j]);
    }
  }
  return out;
}

/**
 * Resample elevation to a fixed distance step and smooth it. `ele` may contain NaN for
 * missing values; they are interpolated. Returns {grid, ele} or null (not enough data).
 */
export function smoothedProfile(dist, ele) {
  // Known values, with duplicate distances collapsed (the first one wins, like np.unique).
  // Distances never decrease, so skipping repeats is enough.
  const dk = [], ek = [];
  for (let i = 0; i < dist.length; i++) {
    if (Number.isNaN(ele[i])) continue;
    if (dk.length && dist[i] === dk[dk.length - 1]) continue;
    dk.push(dist[i]);
    ek.push(ele[i]);
  }
  if (dk.length < 2) return null;
  const total = dist[dist.length - 1];
  // np.arange(0, total + step, step)
  const grid = new Float64Array(Math.max(1, Math.ceil((total + RESAMPLE_STEP_M) / RESAMPLE_STEP_M)));
  for (let i = 0; i < grid.length; i++) grid[i] = i * RESAMPLE_STEP_M;
  grid[grid.length - 1] = Math.min(grid[grid.length - 1], total);
  let resampled = interp(grid, dk, ek);

  const window = Math.max(1, Math.round(SMOOTH_WINDOW_M / RESAMPLE_STEP_M));
  if (window > 1 && resampled.length > window) {
    const pad = Math.floor(window / 2);
    const m = resampled.length;
    const at = (k) => resampled[Math.min(Math.max(k, 0), m - 1)]; // edge padding
    // Same arithmetic as np.convolve(padded, ones(window) / window, "valid").
    const w = 1 / window;
    const out = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let s = 0;
      for (let k = i - pad; k < i - pad + window; k++) s += at(k) * w;
      out[i] = s;
    }
    resampled = out;
  }
  return { grid, ele: resampled };
}

/**
 * Total ascent and descent, ignoring oscillations smaller than `threshold`. Hysteresis: a
 * change only counts once the elevation has moved at least `threshold` from the last
 * reference level in one direction.
 */
export function gainLoss(ele, threshold = GAIN_THRESHOLD_M) {
  if (ele.length < 2) return [0, 0];
  let gain = 0, loss = 0;
  let ref = ele[0];
  for (let i = 1; i < ele.length; i++) {
    const v = ele[i];
    if (v - ref >= threshold) {
      gain += v - ref;
      ref = v;
    } else if (ref - v >= threshold) {
      loss += ref - v;
      ref = v;
    }
  }
  const last = ele[ele.length - 1];
  if (last > ref) gain += last - ref;
  else loss += ref - last;
  return [gain, loss];
}

/** Simplified [[lat, lon], ...] geometry for map display and geometry comparisons. */
export function simplifyGeometry(lats, lons, toleranceM = SIMPLIFY_TOLERANCE_M) {
  const xy = new Array(lats.length);
  for (let i = 0; i < lats.length; i++) xy[i] = toMetric(lats[i], lons[i]);
  return lineFromMetric(simplify(xy, toleranceM), 6);
}

/** Stats of a route from its points [[lat, lon, ele|null], ...]. */
export function computeStats(points) {
  if (points.length < 2) throw new GpxError("A route needs at least two points");
  const n = points.length;
  const lats = new Float64Array(n), lons = new Float64Array(n), ele = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lats[i] = points[i][0];
    lons[i] = points[i][1];
    ele[i] = points[i][2] == null ? NaN : points[i][2];
  }
  const dist = cumulativeDistance(lats, lons);
  const profile = smoothedProfile(dist, ele);
  let gain = null, loss = null, minE = null, maxE = null;
  if (profile) {
    [gain, loss] = gainLoss(profile.ele);
    gain = Math.round(gain);
    loss = Math.round(loss);
    let lo = Infinity, hi = -Infinity;
    for (const v of profile.ele) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    minE = round(lo, 1);
    maxE = round(hi, 1);
  }
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (let i = 0; i < n; i++) {
    if (lats[i] < minLat) minLat = lats[i];
    if (lats[i] > maxLat) maxLat = lats[i];
    if (lons[i] < minLon) minLon = lons[i];
    if (lons[i] > maxLon) maxLon = lons[i];
  }
  const startEnd = geodesicDistance(lats[0], lons[0], lats[n - 1], lons[n - 1]);
  return {
    distance_km: round(dist[n - 1] / 1000, 2),
    elevation_gain_m: gain,
    elevation_loss_m: loss,
    min_elevation_m: minE,
    max_elevation_m: maxE,
    start_lat: lats[0],
    start_lon: lons[0],
    end_lat: lats[n - 1],
    end_lon: lons[n - 1],
    min_lat: minLat,
    min_lon: minLon,
    max_lat: maxLat,
    max_lon: maxLon,
    is_loop: startEnd <= config.LOOP_THRESHOLD_M,
    geometry: simplifyGeometry(lats, lons),
  };
}
