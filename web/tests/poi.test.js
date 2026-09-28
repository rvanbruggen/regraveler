import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { addBackup, makeBackup, makeSelection, readBackup } from "../js/backup.js";
import { Library, MemoryBackend } from "../js/db.js";
import {
  categoryId, isDuplicatePlace, matchCategory, parseCsv, parseKml, parseKmz, parsePlacesCsv, placesAlong,
  readPlacesFile, suggestCategory,
} from "../js/poi.js";
import * as places from "../js/places.js";
import * as svc from "../js/service.js";
import { config } from "../js/config.js";
import { parseGpx } from "../js/gpx.js";
import { makeZip } from "../js/zip.js";
import { fitFile, gpxXml, linePoints, offset, tcxXml } from "./helpers.js";

// A Google My Maps export, trimmed: styles with a StyleMap, layers as folders, a line.
const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Central Antwerp</name>
  <Style id="icon-1459-normal"><IconStyle><Icon><href>https://www.gstatic.com/mapspro/images/stock/1459-trans-train.png</href></Icon></IconStyle></Style>
  <StyleMap id="icon-1459"><Pair><key>normal</key><styleUrl>#icon-1459-normal</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#x</styleUrl></Pair></StyleMap>
  <Style id="icon-1453"><IconStyle><Icon><href>images/icon-2.png</href></Icon></IconStyle></Style>
  <Folder><name>Bars</name>
    <Placemark><name><![CDATA[Café De Kat & co]]></name><description><![CDATA[Great <b>beer</b><br>open late]]></description><styleUrl>#icon-1518</styleUrl><Point><coordinates>4.403592,51.2214846,0</coordinates></Point></Placemark>
    <Placemark><name>Pelikaan</name><Point><coordinates>
      4.4026141,51.2205901,0
    </coordinates></Point></Placemark>
  </Folder>
  <Folder><name>Transport</name>
    <Placemark><name>Antwerpen-Centraal</name><styleUrl>#icon-1459</styleUrl><Point><coordinates>4.4211,51.2172,0</coordinates></Point></Placemark>
    <Placemark><name>Q-Park</name><styleUrl>#icon-1453-labelson-parking</styleUrl><Point><coordinates>4.4208,51.2182,0</coordinates></Point></Placemark>
    <Placemark><name>Scenic line</name><LineString><coordinates>4.4,51.2 4.5,51.3</coordinates></LineString></Placemark>
  </Folder>
  <Folder><name>Rik &amp; Katleen</name>
    <Placemark><name>Home</name><Point><coordinates>4.41,51.19,0</coordinates></Point></Placemark>
  </Folder>
</Document></kml>`;

test("KML: layers from folders, icons through style maps, lines skipped", () => {
  const d = parseKml(KML);
  assert.equal(d.name, "Central Antwerp");
  assert.equal(d.skipped, 1);
  assert.deepEqual(d.layers.map((l) => [l.name, l.places.length]), [["Bars", 2], ["Transport", 2], ["Rik & Katleen", 1]]);
  const [kat, pelikaan] = d.layers[0].places;
  assert.equal(kat.name, "Café De Kat & co");
  assert.equal(kat.description, "Great beer\nopen late");
  assert.deepEqual([kat.lat, kat.lon], [51.2214846, 4.403592]);
  assert.equal(pelikaan.lat, 51.2205901);
  assert.match(d.layers[1].places[0].icon, /1459-trans-train/);
  // Unknown style: its id is kept, which often says what it is.
  assert.equal(d.layers[1].places[1].icon, "icon-1453-labelson-parking");
});

test("KMZ: the KML inside the zip", async () => {
  const zip = await makeZip([{ name: "images/icon-1.png", data: new Uint8Array([1, 2]) }, { name: "doc.kml", data: KML }]);
  const d = await parseKmz(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(d.layers.length, 3);
  await assert.rejects(readPlacesFile(new TextEncoder().encode("x"), "places.pdf"), /KML, KMZ/);
});

test("categories are suggested from the icon, then the layer name", () => {
  const d = parseKml(KML);
  const [bars, transport, home] = d.layers;
  assert.equal(suggestCategory(bars.places[1], bars.name), "cafe");
  assert.equal(suggestCategory(transport.places[0], transport.name), "station"); // train icon
  assert.equal(suggestCategory(transport.places[1], transport.name), "parking"); // style id
  assert.equal(suggestCategory(home.places[0], home.name), null);
  assert.equal(matchCategory("Kroegtijgers"), "cafe");
  assert.equal(matchCategory("Fritleeuwen"), "frituur");
  assert.equal(matchCategory("Museums / Places to see"), "sight");
  assert.equal(matchCategory("Rebar"), null, "word starts only");
  assert.equal(suggestCategory({ category: "Drinking water" }, "x"), "water");
  assert.equal(categoryId("Gîtes & B&B's"), "gites-b-b-s");
});

test("CSV: a Google My Maps layer (WKT, an unquoted comma in a name)", () => {
  const csv = `WKT,name,description
"POINT (4.4090674 51.2162438)",Oud Arsenaal,
"POINT (4.430836999999999 51.2301659)",Poppemieke, Café,
"POINT (24.5201788 46.1361113)",OVERR,far away
`;
  const d = parsePlacesCsv(csv, "Kroegtijgers en Fritleeuwen- Kroegtijgers.csv");
  assert.equal(d.name, "Kroegtijgers en Fritleeuwen");
  assert.equal(d.layers[0].name, "Kroegtijgers");
  const ps = d.layers[0].places;
  assert.deepEqual(ps.map((p) => p.name), ["Oud Arsenaal", "Poppemieke, Café", "OVERR"]);
  assert.deepEqual([ps[1].lat, ps[1].lon], [51.2301659, 4.430836999999999]);
  assert.equal(ps[2].description, "far away");
});

test("CSV: semicolons and decimal commas, a lat/lon column, categories and links", () => {
  const eu = parsePlacesCsv(`Naam;Breedtegraad;Lengtegraad;Type;Link
Kraantje Markt;51,2;4,4;Drinking water;https://x.org/a
"Schuilhut ""De Put""";51,3;4,5;;
Kapot;abc;4,5;;
`, "water.csv");
  const ps = eu.layers[0].places;
  assert.equal(eu.skipped, 1);
  assert.deepEqual(ps.map((p) => [p.name, p.lat, p.lon, p.category, p.url]), [
    ["Kraantje Markt", 51.2, 4.4, "Drinking water", "https://x.org/a"],
    ['Schuilhut "De Put"', 51.3, 4.5, null, null],
  ]);
  const one = parsePlacesCsv("name,location\nBench,\"51.1, 4.2\"\n", "b.csv");
  assert.deepEqual([one.layers[0].places[0].lat, one.layers[0].places[0].lon], [51.1, 4.2]);
  assert.throws(() => parsePlacesCsv("name,notes\nA,b\n", "x.csv"), /No coordinates/);
  assert.deepEqual(parseCsv("a\tb\n1\t2").rows, [["a", "b"], ["1", "2"]]);
});

test("places along a route: km mark and distance off the route, in riding order", () => {
  const start = [51.0, 4.4];
  const geometry = linePoints({ start, lengthM: 10000, stepM: 100 }).map(([la, lo]) => [la, lo]);
  const at = (n, e) => offset(...start, n, e);
  const ps = [
    { name: "far", ...ll(at(500, 5000)) },
    { name: "km 8", ...ll(at(-50, 8000)) },
    { name: "km 2", ...ll(at(120, 2000)) },
    { name: "before start", ...ll(at(0, -150)) },
  ];
  const along = placesAlong(geometry, 10, ps, 200);
  assert.deepEqual(along.map((a) => [a.place.name, a.km]), [["before start", 0], ["km 2", 2], ["km 8", 8]]);
  assert.ok(Math.abs(along[1].off_m - 120) <= 2);
  assert.equal(isDuplicatePlace({ name: "KM 2", ...ll(at(130, 2010)) }, ps), true);
  assert.equal(isDuplicatePlace({ name: "km 2", ...ll(at(300, 2000)) }, ps), false);
});

function ll([lat, lon]) {
  return { lat, lon };
}

// ------------------------------------------------------------------ the library's places

beforeEach(async () => {
  svc.setLibrary(await Library.open(new MemoryBackend()));
  places.setPlacesLoader(async () => [], []);
  config.AUTO_RENAME_ON_IMPORT = false;
  config.SURFACE_AUTO_ESTIMATE = false;
});

test("import a My Maps file: categories per layer, a new one, a layer left out, re-import skips", async () => {
  const d = parseKml(KML);
  const res = await svc.importPlaces(d, {
    source: "Central Antwerp.kmz",
    layers: [{ include: true, category: "suggested" }, { include: true, category: "suggested" }, { include: false }],
  });
  assert.equal(res.list.name, "Central Antwerp");
  assert.equal(res.added, 4);
  const cats = Object.fromEntries(svc.allPlaces().map((p) => [p.name, p.category]));
  assert.deepEqual(cats, { "Antwerpen-Centraal": "station", "Café De Kat & co": "cafe", Pelikaan: "cafe", "Q-Park": "parking" });
  assert.ok(!svc.allPlaces().some((p) => p.name === "Home"), "the unticked layer is not imported");

  // A layer as a new category of its own, and a re-import that adds nothing twice.
  const again = await svc.importPlaces(d, { layers: [{ include: true, category: "new" }, { include: true, category: "other" }, { include: false }] });
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 4);
  const csv = parsePlacesCsv("WKT,name\n\"POINT (4.39 51.21)\",Frituur n°1\n", "Kroegtijgers en Fritleeuwen- Fritleeuwen.csv");
  await svc.importPlaces(csv, { layers: [{ include: true, category: "new" }] });
  const fl = svc.placeCategories().find((c) => c.label === "Fritleeuwen");
  assert.ok(fl && fl.color && fl.symbol);
  assert.equal(svc.allPlaces().find((p) => p.name === "Frituur n°1").category, fl.id);
  assert.deepEqual(svc.placeLists().map((l) => l.name), ["Central Antwerp", "Kroegtijgers en Fritleeuwen"]);
});

test("marks on the map, editing, lists shown or hidden, removing a list", async () => {
  const m = await svc.addPlace({ lat: 51.1, lon: 4.3 });
  assert.equal(m.name, "New place");
  assert.equal(svc.placeLists()[0].name, "My marks");
  await svc.updatePlace(m.id, { name: "  Great view ", category: "photo", notes: "", url: "https://photos.example/album" });
  assert.deepEqual([svc.place(m.id).name, svc.place(m.id).category, svc.place(m.id).notes], ["Great view", "photo", null]);
  await svc.updatePlace(m.id, { name: "" });
  assert.equal(svc.place(m.id).name, "Great view", "a place keeps a name");

  const { list } = await svc.importPlaces(parseKml(KML), { layers: [{ include: true, category: "cafe" }, { include: false }, { include: false }] });
  assert.equal(svc.visiblePlaces().length, 3);
  await svc.setPlaceListVisible(list.id, false);
  assert.deepEqual(svc.visiblePlaces().map((p) => p.name), ["Great view"]);
  assert.equal(await svc.deletePlaceList(list.id), 2);
  assert.deepEqual(svc.allPlaces().map((p) => p.name), ["Great view"]);
  await svc.deletePlaces([m.id]);
  await assert.rejects(svc.deleteCategory("photo"), /Built-in/);
  const own = await svc.saveCategory({ label: "Gîtes" });
  assert.equal(own.id, "gites");
  assert.equal((await svc.saveCategory({ label: "gîtes" })).id, "gites", "same name: the same category");
  await svc.saveCategory({ id: "gites", label: "Gîtes & B&B", symbol: "🏡" });
  assert.equal(svc.placeCategories().find((c) => c.id === "gites").symbol, "🏡");
  const g = await svc.addPlace({ lat: 50.5, lon: 5.5, category: "gites" });
  await assert.rejects(svc.deleteCategory("gites"), /still use/);
  await svc.deletePlaces([g.id]);
  await svc.deleteCategory("gites");
  assert.ok(!svc.placeCategories().some((c) => c.id === "gites"));
});

test("places along a library route, and places in backups", async () => {
  const start = [51.0, 4.4];
  const pts = linePoints({ start, lengthM: 10000, stepM: 100, ele: () => 10 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", pts]]), "Route.gpx");
  await svc.addPlace({ ...ll(offset(...start, 80, 3000)), name: "Water tap", category: "water" });
  await svc.addPlace({ ...ll(offset(...start, 900, 3000)), name: "Too far" });
  const along = svc.placesAlongRoute(r.id);
  assert.deepEqual(along.map((a) => [a.place.name, a.km]), [["Water tap", 3]]);

  const zip = await makeBackup(svc.library());
  const data = await readBackup(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(data.docs.length, 3); // two places and their list
  const other = await Library.open(new MemoryBackend());
  await other.restore(data);
  assert.deepEqual(other.docsOf("poi").map((p) => p.name).sort(), ["Too far", "Water tap"]);
});

// ------------------------------------------------------------------ waypoints

const line = linePoints({ start: [51.0, 4.4], lengthM: 2000, stepM: 50, ele: () => 10 });

test("waypoints: GPX <wpt>, FIT and TCX course points (not turn instructions) become places", async () => {
  const gpx = gpxXml([["t", line]], { waypoints: [
    { lat: 51.001, lon: 4.401, name: "Kraantje", sym: "Drinking Water" },
    { lat: 51.002, lon: 4.402, name: "Top", sym: "Scenic Area", desc: "nice view" },
  ] });
  const g = await readPlacesFile(gpx, "Rondje.gpx");
  assert.equal(g.name, "Rondje");
  const [a, b] = g.layers[0].places;
  assert.deepEqual([a.name, suggestCategory(a, "Rondje")], ["Kraantje", "water"]);
  assert.deepEqual([b.description, suggestCategory(b, "Rondje")], ["nice view", "photo"]);
  // A GPX file with only waypoints (no track) is fine here.
  const only = new TextEncoder().encode('<gpx><wpt lat="51" lon="4"><name>X</name></wpt></gpx>');
  assert.equal((await readPlacesFile(only, "x.gpx")).layers[0].places.length, 1);

  const fit = fitFile(line, { fileType: 6, coursePoints: [
    { lat: 51.0005, lon: 4.405, type: 3, name: "Water" },
    { lat: 51.0006, lon: 4.406, type: 6, name: "Left" }, // a turn: not a place
    { lat: 51.0007, lon: 4.407, type: 39, name: "WC" },
    { lat: 51.0008, lon: 4.408, type: 0, name: "" }, // generic without a name: not a place
  ] });
  const f = await readPlacesFile(fit, "course.fit");
  assert.deepEqual(f.layers[0].places.map((p) => [p.name, suggestCategory(p, "course")]), [["Water", "water"], ["WC", "toilet"]]);

  const tcx = tcxXml(line, { course: "C", coursePoints: [
    { name: "Frietkot", lat: 51.001, lon: 4.41, type: "Food" },
    { name: "Turn", lat: 51.001, lon: 4.42, type: "Left" },
    { name: "Climb", lat: 51.001, lon: 4.43, type: "4th Category" },
  ] });
  const t = await readPlacesFile(tcx, "c.tcx");
  assert.deepEqual(t.layers[0].places.map((p) => [p.name, suggestCategory(p, "c")]), [["Frietkot", "food"]]);
  await assert.rejects(readPlacesFile(gpxXml([["t", line]]), "none.gpx"), /No waypoints/);
});

test("a route's file offers its waypoints", async () => {
  const data = gpxXml([["t", line]], { waypoints: [{ lat: 51.001, lon: 4.401, name: "Kraantje", sym: "Drinking Water" }] });
  const { routes: [r] } = await svc.importGpx(data, "Route.gpx");
  const wps = await svc.routeWaypoints(svc.route(r.id));
  assert.deepEqual(wps.map((w) => [w.name, w.symbol]), [["Kraantje", "Drinking Water"]]);
});

test("an exported set carries the places along its routes, and adding it merges them", async () => {
  const start = [51.0, 4.4];
  const pts = linePoints({ start, lengthM: 10000, stepM: 100, ele: () => 10 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", pts]]), "Route.gpx");
  const cat = await svc.saveCategory({ label: "Gîtes", symbol: "🏡" });
  const { list } = await svc.importPlaces({ name: "Stops", layers: [{ name: "x", places: [
    { name: "Tap", lat: offset(...start, 50, 2000)[0], lon: offset(...start, 50, 2000)[1], description: "cold water" },
    { name: "Gîte", lat: offset(...start, -80, 6000)[0], lon: offset(...start, -80, 6000)[1] },
    { name: "Elsewhere", lat: 50.5, lon: 5.5 },
  ] }] }, { layers: [{ include: true, category: "water" }] });
  const gite = svc.allPlaces().find((p) => p.name === "Gîte");
  await svc.updatePlace(gite.id, { category: cat.id });

  const zip = await makeSelection(svc.library(), [r.id], { title: "Set", personal: false });
  const data = await readBackup(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(data.docs.filter((d) => d.kind === "poi").map((p) => [p.name, p.notes]).sort(), [["Gîte", null], ["Tap", null]]);
  assert.deepEqual(data.docs.filter((d) => d.kind === "poi_list").map((l) => l.name), [list.name]);
  assert.deepEqual(data.categories.map((c) => c.label), ["Gîtes"]);
  const without = await readBackup(new Uint8Array(await (await makeSelection(svc.library(), [r.id], { places: false })).arrayBuffer()));
  assert.equal(without.docs.length, 0);

  // Into another library: the places, their list and the category come along, once.
  const other = await Library.open(new MemoryBackend());
  const res = await addBackup(other, data);
  assert.equal(res.places, 2);
  assert.equal((await addBackup(other, data)).places, 0);
  assert.deepEqual(other.docsOf("poi_list").map((l) => l.name), ["Stops"]);
  assert.equal(other.settings.POI_CATEGORIES.find((c) => c.label === "Gîtes").symbol, "🏡");
  assert.equal(other.docsOf("poi").find((p) => p.name === "Gîte").category, cat.id);
});

test("OpenStreetMap places along a route: new ones only, and one kept as yours", async () => {
  const start = [51.0, 4.4];
  const pts = linePoints({ start, lengthM: 10000, stepM: 100, ele: () => 10 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", pts]]), "Route.gpx");
  const at = (n, e) => offset(...start, n, e);
  const mine = await svc.addPlace({ lat: at(30, 4000)[0], lon: at(30, 4000)[1], name: "Tap", category: "water" });
  const answer = { elements: [
    { type: "node", id: 1, lat: at(40, 2000)[0], lon: at(40, 2000)[1], tags: { amenity: "drinking_water" } },
    { type: "node", id: 2, lat: mine.lat, lon: mine.lon, tags: { amenity: "drinking_water", name: "Tap" } }, // already mine
    { type: "node", id: 3, lat: at(20, 7000)[0], lon: at(20, 7000)[1], tags: { shop: "bicycle", name: "Fietsen Jan" } },
    { type: "node", id: 4, lat: at(20, 8000)[0], lon: at(20, 8000)[1], tags: { amenity: "cafe", name: "Café" } }, // not asked for
  ] };
  let query = null;
  const fetchFn = async (url, init) => {
    query = decodeURIComponent(init.body.slice(5));
    return { ok: true, status: 200, json: async () => answer };
  };
  const along = await svc.osmAlongRoute(r.id, { fetchFn });
  assert.match(query, /^\[out:json\]\[timeout:40\];\(nwr\[/);
  assert.deepEqual(along.map((a) => [a.place.name, a.km]), [["Drinking water", 2], ["Fietsen Jan", 7]]);

  const kept = await svc.keepOsmPlace(along[1].place);
  assert.equal(kept.list_id, "osm");
  assert.equal(kept.osm_id, "node/3");
  assert.equal((await svc.keepOsmPlace(along[1].place)).id, kept.id, "kept once");
  assert.deepEqual(svc.placeLists().map((l) => l.name).sort(), ["From OpenStreetMap", "My marks"]);

  await svc.setOsmCategories(["cafe", "nonsense"]);
  assert.deepEqual(svc.osmCategories(), ["cafe"]);
  await assert.rejects(svc.osmInArea([50, 4, 51, 5], { fetchFn }), /Zoom in/);
});

test("OpenStreetMap places kept in one go, into a list of your choice", async () => {
  const found = [
    { osm_id: "node/1", name: "Tap", lat: 51.0, lon: 4.4, category: "water", notes: null, url: "https://www.openstreetmap.org/node/1" },
    { osm_id: "node/2", name: "Fietspunt", lat: 51.01, lon: 4.41, category: "bike", notes: "Open: 24/7", url: "https://fietspunt.example" },
    { osm_id: "way/3", name: "Uitzicht", lat: 51.02, lon: 4.42, category: "photo", notes: null, url: null },
  ];
  const first = await svc.keepOsmPlaces(found.slice(0, 2));
  assert.deepEqual([first.list.name, first.added, first.skipped], ["From OpenStreetMap", 2, 0]);
  // Again, with one more, into a new list named after a route: only the new one is added.
  const second = await svc.keepOsmPlaces(found, { listName: "Along the Demer" });
  assert.deepEqual([second.list.name, second.added, second.skipped], ["Along the Demer", 1, 2]);
  const third = await svc.keepOsmPlaces([found[2]], { listId: first.list.id });
  assert.equal(third.added, 0, "already kept");
  assert.deepEqual(svc.allPlaces().map((p) => [p.name, p.category, p.osm_id]).sort(),
    [["Fietspunt", "bike", "node/2"], ["Tap", "water", "node/1"], ["Uitzicht", "photo", "way/3"]]);
  await assert.rejects(svc.keepOsmPlaces(found, { listId: "nope" }), /No such place list/);
});

test("OpenStreetMap places next to one you kept are still offered, unless the same kind", async () => {
  const start = [51.0, 4.4];
  const pts = linePoints({ start, lengthM: 3000, stepM: 100, ele: () => 10 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", pts]]), "Route.gpx");
  const at = offset(...start, 20, 1500);
  const near = offset(...start, 25, 1505); // ~7 m away
  const answer = { elements: [
    { type: "node", id: 1, lat: at[0], lon: at[1], tags: { amenity: "toilets" } },
    { type: "node", id: 2, lat: near[0], lon: near[1], tags: { amenity: "shelter", shelter_type: "picnic_shelter" } },
    { type: "node", id: 3, lat: near[0], lon: near[1], tags: { amenity: "toilets", name: "WC 2" } },
  ] };
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => answer });
  const first = await svc.osmAlongRoute(r.id, { fetchFn });
  await svc.keepOsmPlaces([first.find((a) => a.place.osm_id === "node/1").place]);
  const after = await svc.osmAlongRoute(r.id, { fetchFn });
  // The kept toilet is gone; the shelter 7 m away stays; the second toilet 7 m away is taken for the same one.
  assert.deepEqual(after.map((a) => a.place.osm_id), ["node/2"]);
});

test("OpenStreetMap places along a route within a range of your choice", async () => {
  const start = [51.0, 4.4];
  const pts = linePoints({ start, lengthM: 5000, stepM: 100, ele: () => 10 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", pts]]), "Route.gpx");
  const place = (id, north) => {
    const [lat, lon] = offset(...start, north, 2500);
    return { type: "node", id, lat, lon, tags: { amenity: "drinking_water", name: `at ${north} m` } };
  };
  const answer = { elements: [place(1, 150), place(2, 450), place(3, 900), place(4, 3000)] };
  const queries = [];
  const fetchFn = async (url, init) => {
    queries.push(decodeURIComponent(init.body.slice(5)));
    return { ok: true, status: 200, json: async () => answer };
  };
  const names = async (range) => (await svc.osmAlongRoute(r.id, { fetchFn }, range)).map((a) => a.place.name);
  assert.deepEqual(await names(), ["at 150 m"]); // 200 m by default
  assert.deepEqual(await names(500), ["at 150 m", "at 450 m"]);
  assert.deepEqual(await names(1000), ["at 150 m", "at 450 m", "at 900 m"]);
  // A wider range asks for wider boxes: 1050 m to spare instead of 250 m.
  const south = (q) => Number(/\(([\d.]+),/.exec(q)[1]);
  assert.ok(south(queries[0]) - south(queries[2]) > 0.006);
  await assert.rejects(svc.osmAlongRoute(r.id, { fetchFn }, 10000), /5 km/);
});

// ------------------------------------------------------------------ search for places (utility)

test("search for places along a route: your places and OpenStreetMap, by kind and range", async () => {
  const start = [51.0, 4.4];
  const pts = linePoints({ start, lengthM: 6000, stepM: 50, ele: () => 10 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", pts]]), "Route.gpx");
  const at = (n, e) => offset(...start, n, e);
  await svc.addPlace({ ...ll(at(40, 1000)), name: "My café", category: "cafe" });
  await svc.addPlace({ ...ll(at(600, 2000)), name: "My far water", category: "water" });
  await svc.addPlace({ ...ll(at(30, 3000)), name: "My photo", category: "photo" });
  const answer = { elements: [
    { type: "node", id: 1, lat: at(100, 4000)[0], lon: at(100, 4000)[1], tags: { amenity: "toilets" } },
    { type: "node", id: 2, lat: at(20, 5000)[0], lon: at(20, 5000)[1], tags: { amenity: "cafe", name: "OSM café" } },
  ] };
  let asked = 0;
  const fetchFn = async () => { asked++; return { ok: true, status: 200, json: async () => answer }; };
  const find = async (req) => (await svc.findPlacesAlong({ route_id: r.id, range_m: 200, ...req }, { fetchFn })).found;

  const both = await find({ sources: ["mine", "osm"], categories: ["cafe", "water", "toilet"] });
  assert.deepEqual(both.map((a) => [a.place.name, a.km, a.source]), [["My café", 1, "mine"], ["Toilet", 4, "osm"], ["OSM café", 5, "osm"]]);
  assert.deepEqual((await find({ sources: ["mine", "osm"], categories: ["cafe", "water"], range_m: 1000 })).map((a) => a.place.name),
    ["My café", "My far water", "OSM café"]);
  const before = asked;
  assert.deepEqual((await find({ sources: ["mine"], categories: ["photo", "cafe"] })).map((a) => a.place.name), ["My café", "My photo"]);
  assert.equal(asked, before, "your places only: OpenStreetMap is not asked");
  await assert.rejects(find({ sources: ["mine"], categories: [] }), /at least one kind/);
  await assert.rejects(find({ sources: [], categories: ["cafe"] }), /where to look/);

  // OpenStreetMap busy: your own places are still found, with a note why the rest is missing.
  const busy = async () => ({ ok: false, status: 504, json: async () => ({}) });
  const res = await svc.findPlacesAlong({ route_id: r.id, range_m: 200, sources: ["mine", "osm"], categories: ["cafe", "toilet"] }, { fetchFn: busy });
  assert.deepEqual(res.found.map((a) => a.place.name), ["My café"]);
  assert.match(res.osm_error, /busy/);
  // OpenStreetMap only: then it is an error.
  await assert.rejects(svc.findPlacesAlong({ route_id: r.id, sources: ["osm"], categories: ["toilet"] }, { fetchFn: busy }), /busy/);
});

test("a route with places: as waypoints (same track), or ridden to with detours", async () => {
  const start = [51.0, 4.4];
  const pts = linePoints({ start, lengthM: 6000, stepM: 50, ele: () => 10 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", pts]]), "Route.gpx");
  const at = (n, e) => ll(offset(...start, n, e));
  const places = [
    { ...at(10, 1000), name: "On the way", category: "water" }, // passed anyway
    { ...at(400, 3000), name: "Castle", category: "sight" },
    { ...at(300, 3300), name: "Café", category: "cafe", notes: "closed on Monday" },
  ];
  const req = { route_id: r.id, places, straight: true, name: "With places" };

  const wp = await svc.withPlacesPreview({ ...req, waypoints: true, detours: false });
  assert.equal(wp.extra_km, 0);
  assert.equal(wp.waypoints, 3);
  const gpx = parseGpx((await svc.withPlacesGpx({ ...req, waypoints: true, detours: false })).text);
  assert.deepEqual(gpx.waypoints.map((w) => w.name), ["On the way", "Castle", "Café"]);
  assert.equal(gpx.waypoints[2].description, "Café / bar\nclosed on Monday");
  assert.equal(gpx.tracks[0].points.length, pts.length, "the same track");
  // Saved as a new route on the same track: allowed, linked to the original, not a duplicate.
  const saved = await svc.withPlacesSave({ ...req, waypoints: true, detours: false });
  const s = svc.route(saved.id);
  assert.deepEqual(s.derived_from, [r.id]);
  assert.equal(s.track_hash, svc.route(r.id).track_hash);
  assert.equal(svc.library().isIgnored(r.id, s.id), true);

  // Detours: the castle and the café are close together, so one detour through both.
  const dt = await svc.withPlacesPreview({ ...req, waypoints: false, detours: true });
  assert.equal(dt.waypoints, 0);
  assert.equal(dt.detours.length, 1);
  assert.deepEqual(dt.detours[0].places, ["Castle", "Café"]);
  // Straight lines 2.2 km → castle → café → 3.9 km: 0.89 + 0.32 + 0.67 = 1.88 km instead of 1.70.
  assert.ok(Math.abs(dt.extra_km - 0.18) < 0.02, `extra ${dt.extra_km} km`);
  const line = parseGpx((await svc.withPlacesGpx({ ...req, waypoints: false, detours: true })).text).tracks[0].points;
  for (const p of places.slice(1)) assert.ok(line.some(([la, lo]) => Math.abs(la - p.lat) < 1e-6 && Math.abs(lo - p.lon) < 1e-6), p.name);
  await assert.rejects(svc.withPlacesPreview({ ...req, places: [], waypoints: true }), /at least one place/);
  await assert.rejects(svc.withPlacesPreview({ ...req, waypoints: false, detours: false }), /waypoints, detours or both/);
});
