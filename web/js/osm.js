// Places from OpenStreetMap, through the Overpass API. The public servers are free but often
// busy (answers of 10-30 s, or 504), so: only on request (never on every map move), each
// server in turn, answers kept for a week (in this browser, or by the rerouter server), and a
// clear message when none answers.

import { config } from "./config.js";
import { osmPlaces, overpassQuery, routeBoxes } from "./poi.js";

export class OverpassUnavailable extends Error {}

const CACHE_PREFIX = "rerouter.osm.";
const CACHE_MAX = 60; // answers kept in this browser

/** A short hash of a string (for cache keys). */
function hash(s) {
  let h1 = 0x811c9dc5, h2 = 0;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = (h2 * 31 + s.charCodeAt(i)) | 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

function cacheGet(key) {
  try {
    const hit = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || "null");
    if (hit && Date.now() - hit.t < config.OVERPASS_CACHE_DAYS * 86400e3) return hit.answer;
  } catch { /* no storage, or damaged: ask again */ }
  return null;
}

function cachePut(key, answer) {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length >= CACHE_MAX) {
      const oldest = keys.map((k) => [k, JSON.parse(localStorage.getItem(k) || "{}").t || 0]).sort((a, b) => a[1] - b[1]);
      for (const [k] of oldest.slice(0, keys.length - CACHE_MAX + 1)) localStorage.removeItem(k);
    }
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), answer }));
  } catch { /* full or blocked: just don't keep it */ }
}

/**
 * Run an Overpass query: the server's proxy when `proxyUrl` is given, else each public server
 * in turn. `fetchFn` for tests. Throws OverpassUnavailable when none answers.
 */
export async function runQuery(query, { proxyUrl = null, fetchFn = fetch, onTry = null } = {}) {
  const key = hash(query);
  const cached = cacheGet(key);
  if (cached) return cached;
  const urls = proxyUrl ? [proxyUrl] : config.OVERPASS_URLS;
  const problems = [];
  for (const url of urls) {
    onTry?.(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.OVERPASS_TIMEOUT_S * 1000);
    try {
      const res = await fetchFn(url, {
        method: "POST", body: `data=${encodeURIComponent(query)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctrl.signal,
      });
      if (!res.ok) {
        problems.push(`${new URL(url).host}: HTTP ${res.status}`);
        continue;
      }
      const answer = await res.json();
      if (answer.remark && /runtime error|timed out/i.test(answer.remark) && !answer.elements?.length) {
        problems.push(`${new URL(url).host}: ${answer.remark}`);
        continue;
      }
      cachePut(key, answer);
      return answer;
    } catch (err) {
      problems.push(`${new URL(url, "http://x").host}: ${err.name === "AbortError" ? "no answer in time" : err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new OverpassUnavailable(`OpenStreetMap's place servers are busy right now; try again in a while (${problems.join("; ")})`);
}

/** Places of the categories in a map area [south, west, north, east]. */
export async function placesInArea(bbox, categories, labels, opts = {}) {
  return osmPlaces(await runQuery(overpassQuery(categories, { bbox }), opts), categories, labels);
}

/** Places of the categories around a route [[lat, lon], ...] (pick the near ones with placesAlong). */
export async function placesAroundRoute(geometry, categories, labels, padM, opts = {}) {
  return osmPlaces(await runQuery(overpassQuery(categories, { bboxes: routeBoxes(geometry, { padM }) }), opts), categories, labels);
}
