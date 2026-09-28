import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { addBackup, makeSelection, readBackup } from "../js/backup.js";
import { config } from "../js/config.js";
import { Library, MemoryBackend } from "../js/db.js";
import { pointInPolygon } from "../js/geo.js";
import * as places from "../js/places.js";
import { parseKmlAreas } from "../js/poi.js";
import * as svc from "../js/service.js";
import { gpxXml, linePoints, offset } from "./helpers.js";

const START = [51.0, 4.4];

beforeEach(async () => {
  svc.setLibrary(await Library.open(new MemoryBackend()));
  places.setPlacesLoader(async () => [], []);
  places.setAdminLoader(async () => ({ regions: {}, provinces: {} })); // no region names in these tests
  config.AUTO_RENAME_ON_IMPORT = false;
  config.SURFACE_AUTO_ESTIMATE = false;
});

/** Routes starting 0, 10 and 20 km east of START (A loop-ish, B and C point to point). */
async function threeRoutes() {
  const ids = [];
  for (const [i, name] of ["A", "B", "C"].entries()) {
    const pts = linePoints({ start: offset(...START, 0, i * 10000), lengthM: 5000, stepM: 100, headingDeg: 0, ele: () => 10 });
    const { routes } = await svc.importGpx(gpxXml([["t", pts]]), `${name}.gpx`, { activity: i ? "road" : "gravel", tags: i === 2 ? ["kempen"] : [] });
    ids.push(routes[0].id);
  }
  return ids;
}

const names = (params) => svc.listRoutes(params).map((r) => r.name);

test("collections: nested, a route in several, filtered with its sub-collections", async () => {
  const [a, b, c] = await threeRoutes();
  const trips = await svc.createCollection({ name: "Trips" });
  const ardennes = await svc.createCollection({ name: "Ardennes 2026", parent_id: trips.id });
  const favs = await svc.createCollection({ name: "Favourites" });
  assert.equal((await svc.createCollection({ name: "trips" })).id, trips.id, "same name, same place: the same collection");
  await svc.addToCollection(trips.id, [a]);
  await svc.addToCollection(ardennes.id, [b, b, 9999]);
  await svc.addToCollection(favs.id, [b, c]);

  assert.deepEqual(names(`coll=${trips.id}`), ["A", "B"]);
  assert.deepEqual(names(`coll=${ardennes.id}`), ["B"]);
  assert.deepEqual(names(`coll=${favs.id}&activity=road`), ["B", "C"]);
  assert.equal(svc.collectionPath(ardennes.id), "Trips › Ardennes 2026");
  assert.deepEqual(svc.collectionsOf(b).map((x) => x.path), ["Favourites", "Trips › Ardennes 2026"]);

  // Can't go inside itself; removing a collection moves its children up.
  await assert.rejects(svc.updateCollection(trips.id, { parent_id: ardennes.id }), /inside itself/);
  await svc.updateCollection(ardennes.id, { name: "Ardennen" });
  await svc.deleteCollection(trips.id);
  assert.equal(svc.collectionPath(ardennes.id), "Ardennen");
  assert.deepEqual(names(`coll=${ardennes.id}`), ["B"]);

  await svc.removeFromCollection(favs.id, [c]);
  assert.deepEqual(names(`coll=${favs.id}`), ["B"]);
  // A removed route leaves its collections.
  await svc.deleteRoutes([b]);
  assert.deepEqual(svc.library().getDoc("collection", ardennes.id).route_ids, []);
});

test("smart collections are saved filters", async () => {
  await threeRoutes();
  assert.equal(svc.filterQuery("view=map&activity=road&sort=name&min_distance=4&ids=3"), "min_distance=4&activity=road");
  const s = await svc.saveSmart({ name: "Road", query: "activity=road&sort=distance_km" });
  assert.equal(s.query, "activity=road");
  await assert.rejects(svc.saveSmart({ name: "Nothing", query: "sort=name" }), /Set some filters/);
  const cat = svc.catalog();
  assert.deepEqual(cat.smart.map((x) => [x.name, x.count]), [["Road", 2]]);
  await svc.saveSmart({ id: s.id, name: "Road bikes", query: "activity=road&tags=kempen" });
  assert.deepEqual(svc.catalog().smart.map((x) => [x.name, x.count]), [["Road bikes", 1]]);
  await svc.deleteSmart(s.id);
  assert.equal(svc.catalog().smart.length, 0);
});

test("areas: routes that start inside", async () => {
  const [a, b] = await threeRoutes();
  assert.equal(pointInPolygon(0.5, 0.5, [[0, 0], [0, 1], [1, 1], [1, 0]]), true);
  assert.equal(pointInPolygon(1.5, 0.5, [[0, 0], [0, 1], [1, 1], [1, 0]]), false);
  // A box around the starts of A and B (0 and 10 km east), not C (20 km).
  const box = [offset(...START, -500, -500), offset(...START, -500, 12000), offset(...START, 500, 12000), offset(...START, 500, -500)];
  const area = await svc.saveArea({ name: "Hageland", polygon: box });
  assert.deepEqual(names(`area=${area.id}`), ["A", "B"]);
  assert.deepEqual(svc.areasOf(a).map((x) => x.name), ["Hageland"]);
  assert.equal(svc.catalog().areas[0].count, 2);
  await assert.rejects(svc.saveArea({ name: "x", polygon: [[1, 1], [2, 2]] }), /three points/);
  await svc.saveArea({ id: area.id, name: "Hageland (east)" });
  assert.equal(svc.library().getDoc("area", area.id).polygon.length, 4, "renaming keeps the shape");

  const kml = `<kml><Document><name>Streken</name><Folder><name>Areas</name>
    <Placemark><name>Vlaamse Ardennen</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
      3.5,50.7,0 3.9,50.7,0 3.9,50.9,0 3.5,50.9,0 3.5,50.7,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    <Placemark><name>Hageland (east)</name><MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates>
      4.3,50.9 4.6,50.9 4.6,51.1 4.3,51.1</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry></Placemark>
    <Placemark><name>A point</name><Point><coordinates>4.4,51.0</coordinates></Point></Placemark>
  </Folder></Document></kml>`;
  const found = parseKmlAreas(kml);
  assert.deepEqual(found.map((x) => [x.name, x.polygon.length]), [["Vlaamse Ardennen", 5], ["Hageland (east)", 4]]);
  assert.deepEqual(found[0].polygon[1], [50.7, 3.9], "lat, lon");
  assert.deepEqual(await svc.importAreas(found), { added: 1, replaced: 1 });
  assert.deepEqual(svc.areas().map((x) => x.name), ["Hageland (east)", "Vlaamse Ardennen"]);
  assert.throws(() => parseKmlAreas("<kml><Document><Placemark><Point><coordinates>4,51</coordinates></Point></Placemark></Document></kml>"), /No areas/);
});

test("the catalog: collections as a tree, and counts by activity, source, tag and loop", async () => {
  const [a, b] = await threeRoutes();
  const t = await svc.createCollection({ name: "Trips" });
  const sub = await svc.createCollection({ name: "Ardennes", parent_id: t.id });
  await svc.addToCollection(sub.id, [a, b]);
  const cat = svc.catalog();
  assert.equal(cat.total, 3);
  assert.deepEqual(cat.collections.map((c) => [c.name, c.count, c.children.map((k) => [k.name, k.count])]), [["Trips", 2, [["Ardennes", 2]]]]);
  assert.deepEqual(cat.activities, [{ value: "gravel", count: 1 }, { value: "road", count: 2 }]);
  assert.deepEqual(cat.tags, [{ value: "kempen", count: 1 }]);
  assert.deepEqual(cat.loops.map((x) => x.count).reduce((s, n) => s + n), 3);
});

test("an exported set carries its collections and areas; adding it merges them", async () => {
  const [a, b, c] = await threeRoutes();
  const trips = await svc.createCollection({ name: "Trips" });
  const sub = await svc.createCollection({ name: "Ardennes", parent_id: trips.id });
  const other = await svc.createCollection({ name: "Other" });
  await svc.addToCollection(sub.id, [a, b]);
  await svc.addToCollection(other.id, [c]);
  const box = [offset(...START, -500, -500), offset(...START, -500, 1000), offset(...START, 500, 1000), offset(...START, 500, -500)];
  await svc.saveArea({ name: "Around A", polygon: box });
  await svc.saveArea({ name: "Nowhere", polygon: [[10, 10], [10, 11], [11, 11]] });

  const zip = await makeSelection(svc.library(), [a, b], { title: "Set", places: false });
  const data = await readBackup(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(data.docs.filter((d) => d.kind === "collection").map((d) => [d.name, d.route_ids.length]).sort(), [["Ardennes", 2], ["Trips", 0]]);
  assert.deepEqual(data.docs.filter((d) => d.kind === "area").map((d) => d.name), ["Around A"]);

  // Into another library that already has a "Trips" collection with a route of its own.
  const lib2 = await Library.open(new MemoryBackend());
  svc.setLibrary(lib2);
  const pts = linePoints({ start: [50.5, 5.5], lengthM: 3000, stepM: 100, ele: () => 1 });
  const { routes: [mine] } = await svc.importGpx(gpxXml([["t", pts]]), "Mine.gpx");
  const t2 = await svc.createCollection({ name: "Trips" });
  await svc.addToCollection(t2.id, [mine.id]);
  const res = await addBackup(lib2, data);
  assert.deepEqual([res.added, res.collections, res.areas], [2, 1, 1]);
  assert.equal(lib2.docsOf("collection").length, 2, "Trips merged, Ardennes added below it");
  const ard = lib2.docsOf("collection").find((x) => x.name === "Ardennes");
  assert.equal(ard.parent_id, t2.id);
  assert.deepEqual(names(`coll=${ard.id}`), ["A", "B"]);
  assert.deepEqual(names(`coll=${t2.id}`), ["A", "B", "Mine"]);
  // Again: nothing new.
  const again = await addBackup(lib2, data);
  assert.deepEqual([again.added, again.collections, again.areas], [0, 0, 0]);
  assert.equal(lib2.docsOf("collection").find((x) => x.name === "Ardennes").route_ids.length, 2);
});

test("regions: the region and province of a route's start, in the catalog and as a filter", async () => {
  const town = (name, [lat, lon], code) => [name, "PPL", lat, lon, 1000, 0, 0, code];
  const recs = [
    town("Startdorp", offset(...START, 300, 0), "BE.VLG.VBR"),
    town("Oostdorp", offset(...START, 300, 10000), "BE.VLG.VBR"),
    town("Verdorp", offset(...START, 300, 20000), "BE.WAL.WBR"),
    ["Een bos", "FRST", ...offset(...START, 0, 5000), 0, 3, 9], // a landmark: no region
  ];
  places.setPlacesLoader(async (k) => (k === "51_4" ? recs : []), ["51_4"]);
  places.setAdminLoader(async () => ({
    regions: { "BE.VLG": "Vlaanderen", "BE.WAL": "Wallonie" },
    provinces: { "BE.VLG.VBR": { name: "Vlaams-Brabant", region: "BE.VLG" }, "BE.WAL.WBR": { name: "Brabant Wallon", region: "BE.WAL" } },
  }));
  const [a, b, c] = await threeRoutes();
  assert.deepEqual(svc.route(a).region, { region: "BE.VLG", region_name: "Vlaanderen", province: "BE.VLG.VBR", province_name: "Vlaams-Brabant" });
  assert.equal(svc.route(c).region.province_name, "Brabant Wallon");
  assert.deepEqual(names("region=BE.VLG"), ["A", "B"]);
  assert.deepEqual(names("region=BE.WAL.WBR"), ["C"]);
  const tree = svc.catalog().regions;
  assert.deepEqual(tree.map((g) => [g.name, g.count, g.provinces.map((p) => [p.name, p.count])]),
    [["Vlaanderen", 2, [["Vlaams-Brabant", 2]]], ["Wallonie", 1, [["Brabant Wallon", 1]]]]);
  assert.equal(svc.filterQuery("region=BE.VLG&view=map"), "region=BE.VLG");

  // Routes from before regions get theirs in the background; far from any town: none (null).
  const r = svc.route(b);
  delete r.region;
  await svc.library().saveRoutes([r]);
  const pts = linePoints({ start: [48.0, 2.0], lengthM: 2000, stepM: 100, ele: () => 1 });
  const { routes: [far] } = await svc.importGpx(gpxXml([["t", pts]]), "Far.gpx");
  assert.equal(svc.route(far.id).region, null);
  assert.equal(await svc.backfillRegions(), 1);
  assert.equal(svc.route(b).region.province, "BE.VLG.VBR");
  assert.equal(await svc.backfillRegions(), 0);
});

test("without the region names (no place data) the region is tried again later", async () => {
  places.setAdminLoader(async () => { throw new Error("offline"); });
  const [a] = await threeRoutes();
  assert.equal(svc.route(a).region, undefined);
  assert.equal(await svc.backfillRegions(), 0, "still offline: nothing yet");
  places.setAdminLoader(async () => ({ regions: {}, provinces: {} }));
  assert.equal(await svc.backfillRegions(), 3);
  assert.equal(svc.route(a).region, null);
});
