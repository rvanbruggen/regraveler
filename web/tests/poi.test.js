import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeBackup, readBackup } from "../js/backup.js";
import { Library, MemoryBackend } from "../js/db.js";
import {
  categoryId, isDuplicatePlace, matchCategory, parseCsv, parseKml, parseKmz, parsePlacesCsv, placesAlong,
  readPlacesFile, suggestCategory,
} from "../js/poi.js";
import * as places from "../js/places.js";
import * as svc from "../js/service.js";
import { config } from "../js/config.js";
import { makeZip } from "../js/zip.js";
import { gpxXml, linePoints, offset } from "./helpers.js";

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
  await assert.rejects(readPlacesFile(new TextEncoder().encode("x"), "places.gpx"), /KML, KMZ/);
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
