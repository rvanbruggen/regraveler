import { test } from "node:test";
import assert from "node:assert/strict";

import * as cb from "../js/combiner.js";
import * as places from "../js/places.js";
import * as surface from "../js/surface.js";
import { approx, linePoints, offset } from "./helpers.js";

const START = [51.0, 4.4];
const at = (northM, eastM) => offset(...START, northM, eastM);

// A tiny "country" along a 10 km route heading east from START (like tests/test_places.py):
// [name, code, lat, lon, population, notability]. The build script already picked the Dutch
// names (Grootdorp, Testwoud).
function useTinyPlaces() {
  const recs = [
    ["Startdorp", "PPL", ...at(300, 0), 5000, 0],
    ["Gehucht", "PPL", ...at(100, 100), 0, 0], // nameless hamlet near the start
    ["Middendorp", "PPL", ...at(200, 3000), 2000, 0],
    ["Grootdorp", "PPL", ...at(-300, 5500), 20000, 0],
    ["Testwoud", "FRST", ...at(900, 7500), 0, 2],
    ["Rond Punt", "PPL", ...at(0, 8500), 0, 1], // odd point: skipped
    ["Verweg", "PPL", ...at(5000, 5000), 9000, 0], // not on the route
    ["Einddorp", "PPL", ...at(200, 10000), 3000, 0],
  ].map((r, i) => [...r, i]);
  places.setPlacesLoader(async (key) => (key === "51_4" ? recs : []), ["51_4"]);
}

const routeGeometry = (lengthM = 10000) =>
  linePoints({ start: START, lengthM, stepM: 100, headingDeg: 90 }).map(([la, lo]) => [la, lo]);

test("point to point name", async () => {
  useTinyPlaces();
  const g = await places.generateName(routeGeometry(), false);
  assert.equal(g.name, "Startdorp – Middendorp – Grootdorp – Einddorp");
});

test("landmarks and loops", async () => {
  useTinyPlaces();
  const geom = routeGeometry(9000);
  const back = geom.slice().reverse().map(([la, lo]) => [la + 0.00001, lo]);
  const g = await places.generateName([...geom, ...back], true);
  assert.equal(g.start, "Startdorp");
  assert.ok(g.places.includes("Testwoud"));
  assert.ok(!g.name.includes("Einddorp"), "1 km past the turn-around: not visited");
  assert.ok(g.places.length <= 3);
});

test("no places nearby", async () => {
  useTinyPlaces();
  const far = routeGeometry().map(([la, lo]) => [la + 2, lo]);
  assert.equal((await places.generateName(far, false)).name, null);
});

test("missing place data is reported", async () => {
  places.setPlacesLoader(async () => {
    throw new Error("no network");
  });
  await assert.rejects(places.generateName(routeGeometry(), false), places.PlacesUnavailable);
});

test("notes keep the original name", () => {
  assert.equal(places.notesWithOriginal(null, "Gravelroute X"), "Original name: Gravelroute X");
  assert.equal(places.notesWithOriginal("nice", "Gravelroute X"), "Original name: Gravelroute X\n\nnice");
  const once = places.notesWithOriginal("nice", "Gravelroute X");
  assert.equal(places.notesWithOriginal(once, "Startdorp – Y"), once);
});

test("disambiguate", () => {
  const taken = new Set(["a – b"]);
  assert.equal(places.disambiguate("A – C", 50, taken), "A – C");
  assert.equal(places.disambiguate("A – B", 66.4, taken), "A – B (66 km)");
  assert.equal(places.disambiguate("A – B", 66.4, new Set([...taken, "a – b (66 km)"])), "A – B (66 km, 2)");
});

// ------------------------------------------------------------------ surface

const tagCases = [
  [{ highway: "residential", surface: "asphalt" }, ["paved", false]],
  [{ highway: "track", surface: "gravel" }, ["unpaved", false]],
  [{ highway: "unclassified", surface: "sett" }, ["cobbles", false]],
  [{ highway: "track", surface: "compacted;gravel" }, ["unpaved", false]],
  [{ highway: "residential" }, ["paved", true]],
  [{ highway: "cycleway" }, ["paved", true]],
  [{ highway: "track", tracktype: "grade1" }, ["paved", true]],
  [{ highway: "track", tracktype: "grade3" }, ["unpaved", true]],
  [{ highway: "track" }, ["unpaved", true]],
  [{ highway: "path" }, ["unpaved", true]],
  [{ highway: "footway" }, ["unknown", true]],
  [{}, ["unknown", true]],
];
for (const [tags, expected] of tagCases) {
  test(`classify ${JSON.stringify(tags)}`, () => assert.deepEqual(surface.classify(tags), expected));
}

const track = (lengthM = 10000) => cb.makeTrack(linePoints({ lengthM, stepM: 50 }));

/** Each request: first half asphalt, then 20 % sett, 30 % track without a surface tag. */
function fakeMatcher() {
  const calls = [];
  const fn = async (waypoints) => {
    calls.push(waypoints);
    const length = (waypoints.length - 1) * 1000; // pretend 1 km between waypoints
    return {
      length,
      rows: [
        [0.5 * length, { highway: "tertiary", surface: "asphalt" }],
        [0.2 * length, { highway: "residential", surface: "sett" }],
        [0.3 * length, { highway: "track", tracktype: "grade3" }],
      ],
      coords: waypoints.map(([la, lo]) => [la, lo]),
    };
  };
  fn.calls = calls;
  return fn;
}

test("estimate aggregates categories and chunks requests", async () => {
  const m = fakeMatcher();
  const t = track(10000);
  const gaps = surface.matchWaypoints(t, 100).length - 1;
  const res = await surface.estimate(t, { matcher: m, spacingM: 100, chunk: 20 });
  assert.equal(m.calls.length, Math.ceil(gaps / 19));
  assert.ok(m.calls.every((c) => c.length <= 20));
  assert.equal(m.calls.reduce((s, c) => s + c.length - 1, 0), gaps);
  assert.deepEqual(m.calls[0][m.calls[0].length - 1], m.calls[1][0]);
  approx(res.paved_km, 0.5 * gaps);
  approx(res.cobbles_km, 0.2 * gaps);
  approx(res.unpaved_km, 0.3 * gaps);
  assert.equal(res.unknown_km, 0);
  approx(res.inferred_km, 0.3 * gaps);
  assert.equal(res.paved_pct, 70); // cobbles count as paved
  assert.equal(res.top_surfaces[0][0], "asphalt");
  assert.ok(res.segments.every(([cat]) => ["paved", "cobbles", "unpaved"].includes(cat)));
});

test("estimate without enough known surface", async () => {
  const mostlyUnknown = async (waypoints) => ({
    length: 1000, rows: [[800, { highway: "footway" }], [200, { surface: "asphalt" }]], coords: waypoints,
  });
  const res = await surface.estimate(track(1000), { matcher: mostlyUnknown, spacingM: 500 });
  approx(res.unknown_km, 0.8);
  assert.equal(res.paved_pct, null);
});

test("segments follow the stretches in order", () => {
  const segments = [];
  const coords = Array.from({ length: 11 }, (_, i) => [51.0, 4.0 + i * 0.001]); // 10 equal steps
  surface.addSegments(segments, coords, [[300, "paved"], [700, "unpaved"]]);
  assert.deepEqual(segments.map(([c]) => c), ["paved", "unpaved"]);
  assert.equal(segments[0][1].length, 4); // points 0..3 (30 % of the way)
  assert.deepEqual(segments[0][1][segments[0][1].length - 1], segments[1][1][0]);
});

for (const [start, overwrite, pct, source] of [
  [{}, false, 70, "estimated"],
  [{ paved_pct: 40, paved_source: "estimated" }, false, 70, "estimated"],
  [{ paved_pct: 40, paved_source: "manual" }, false, 40, "manual"],
  [{ paved_pct: 40, paved_source: null }, false, 40, null], // entered before estimates existed
  [{ paved_pct: 40, paved_source: "manual" }, true, 70, "estimated"],
]) {
  test(`applyEstimate keeps manual values: ${JSON.stringify(start)} overwrite=${overwrite}`, () => {
    const r = { paved_pct: null, paved_source: null, surface: null, ...start };
    surface.applyEstimate(r, { paved_pct: 70 }, overwrite);
    assert.deepEqual(r.surface, { paved_pct: 70 });
    assert.deepEqual([r.paved_pct, r.paved_source], [pct, source]);
  });
}
