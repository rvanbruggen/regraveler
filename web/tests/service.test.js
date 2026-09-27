import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { makeBackup, readBackup } from "../js/backup.js";
import { config } from "../js/config.js";
import { Library, MemoryBackend } from "../js/db.js";
import { parseGpx } from "../js/gpx.js";
import * as places from "../js/places.js";
import * as svc from "../js/service.js";
import { readZip } from "../js/zip.js";
import { approx, gpxXml, linePoints, loopPoints, offset } from "./helpers.js";

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
