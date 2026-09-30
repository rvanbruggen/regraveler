import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { addBackup, makeBackup, makeSelection, readBackup } from "../js/backup.js";
import { config } from "../js/config.js";
import { Library, MemoryBackend } from "../js/db.js";
import { parseGpx } from "../js/gpx.js";
import * as places from "../js/places.js";
import * as svc from "../js/service.js";
import { readZip } from "../js/zip.js";
import { gzipSync } from "node:zlib";

import { parseTrackFile } from "../js/trackfile.js";
import { approx, fitFile, gpxXml, linePoints, loopPoints, offset, tcxXml } from "./helpers.js";

const START = [51.0, 4.4];
const at = (n, e) => offset(...START, n, e);

beforeEach(async () => {
  svc.setLibrary(await Library.open(new MemoryBackend()));
  const recs = [
    ["Startdorp", "PPL", ...at(300, 0), 5000, 0, 0],
    ["Middendorp", "PPL", ...at(200, 3000), 2000, 0, 1],
    ["Grootdorp", "PPL", ...at(-300, 5500), 20000, 0, 2],
    ["Einddorp", "PPL", ...at(200, 10000), 3000, 0, 3],
  ];
  places.setPlacesLoader(async (k) => (k === "51_4" ? recs : []), ["51_4"]);
  places.setAdminLoader(async () => ({ regions: {}, provinces: {} })); // no region names in these tests
  config.AUTO_RENAME_ON_IMPORT = true;
  config.SURFACE_AUTO_ESTIMATE = false;
});

const east = (northM = 0, lengthM = 10000) =>
  linePoints({ start: offset(...START, northM, 0), lengthM, stepM: 100, headingDeg: 90, ele: () => 10 });

async function importOne(name, points, opts = {}) {
  return svc.importGpx(gpxXml([["t", points]]), name, opts);
}

test("import names routes after places and keeps the original name in the notes", async () => {
  const res = await importOne("Gravelroute Test.gpx", east(), { source_name: "db.be" });
  assert.equal(res.status, "imported");
  const [r] = svc.listRoutes("");
  assert.equal(r.name, "Startdorp – Middendorp – Grootdorp – Einddorp");
  assert.equal(r.notes, "Original name: Gravelroute Test");
  assert.equal(r.source_name, "db.be");
  assert.equal(r.activity, "gravel");
  approx(r.distance_km, 10, { rel: 0.01 });
});

test("a second route with the same name gets the distance added", async () => {
  await importOne("One.gpx", east());
  await importOne("Two.gpx", east().map(([la, lo, e]) => [la + 0.0002, lo, e]));
  const names = svc.listRoutes("").map((r) => r.name).sort();
  assert.deepEqual(names, ["Startdorp – Middendorp – Grootdorp – Einddorp", "Startdorp – Middendorp – Grootdorp – Einddorp (10 km)"]);
});

test("identical file and same track in another file are duplicates; similar routes are flagged", async () => {
  const data = gpxXml([["t", east()]]);
  await svc.importGpx(data, "A.gpx");
  assert.equal((await svc.importGpx(data, "A copy.gpx")).status, "duplicate");
  const renamed = await svc.importGpx(gpxXml([["other name", east()]], { name: "x" }), "B.gpx");
  assert.equal(renamed.status, "duplicate");
  assert.match(renamed.message, /different file/);
  const near = await importOne("C.gpx", east(15));
  assert.equal(near.status, "imported");
  assert.equal(near.similar.length, 1);
});

test("unusable files are reported, not thrown", async () => {
  const res = await svc.importGpx(new TextEncoder().encode("<gpx></gpx>"), "bad.gpx");
  assert.equal(res.status, "error");
});

test("multi-track files give one route per track; file names are kept when renaming is off", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  const data = gpxXml([["North", east(0, 3000)], ["South", east(-3000, 3000)]]);
  const res = await svc.importGpx(data, "Two tracks.gpx");
  assert.deepEqual(res.routes.map((r) => r.name), ["North", "South"]);
  assert.equal(svc.routeName("Start (48).gpx", "Real name", 1, 0), "Real name");
  assert.equal(svc.routeName("sportvlaanderen-gravelroute-mol.gpx", "Mol", 1, 0), "Mol");
  assert.equal(svc.routeName("Bosland.gpx", "Track 1", 1, 0), "Bosland");
});

test("batch import: batch values, per-file overrides and tags", async () => {
  const { results } = await svc.importFiles(
    [
      { name: "a.gpx", data: gpxXml([["t", east(0, 3000)]]) },
      { name: "b.gpx", data: gpxXml([["t", east(-5000, 3000)]]), override: { source_name: "other", activity: "hiking", tags: "Forest" } },
    ],
    { source_name: "batch", source_url: "https://x.org", activity: "road", tags: "kempen, Spring " },
  );
  assert.deepEqual(results.map((r) => r.status), ["imported", "imported"]);
  const [a, b] = results.map((r) => svc.route(r.routes[0].id));
  assert.deepEqual([a.source_name, a.activity, a.tags], ["batch", "road", ["kempen", "spring"]]);
  assert.deepEqual([b.source_name, b.activity, b.tags], ["other", "hiking", ["kempen", "spring", "forest"]]);
  assert.equal(b.source_url, "https://x.org");
});

test("filters and sorting", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("Short.gpx", east(0, 3000));
  await importOne("Long.gpx", east(-5000, 9000));
  const long = svc.listRoutes("").find((r) => r.name === "Long");
  await svc.updateRoute(long.id, { quality_rating: 4, tags: ["Forest"], paved_pct: 30 });
  assert.deepEqual(svc.listRoutes("min_distance=5").map((r) => r.name), ["Long"]);
  assert.deepEqual(svc.listRoutes("sort=distance_km&order=desc").map((r) => r.name), ["Long", "Short"]);
  assert.deepEqual(svc.listRoutes("tags=forest").map((r) => r.name), ["Long"]);
  assert.deepEqual(svc.listRoutes("min_quality=3").map((r) => r.name), ["Long"]);
  assert.deepEqual(svc.listRoutes("max_paved=50").map((r) => r.name), ["Long"]); // empty values never match
  assert.deepEqual(svc.listRoutes("sort=quality_rating&order=asc").map((r) => r.name), ["Long", "Short"]); // empty last
  assert.deepEqual(svc.listRoutes("q=sho").map((r) => r.name), ["Short"]);
  assert.equal(svc.route(long.id).paved_source, "manual");
});

test("bulk tags and activity; delete removes routes and unused files", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 3000));
  await importOne("B.gpx", east(-5000, 3000));
  const ids = svc.listRoutes("").map((r) => r.id);
  assert.deepEqual(await svc.changeTags(ids, ["X", "y"], []), { updated: 2 });
  assert.deepEqual(await svc.changeTags(ids, [], ["x"]), { updated: 2 });
  assert.deepEqual(svc.facets().tags, [["y", 2]]);
  assert.deepEqual(await svc.setActivity(ids, "road"), { updated: 2 });
  await assert.rejects(svc.setActivity(ids, "swimming"), svc.ServiceError);
  const file = await svc.routeGpx(ids[0]);
  assert.equal(parseGpx(file.data).tracks.length, 1);
  assert.deepEqual(await svc.deleteRoutes([ids[0]]), { deleted: 1 });
  assert.equal((await svc.library().allFiles()).length, 1);
});

test("zip export holds the original files", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 3000));
  await importOne("A.gpx", east(-5000, 3000)); // same file name, other content
  const zip = await svc.exportZip(svc.listRoutes("").map((r) => r.id));
  const entries = await readZip(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name).sort(), ["A (2).gpx", "A.gpx"]);
});

test("combine: suggest, preview and save with straight connectors", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 6000));
  await importOne("B.gpx", east(800, 6000));
  const [a, b] = ["A", "B"].map((n) => svc.listRoutes("").find((r) => r.name === n));
  const sug = await svc.combineSuggest(a.id, b.id, 2);
  const [pa, pb] = sug.parts;
  const req = {
    parts: [
      { route_id: a.id, start: pa.start, end: pa.end },
      { route_id: b.id, start: pb.start, end: pb.end },
    ],
    closed: true, straight: true,
  };
  const prev = await svc.combinePreview(req);
  assert.equal(prev.is_loop, true);
  assert.equal(prev.crossing, false);
  assert.equal(prev.connectors.length, 2);
  approx(prev.connectors[0].distance_km, 0.8, { abs: 0.05 });
  const saved = await svc.combineSave({ ...req, name: "A + B" });
  const r = svc.route(saved.id);
  assert.equal(r.name, "A + B");
  assert.deepEqual(r.derived_from, [a.id, b.id]);
  assert.equal(r.source_name, "combined");
  await assert.rejects(svc.combineSave({ ...req, name: "A + B" }), /already saved/);
  const gpx = await svc.combineGpx({ ...req, name: "A + B" });
  assert.equal(parseGpx(gpx.text).tracks[0].name, "A + B");
});

test("restart a loop: saved as a variant, kept out of the duplicates", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("Loop.gpx", loopPoints({ radiusM: 2000, n: 400, ele: () => 5 }));
  const [loop] = svc.listRoutes("");
  await svc.updateRoute(loop.id, { quality_rating: 5 });
  const start = loop.geometry[Math.floor(loop.geometry.length / 3)];
  const prev = await svc.restartPreview({ route_id: loop.id, start });
  approx(prev.distance_km, loop.distance_km, { rel: 0.01 });
  const saved = await svc.restartSave({ route_id: loop.id, start, name: "Loop (start elsewhere)" });
  const r = svc.route(saved.id);
  assert.equal(r.name, "Loop (start elsewhere)");
  assert.equal(r.quality_rating, 5);
  assert.deepEqual(svc.duplicates().groups, []);
});

test("duplicates: groups, ignore and reset", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0));
  await importOne("A again.gpx", east(10));
  const { groups } = svc.duplicates();
  assert.equal(groups.length, 1);
  const ids = groups[0].routes.map((r) => r.id);
  await svc.ignoreDuplicates(ids);
  assert.equal(svc.duplicates().groups.length, 0);
  await svc.resetIgnoredDuplicates();
  assert.equal(svc.duplicates().groups.length, 1);
});

test("rename proposals and apply", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("Gravelroute Test.gpx", east());
  const [r] = svc.listRoutes("");
  await svc.updateRoute(r.id, { notes: "ride in spring" });
  const [p] = await svc.renameProposals();
  assert.equal(p.proposal, "Startdorp – Middendorp – Grootdorp – Einddorp");
  assert.deepEqual(await svc.renameApply([{ id: r.id, name: "Startdorp – Grootdorp" }]), { renamed: 1 });
  const after = svc.route(r.id);
  assert.equal(after.slug, "startdorp-grootdorp");
  assert.equal(after.notes, "Original name: Gravelroute Test\n\nride in spring");
});

test("backup and restore round trip", async () => {
  await importOne("A.gpx", east(0, 3000));
  await svc.ignoreDuplicates([1, 2]);
  await svc.library().setSetting("BROUTER_URL", "http://nas:17777");
  const zip = await makeBackup(svc.library());
  const data = await readBackup(new Uint8Array(await zip.arrayBuffer()));
  const other = await Library.open(new MemoryBackend());
  await other.restore(data);
  assert.equal(other.all().length, 1);
  assert.equal(other.all()[0].name, svc.listRoutes("")[0].name);
  assert.equal(other.isIgnored(2, 1), true);
  assert.equal(other.settings.BROUTER_URL, "http://nas:17777");
  const file = await other.getFile(other.all()[0].file_hash);
  assert.equal(parseGpx(file.data).tracks.length, 1);
});

test("a selection of routes is added to another library without replacing it", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 3000));
  await importOne("B.gpx", east(2000, 3000));
  await importOne("C.gpx", east(4000, 3000));
  const [a, b, c] = svc.listRoutes("").sort((x, y) => x.id - y.id);
  const d = svc.library().get(c.id);
  d.derived_from = [a.id];
  await svc.library().saveRoutes([d]);
  await svc.ignoreDuplicates([a.id, c.id]);
  await svc.ignoreDuplicates([a.id, b.id]);
  const zip = await makeSelection(svc.library(), [a.id, c.id], { title: "Two routes" });
  const data = await readBackup(new Uint8Array(await zip.arrayBuffer()));
  assert.equal(data.kind, "selection");
  assert.equal(data.title, "Two routes");
  assert.equal(data.routes.length, 2);
  assert.equal(data.files.length, 2);
  assert.deepEqual(data.ignored, [`${a.id}_${c.id}`]);
  assert.deepEqual(data.settings, {});

  // Another library that already has B and C: only A is new; C keeps its own id.
  const other = await Library.open(new MemoryBackend());
  const keep = svc.library();
  svc.setLibrary(other);
  await importOne("B.gpx", east(2000, 3000));
  await importOne("C again.gpx", east(4000, 3000));
  svc.setLibrary(keep);
  assert.equal(other.all().length, 2);
  const res = await addBackup(other, data);
  assert.deepEqual([res.added, res.skipped], [1, 1]);
  assert.equal(other.all().length, 3);
  const added = other.get(res.ids[0]);
  assert.equal(added.name, a.name);
  assert.ok(await other.getFile(added.file_hash));
  // C was already there (the same track): the "not duplicates" decision now points at it.
  const cThere = other.all().find((r) => r.name.startsWith("C"));
  assert.equal(other.isIgnored(added.id, cThere.id), true);
  // Adding the same set again adds nothing.
  assert.deepEqual((await addBackup(other, data)).added, 0);
});

test("a shared set can leave out notes and ratings", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 3000), { notes: "my secret", tags: ["forest"] });
  const r = svc.library().all()[0];
  r.quality_rating = 4;
  await svc.library().saveRoutes([r]);
  const read = async (opts) => (await readBackup(new Uint8Array(await (await makeSelection(svc.library(), [r.id], opts)).arrayBuffer()))).routes[0];
  const full = await read({});
  assert.deepEqual([full.notes, full.quality_rating], ["my secret", 4]);
  const shared = await read({ personal: false });
  assert.deepEqual([shared.notes, shared.quality_rating, shared.tags], [null, null, ["forest"]]);
  assert.equal(svc.library().get(r.id).notes, "my secret"); // the library itself is untouched
});

test("derived routes keep their link to a parent in the same set", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 3000));
  await importOne("B.gpx", east(2000, 3000));
  const [a, b] = svc.listRoutes("").sort((x, y) => x.id - y.id);
  const r = svc.library().get(b.id);
  r.derived_from = [a.id];
  await svc.library().saveRoutes([r]);
  const zip = await makeSelection(svc.library(), [b.id, a.id]);
  const data = await readBackup(new Uint8Array(await zip.arrayBuffer()));
  const other = await Library.open(new MemoryBackend());
  await other.saveRoutes([{ name: "x", slug: "x", file_hash: "f", track_index: 0, derived_from: [] }]);
  const res = await addBackup(other, data);
  assert.equal(res.added, 2);
  const child = other.all().find((x) => x.name === b.name);
  const parent = other.all().find((x) => x.name === a.name);
  assert.notEqual(parent.id, a.id); // new ids
  assert.deepEqual(child.derived_from, [parent.id]);
});

test("routes without a track hash get one from their file", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 3000));
  const [r] = svc.listRoutes("");
  const expected = r.track_hash;
  r.track_hash = null; // as moved from an early server version
  await svc.library().saveRoutes([r]);
  assert.equal(await svc.backfillTrackHashes(), 1);
  assert.equal(svc.route(r.id).track_hash, expected);
  assert.equal(await svc.backfillTrackHashes(), 0);
  // The same track in another file is now a duplicate again.
  const res = await svc.importGpx(gpxXml([["other name", east(0, 3000)]], { name: "x" }), "B.gpx");
  assert.equal(res.status, "duplicate");
});

test("mountain biking: an activity with its own connector profile", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  assert.ok(svc.clientConfig().activities.includes("mtb"));
  assert.ok(config.BROUTER_PROFILES.includes(config.ACTIVITY_PROFILES.mtb));
  await importOne("A.gpx", east(0, 6000), { activity: "mtb" });
  await importOne("B.gpx", east(800, 6000));
  const [a, b] = ["A", "B"].map((n) => svc.listRoutes("").find((r) => r.name === n));
  assert.equal(a.activity, "mtb");
  assert.deepEqual(await svc.setActivity([b.id], "mtb"), { updated: 1 });
  assert.equal(svc.listRoutes("activity=mtb").length, 2);

  // Both routes are mountain-bike routes: connectors are routed with BRouter's mtb profile.
  const profiles = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams;
    profiles.push(q.get("profile"));
    const coords = q.get("lonlats").split("|").map((ll) => [...ll.split(",").map(Number), 10]);
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: coords } }] }));
  };
  try {
    const [pa, pb] = (await svc.combineSuggest(a.id, b.id, 2)).parts;
    await svc.combinePreview({
      parts: [{ route_id: a.id, start: pa.start, end: pa.end }, { route_id: b.id, start: pb.start, end: pb.end }],
      closed: true,
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(profiles, ["mtb", "mtb"]);
});

test("combine pattern 'out on A, back on B' for two loops from the same start", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  const square = (sign) => {
    const corners = [[0, 0], [0, 4000 * sign], [4000, 4000 * sign], [4000, 200 * sign], [0, 0]];
    const pts = [];
    for (let k = 0; k < corners.length - 1; k++) {
      const [n0, e0] = corners[k], [n1, e1] = corners[k + 1];
      const steps = Math.round(Math.hypot(n1 - n0, e1 - e0) / 50);
      for (let i = k ? 1 : 0; i <= steps; i++) pts.push([...at(n0 + (i / steps) * (n1 - n0), e0 + (i / steps) * (e1 - e0)), 10]);
    }
    return pts;
  };
  await importOne("East.gpx", square(1));
  await importOne("West.gpx", square(-1));
  const [a, b] = ["East", "West"].map((n) => svc.listRoutes("").find((r) => r.name === n));
  const sug = await svc.combineSuggest(a.id, b.id, "outback");
  const [pa, pb] = sug.parts;
  assert.equal(pa.start_km, 0);
  assert.equal(pb.end_km, 0);
  assert.ok(pa.with_route && pb.with_route);
  const prev = await svc.combinePreview({
    parts: [
      { route_id: a.id, start: pa.start, end: pa.end, other_way: pa.other_way },
      { route_id: b.id, start: pb.start, end: pb.end, other_way: pb.other_way },
    ],
    closed: true, straight: true,
  });
  assert.equal(prev.is_loop, true);
  assert.deepEqual(prev.parts.map((p) => p.with_route), [true, true]);
  assert.equal(prev.connectors[1].routed, false); // back at the shared start already
  await assert.rejects(svc.combineSuggest(a.id, b.id, "zigzag"), svc.ServiceError);
});

// ------------------------------------------------------------------ TCX and FIT files

// A recorded ride of the east() route, with 1 km of riding to its start first.
const rideOfEast = () => [
  ...linePoints({ start: offset(...START, -1000, 0), lengthM: 900, stepM: 100, headingDeg: 0, ele: () => 10 }),
  ...east(),
];

test("a FIT course is imported as a route; its original is kept and GPX is written from it", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  const data = fitFile(east(), { fileType: 6, courseName: "Kempen", subSport: 46 });
  const { results: [res] } = await svc.importFiles([{ name: "kempen.fit", data }], { activity: "road" });
  assert.equal(res.status, "imported");
  const r = svc.route(res.routes[0].id);
  assert.equal(r.file_format, "fit");
  assert.equal(r.track_name, "Kempen");
  assert.equal(r.activity, "gravel"); // the file says gravel; the batch's "road" is only a default
  approx(r.distance_km, 10, { rel: 0.01 });
  assert.equal(svc.notGpx(r), true);

  const original = await svc.routeGpx(r.id);
  assert.equal(original.filename, "kempen.fit");
  assert.deepEqual(original.data, data);
  const gpx = await svc.routeAsGpx(r.id);
  assert.equal(gpx.filename, "kempen.gpx");
  assert.equal(parseTrackFile(new TextEncoder().encode(gpx.data)).tracks[0].points.length, east().length);
  // The profile, the combiner and the surface estimate read the FIT file too.
  assert.ok(await svc.routeProfile(r));

  // A zip of GPX files gets the GPX version.
  const zip = await svc.exportZip([r.id]);
  const entries = await readZip(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ["kempen.gpx"]);
});

test("a recorded ride of a library route can be logged on it instead of imported", async () => {
  const { results: [route] } = await svc.importFiles([{ name: "route.gpx", data: gpxXml([["t", east()]]) }]);
  const routeId = route.routes[0].id;
  const ride = fitFile(rideOfEast(), { start: "2026-09-14T07:30:00Z" });

  const { results: [res] } = await svc.importFiles([{ name: "Morning_Ride.fit.gz", data: new Uint8Array(gzipSync(ride)) }]);
  assert.equal(res.status, "ride");
  assert.equal(res.filename, "Morning_Ride.fit");
  assert.equal(res.ride.route_id, routeId);
  assert.equal(res.ride.date, "2026-09-14");
  assert.ok(res.ride.covered >= 0.95, `covered ${res.ride.covered}`);
  assert.ok(res.ride.on_route < 0.95 && res.ride.on_route > 0.8, `on route ${res.ride.on_route}`);
  approx(res.ride.distance_km, 10.9, { abs: 0.2 });
  assert.equal(svc.listRoutes("").length, 1, "nothing imported");

  await svc.logRide(routeId, res.ride);
  await svc.logRide(routeId, res.ride); // the same file is logged once
  await svc.logRide(routeId, { date: "2026-05-01" });
  assert.deepEqual(svc.route(routeId).rides.map((x) => x.date), ["2026-05-01", "2026-09-14"]);

  // The same file again: already logged.
  const again = await svc.importFiles([{ name: "Morning_Ride.fit", data: ride }]);
  assert.equal(again.results[0].status, "duplicate");
  assert.match(again.results[0].message, /already logged/);

  // Or imported anyway, as its own route.
  const other = fitFile(rideOfEast(), { start: "2026-09-21T07:30:00Z" });
  const forced = await svc.importFiles([{ name: "Other.fit", data: other, match_rides: false }]);
  assert.equal(forced.results[0].status, "imported");
  assert.equal(svc.route(forced.results[0].routes[0].id).file_format, "fit");
});

test("a ride elsewhere, part of a route, a course or a GPX file is not taken for a ride of a route", async () => {
  await svc.importFiles([{ name: "route.gpx", data: gpxXml([["t", east()]]) }]);
  const elsewhere = fitFile(east(-5000));
  const halfway = fitFile(east(0, 4000)); // only 40% of the route
  const course = fitFile(rideOfEast(), { fileType: 6 });
  const tcx = tcxXml(rideOfEast(), { sport: "Biking" });
  const { results } = await svc.importFiles([
    { name: "ride.tcx", data: tcx }, // a TCX activity is a recorded ride too
    { name: "elsewhere.fit", data: elsewhere },
    { name: "halfway.fit", data: halfway },
    { name: "course.fit", data: course },
  ]);
  assert.deepEqual(results.map((r) => r.status), ["ride", "imported", "imported", "imported"]);
  // The GPX version of the same ride is imported like any GPX file (here: the same track as
  // the course, so a duplicate).
  const gpx = await svc.importFiles([{ name: "ride.gpx", data: gpxXml([["t", rideOfEast()]]) }]);
  assert.equal(gpx.results[0].status, "duplicate");
});

test("backups keep TCX and FIT originals under their own extension", async () => {
  await svc.importFiles([
    { name: "a.fit", data: fitFile(east(0, 3000), { fileType: 6 }) },
    { name: "b.tcx", data: tcxXml(east(-5000, 3000), { course: "B" }) },
  ]);
  const zip = await makeBackup(svc.library());
  const names = (await readZip(new Uint8Array(await zip.arrayBuffer()))).map((e) => e.name).sort();
  assert.ok(names.some((n) => /^gpx\/[0-9a-f]{64}\.fit$/.test(n)), names.join());
  assert.ok(names.some((n) => /^gpx\/[0-9a-f]{64}\.tcx$/.test(n)), names.join());
  const data = await readBackup(new Uint8Array(await zip.arrayBuffer()));
  const other = await Library.open(new MemoryBackend());
  await other.restore(data);
  svc.setLibrary(other);
  for (const r of other.all()) assert.ok(await svc.routeProfile(r));
});

test("combine: a connector can ride through one of your places", async () => {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 6000));
  await importOne("B.gpx", east(800, 6000));
  const [a, b] = ["A", "B"].map((n) => svc.listRoutes("").find((r) => r.name === n));
  const sug = await svc.combineSuggest(a.id, b.id, 2);
  const [pa, pb] = sug.parts;
  const req = {
    parts: [{ route_id: a.id, start: pa.start, end: pa.end }, { route_id: b.id, start: pb.start, end: pb.end }],
    closed: true, straight: true,
  };
  const plain = await svc.combinePreview(req);
  // A café 1 km out of the way of the first connector, and one far away.
  const c = plain.connectors[0];
  const mid = [(c.from[0] + c.to[0]) / 2, (c.from[1] + c.to[1]) / 2];
  const cafe = await svc.addPlace({ lat: offset(...mid, 0, 500)[0], lon: offset(...mid, 0, 500)[1], name: "Café Halfweg", category: "cafe" });
  await svc.addPlace({ lat: 50.0, lon: 5.9, name: "Far away" });
  const options = svc.placesForConnector(c.from, c.to);
  assert.deepEqual(options.map((o) => o.place.name), ["Café Halfweg"]);
  approx(options[0].detour_km, 0.48, { abs: 0.05 }); // 2 × √(0.4² + 0.5²) − 0.8

  const via = await svc.combinePreview({ ...req, vias: [cafe.id, null] });
  assert.deepEqual(via.connectors.map((x) => x.via?.name ?? null), ["Café Halfweg", null]);
  assert.ok(via.connectors[0].distance_km > c.distance_km + 0.2, "the connector makes the detour");
  assert.match(via.description, /through Café Halfweg/);
  // The route passes the café.
  const along = (await svc.combineGpx({ ...req, vias: [cafe.id, null], name: "x" })).text;
  const pts = parseGpx(along).tracks[0].points;
  assert.ok(pts.some(([la, lo]) => Math.abs(la - cafe.lat) < 1e-6 && Math.abs(lo - cafe.lon) < 1e-6));
  await svc.deletePlaces([cafe.id]);
  await assert.rejects(svc.combinePreview({ ...req, vias: [cafe.id] }), /was removed/);
});

// ------------------------------------------------------------------ combine: connections one by one

async function threeLines() {
  config.AUTO_RENAME_ON_IMPORT = false;
  await importOne("A.gpx", east(0, 6000));
  await importOne("B.gpx", east(800, 6000));
  await importOne("C.gpx", east(1600, 6000));
  return ["A", "B", "C"].map((n) => svc.listRoutes("").find((r) => r.name === n));
}
const partOf = (r, fromM, toM) => ({ route_id: r.id, start: at(fromM.n, fromM.e), end: at(toM.n, toM.e) });

test("combine: route one connection, then use it as approved", async () => {
  const [a, b] = await threeLines();
  const parts = [partOf(a, { n: 0, e: 0 }, { n: 0, e: 3000 }), partOf(b, { n: 800, e: 3000 }, { n: 800, e: 6000 })];
  const conn = await svc.combineConnector({ from_part: parts[0], to_part: parts[1], straight: true });
  approx(conn.distance_km, 0.8, { abs: 0.01 });
  assert.equal(conn.routed, true);
  assert.equal(conn.alternative, 0);
  approx(conn.from[0], at(0, 3000)[0], { abs: 1e-5 });
  approx(conn.to[0], at(800, 3000)[0], { abs: 1e-5 });

  // Not the straight line: the approved route goes round by the east.
  const bend = [...at(400, 3500), null];
  const approved = { ...conn, points: [conn.points[0], bend, conn.points[conn.points.length - 1]] };
  const prev = await svc.combinePreview({ parts, closed: false, straight: true, connectors: [approved] });
  assert.equal(prev.connectors[0].approved, true);
  approx(prev.connectors[0].distance_km, 2 * Math.hypot(0.4, 0.5), { abs: 0.01 });
  const gpx = parseGpx((await svc.combineGpx({ parts, closed: false, straight: true, connectors: [approved], name: "x" })).text);
  assert.ok(gpx.tracks[0].points.some(([la, lo]) => Math.abs(la - bend[0]) < 1e-6 && Math.abs(lo - bend[1]) < 1e-6));

  // A part moved: the approved connection no longer fits.
  const moved = [partOf(a, { n: 0, e: 0 }, { n: 0, e: 2500 }), parts[1]];
  await assert.rejects(svc.combinePreview({ parts: moved, closed: false, straight: true, connectors: [approved] }), /no longer fits/);
  await assert.rejects(svc.combinePreview({ parts, closed: false, straight: true, connectors: "x" }), /must be a list/);
});

test("combine: a connection asks BRouter for the alternative chosen", async () => {
  const [a, b] = await threeLines();
  const parts = [partOf(a, { n: 0, e: 0 }, { n: 0, e: 3000 }), partOf(b, { n: 800, e: 3000 }, { n: 800, e: 6000 })];
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const q = new URL(url).searchParams;
    asked.push(q.get("alternativeidx"));
    const coords = q.get("lonlats").split("|").map((c) => [...c.split(",").map(Number), 10]);
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: coords } }] }));
  };
  try {
    await svc.combineConnector({ from_part: parts[0], to_part: parts[1] });
    const alt = await svc.combineConnector({ from_part: parts[0], to_part: parts[1], alternative: 2 });
    assert.equal(alt.alternative, 2);
    await assert.rejects(svc.combineConnector({ from_part: parts[0], to_part: parts[1], alternative: 4 }), /alternative from 0 to 3/);
    await assert.rejects(svc.combineConnector({ from_part: parts[0] }), /needs the part it leaves and the part it joins/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(asked, ["0", "2"]);
});

test("combine: several parts of one route; at most 4 routes and 6 parts", async () => {
  const [a, b, c] = await threeLines();
  const req = {
    parts: [
      partOf(a, { n: 0, e: 0 }, { n: 0, e: 2000 }),
      partOf(b, { n: 800, e: 2000 }, { n: 800, e: 4000 }),
      partOf(a, { n: 0, e: 4000 }, { n: 0, e: 6000 }),
    ],
    closed: false, straight: true,
  };
  const prev = await svc.combinePreview(req);
  assert.equal(prev.parts.length, 3);
  approx(prev.distance_km, 2 + 0.8 + 2 + 0.8 + 2, { abs: 0.05 });

  await importOne("D.gpx", east(2400, 6000));
  await importOne("E.gpx", east(3200, 6000));
  const [d, e] = ["D", "E"].map((n) => svc.listRoutes("").find((r) => r.name === n));
  const one = (r, i) => partOf(r, { n: 0, e: i * 1000 }, { n: 0, e: i * 1000 + 500 });
  await assert.rejects(svc.combinePreview({ parts: [a, b, c, d, e].map(one), straight: true }), /at most 4 routes/);
  await assert.rejects(svc.combinePreview({ parts: [a, b, c, a, b, c, a].map(one), straight: true }), /Use 2 to 6 parts/);
});
