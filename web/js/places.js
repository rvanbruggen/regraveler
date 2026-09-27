// Descriptive route names from the places a route visits (port of places.py).
//
// Place data: GeoNames (https://www.geonames.org/, CC BY 4.0), trimmed by
// tools/build_places.py into 1 x 1 degree tiles under data/places/. Towns and villages come
// with their population; landmarks are named forests, heaths, hills, parks, lakes, castles and
// abbeys. Names are in Dutch where GeoNames has one (Zoniënwoud, not Forêt de Soignes).
//
// A generated name looks like "Tervuren – Zoniënwoud – Overijse – Huldenberg": the start
// town, then up to three noteworthy places in riding order (for a point-to-point route, the
// last one is where it ends).

import { SegmentGrid, closestOnSegment, cumulative, lineToMetric, toMetric } from "./geo.js";

export const SEPARATOR = " – ";

const TOWN_CODES = new Set(["PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLC", "PPLS", "PPLF", "PPLL"]);
// Landmarks worth putting in a route name, with how close (m) the route must pass their
// (single) GeoNames point: forests and heaths are large, a castle or abbey is not.
export const LANDMARK_CODES = {
  FRST: 1500, FRSTF: 1500, HTH: 1200, PRK: 800, RESN: 1200, RESF: 1500,
  HLL: 400, HLLS: 600, MT: 400, LK: 600, LKS: 800, RSV: 600,
  CSTL: 300, MSTY: 300, HSTS: 300,
};
const MAX_LANDMARK_M = Math.max(...Object.values(LANDMARK_CODES));

const TOWN_PASS_M = 700; // the route "visits" a town when it passes this close to its centre
const START_SEARCH_M = 3000;

export class PlacesUnavailable extends Error {}

// ------------------------------------------------------------------ loading

// (tile key "lat_lon") -> Promise of [[name, code, lat, lon, population, notability, order], ...]
let loader = async (key) => {
  const res = await fetch(new URL(`../data/places/${key}.json`, import.meta.url));
  if (res.status === 404) return [];
  if (!res.ok) throw new PlacesUnavailable(`Could not load place data (${res.status})`);
  return res.json();
};
let index = null; // Set of tile keys that exist, or null (unknown: try them all)
const tiles = new Map(); // key -> Promise of prepared tile

/** Replace how tiles are loaded (tests, workers). `tileKeys`: the tiles that exist. */
export function setPlacesLoader(fn, tileKeys = null) {
  loader = fn;
  index = tileKeys ? new Set(tileKeys) : null;
  tiles.clear();
}

async function loadIndex() {
  if (index !== null) return;
  try {
    const res = await fetch(new URL("../data/places/index.json", import.meta.url));
    if (res.ok) index = new Set((await res.json()).tiles);
  } catch (_) {
    // No index: try every tile.
  }
}

function prepare(records) {
  const n = records.length;
  const t = {
    names: new Array(n), codes: new Array(n), kinds: new Uint8Array(n),
    x: new Float64Array(n), y: new Float64Array(n), population: new Float64Array(n), notability: new Float64Array(n),
    order: new Float64Array(n),
  };
  records.forEach(([name, code, lat, lon, pop, notab, order], i) => {
    const [x, y] = toMetric(lat, lon);
    t.names[i] = name;
    t.codes[i] = code;
    t.kinds[i] = TOWN_CODES.has(code) ? 0 : 1;
    t.x[i] = x;
    t.y[i] = y;
    t.population[i] = pop || 0;
    t.notability[i] = notab || 0;
    t.order[i] = order ?? i;
  });
  return t;
}

function tile(key) {
  if (!tiles.has(key)) {
    const p = Promise.resolve(loader(key)).then((recs) => prepare(recs || []));
    p.catch(() => tiles.delete(key)); // retry next time
    tiles.set(key, p);
  }
  return tiles.get(key);
}

/** The places in the tiles covering a lat/lon box: flat list of candidate objects. */
async function placesIn(minLat, minLon, maxLat, maxLon) {
  await loadIndex();
  const keys = [];
  for (let la = Math.floor(minLat); la <= Math.floor(maxLat); la++) {
    for (let lo = Math.floor(minLon); lo <= Math.floor(maxLon); lo++) {
      const key = `${la}_${lo}`;
      if (!index || index.has(key)) keys.push(key);
    }
  }
  let loaded;
  try {
    loaded = await Promise.all(keys.map(tile));
  } catch (err) {
    throw err instanceof PlacesUnavailable ? err : new PlacesUnavailable(`Could not load place data: ${err.message}`);
  }
  return loaded;
}

// ------------------------------------------------------------------ naming

function importance(p) {
  if (p.kind === 0) return Math.log10(p.population + 1) + 0.15 * Math.min(p.notability, 20);
  // Landmarks: forests and heaths are what riders and hikers look for; well-known ones rank high.
  return 2.5 + 0.3 * Math.min(p.notability, 20);
}

/**
 * Proposed name for a route: {name, start, places: [...]} (name null if nothing found).
 * geometry: [[lat, lon], ...]
 */
export async function generateName(geometry, isLoop, maxPlaces = 3) {
  const xy = lineToMetric(geometry);
  const cum = cumulative(xy);
  const L = cum[cum.length - 1] || 1;

  // Candidates near the route.
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const [la, lo] of geometry) {
    minLat = Math.min(minLat, la);
    maxLat = Math.max(maxLat, la);
    minLon = Math.min(minLon, lo);
    maxLon = Math.max(maxLon, lo);
  }
  const pad = Math.max(START_SEARCH_M, MAX_LANDMARK_M);
  const padLat = (pad * 1.2) / 111000;
  const padLon = padLat / Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const loaded = await placesIn(minLat - padLat, minLon - padLon, maxLat + padLat, maxLon + padLon);

  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of xy) {
    minx = Math.min(minx, x);
    maxx = Math.max(maxx, x);
    miny = Math.min(miny, y);
    maxy = Math.max(maxy, y);
  }
  const near = [];
  for (const t of loaded) {
    for (let i = 0; i < t.names.length; i++) {
      const x = t.x[i], y = t.y[i];
      if (x > minx - pad && x < maxx + pad && y > miny - pad && y < maxy + pad) {
        near.push({
          name: t.names[i], code: t.codes[i], kind: t.kinds[i], x, y,
          population: t.population[i], notability: t.notability[i], order: t.order[i],
        });
      }
    }
  }
  // GeoNames order, so ties between equally important places are broken the same way always.
  near.sort((a, b) => a.order - b.order);
  if (!near.length) return { name: null, start: null, places: [] };

  // Start: the nearest real town (one with a known population) to the start point, else the
  // nearest town of any size.
  const [sx, sy] = xy[0];
  const dStart = (p) => Math.hypot(p.x - sx, p.y - sy);
  const towns = near.filter((p) => p.kind === 0);
  let start = null;
  for (const cond of [
    (p) => p.population > 0 && dStart(p) <= START_SEARCH_M,
    (p) => dStart(p) <= START_SEARCH_M,
    () => true,
  ]) {
    const idx = towns.filter(cond);
    if (idx.length) {
      start = idx.reduce((a, b) => (dStart(b) < dStart(a) ? b : a));
      break;
    }
  }
  if (!start) return { name: null, start: null, places: [] };
  const startName = start.name;

  // Places the route visits: distance to the line and position along it.
  const grid = new SegmentGrid(xy, 1000);
  let visits = [];
  for (const p of near) {
    const limit = p.kind === 0 ? TOWN_PASS_M : LANDMARK_CODES[p.code];
    if (p.name === startName) continue;
    // Skip hamlets and odd points ("Rond Punt"): a town needs a population or some fame.
    if (p.kind === 0 && p.population === 0 && p.notability < 3) continue;
    let best = Infinity, at = 0;
    for (const i of grid.near(p.x, p.y, limit)) {
      const c = closestOnSegment(p.x, p.y, xy[i][0], xy[i][1], xy[i + 1][0], xy[i + 1][1]);
      if (c.d < best || (c.d === best && cum[i] + c.t * (cum[i + 1] - cum[i]) < at)) {
        best = c.d;
        at = cum[i] + c.t * (cum[i + 1] - cum[i]);
      }
    }
    if (best > limit) continue;
    const pos = at / L;
    // Not right at the start (or, for a loop, right before the finish).
    if (pos < 0.05 || (isLoop && pos > 0.95)) continue;
    visits.push({ pos, importance: importance(p), name: p.name, kind: p.kind });
  }

  // One name per place (a forest can have several points), keep the best.
  const best = new Map();
  for (const v of visits) if (!best.has(v.name) || v.importance > best.get(v.name).importance) best.set(v.name, v);
  visits = [...best.values()];

  let endName = null;
  if (!isLoop) {
    const [ex, ey] = xy[xy.length - 1];
    const dEnd = (p) => Math.hypot(p.x - ex, p.y - ey);
    const idx = towns.filter((p) => dEnd(p) <= START_SEARCH_M);
    if (idx.length) {
      const popFirst = idx.filter((p) => p.population > 0);
      const pick = popFirst.length ? popFirst : idx;
      endName = pick.reduce((a, b) => (dEnd(b) < dEnd(a) ? b : a)).name;
      if (endName === startName) endName = null;
    }
    visits = visits.filter((v) => v.name !== endName && v.pos < 0.95);
  }

  const nMid = maxPlaces - (endName ? 1 : 0);
  const chosen = [];
  // Spread the picks: the best place in each stretch of the route, then fill up.
  for (let k = 0; k < nMid; k++) {
    const lo = k / nMid, hi = (k + 1) / nMid;
    const inPart = visits.filter((v) => v.pos >= lo && v.pos < hi && !chosen.includes(v));
    if (inPart.length) chosen.push(inPart.reduce((a, b) => (b.importance > a.importance ? b : a)));
  }
  for (const v of [...visits].sort((a, b) => b.importance - a.importance)) {
    if (chosen.length >= nMid) break;
    if (!chosen.includes(v)) chosen.push(v);
  }
  chosen.sort((a, b) => a.pos - b.pos);
  const parts = [startName, ...chosen.map((v) => v.name), ...(endName ? [endName] : [])];
  return { name: parts.join(SEPARATOR), start: startName, places: parts.slice(1) };
}

// ------------------------------------------------------------------ renaming helpers

export const ORIGINAL_PREFIX = "Original name: ";

/** Put the original name at the top of the notes (only the first time a route is renamed). */
export function notesWithOriginal(notes, original) {
  notes = (notes || "").trim();
  if (notes.startsWith(ORIGINAL_PREFIX)) return notes;
  return `${ORIGINAL_PREFIX}${original}` + (notes ? `\n\n${notes}` : "");
}

/** Add the distance when another route already has this name. taken: Set of lower-case names. */
export function disambiguate(name, distanceKm, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  const km = Math.round(distanceKm);
  let candidate = `${name} (${km} km)`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${name} (${km} km, ${n++})`;
  return candidate;
}
