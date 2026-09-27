// Import a public route from a link (Utilities › Import from a link).
//
// RideWithGPS: a public route or ride has a JSON document (/routes/<id>.json, /trips/<id>.json)
// that anyone may read, cross-origin too (it sends Access-Control-Allow-Origin: *), so this
// works on the static site and on a server alike. Its track points become a GPX file, which is
// imported like any other. (Its .gpx export needs a login since 2026, the JSON does not.)
//
// Komoot: the same idea. A public tour (or a private one shared with a share_token link) has
// /api/v007/tours/<id> (name, sport, surfaces) and /api/v007/tours/<id>/coordinates (the track
// with elevation), readable from any site. Its .gpx export needs a login.
//
// Strava: every export (GPX, TCX, the API) needs a signed-in Strava user, so the page can't
// fetch the route itself. It recognises the link and hands the user the export address to
// download while signed in to Strava; the downloaded file is then imported with the link.
//
// Any other link: fetched as it is, and imported if it is a GPX file. The browser can only read
// it if that site allows other sites to (CORS); where it doesn't, a rerouter server fetches it
// instead (api/fetch-gpx), the static site can't.

import { GpxError, parseGpx, writeGpx } from "./gpx.js";

export class LinkImportError extends Error {
  /** exportUrl: where the user can download the GPX themselves (Strava). */
  constructor(message, { exportUrl = null } = {}) {
    super(message);
    this.exportUrl = exportUrl;
  }
}

// Largest GPX file fetched from a link (bytes).
export const MAX_LINK_BYTES = 20_000_000;
// How long the browser tries to fetch a GPX file itself before giving up (ms).
export const LINK_TIMEOUT_MS = 15_000;

const RWGPS_HOSTS = /^(www\.)?(ridewithgps\.com|rwgps\.com)$/i;
const KOMOOT_HOSTS = /^(www\.|api\.)?komoot\.[a-z]{2,3}(\.[a-z]{2})?$/i;
const STRAVA_HOSTS = /^(www\.)?strava\.com$/i;

const hostOf = (url) => new URL(url).hostname.replace(/^www\./i, "");

/**
 * Recognise a route link. Returns {service, kind, id, url, ...}, url being the canonical
 * address (stored as the route's source URL). service: "ridewithgps", "komoot", "strava" or
 * "web" (any other link, maybe a GPX file). Throws LinkImportError for what can't be a route.
 */
export function parseRouteLink(text) {
  let u;
  try {
    u = new URL(String(text).trim());
  } catch (_) {
    throw new LinkImportError("That is not a web address. Paste the link of a route or of a GPX file.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new LinkImportError("Only web links (https://…) can be imported.");
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (RWGPS_HOSTS.test(u.hostname)) {
    const m = path.match(/^\/(routes|trips)\/(\d+)(\.\w+)?$/);
    if (!m) throw new LinkImportError("That RideWithGPS link is not a route or a ride (it should look like ridewithgps.com/routes/12345).");
    return { service: "ridewithgps", kind: m[1] === "trips" ? "ride" : "route", id: m[2], url: `https://ridewithgps.com/${m[1]}/${m[2]}` };
  }
  if (KOMOOT_HOSTS.test(u.hostname)) {
    // komoot.com/tour/1, komoot.com/nl-nl/tour/1, komoot.de/tour/1, …/api/v007/tours/1.gpx
    const m = path.match(/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/tour\/(\d+)(?:\/.*)?$/i) || path.match(/^\/(?:api\/)?v007\/tours\/(\d+)(?:\.\w+|\/.*)?$/i);
    if (!m) throw new LinkImportError("That Komoot link is not a tour (it should look like komoot.com/tour/12345).");
    const shareToken = u.searchParams.get("share_token") || null;
    const url = `https://www.komoot.com/tour/${m[1]}${shareToken ? `?share_token=${encodeURIComponent(shareToken)}` : ""}`;
    return { service: "komoot", kind: "tour", id: m[1], url, shareToken };
  }
  if (STRAVA_HOSTS.test(u.hostname)) {
    const m = path.match(/^\/routes\/(\d+)(\/.*)?$/);
    if (!m) throw new LinkImportError("That Strava link is not a route (it should look like strava.com/routes/12345).");
    const url = `https://www.strava.com/routes/${m[1]}`;
    return { service: "strava", kind: "route", id: m[1], url, exportUrl: `${url}/export_gpx` };
  }
  u.hash = "";
  return { service: "web", kind: "file", id: null, url: u.href };
}

const SERVICE_NAMES = { ridewithgps: "RideWithGPS", komoot: "Komoot", strava: "Strava" };

/** The source name for a link: the service, or the site a GPX file came from. */
export const serviceName = (link) => SERVICE_NAMES[link.service] || hostOf(link.url);

// Activity names of the services -> rerouter activities. (Komoot calls "mtb_easy" a gravel ride.)
const ACTIVITY_PATTERNS = [
  [/gravel|cyclocross|mtb_easy/, "gravel"],
  [/mountain|mtb/, "mtb"],
  [/road|racebike/, "road"],
  [/hik|walk|trail_run|running|jogging|mountaineering/, "hiking"],
];

function activityFrom(types) {
  for (const t of types || []) {
    for (const [re, activity] of ACTIVITY_PATTERNS) if (re.test(String(t).toLowerCase())) return activity;
  }
  return null;
}

/** GPX text -> the bytes to import (UTF-8). */
const encode = (text) => new TextEncoder().encode(text);

/**
 * A RideWithGPS JSON document (route or trip) -> what the import needs:
 * {name, description, data (GPX bytes), filename, points, activity, paved_pct, distance_km}.
 */
export function fromRideWithGps(doc) {
  const r = doc?.route || doc?.trip || doc;
  const pts = (r?.track_points || [])
    .filter((p) => Number.isFinite(p.y) && Number.isFinite(p.x))
    .map((p) => [p.y, p.x, Number.isFinite(p.e) ? p.e : null]);
  if (pts.length < 2) throw new LinkImportError("This RideWithGPS route has no track to import.");
  const name = (r.name || "").trim() || `RideWithGPS ${r.id ?? ""}`.trim();
  const description = (r.description || "").trim() || null;
  return {
    name,
    description,
    data: encode(writeGpx(name, pts, description, "rerouter (from RideWithGPS)")),
    filename: `${name}.gpx`,
    points: pts.length,
    activity: activityFrom(r.activity_types),
    paved_pct: Number.isFinite(r.unpaved_pct) ? 100 - r.unpaved_pct : null,
    distance_km: Number.isFinite(r.distance) ? r.distance / 1000 : null,
  };
}

// Komoot surface types ("sb#asphalt", "sf#unknown", …) that count as paved; cobbles too, as in
// rerouter's own estimate (surface.js). Anything else known is unpaved.
const KOMOOT_PAVED = /#(asphalt|paved|concrete|paving_stones|cobbles|cobblestone|sett)$/;

/** Paved % from Komoot's surface summary, like surface.js: of the known part, if it's at least half. */
export function komootPavedPct(surfaces) {
  let paved = 0, known = 0, total = 0;
  for (const s of surfaces || []) {
    const amount = Number(s.amount) || 0;
    total += amount;
    if (/unknown/.test(s.type)) continue;
    known += amount;
    if (KOMOOT_PAVED.test(s.type)) paved += amount;
  }
  return known && known >= 0.5 * total ? Math.round((100 * paved) / known) : null;
}

/** A Komoot tour document and its coordinates document -> what the import needs (see fromRideWithGps). */
export function fromKomoot(tour, coordinates) {
  const pts = (coordinates?.items || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => [p.lat, p.lng, Number.isFinite(p.alt) ? p.alt : null]);
  if (pts.length < 2) throw new LinkImportError("This Komoot tour has no track to import.");
  const name = (tour?.name || "").trim() || `Komoot ${tour?.id ?? ""}`.trim();
  return {
    name,
    description: null,
    data: encode(writeGpx(name, pts, null, "rerouter (from Komoot)")),
    filename: `${name}.gpx`,
    points: pts.length,
    activity: activityFrom([tour?.sport]),
    paved_pct: komootPavedPct(tour?.summary?.surfaces),
    distance_km: Number.isFinite(tour?.distance) ? tour.distance / 1000 : null,
  };
}

/** A GPX file fetched from a link -> what the import needs. The file is imported unchanged. */
export function fromGpxFile(data, url) {
  let parsed;
  try {
    parsed = parseGpx(data);
  } catch (err) {
    if (!(err instanceof GpxError)) throw err;
    throw new LinkImportError(`That link doesn't lead to a GPX file (${err.message.replace(/^Could not parse GPX: /, "")}). ` +
      "Use the link of the file itself, e.g. the site's \"Download GPX\" link.");
  }
  let filename = "";
  try {
    filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch (_) {}
  const stem = filename.replace(/\.gpx$/i, "");
  const name = parsed.name || parsed.tracks[0].name || stem || hostOf(url);
  if (!/\.gpx$/i.test(filename)) filename = `${name}.gpx`;
  return {
    name,
    description: parsed.description || null,
    data,
    filename,
    points: parsed.tracks.reduce((n, t) => n + t.points.length, 0),
    tracks: parsed.tracks.length,
    track_name: parsed.tracks[0].name || null,
    activity: null,
    paved_pct: null,
    distance_km: null,
  };
}

async function getJson(url, fetchFn, what) {
  let res;
  try {
    // Komoot answers only application/hal+json (406 to a plain application/json).
    res = await fetchFn(url, { headers: { Accept: "application/hal+json, application/json" } });
  } catch (err) {
    throw new LinkImportError(`${what.service} could not be reached: ${err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new LinkImportError(what.private);
  if (res.status === 404) throw new LinkImportError(`${what.service} has no ${what.kind} ${what.id}.`);
  if (!res.ok) throw new LinkImportError(`${what.service} answered ${res.status} ${res.statusText}.`);
  return res.json();
}

/** The detail of a rerouter server's error answer, if it has one. */
async function serverDetail(res) {
  try {
    const detail = (await res.json()).detail;
    if (typeof detail === "string") return detail;
  } catch (_) {}
  return `${res.status} ${res.statusText}`;
}

/**
 * Fetch a GPX file: straight from the site, or through the rerouter server (proxy) when the
 * site doesn't let the browser read it. Returns the bytes.
 */
async function fetchGpxFile(link, fetchFn, proxy) {
  const host = hostOf(link.url);
  let res = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINK_TIMEOUT_MS);
  try {
    res = await fetchFn(link.url, { signal: ctrl.signal });
  } catch (_) {
    // Refused by the browser (the site doesn't allow other sites to read it, or it's http://
    // on an https page) or not reachable. The server can try; the static site can't.
    if (!proxy) {
      throw new LinkImportError(`${host} doesn't let other websites read its files (or can't be reached), so this ` +
        "version of rerouter can't fetch it. Download the file and add it on the Import screen instead " +
        "(you can paste this link there as its source URL).");
    }
  } finally {
    clearTimeout(timer);
  }
  let viaServer = false;
  if (!res) {
    viaServer = true;
    try {
      res = await proxy(link.url);
    } catch (err) {
      throw new LinkImportError(`The rerouter server is not reachable: ${err.message}`);
    }
  }
  if (!res.ok) {
    if (viaServer) throw new LinkImportError(await serverDetail(res));
    if (res.status === 401 || res.status === 403) throw new LinkImportError(`${host} wants you to sign in for this file. Download it yourself and add it on the Import screen.`);
    if (res.status === 404) throw new LinkImportError(`There is nothing at that link on ${host} (404).`);
    throw new LinkImportError(`${host} answered ${res.status} ${res.statusText}.`);
  }
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_LINK_BYTES) throw new LinkImportError(`That file is too large (over ${MAX_LINK_BYTES / 1e6} MB).`);
  return data;
}

/**
 * Fetch the route behind a parsed link. Returns {name, description, data, filename, points,
 * activity, paved_pct, distance_km, link}. proxy(url) -> Response: fetches a GPX file through
 * the rerouter server (only there; null on the static site). Strava, private routes and links
 * that aren't GPX files throw a LinkImportError explaining what to do.
 */
export async function fetchRoute(link, fetchFn = globalThis.fetch, { proxy = null } = {}) {
  if (link.service === "strava") {
    throw new LinkImportError(
      "Strava only hands out a route's GPX to someone signed in to Strava, so rerouter can't fetch it. " +
      "Download it yourself (while signed in), then choose the downloaded file below: it gets this link as its source.",
      { exportUrl: link.exportUrl });
  }
  if (link.service === "ridewithgps") {
    const api = `https://ridewithgps.com/${link.kind === "ride" ? "trips" : "routes"}/${link.id}.json`;
    const doc = await getJson(api, fetchFn, {
      service: "RideWithGPS", kind: link.kind, id: link.id,
      private: `This RideWithGPS ${link.kind} is not public. Ask its owner to make it public, or download its GPX while signed in and import that file.`,
    });
    return { ...fromRideWithGps(doc), link };
  }
  if (link.service === "komoot") {
    const q = link.shareToken ? `?share_token=${encodeURIComponent(link.shareToken)}` : "";
    const what = {
      service: "Komoot", kind: "tour", id: link.id,
      private: "This Komoot tour is private. If its owner shared it with you, use the link they sent (it has a share_token in it).",
    };
    const base = `https://www.komoot.com/api/v007/tours/${link.id}`;
    const [tour, coordinates] = await Promise.all([getJson(`${base}${q}`, fetchFn, what), getJson(`${base}/coordinates${q}`, fetchFn, what)]);
    return { ...fromKomoot(tour, coordinates), link };
  }
  return { ...fromGpxFile(await fetchGpxFile(link, fetchFn, proxy), link.url), link };
}
