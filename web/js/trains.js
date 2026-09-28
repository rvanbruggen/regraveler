// Train rides: days out with the train, with library routes as the riding part.
//
//   ride-out    ride from home (a route that starts near home), take the train back
//   train-out   take the train out, ride home (a route that ends near home)
//   train-both  train out to the start, ride, train back from the end (point to point)
//   loop        train out to a station on a loop, ride the loop, train back from there
//
// Stations: data/stations.json (tools/build_stations.py, from OpenStreetMap). Timetables:
// Transitous (api.transitous.org, the whole of Europe, community-run) and iRail
// (api.irail.be, SNCB/NMBS) as a fallback between Belgian stations. Neither can limit the
// number of transfers reliably, so that is done here.

import { config } from "./config.js";
import { closestOnSegment, cumulative, geodesicDistance, lineToMetric, toMetric } from "./geo.js";

export class TrainsUnavailable extends Error {}

export const PATTERNS = ["ride-out", "train-out", "train-both", "loop"];
const DETOUR = 1.3; // riding distance to a station ≈ straight line × this

// ------------------------------------------------------------------ stations

let stationsLoader = async () => {
  const res = await fetch(new URL("../data/stations.json", import.meta.url));
  if (!res.ok) throw new TrainsUnavailable(`Could not load the stations (${res.status})`);
  return (await res.json()).stations;
};
let stations = null; // Promise of [{name, lat, lon, uic, x, y}]

export function setStationsLoader(fn) {
  stationsLoader = fn;
  stations = null;
}

export async function allStations() {
  stations ??= Promise.resolve(stationsLoader()).then((list) => list.map(([name, lat, lon, uic]) => {
    const [x, y] = toMetric(lat, lon);
    return { name, lat, lon, uic: uic || null, x, y };
  })).catch((err) => {
    stations = null;
    throw err;
  });
  return stations;
}

/** Stations within `maxM` of a point, nearest first: [{station, m}]. */
export function stationsNear(list, lat, lon, maxM) {
  const [x, y] = toMetric(lat, lon);
  const out = [];
  for (const s of list) {
    const m = Math.hypot(s.x - x, s.y - y);
    if (m <= maxM) out.push({ station: s, m });
  }
  return out.sort((a, b) => a.m - b.m);
}

/** The station nearest to a line (a loop): {station, m, at} (at: metres along it), or null. */
function stationNearLine(list, line, maxM) {
  const xy = lineToMetric(line);
  const cum = cumulative(xy);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  let best = null;
  for (const s of list) {
    if (s.x < minX - maxM || s.x > maxX + maxM || s.y < minY - maxM || s.y > maxY + maxM) continue;
    for (let i = 0; i < xy.length - 1; i++) {
      const c = closestOnSegment(s.x, s.y, xy[i][0], xy[i][1], xy[i + 1][0], xy[i + 1][1]);
      if (c.d <= maxM && (!best || c.d < best.m)) best = { station: s, m: c.d, at: cum[i] + c.t * (cum[i + 1] - cum[i]) };
    }
  }
  return best;
}

// ------------------------------------------------------------------ planning (offline)

const kmTo = (m) => (m * DETOUR) / 1000;

/**
 * Candidate trips from library routes, without timetables: [{pattern, route_id, reversed,
 * from (station or "home"), to, ride_km, connector_km, start_at_m (loops)}], best first (least
 * riding to and from stations). opts: {patterns, home {lat, lon}, homeStation, maxStationM,
 * homeReachM, minKm, maxKm, minTrainM (a station closer to home than this is not worth a
 * train: ride there)}.
 */
export function planCandidates(routes, list, opts) {
  const { home, homeStation, maxStationM = 3000, homeReachM = 5000, minKm = 0, maxKm = Infinity, minTrainM = 10000 } = opts;
  const want = new Set(opts.patterns || PATTERNS);
  const out = [];
  const far = homeStation ? list.filter((s) => Math.hypot(s.x - homeStation.x, s.y - homeStation.y) >= minTrainM) : list;
  const near = (lat, lon) => stationsNear(far, lat, lon, maxStationM)[0] || null;
  const fromHome = (lat, lon) => (home ? geodesicDistance(home.lat, home.lon, lat, lon) : Infinity);
  const push = (c) => {
    const ride = c.route_km + c.connector_km;
    if (ride >= minKm && ride <= maxKm) out.push({ ...c, ride_km: Math.round(ride * 10) / 10, connector_km: Math.round(c.connector_km * 10) / 10 });
  };
  for (const r of routes) {
    if (r.is_loop) {
      if (!want.has("loop")) continue;
      const s = stationNearLine(far, r.geometry, maxStationM);
      if (s) push({ pattern: "loop", route_id: r.id, reversed: false, from: s.station, to: s.station, start_at_m: Math.round(s.at), route_km: r.distance_km, connector_km: 2 * kmTo(s.m) });
      continue;
    }
    for (const reversed of [false, true]) {
      const [a, b] = reversed ? [[r.end_lat, r.end_lon], [r.start_lat, r.start_lon]] : [[r.start_lat, r.start_lon], [r.end_lat, r.end_lon]];
      const sa = near(...a), sb = near(...b);
      const ha = fromHome(...a), hb = fromHome(...b);
      if (want.has("ride-out") && ha <= homeReachM && sb) {
        push({ pattern: "ride-out", route_id: r.id, reversed, from: "home", to: sb.station, route_km: r.distance_km, connector_km: kmTo(ha) + kmTo(sb.m) });
      }
      if (want.has("train-out") && hb <= homeReachM && sa) {
        push({ pattern: "train-out", route_id: r.id, reversed, from: sa.station, to: "home", route_km: r.distance_km, connector_km: kmTo(sa.m) + kmTo(hb) });
      }
      if (want.has("train-both") && sa && sb && ha > homeReachM && hb > homeReachM) {
        push({ pattern: "train-both", route_id: r.id, reversed, from: sa.station, to: sb.station, route_km: r.distance_km, connector_km: kmTo(sa.m) + kmTo(sb.m) });
      }
    }
  }
  // Least riding to and from the stations first; one direction per route and pattern.
  out.sort((x, y) => x.connector_km - y.connector_km);
  const seen = new Set();
  return out.filter((c) => {
    const k = `${c.pattern}:${c.route_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------------ timetables

const TRANSITOUS = "https://api.transitous.org/api/v1";
const IRAIL = "https://api.irail.be/v1";
const ID_CACHE = "rerouter.stationIds";

function idCache() {
  try {
    return JSON.parse(localStorage.getItem(ID_CACHE) || "{}");
  } catch {
    return {};
  }
}
function remember(key, id) {
  try {
    const c = idCache();
    if (id) c[key] = id;
    else delete c[key];
    localStorage.setItem(ID_CACHE, JSON.stringify(c));
  } catch { /* only for now */ }
}

const isBelgian = (s) => /^88\d{5}$/.test(s.uic || "");
const stationKey = (s) => `${s.name}@${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;

async function getJson(url, fetchFn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (config.TRAINS_TIMEOUT_S || 25) * 1000);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    throw new TrainsUnavailable(err.name === "AbortError" ? "no answer in time" : err.message);
  } finally {
    clearTimeout(timer);
  }
}

/** The Transitous id of a station: derived for Belgian ones, else looked up by name (cached). */
export async function transitousId(s, { fetchFn = fetch } = {}) {
  if (isBelgian(s)) return `be-sncb_S${s.uic}`;
  const key = stationKey(s);
  const cached = idCache()[key];
  if (cached) return cached;
  const url = `${TRANSITOUS}/geocode?text=${encodeURIComponent(s.name)}&type=STOP&place=${s.lat},${s.lon}`;
  const { ok, body } = await getJson(url, fetchFn);
  if (!ok || !Array.isArray(body)) throw new TrainsUnavailable(`Could not find station ${s.name} in the timetables`);
  const hits = body.filter((x) => x.type === "STOP" && Number.isFinite(x.lat))
    .map((x) => ({ id: x.id, m: geodesicDistance(s.lat, s.lon, x.lat, x.lon) }))
    .filter((x) => x.m <= 800).sort((a, b) => a.m - b.m);
  if (!hits.length) throw new TrainsUnavailable(`Could not find station ${s.name} in the timetables`);
  remember(key, hits[0].id);
  return hits[0].id;
}

/**
 * Train connections from station to station, departing after `time` (or arriving before it,
 * with arriveBy), with at most `maxTransfers` transfers: [{dep, arr (Date), minutes,
 * transfers, trains: ["IC 4930", …], legs: [{train, from, to, dep, arr}]}], earliest first.
 */
export async function connections(from, to, time, { arriveBy = false, maxTransfers = 2, fetchFn = fetch } = {}) {
  let list;
  try {
    list = await viaTransitous(from, to, time, arriveBy, fetchFn);
  } catch (err) {
    if (!(isBelgian(from) && isBelgian(to))) throw err;
    list = await viaIRail(from, to, time, arriveBy, fetchFn); // Belgium: SNCB's own timetable
  }
  return list.filter((c) => c.transfers <= maxTransfers).sort((a, b) => a.dep - b.dep);
}

async function viaTransitous(from, to, time, arriveBy, fetchFn) {
  const [a, b] = await Promise.all([transitousId(from, { fetchFn }), transitousId(to, { fetchFn })]);
  const q = new URLSearchParams({ fromPlace: a, toPlace: b, time: time.toISOString(), transitModes: "RAIL", numItineraries: "5" });
  if (arriveBy) q.set("arriveBy", "true");
  const { ok, status, body } = await getJson(`${TRANSITOUS}/plan?${q}`, fetchFn);
  if (!ok || !body || !Array.isArray(body.itineraries)) {
    const msg = body?.error || `HTTP ${status}`;
    if (/Could not find timetable location/.test(msg)) {
      remember(stationKey(from), null);
      remember(stationKey(to), null);
    }
    throw new TrainsUnavailable(`Transitous: ${msg}`);
  }
  return body.itineraries.map((it) => {
    const legs = it.legs.filter((l) => l.mode !== "WALK").map((l) => ({
      train: l.routeShortName || l.mode, from: l.from?.name, to: l.to?.name, dep: new Date(l.startTime), arr: new Date(l.endTime),
    }));
    return {
      dep: new Date(it.startTime), arr: new Date(it.endTime), minutes: Math.round(it.duration / 60),
      transfers: it.transfers ?? Math.max(0, legs.length - 1), trains: legs.map((l) => l.train), legs,
    };
  });
}

async function viaIRail(from, to, time, arriveBy, fetchFn) {
  const p2 = (n) => String(n).padStart(2, "0");
  const q = new URLSearchParams({
    from: `BE.NMBS.00${from.uic}`, to: `BE.NMBS.00${to.uic}`, format: "json", results: "6", lang: "nl",
    date: `${p2(time.getDate())}${p2(time.getMonth() + 1)}${String(time.getFullYear()).slice(2)}`,
    time: `${p2(time.getHours())}${p2(time.getMinutes())}`, timesel: arriveBy ? "arrival" : "departure",
  });
  const { ok, status, body } = await getJson(`${IRAIL}/connections/?${q}`, fetchFn);
  if (!ok || !body || !Array.isArray(body.connection)) throw new TrainsUnavailable(`No timetable answered (iRail: HTTP ${status})`);
  return body.connection.map((c) => {
    const dep = new Date(Number(c.departure.time) * 1000), arr = new Date(Number(c.arrival.time) * 1000);
    const train = (x) => (x.vehicleinfo?.shortname || x.vehicle || "").replace(/^BE\.NMBS\./, "");
    return {
      dep, arr, minutes: Math.round((arr - dep) / 60000), transfers: Number(c.vias?.number || 0),
      trains: [train(c.departure), ...(c.vias?.via || []).map((v) => train(v.departure || v))].filter(Boolean),
      legs: [{ train: train(c.departure), from: from.name, to: to.name, dep, arr }],
    };
  });
}
