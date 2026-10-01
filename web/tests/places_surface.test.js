import { test } from "node:test";
import assert from "node:assert/strict";

import * as cb from "../js/combiner.js";
import * as places from "../js/places.js";
import * as surface from "../js/surface.js";
import { geodesicDistance } from "../js/geo.js";
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

/** Points every ~10 m on the straight lines between the given [lat, lon] points. */
function densify(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(1, Math.round(geodesicDistance(a[0], a[1], b[0], b[1]) / 10));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

const pathLength = (coords) =>
  coords.slice(1).reduce((s, c, i) => s + geodesicDistance(coords[i][0], coords[i][1], c[0], c[1]), 0);

/** Each request: first half asphalt, then 20 % sett, 30 % track without a surface tag. */
function fakeMatcher() {
  const calls = [];
  const fn = async (waypoints) => {
    calls.push(waypoints);
    const coords = densify(waypoints);
    const length = pathLength(coords);
    return {
      length,
      rows: [
        [0.5 * length, { highway: "tertiary", surface: "asphalt" }],
        [0.2 * length, { highway: "residential", surface: "sett" }],
        [0.3 * length, { highway: "track", tracktype: "grade3" }],
      ],
      coords,
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
  // km along the track: every request covers its own stretch once
  approx(res.paved_km, 5, { abs: 0.1 });
  approx(res.cobbles_km, 2, { abs: 0.1 });
  approx(res.unpaved_km, 3, { abs: 0.1 });
  approx(res.paved_km + res.cobbles_km + res.unpaved_km + res.unknown_km, 10, { abs: 0.02 });
  assert.ok(res.unknown_km < 0.05);
  approx(res.inferred_km, 3, { abs: 0.1 });
  approx(res.match_ratio, 1, { abs: 0.01 });
  assert.equal(res.paved_pct, 70); // cobbles count as paved
  assert.equal(res.top_surfaces[0][0], "asphalt");
  assert.ok(res.segments.every(([cat]) => ["paved", "cobbles", "unpaved"].includes(cat)));
});

// For a 3 km route heading east from START: a matcher that follows it, but at the waypoint at
// 1500 m rides `extra` ([lat, lon] points, tagged `tags`) and, if `rejoinM`, leaves out the
// route up to the waypoint at rejoinM (BRouter went around it).
function detourMatcher(extra, tags, rejoinM = null) {
  return async (waypoints) => {
    const nearest = (m) => {
      const p = at(0, m);
      const ds = waypoints.map((w) => geodesicDistance(w[0], w[1], p[0], p[1]));
      return ds.indexOf(Math.min(...ds));
    };
    const from = nearest(1500), to = rejoinM == null ? from : nearest(rejoinM);
    const asphalt = { highway: "tertiary", surface: "asphalt" };
    const before = densify(waypoints.slice(0, from + 1));
    const detour = [waypoints[from], ...extra, waypoints[to]];
    const after = densify(waypoints.slice(to));
    const rows = [[pathLength(before), asphalt], [pathLength(detour), tags], [pathLength(after), asphalt]];
    const coords = [...before, ...detour.slice(1), ...after.slice(1)];
    return { length: pathLength(coords), rows, coords };
  };
}

test("estimate ignores BRouter riding out and back to a waypoint", async () => {
  // a 400 m dead end off the route, ridden there and back
  const spur = [at(100, 1500), at(200, 1500), at(400, 1500), at(200, 1500)];
  const res = await surface.estimate(track(3000), { matcher: detourMatcher(spur, { highway: "track" }), spacingM: 300 });
  assert.ok(res.matched_km > 3.7); // BRouter's own path
  approx(res.unpaved_km, 0, { abs: 0.01 });
  approx(res.paved_km, 3, { abs: 0.02 });
  approx(res.match_ratio, 1, { abs: 0.01 });
  assert.ok(res.segments.every(([cat]) => cat === "paved"));
});

test("estimate counts what BRouter did not follow as unknown", async () => {
  // leaves the route at 1500 m, rides a parallel road 300 m north, rejoins at 2100 m
  const detour = [at(300, 1500), at(300, 2100)];
  const res = await surface.estimate(track(3000), {
    matcher: detourMatcher(detour, { highway: "residential", surface: "sett" }, 2100), spacingM: 300,
  });
  approx(res.cobbles_km, 0, { abs: 0.01 });
  approx(res.unmatched_km, 0.6, { abs: 0.02 });
  approx(res.paved_km + res.unknown_km, 3, { abs: 0.02 });
  approx(res.match_ratio, 0.8, { abs: 0.01 });
});

test("estimate of a route that rides the same road twice", async () => {
  // 2 km east and back on the same road (a waypoint at the turnaround, the ones on the way back
  // on top of those on the way out)
  const pts = [...linePoints({ lengthM: 2000, stepM: 50 }), ...linePoints({ start: at(0, 2000), lengthM: 2000, stepM: 50, headingDeg: 270 }).slice(1)];
  const res = await surface.estimate(cb.makeTrack(pts), { matcher: fakeMatcher(), spacingM: 250 });
  approx(res.paved_km + res.cobbles_km + res.unpaved_km, 4, { abs: 0.05 });
  approx(res.match_ratio, 1, { abs: 0.01 });
});

test("estimate without enough known surface", async () => {
  const mostlyUnknown = async (waypoints) => ({
    length: 1000, rows: [[800, { highway: "footway" }], [200, { surface: "asphalt" }]], coords: densify(waypoints),
  });
  const res = await surface.estimate(track(1000), { matcher: mostlyUnknown, spacingM: 500 });
  approx(res.unknown_km, 0.8, { abs: 0.02 });
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
