import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildProfile, columns, gradeAt, gradeBands, gradeClass, indexAt, nearestIndex, niceStep, ticks,
} from "../js/profile.js";
import { computeStats } from "../js/stats.js";
import { approx, linePoints } from "./helpers.js";

// 1 km flat, 1 km at 5 %, 1 km flat, 500 m at 10 %, 500 m flat.
const hilly = (d) => {
  if (d < 1000) return 10;
  if (d < 2000) return 10 + (d - 1000) * 0.05;
  if (d < 3000) return 60;
  if (d < 3500) return 60 + (d - 3000) * 0.1;
  return 110;
};

test("profile matches the route stats", () => {
  const pts = linePoints({ lengthM: 4000, ele: hilly });
  const p = buildProfile(pts);
  const s = computeStats(pts);
  approx(p.total / 1000, s.distance_km, { abs: 0.01 });
  approx(p.min, s.min_elevation_m, { abs: 0.1 });
  approx(p.max, s.max_elevation_m, { abs: 0.1 });
  assert.equal(p.dist[1] - p.dist[0], 10);
  assert.equal(p.lat.length, p.dist.length);
});

test("profile positions follow the route", () => {
  const pts = linePoints({ lengthM: 2000, ele: () => 5 });
  const p = buildProfile(pts);
  const mid = indexAt(p, 1000);
  approx(p.lat[mid], pts[100][0], { abs: 5e-5 }); // the helper uses approximate metres per degree
  approx(p.lon[mid], pts[100][1], { abs: 5e-5 });
  const near = nearestIndex(p, pts[150][0], pts[150][1]);
  assert.equal(near.index, indexAt(p, 1500));
  assert.ok(near.metres < 5);
});

test("no elevation gives no profile", () => {
  assert.equal(buildProfile(linePoints({ lengthM: 1000 })), null);
});

test("repeated points are ignored", () => {
  const pts = linePoints({ lengthM: 1000, ele: (d) => d / 100 });
  const doubled = pts.flatMap((q) => [q, q]);
  const p = buildProfile(doubled);
  approx(p.total, buildProfile(pts).total, { abs: 1e-6 });
  assert.ok(p.ele.every((v) => Number.isFinite(v)));
});

test("indexAt picks the nearest grid point", () => {
  const p = buildProfile(linePoints({ lengthM: 1000, ele: () => 1 }));
  assert.equal(indexAt(p, 0), 0);
  assert.equal(indexAt(p, 14), 1);
  assert.equal(indexAt(p, 16), 2);
  assert.equal(indexAt(p, 1e9), p.dist.length - 1);
});

test("grades and slope bands", () => {
  const p = buildProfile(linePoints({ lengthM: 4000, ele: hilly }));
  approx(gradeAt(p, indexAt(p, 1500)), 5, { abs: 0.2 });
  approx(gradeAt(p, indexAt(p, 3250)), 10, { abs: 0.2 });
  approx(gradeAt(p, indexAt(p, 500)), 0, { abs: 0.01 });
  assert.equal(gradeClass(2.9), -1);
  assert.equal(gradeClass(5), 0);
  assert.equal(gradeClass(7), 1);
  assert.equal(gradeClass(12), 2);
  const bands = gradeBands(p);
  // The 5 % km and the 10 % stretch, each merged into one band (smoothing blurs the edges).
  const five = bands.filter((b) => b.cls === 0 && b.from >= 1000 && b.to <= 2100);
  assert.equal(five.length, 1);
  assert.ok(five[0].to - five[0].from >= 800);
  const ten = bands.filter((b) => b.cls === 2);
  assert.equal(ten.length, 1);
  assert.ok(ten[0].from >= 3000 && ten[0].to <= 3600);
  assert.ok(!bands.some((b) => b.to <= 1000 || b.from >= 3600), "no bands on flat ground");
});

test("descents get no band", () => {
  const p = buildProfile(linePoints({ lengthM: 2000, ele: (d) => 200 - d * 0.08 }));
  assert.deepEqual(gradeBands(p), []);
});

test("columns keep the highest point of each pixel", () => {
  // A 20 m spike of 30 m on a 20 km flat route: 2 grid points in a 100-pixel chart.
  const p = buildProfile(linePoints({ lengthM: 20000, stepM: 10, ele: (d) => (d >= 10000 && d < 10060 ? 40 : 10) }));
  const col = columns(p, 100);
  assert.equal(col.length, 100);
  assert.ok(Math.max(...col) > 20, "the spike is visible");
  assert.ok(col.every((v) => Number.isFinite(v)));
});

test("nice axis steps and ticks", () => {
  assert.equal(niceStep(100, 3), 50);
  assert.equal(niceStep(42, 3), 20);
  assert.equal(niceStep(7, 4), 2);
  assert.equal(niceStep(0, 3), 1);
  assert.deepEqual(ticks(0, 100, 50), [0, 50, 100]);
  assert.deepEqual(ticks(5, 42, 20), [20, 40]);
  assert.deepEqual(ticks(0, 0.3, 0.1), [0, 0.1, 0.2, 0.3]);
});
