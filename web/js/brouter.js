// Minimal client for a BRouter HTTP server (https://github.com/abrensch/brouter).
//
// Request format (see brouter-server ServerHandler.java):
//     GET /brouter?lonlats=lon,lat|lon,lat&profile=gravel&alternativeidx=0&format=geojson
// The GeoJSON response holds one LineString feature with [lon, lat, elevation] coordinates.
// Errors come back as HTTP 4xx/5xx with a plain-text message (sometimes empty).
// The public server (brouter.de) sends Access-Control-Allow-Origin: *, so a web page can
// call it directly.

import { config } from "./config.js";

/** BRouter answered, but could not compute a route. */
export class BRouterError extends Error {}
/** BRouter could not be reached. */
export class BRouterUnavailable extends Error {}

function explain(message) {
  const m = /datafile (\S+\.rd5) not found/.exec(message);
  if (m) return `BRouter has no routing data for this area (missing tile ${m[1]}).`;
  return message;
}

// One request at a time: a shared public server should not get bursts from one page.
let queue = Promise.resolve();

async function request(waypoints, profile, params = null, baseUrl = null) {
  const base = (baseUrl || config.BROUTER_URL).replace(/\/+$/, "");
  const query = [
    `lonlats=${waypoints.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join("|")}`,
    `profile=${encodeURIComponent(profile)}`,
    "alternativeidx=0",
    "format=geojson",
    ...Object.entries(params || {}).map(([k, v]) => `profile:${encodeURIComponent(k)}=${encodeURIComponent(v)}`),
  ].join("&");
  const url = `${base}/brouter?${query}`;
  const run = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.BROUTER_TIMEOUT_S * 1000);
    let res, body;
    try {
      res = await fetch(url, { signal: ctrl.signal });
      body = await res.text();
    } catch (err) {
      throw new BRouterUnavailable(`BRouter is not reachable at ${base}: ${err.name === "AbortError" ? "timed out" : err.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new BRouterError(explain(body.trim()) || `BRouter returned HTTP ${res.status} (unknown profile '${profile}'?)`);
    }
    try {
      const feature = JSON.parse(body).features[0];
      if (!feature.geometry.coordinates) throw new Error();
      return feature;
    } catch (_) {
      throw new BRouterError(explain(body.trim()) || "BRouter returned an unexpected response");
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

function points(feature) {
  const pts = feature.geometry.coordinates.map((c) => [Number(c[1]), Number(c[0]), c.length > 2 && c[2] != null ? Number(c[2]) : null]);
  if (pts.length < 2) throw new BRouterError("BRouter returned an empty route");
  return pts;
}

/** Route between two [lat, lon] points; returns [[lat, lon, ele], ...]. */
export async function route(start, end, profile, params = null, baseUrl = null) {
  return points(await request([start, end], profile, params, baseUrl));
}

/**
 * Route through the waypoints: {length, rows: [[distance_m, {tag: value}], ...], coords}.
 * Uses the per-segment "messages" table of BRouter's GeoJSON output (Distance and WayTags
 * columns). Pass params {processUnusedTags: "1"} to get all OSM tags.
 */
export async function wayTags(waypoints, profile, params = null, baseUrl = null) {
  const feature = await request(waypoints, profile, params, baseUrl);
  const props = feature.properties || {};
  const messages = props.messages || [];
  const rows = [];
  if (messages.length) {
    const header = messages[0];
    const di = header.indexOf("Distance"), wi = header.indexOf("WayTags");
    if (di < 0 || wi < 0) throw new BRouterError("BRouter response has no Distance/WayTags columns");
    for (const m of messages.slice(1)) {
      const tags = {};
      for (const kv of String(m[wi]).split(/\s+/)) {
        const eq = kv.indexOf("=");
        if (eq > 0) tags[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      rows.push([Number(m[di]), tags]);
    }
  }
  const length = Number(props["track-length"]) || rows.reduce((s, [d]) => s + d, 0);
  const coords = feature.geometry.coordinates.map((c) => [Number(c[1]), Number(c[0])]);
  return { length, rows, coords };
}
