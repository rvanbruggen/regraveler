import { test } from "node:test";
import assert from "node:assert/strict";

import { simplifyLatLon } from "../js/geo.js";
import { duplicatePairs, findSimilar, groupPairs, proximityPairs } from "../js/similarity.js";
import { approx, linePoints, offset } from "./helpers.js";

const START = [51.0, 4.4];
const route = (id, points) => {
  const geometry = points.map(([la, lo]) => [la, lo]);
  const lats = geometry.map((p) => p[0]), lons = geometry.map((p) => p[1]);
  return { id, geometry, min_lat: Math.min(...lats), min_lon: Math.min(...lons), max_lat: Math.max(...lats), max_lon: Math.max(...lons) };
};
const eastLine = ({ northM = 0, eastM = 0, lengthM = 5000 } = {}) =>
  linePoints({ start: offset(...START, northM, eastM), lengthM, stepM: 100, headingDeg: 90 });

// ------------------------------------------------------------------ proximity

test("parallel routes within the distance share their length", () => {
  const [pair] = proximityPairs([route(1, eastLine()), route(2, eastLine({ northM: 50 }))], 100);
  assert.deepEqual([pair.a_id, pair.b_id], [1, 2]);
  approx(pair.min_distance_m, 50, { abs: 1 });
  approx(pair.a_shared_km, 5.0, { rel: 0.02 });
  approx(pair.a_shared_pct, 100, { abs: 2 });
  assert.ok(pair.a_segments.length && pair.b_segments.length);
});

test("parallel routes outside the distance are ignored", () => {
  assert.deepEqual(proximityPairs([route(1, eastLine()), route(2, eastLine({ northM: 50 }))], 30), []);
});

test("partial overlap", () => {
  const [pair] = proximityPairs([route(1, eastLine({ lengthM: 4000 })), route(2, eastLine({ eastM: 3000, lengthM: 4000 }))], 20);
  approx(pair.min_distance_m, 0, { abs: 0.05 });
  approx(pair.a_shared_km, 1.0, { abs: 0.05 });
  approx(pair.a_shared_pct, 25, { abs: 2 });
  approx(pair.b_shared_pct, 25, { abs: 2 });
});

test("crossing routes share only a short stretch", () => {
  const b = linePoints({ start: offset(...START, -2500, 2500), lengthM: 5000, stepM: 100, headingDeg: 0 });
  const [pair] = proximityPairs([route(1, eastLine()), route(2, b)], 50);
  assert.equal(pair.min_distance_m, 0);
  approx(pair.a_shared_km, 0.1, { abs: 0.02 }); // ~100 m around the crossing (2 x 50 m)
});

test("a near miss reports the closest points", () => {
  const a = route(1, eastLine({ lengthM: 2000 }));
  const b = route(2, eastLine({ eastM: 2080, lengthM: 2000 }));
  const [pair] = proximityPairs([a, b], 100);
  approx(pair.min_distance_m, 80, { abs: 1 });
  const [endA, startB] = pair.closest;
  approx(endA[0], a.geometry[a.geometry.length - 1][0], { abs: 1e-5 });
  approx(endA[1], a.geometry[a.geometry.length - 1][1], { abs: 1e-5 });
  approx(startB[1], b.geometry[0][1], { abs: 1e-5 });
});

test("bbox prefilter, and pairs listed once", () => {
  const routes = [
    route(1, eastLine()), route(2, eastLine({ northM: 30 })), route(3, eastLine({ northM: 60 })),
    route(4, eastLine({ northM: 50000 })),
  ];
  const pairs = proximityPairs(routes, 40).map((p) => [p.a_id, p.b_id]).sort();
  assert.deepEqual(pairs, [[1, 2], [2, 3]]);
});

test("degenerate input", () => {
  assert.deepEqual(proximityPairs([], 100), []);
  assert.deepEqual(proximityPairs([route(1, eastLine())], 100), []);
  assert.deepEqual(proximityPairs([route(1, eastLine()), { id: 2, geometry: [] }], 100), []);
});

test("simplifyLatLon reduces points and keeps the ends", () => {
  const geom = linePoints({ lengthM: 5000, stepM: 10 }).map(([la, lo]) => [la, lo]);
  const simple = simplifyLatLon(geom, 10);
  assert.ok(simple.length < 10);
  approx(simple[0][0], geom[0][0], { abs: 1e-5 });
  approx(simple[simple.length - 1][1], geom[geom.length - 1][1], { abs: 1e-5 });
  assert.equal(simplifyLatLon(geom, 0), geom);
});

// ------------------------------------------------------------------ similar and duplicates

test("findSimilar: same route slightly offset is very similar; a far route is not", () => {
  const a = route(1, eastLine());
  const others = [route(2, eastLine({ northM: 20 })), route(3, eastLine({ northM: 5000 }))];
  const sims = findSimilar(a.geometry, [a.min_lat, a.min_lon, a.max_lat, a.max_lon], others);
  assert.equal(sims.length, 1);
  assert.equal(sims[0].other_id, 2);
  assert.equal(sims[0].very_similar, true);
});

test("duplicates: a route inside a longer one is a variant pair; groups need both ways", () => {
  const whole = route(1, eastLine({ lengthM: 10000 }));
  const part = route(2, eastLine({ eastM: 2000, lengthM: 3000 }));
  const twin = route(3, eastLine({ northM: 10, lengthM: 10000 }));
  const pairs = duplicatePairs([whole, part, twin], 50, 0.85);
  const byKey = new Map(pairs.map((p) => [`${p.a_id}-${p.b_id}`, p]));
  assert.ok(byKey.get("1-2").b_in_a > 0.95 && byKey.get("1-2").a_in_b < 0.4);
  assert.ok(byKey.get("1-3").a_in_b > 0.95 && byKey.get("1-3").b_in_a > 0.95);
  const groups = groupPairs(pairs, 0.85).map((g) => [...g].sort());
  assert.deepEqual(groups, [[1, 3]]);
});

test("duplicates: detects a route ridden the other way", () => {
  const a = route(1, eastLine());
  const b = route(2, eastLine({ northM: 5 }).reverse());
  const [p] = duplicatePairs([a, b], 50, 0.9);
  assert.equal(p.reversed, true);
  const [q] = duplicatePairs([a, route(3, eastLine({ northM: 5 }))], 50, 0.9);
  assert.equal(q.reversed, false);
});
