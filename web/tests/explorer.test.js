import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { Library, MemoryBackend } from "../js/db.js";
import {
  boxOf, compareTile, sharedFresh, sharedMissingCount, tileState,
  isTilesKml, lineTiles, maxCluster, maxSquare, parseTilesKml, readTilesFile, routeGain, tileBounds, tileKey, tileOf, tileRange, tileXY,
} from "../js/explorer.js";
import * as places from "../js/places.js";
import * as svc from "../js/service.js";
import { config } from "../js/config.js";
import { makeZip } from "../js/zip.js";
import { gpxXml, linePoints } from "./helpers.js";

// A tile as VeloViewer exports it: a label point, then the closed square (6 decimals).
const square = (x, y, label = true) => {
  const [[s, w], [n, e]] = tileBounds(x, y);
  const f = (v) => v.toFixed(6);
  const pts = [[w, n], [e, n], [e, s], [w, s], [w, n]].map(([lo, la]) => `${f(lo)},${f(la)}`);
  return `<Placemark><styleUrl>#s</styleUrl><LineString><coordinates>${label ? `${f(w + 0.0022)},${f(n - 0.0014)} ` : ""}${pts.join(" ")}</coordinates></LineString></Placemark>`;
};
const kml = (name, tiles, label = true) =>
  `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>` +
  `<Style id="s"><LineStyle><color>ff0000FF</color><width>1</width></LineStyle></Style><Folder><name>${name}</name>` +
  tiles.map(([x, y]) => square(x, y, label)).join("") + "</Folder></Document></kml>";

const ANTWERP = tileOf(51.2194, 4.4025);

test("tiles: zoom 14, Antwerp", () => {
  assert.deepEqual(ANTWERP, [8392, 5469]);
  const [[s, w], [n, e]] = tileBounds(...ANTWERP);
  assert.ok(s < 51.2194 && 51.2194 < n && w < 4.4025 && 4.4025 < e);
  assert.ok(Math.abs(e - w - 360 / 2 ** 14) < 1e-9);
  assert.deepEqual(tileXY(tileKey(8392, 5469)), [8392, 5469]);
  assert.deepEqual(tileRange([[s + 0.001, w + 0.001], [n - 0.001, e - 0.001]]), { x0: 8392, x1: 8392, y0: 5469, y1: 5469 });
});

test("read an explored tiles export (and a missing tiles one, without label points)", () => {
  const [x, y] = ANTWERP;
  const d = parseTilesKml(kml("Explored Tiles - Veloviewer", [[x, y], [x + 1, y], [x, y + 1], [x, y]]));
  assert.equal(d.mode, "explored");
  assert.equal(d.name, "Explored Tiles - Veloviewer");
  assert.deepEqual(d.tiles, [tileKey(x, y), tileKey(x, y + 1), tileKey(x + 1, y)]);
  assert.equal(d.skipped, 0);

  const m = parseTilesKml(kml(" - Missing VeloViewer Explorer Tiles", [[x, y]], false));
  assert.equal(m.mode, "missing");
  assert.equal(m.name, "Missing VeloViewer Explorer Tiles");
  assert.deepEqual(m.tiles, [tileKey(x, y)]);
  assert.ok(isTilesKml(kml("x", [[x, y]], false)));
});

test("a places file is no tiles export; shapes that aren't tiles are left out", async () => {
  const places = `<kml><Document><name>Bars</name><Placemark><name>A</name><Point><coordinates>4.4,51.2</coordinates></Point></Placemark></Document></kml>`;
  assert.equal(isTilesKml(places), false);
  assert.throws(() => parseTilesKml(places), /No explorer tiles/);
  const big = `<kml><Document><Placemark><LineString><coordinates>4.3,51.1 4.5,51.1 4.5,51.3 4.3,51.1</coordinates></LineString></Placemark>${square(...ANTWERP)}</Document></kml>`;
  const d = parseTilesKml(big);
  assert.equal(d.tiles.length, 1);
  assert.equal(d.skipped, 1);
  // KMZ too
  const kmz = await makeZip([{ name: "doc.kml", data: new TextEncoder().encode(kml("Explored Tiles", [ANTWERP])) }]);
  assert.equal((await readTilesFile(new Uint8Array(await kmz.arrayBuffer()), "tiles.kmz")).tiles.length, 1);
  await assert.rejects(readTilesFile(new Uint8Array(), "tiles.gpx"), /KML/);
});

test("the tiles a line passes through, corners cut between two points included", () => {
  const [[s, w], [n, e]] = tileBounds(...ANTWERP);
  const midLat = (s + n) / 2, midLon = (w + e) / 2, dLat = n - s, dLon = e - w;
  // Three tiles east, in one segment.
  const east = lineTiles([[midLat, midLon], [midLat, midLon + 3 * dLon]]);
  assert.deepEqual(east.map(tileXY), [[8392, 5469], [8393, 5469], [8394, 5469], [8395, 5469]]);
  // A diagonal just below the corner goes through the tile to the right first.
  const diag = lineTiles([[s + 0.3 * dLat, e - 0.2 * dLon], [s - 0.2 * dLat, e + 0.4 * dLon]]);
  assert.deepEqual(diag.map(tileXY), [[8392, 5469], [8393, 5469], [8393, 5470]]);
  // Back and forth: each tile once.
  assert.equal(lineTiles([[midLat, midLon], [midLat, midLon + dLon], [midLat, midLon]]).length, 2);
  assert.deepEqual(lineTiles([]), []);
});

test("max square and max cluster", () => {
  const set = new Set();
  for (let x = 10; x < 14; x++) for (let y = 20; y < 23; y++) set.add(tileKey(x, y)); // 4 x 3
  set.add(tileKey(30, 30));
  assert.deepEqual(maxSquare(set), { size: 3, x: 10, y: 20 });
  // Cluster: tiles with four explored neighbours: the two in the middle row inside.
  assert.equal(maxCluster(set).size, 2);
  set.add(tileKey(14, 20)); set.add(tileKey(14, 21)); set.add(tileKey(14, 22));
  assert.deepEqual(maxSquare(set), { size: 3, x: 10, y: 20 });
  assert.equal(maxCluster(set).size, 3);
  assert.deepEqual(maxSquare(new Set()), { size: 0, x: null, y: null });
});

test("what a route adds: new tiles of an explored set, or of a missing one", () => {
  const route = [1, 2, 3, 4];
  assert.deepEqual(routeGain(route, new Set([2, 3]), "explored"), { tiles: 4, fresh: [1, 4] });
  assert.deepEqual(routeGain(route, new Set([2, 9]), "missing"), { tiles: 4, fresh: [2] });
});

test("two sets compared: explored by one, both, missing for both; a missing set only knows its area", () => {
  const K = (x, y) => tileKey(x, y);
  // Rider A explored (10,10) and (11,10). Rider B's missing export: (11,10), (12,10) and (10,11),
  // so its area is x 10..12, y 10..11, and B explored the other tiles in it.
  const a = { mode: "explored", set: new Set([K(10, 10), K(11, 10)]) };
  const bTiles = [K(11, 10), K(12, 10), K(10, 11)];
  const b = { mode: "missing", set: new Set(bTiles), box: boxOf(bTiles) };
  assert.deepEqual(b.box, { x0: 10, x1: 12, y0: 10, y1: 11 });
  assert.equal(tileState(b, K(11, 11)), "explored");
  assert.equal(tileState(b, K(20, 20)), "unknown");
  assert.equal(tileState(a, K(20, 20)), "missing");
  assert.equal(compareTile(a, b, K(10, 10)), "both");
  assert.equal(compareTile(a, b, K(11, 10)), "a");
  assert.equal(compareTile(a, b, K(11, 11)), "b");
  assert.equal(compareTile(a, b, K(12, 10)), "shared");
  assert.equal(compareTile(a, b, K(10, 11)), "shared");
  assert.equal(compareTile(a, b, K(20, 20)), null); // B doesn't know it
  assert.equal(compareTile(b, a, K(11, 10)), "b"); // the other way round
  assert.equal(sharedMissingCount(a, b), 2);
  assert.equal(sharedMissingCount(a, { mode: "explored", set: new Set() }), null); // two explored sets: no end to it
  assert.deepEqual(sharedFresh([K(10, 10), K(12, 10), K(20, 20)], a, b), [K(12, 10)]);
  assert.equal(boxOf([]), null);
});

// ---- stored, and against the routes

beforeEach(async () => {
  svc.setLibrary(await Library.open(new MemoryBackend()));
  places.setPlacesLoader(async () => [], []);
  places.setAdminLoader(async () => ({ regions: {}, provinces: {} }));
  config.AUTO_RENAME_ON_IMPORT = false;
  config.SURFACE_AUTO_ESTIMATE = false;
});

test("import tile sets, the active one, new tiles per route, replace by name", async () => {
  // A route 5 km east from the middle of the Antwerp tile: about 4–5 tiles.
  const [[s, w], [n, e]] = tileBounds(...ANTWERP);
  const pts = linePoints({ start: [(s + n) / 2, (w + e) / 2], lengthM: 5000, headingDeg: 90 });
  const r = svc.route((await svc.importGpx(gpxXml([["t", pts]]), "East.gpx")).routes[0].id);
  const tiles = svc.routeTiles(r);
  assert.ok(tiles.length >= 4 && tiles.length <= 5, String(tiles.length));
  assert.equal(svc.newTiles(r), null); // no tiles yet
  assert.equal(svc.routeExplorer(r.id), null);

  const [x, y] = ANTWERP;
  const explored = [];
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) explored.push([x + i, y + j]); // 5 x 5 around the start
  const { set: mine } = await svc.importTileSet(parseTilesKml(kml("Explored Tiles - Veloviewer", explored)), { name: "Mine", source_file: "rixtiles.kml" });
  assert.equal(mine.active, true); // the first set is the active one
  assert.equal(svc.tileSetInfo(mine).square.size, 5);
  assert.equal(svc.newTiles(r), tiles.length - 3); // x, x+1, x+2 are explored
  const g = svc.routeExplorer(r.id);
  assert.equal(g.fresh.length, tiles.length - 3);
  assert.equal(g.square, 5);
  assert.equal(g.squareAfter, 5);
  assert.equal(g.cluster, 9);
  assert.ok(g.clusterAfter >= 10); // the new tiles turn x+2 into a cluster tile

  // A friend's missing tiles: new = the route's tiles among them.
  const { set: theirs } = await svc.importTileSet(parseTilesKml(kml("Missing VeloViewer Explorer Tiles", [[x + 1, y], [x + 9, y]])), { name: "Tom" });
  assert.equal(theirs.active, false);
  await svc.setActiveTileSet(theirs.id);
  assert.equal(svc.activeTileSet().name, "Tom");
  assert.equal(svc.newTiles(r), 1);
  assert.equal(svc.routeExplorer(r.id).square, undefined);

  // Sorting the library on new tiles.
  const r2 = svc.route((await svc.importGpx(gpxXml([["t", pts.slice(0, 2)]]), "Short.gpx")).routes[0].id);
  assert.equal(svc.newTiles(r2), 0);
  assert.deepEqual(svc.listRoutes({ sort: "new_tiles", order: "desc" }).map((x) => x.id), [r.id, r2.id]);

  // Re-import under the same name replaces the tiles.
  const res = await svc.importTileSet(parseTilesKml(kml("Missing VeloViewer Explorer Tiles", [[x + 9, y]])), { name: "tom" });
  assert.equal(res.replaced, true);
  assert.equal(svc.tileSets().length, 2);
  assert.equal(svc.newTiles(r), 0);

  // Compared: Mine (explored, active) and Tom (missing x+9 only; area = that tile).
  assert.equal(svc.compareTileSet(), null);
  assert.equal(svc.newTilesBoth(r), null);
  await svc.setActiveTileSet(mine.id);
  await svc.setCompareTileSet(theirs.id);
  assert.equal(svc.compareTileSet().name, "tom");
  assert.deepEqual(svc.sharedMissing(), { a: "Mine", b: "tom", count: 1 });
  assert.equal(svc.newTilesBoth(r), 0); // the route doesn't reach x+9
  const cmp = svc.routeExplorer(r.id).other;
  assert.equal(cmp.name, "tom");
  assert.deepEqual(cmp.both, []);
  // Making the compared set the active one ends the comparison.
  await svc.setActiveTileSet(theirs.id);
  assert.equal(svc.compareTileSet(), null);

  await svc.updateTileSet(theirs.id, { mode: "explored", name: "Tom's" });
  assert.equal(svc.activeTileSet().name, "Tom's");
  assert.equal(svc.newTiles(r), tiles.length);
  await svc.deleteTileSet(theirs.id);
  assert.equal(svc.activeTileSet().name, "Mine");
});
