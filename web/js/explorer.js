// VeloViewer explorer tiles: the map split in squares (zoom-14 map tiles, about 1.5 km wide in
// Belgium); a tile is "explored" once a ride passes through it. Pure functions: reading a
// VeloViewer KML export (explored tiles, or missing tiles), the tiles a route passes through,
// and the max square and max cluster. Stored as documents (db.js) by service.js.

import { readZip } from "./zip.js";
import { GpxError } from "./gpx.js";

export class TilesError extends GpxError {}

export const TILE_ZOOM = 14;
const N = 2 ** TILE_ZOOM;

/** A tile as one number (x, y at zoom 14), so sets of tiles are cheap. */
export const tileKey = (x, y) => x * N + y;
export const tileXY = (key) => [Math.floor(key / N), key % N];

/** Fractional tile coordinates (Web Mercator) of a point. */
export function tileCoords(lat, lon) {
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return [((lon + 180) / 360) * N, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N];
}

/** The tile a point is in: [x, y]. */
export function tileOf(lat, lon) {
  const [x, y] = tileCoords(lat, lon);
  return [Math.min(N - 1, Math.floor(x)), Math.min(N - 1, Math.floor(y))];
}

const lonOf = (x) => (x / N) * 360 - 180;
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;

/** The corners of a tile: [[south, west], [north, east]]. */
export const tileBounds = (x, y) => [[latOf(y + 1), lonOf(x)], [latOf(y), lonOf(x + 1)]];

/** The tiles within [[south, west], [north, east]]: {x0, x1, y0, y1} (inclusive). */
export function tileRange([[s, w], [n, e]]) {
  const [x0, y0] = tileOf(n, w), [x1, y1] = tileOf(s, e);
  return { x0, x1, y0, y1 };
}

// ------------------------------------------------------------------ the KML export

/**
 * Read a VeloViewer explorer tiles export (KML): {name, mode, tiles: [key, ...], skipped}.
 * Each tile is a square line (or polygon) in the file. `mode` is "missing" when the file holds
 * the tiles still to get (VeloViewer's "Missing … Tiles" export), else "explored".
 */
export function parseTilesKml(text) {
  if (typeof text !== "string") text = new TextDecoder("utf-8").decode(text);
  if (!/<kml[\s>]/i.test(text)) throw new TilesError("Not a KML file (no <kml> element)");
  const name = (/<name>\s*(?:<!\[CDATA\[)?([^<\]]*)/i.exec(text)?.[1] || "").trim().replace(/^-\s*/, "");
  const tiles = new Set();
  let skipped = 0;
  for (const m of text.matchAll(/<coordinates>([^<]*)<\/coordinates>/gi)) {
    const key = squareTile(m[1]);
    if (key == null) skipped++;
    else tiles.add(key);
  }
  if (!tiles.size) throw new TilesError("No explorer tiles (zoom-14 squares) in this file");
  return { name, mode: /missing/i.test(name) ? "missing" : "explored", tiles: [...tiles].sort((a, b) => a - b), skipped };
}

/** The tile a list of "lon,lat" points draws the outline of, or null when it isn't one. */
function squareTile(coords) {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const t of coords.trim().split(/\s+/)) {
    const [lon, lat] = t.split(",").map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  }
  if (!(e > w && n > s)) return null;
  const [xw, yn] = tileCoords(n, w), [xe, ys] = tileCoords(s, e);
  // One tile wide and high (the exports round to 5 or 6 decimals).
  if (Math.abs(xe - xw - 1) > 0.05 || Math.abs(ys - yn - 1) > 0.05) return null;
  return tileKey(Math.floor((xw + xe) / 2), Math.floor((yn + ys) / 2));
}

/** True when a KML file looks like an explorer tiles export (not a list of places). */
export function isTilesKml(text) {
  if (typeof text !== "string") text = new TextDecoder("utf-8").decode(text);
  if (/<Point[\s>]/i.test(text)) return false;
  if (/veloviewer|explorer tiles|explored tiles/i.test(text.slice(0, 2000))) return true;
  const sample = [...text.matchAll(/<coordinates>([^<]*)<\/coordinates>/gi)].slice(0, 20);
  return sample.length > 0 && sample.every((m) => squareTile(m[1]) != null);
}

/** The KML text of a .kml or .kmz file. */
export async function kmlText(bytes, filename) {
  if (/\.kmz$/i.test(filename)) {
    const entries = await readZip(bytes);
    const kml = entries.find((e) => e.name.toLowerCase() === "doc.kml") || entries.find((e) => /\.kml$/i.test(e.name));
    if (!kml) throw new TilesError("No KML document in this KMZ file");
    return typeof kml.data === "string" ? kml.data : new TextDecoder("utf-8").decode(kml.data);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Read an explorer tiles export (.kml or .kmz). */
export async function readTilesFile(bytes, filename) {
  if (!/\.km[lz]$/i.test(filename)) throw new TilesError("Explorer tiles are imported from VeloViewer's KML export");
  return parseTilesKml(await kmlText(bytes, filename));
}

// ------------------------------------------------------------------ routes and tiles

/**
 * The tiles a line ([[lat, lon], ...]) passes through, in the order it reaches them (each
 * once). Walks every segment cell by cell, so a corner cut between two points counts too.
 */
export function lineTiles(geometry) {
  const seen = new Set(), out = [];
  const add = (x, y) => {
    const k = tileKey(x, y);
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  };
  let prev = null;
  for (const p of geometry || []) {
    const cur = tileCoords(p[0], p[1]);
    if (!prev) add(Math.floor(cur[0]), Math.floor(cur[1]));
    else walk(prev, cur, add);
    prev = cur;
  }
  return out;
}

// Amanatides & Woo: the grid cells a segment crosses.
function walk([ax, ay], [bx, by], add) {
  let x = Math.floor(ax), y = Math.floor(ay);
  const ex = Math.floor(bx), ey = Math.floor(by);
  const dx = bx - ax, dy = by - ay;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity;
  let tx = dx ? (sx > 0 ? x + 1 - ax : ax - x) * tdx : Infinity;
  let ty = dy ? (sy > 0 ? y + 1 - ay : ay - y) * tdy : Infinity;
  add(x, y);
  for (let i = 0; (x !== ex || y !== ey) && i < 10000; i++) {
    if (tx < ty) { x += sx; tx += tdx; }
    else { y += sy; ty += tdy; }
    add(x, y);
  }
}

/**
 * What a route adds to a tile set: {tiles, fresh} with `fresh` the tiles that would be new
 * (not yet explored; or, for a "missing" export, among the missing ones).
 */
export function routeGain(routeTiles, set, mode = "explored") {
  const fresh = routeTiles.filter((k) => (mode === "missing" ? set.has(k) : !set.has(k)));
  return { tiles: routeTiles.length, fresh };
}

// ------------------------------------------------------------------ max square, max cluster

/** The biggest square of explored tiles: {size, x, y} (x, y: its top-left tile), or size 0. */
export function maxSquare(set) {
  const keys = [...set].sort((a, b) => {
    const [ax, ay] = tileXY(a), [bx, by] = tileXY(b);
    return ay - by || ax - bx;
  });
  const dp = new Map();
  let best = { size: 0, x: null, y: null };
  for (const k of keys) {
    const [x, y] = tileXY(k);
    const s = 1 + Math.min(
      x > 0 ? dp.get(tileKey(x - 1, y)) || 0 : 0,
      y > 0 ? dp.get(tileKey(x, y - 1)) || 0 : 0,
      x > 0 && y > 0 ? dp.get(tileKey(x - 1, y - 1)) || 0 : 0);
    dp.set(k, s);
    if (s > best.size) best = { size: s, x: x - s + 1, y: y - s + 1 };
  }
  return best;
}

/**
 * The biggest cluster: explored tiles with all four neighbours explored, joined to each other
 * side by side. {size, tiles: [key, ...]}.
 */
export function maxCluster(set) {
  const inner = new Set();
  for (const k of set) {
    const [x, y] = tileXY(k);
    if (set.has(tileKey(x - 1, y)) && set.has(tileKey(x + 1, y)) && set.has(tileKey(x, y - 1)) && set.has(tileKey(x, y + 1))) inner.add(k);
  }
  const done = new Set();
  let best = [];
  for (const start of inner) {
    if (done.has(start)) continue;
    const group = [start];
    done.add(start);
    for (let i = 0; i < group.length; i++) {
      const [x, y] = tileXY(group[i]);
      for (const n of [tileKey(x - 1, y), tileKey(x + 1, y), tileKey(x, y - 1), tileKey(x, y + 1)]) {
        if (inner.has(n) && !done.has(n)) { done.add(n); group.push(n); }
      }
    }
    if (group.length > best.length) best = group;
  }
  return { size: best.length, tiles: best };
}
