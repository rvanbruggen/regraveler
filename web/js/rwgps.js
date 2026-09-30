// Import from your RideWithGPS account (Utilities › Import from RideWithGPS).
//
// RideWithGPS's API v1 (https://ridewithgps.com/api) answers the browser directly: it sends
// Access-Control-Allow-Origin: * and allows the x-rwgps-api-key and x-rwgps-auth-token headers,
// so this works on the static site and on a rerouter server alike, without the server.
//
// Signing in: the user makes an API client at ridewithgps.com/api/api_clients (it gets an API
// key) and generates an auth token for it there (Basic Authentication). rerouter asks for those
// two, never for the RideWithGPS password. OAuth would need the client's secret, which a page
// can't keep.
//
// Listing: /api/v1/routes.json and /api/v1/trips.json, page by page (page_size 20–200, the
// answer's meta.pagination has next_page_url). One route or ride: /api/v1/routes/<id>.json,
// /api/v1/trips/<id>.json, with its track points; those become a GPX file exactly as for a
// public RideWithGPS link (linkimport.js fromRideWithGps), so both get the same source URL
// and a route imported one way is recognised the other way.

import { fromRideWithGps } from "./linkimport.js";

export const RWGPS_API = "https://ridewithgps.com/api/v1";
export const PAGE_SIZE = 200;
// A library of more than this many pages (x PAGE_SIZE) is not listed further.
export const MAX_PAGES = 100;
// Pause between two routes fetched for an import (ms), to be gentle on RideWithGPS.
export const IMPORT_PAUSE_MS = 250;
// A "too many requests" answer: wait this long (or what Retry-After says, up to a minute), a few times.
const RETRY_WAIT_MS = 5000;
const RETRIES = 3;

// The two kinds of things in a RideWithGPS account: planned routes and recorded rides ("trips").
export const KINDS = {
  routes: { path: "routes", root: "route", label: "route", labelPlural: "routes" },
  trips: { path: "trips", root: "trip", label: "ride", labelPlural: "rides" },
};

export class RwgpsError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The address a route or ride is stored under as its source URL (as for an imported link). */
export const sourceUrl = (kind, id) => `https://ridewithgps.com/${KINDS[kind].path}/${id}`;

/** {apiKey, authToken} -> the request headers. */
export function headers({ apiKey, authToken }) {
  return { Accept: "application/json", "x-rwgps-api-key": String(apiKey).trim(), "x-rwgps-auth-token": String(authToken).trim() };
}

/** GET a RideWithGPS API address (only ridewithgps.com: the key and token go nowhere else). */
async function getJson(url, creds, fetchFn, sleepFn) {
  if (new URL(url).origin !== new URL(RWGPS_API).origin) throw new RwgpsError(`RideWithGPS pointed to another site (${url}).`);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchFn(url, { headers: headers(creds) });
    } catch (err) {
      throw new RwgpsError(`RideWithGPS could not be reached: ${err.message}`);
    }
    if (res.status === 429 && attempt < RETRIES) {
      const after = Number(res.headers?.get?.("Retry-After"));
      await sleepFn(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 60_000) : RETRY_WAIT_MS);
      continue;
    }
    if (res.status === 401) {
      throw new RwgpsError("RideWithGPS didn't accept the API key and auth token. Check both (the token belongs to that API client), or generate a new token.", 401);
    }
    if (res.status === 403) throw new RwgpsError("RideWithGPS says this account may not read that.", 403);
    if (res.status === 404) throw new RwgpsError("RideWithGPS has no such route or ride (any more).", 404);
    if (res.status === 429) throw new RwgpsError("RideWithGPS asks to slow down (too many requests). Try again in a while.", 429);
    if (!res.ok) throw new RwgpsError(`RideWithGPS answered ${res.status} ${res.statusText || ""}`.trim() + ".", res.status);
    try {
      return await res.json();
    } catch (_) {
      throw new RwgpsError("RideWithGPS sent something that isn't JSON.");
    }
  }
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** One route or ride from a list -> {kind, id, name, distance_km, gain_m, date, updated_at, url}. */
export function summarise(kind, item) {
  const distance = num(item.distance);
  return {
    kind,
    id: String(item.id),
    name: String(item.name || "").trim() || `RideWithGPS ${KINDS[kind].label} ${item.id}`,
    distance_km: distance == null ? null : distance / 1000,
    gain_m: num(item.elevation_gain),
    // A ride's date is when it was ridden; a route's when it was made.
    date: (kind === "trips" && item.departed_at) || item.created_at || null,
    updated_at: item.updated_at || null,
    url: sourceUrl(kind, item.id),
  };
}

/**
 * All routes (kind "routes") or rides ("trips") of the signed-in account, summarised (see
 * summarise), in RideWithGPS's order. onPage({loaded, total}) reports progress.
 */
export async function listAll(kind, creds, { fetchFn = globalThis.fetch, onPage = null, sleepFn = sleep } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown kind ${kind}`);
  const items = [];
  const seen = new Set();
  let url = `${RWGPS_API}/${k.path}.json?page=1&page_size=${PAGE_SIZE}`;
  for (let page = 1; url && page <= MAX_PAGES; page++) {
    const doc = await getJson(url, creds, fetchFn, sleepFn);
    const list = Array.isArray(doc?.[k.path]) ? doc[k.path] : [];
    for (const item of list) {
      if (item?.id == null || seen.has(String(item.id))) continue;
      seen.add(String(item.id));
      items.push(summarise(kind, item));
    }
    const p = doc?.meta?.pagination || {};
    onPage?.({ loaded: items.length, total: num(p.record_count) });
    if (!list.length) break;
    if (p.next_page_url) url = new URL(p.next_page_url, RWGPS_API).href;
    else if (num(p.page_count) != null && page < num(p.page_count)) url = `${RWGPS_API}/${k.path}.json?page=${page + 1}&page_size=${PAGE_SIZE}`;
    else url = null;
  }
  return items;
}

/**
 * One route or ride, with its track -> what the import needs (as for an imported link:
 * {name, description, data (GPX bytes), filename, points, activity, paved_pct, distance_km}).
 */
export async function fetchOne(kind, id, creds, { fetchFn = globalThis.fetch, sleepFn = sleep } = {}) {
  const doc = await getJson(`${RWGPS_API}/${KINDS[kind].path}/${encodeURIComponent(id)}.json`, creds, fetchFn, sleepFn);
  return fromRideWithGps(doc);
}

/** The library routes each RideWithGPS source URL was imported as: Map url -> [route, …]. */
export function importedByUrl(routes) {
  const map = new Map();
  for (const r of routes) {
    const m = String(r.source_url || "").match(/^https?:\/\/(?:www\.)?(?:ridewithgps|rwgps)\.com\/(routes|trips)\/(\d+)/i);
    if (!m) continue;
    const url = sourceUrl(m[1].toLowerCase(), m[2]);
    if (!map.has(url)) map.set(url, []);
    map.get(url).push(r);
  }
  return map;
}
