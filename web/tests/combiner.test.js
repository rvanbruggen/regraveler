import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as cb from "../js/combiner.js";
import { cumulative, project } from "../js/geo.js";
import { computeStats } from "../js/stats.js";
import { approx, linePoints, loopPoints, offset } from "./helpers.js";

const START = [51.0, 4.4];

const east = ({ northM = 0, eastM = 0, lengthM = 4000, stepM = 20, ele = null } = {}) =>
  linePoints({ start: offset(...START, northM, eastM), lengthM, stepM, headingDeg: 90, ele });

const lengthM = (points) => computeStats(points).distance_km * 1000;
const xy = (track, at) => cb.pointAt(track, at).slice(0, 2);
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const approxLL = (p, q, abs = 1e-6) => {
  approx(p[0], q[0], { abs });
  approx(p[1], q[1], { abs });
};

let calls = [];
/** Records calls; returns a straight line with one midpoint. */
async function fakeRouter(p, q) {
  calls.push([p, q]);
  return [[p[0], p[1], null], [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, null], [q[0], q[1], null]];
}
beforeEach(() => (calls = []));

const legs = (res) => Object.fromEntries(res.legs.map((l) => [l.kind, l]));
const locateXY = (track, p) => project(track.xyz, track.cum, p[0], p[1]);

// ------------------------------------------------------------------ tracks and sections

test("make track: length and duplicate points", () => {
  const pts = east({ lengthM: 1000 });
  const t = cb.makeTrack([...pts, pts[pts.length - 1]]);
  approx(t.length, 1000, { rel: 0.005 });
  assert.equal(t.xyz.length, pts.length);
});

test("pointAt interpolates position and elevation", () => {
  const t = cb.makeTrack(east({ lengthM: 1000, stepM: 100, ele: (d) => d / 10 }));
  const p = cb.pointAt(t, 250);
  approx(dist(p, t.xyz[0]), 250, { abs: 0.5 });
  approx(p[2], 25, { abs: 0.2 });
  approxLL(cb.pointAt(t, -5), t.xyz[0]);
  approxLL(cb.pointAt(t, 1e9), t.xyz[t.xyz.length - 1]);
});

test("section forward and backward", () => {
  const t = cb.makeTrack(east({ lengthM: 1000, stepM: 100 }));
  const fwd = cb.section(t, 150, 650);
  approx(cb.legLength(fwd), 500, { abs: 0.5 });
  assert.ok(dist(fwd[0], cb.pointAt(t, 150)) < 0.01);
  assert.ok(dist(fwd[fwd.length - 1], cb.pointAt(t, 650)) < 0.01);
  const back = cb.section(t, 650, 150);
  assert.deepEqual(back.map((p) => p.slice(0, 2)), fwd.slice().reverse().map((p) => p.slice(0, 2)));
});

test("section the other way round a loop", () => {
  const t = cb.makeTrack(loopPoints({ radiusM: 1000, n: 360 }), true);
  const L = t.length;
  approx(cb.legLength(cb.section(t, 0.2 * L, 0.6 * L)), 0.4 * L, { rel: 0.01 });
  const other = cb.section(t, 0.2 * L, 0.6 * L, true);
  approx(cb.legLength(other), 0.6 * L, { rel: 0.01 });
  assert.ok(dist(other[0], cb.pointAt(t, 0.2 * L)) < 0.01);
  assert.ok(dist(other[other.length - 1], cb.pointAt(t, 0.6 * L)) < 0.01);
  assert.ok(Math.min(...other.map((p) => dist(p, t.xyz[0]))) < 0.01);
  const other2 = cb.section(t, 0.6 * L, 0.2 * L, true);
  approx(cb.legLength(other2), 0.6 * L, { rel: 0.01 });
  assert.ok(dist(other2[0], cb.pointAt(t, 0.6 * L)) < 0.01);
});

test("locate projects onto the route", () => {
  const t = cb.makeTrack(east({ lengthM: 2000 }));
  const [lat, lon] = offset(...START, 40, 700); // 40 m north of the 700 m point
  approx(cb.locate(t, lat, lon) / t.length, 700 / 2000, { abs: 0.001 });
});

// ------------------------------------------------------------------ point to point

test("single connection stitches A, connector, B", async () => {
  const a = cb.makeTrack(east({ lengthM: 4000 }));
  const b = cb.makeTrack(east({ northM: 500, lengthM: 4000 }));
  const res = await cb.combine(a, b, [{ aAt: 3000, bAt: 1000 }], fakeRouter);
  assert.equal(calls.length, 1);
  const l = legs(res);
  approx(cb.legLength(l.a.xyz), 3000, { abs: 1 });
  approx(cb.legLength(l.b.xyz), b.length - 1000, { abs: 1 });
  approx(cb.legLength(l.connector.xyz), Math.hypot(2000, 500), { rel: 0.01 });
  approx(lengthM(res.points), 6000 + Math.hypot(2000, 500), { rel: 0.01 });
  approxLL(res.points[0], cb.latLonOf(a.xyz[0]));
  approxLL(res.points[res.points.length - 1], cb.latLonOf(b.xyz[b.xyz.length - 1]));
});

test("single connection with reversed parts", async () => {
  const a = cb.makeTrack(east({ lengthM: 4000 }));
  const b = cb.makeTrack(east({ northM: 500, lengthM: 4000 }));
  const res = await cb.combine(a, b, [{ aAt: 3000, bAt: 1000 }], fakeRouter, { reverseA: true, reverseB: true });
  const l = legs(res);
  approx(cb.legLength(l.a.xyz), a.length - 3000, { abs: 1 });
  approx(cb.legLength(l.b.xyz), 1000, { abs: 1 });
  approxLL(res.points[0], cb.latLonOf(a.xyz[a.xyz.length - 1]));
  approxLL(res.points[res.points.length - 1], cb.latLonOf(b.xyz[0]));
});

test("reverse the whole result", async () => {
  const a = cb.makeTrack(east({ lengthM: 4000 }));
  const b = cb.makeTrack(east({ northM: 500, lengthM: 4000 }));
  const fwd = await cb.combine(a, b, [{ aAt: 3000, bAt: 1000 }], fakeRouter);
  const rev = await cb.combine(a, b, [{ aAt: 3000, bAt: 1000 }], fakeRouter, { reverse: true });
  assert.deepEqual(rev.points, fwd.points.slice().reverse());
});

test("touching routes are joined without routing", async () => {
  const a = cb.makeTrack(east({ lengthM: 2000 }));
  const b = cb.makeTrack(east({ northM: 10, eastM: 2000, lengthM: 2000 }));
  const res = await cb.combine(a, b, [{ aAt: 2000, bAt: 0 }], fakeRouter, { directJoinM: 25 });
  assert.equal(calls.length, 0);
  assert.equal(cb.connectorsOf(res)[0].routed, false);
  approx(lengthM(res.points), 4010, { rel: 0.005 });
});

test("elevation is kept along the stitched route", async () => {
  const a = cb.makeTrack(east({ lengthM: 2000, ele: (d) => 10 + d / 100 }));
  const b = cb.makeTrack(east({ northM: 300, lengthM: 2000, ele: () => 50 }));
  const res = await cb.combine(a, b, [{ aAt: 2000, bAt: 0 }], fakeRouter);
  approx(res.points[0][2], 10, { abs: 0.1 });
  approx(res.points[res.points.length - 1][2], 50, { abs: 0.1 });
});

// ------------------------------------------------------------------ loops

const twoParallelLines = () => [cb.makeTrack(east({ lengthM: 6000 })), cb.makeTrack(east({ northM: 800, lengthM: 6000 }))];

test("two connections build a closed loop", async () => {
  const [a, b] = twoParallelLines();
  const res = await cb.combine(a, b, [{ aAt: 5000, bAt: 5000 }, { aAt: 1000, bAt: 1000 }], fakeRouter);
  assert.equal(calls.length, 2);
  assert.deepEqual(res.legs.map((l) => l.kind), ["a", "connector", "b", "connector"]);
  approxLL(res.points[0], res.points[res.points.length - 1], 1e-7);
  approx(lengthM(res.points), 4000 + 800 + 4000 + 800, { rel: 0.01 });
  assert.equal(computeStats(res.points).is_loop, true);
});

const twoLoops = () => [
  cb.makeTrack(loopPoints({ radiusM: 1500, n: 400 }), true),
  cb.makeTrack(loopPoints({ center: offset(...START, 0, 4000), radiusM: 1500, n: 400 }), true),
];

test("loop: the other way round a loop route", async () => {
  const [a, b] = twoLoops();
  const L = a.length;
  const cons = [{ aAt: 0.2 * L, bAt: 0.8 * L }, { aAt: 0.3 * L, bAt: 0.7 * L }];
  const short = await cb.combine(a, b, cons, fakeRouter);
  const longA = await cb.combine(a, b, cons, fakeRouter, { reverseA: true });
  approx(cb.legLength(short.legs[0].xyz), 0.1 * L, { rel: 0.02 });
  approx(cb.legLength(longA.legs[0].xyz), 0.9 * L, { rel: 0.02 });
});

test("loop starts at route A's start when that is on the loop", async () => {
  const [a, b] = twoLoops();
  const L = a.length;
  const cons = [{ aAt: 0.2 * L, bAt: 0.8 * L }, { aAt: 0.3 * L, bAt: 0.7 * L }];
  const res = await cb.combine(a, b, cons, fakeRouter, { reverseA: true });
  const aStart = cb.latLonOf(a.xyz[0]);
  approxLL(res.points[0], aStart);
  approxLL(res.points[res.points.length - 1], aStart);
  const noRotate = await cb.combine(a, b, cons, fakeRouter, { reverseA: true, startAtAStart: false });
  approx(lengthM(res.points), lengthM(noRotate.points), { rel: 0.001 });
});

test("loop needs distinct connection points", async () => {
  const [a, b] = twoParallelLines();
  await assert.rejects(cb.combine(a, b, [{ aAt: 1000, bAt: 1000 }, { aAt: 1000, bAt: 3000 }], fakeRouter), cb.CombineError);
  await assert.rejects(cb.combine(a, b, [], fakeRouter), cb.CombineError);
});

// ------------------------------------------------------------------ parts (A1 -> A2 -> B1 -> B2)

test("parts: closed loop rides each part between its points", async () => {
  const [a, b] = twoParallelLines();
  const parts = [cb.part(a, 1000, 5000), cb.part(b, 5000, 1000)];
  const res = await cb.combineParts(parts, fakeRouter);
  assert.deepEqual(res.legs.map((l) => l.kind), ["a", "connector", "b", "connector"]);
  assert.equal(calls.length, 2);
  approx(cb.legLength(res.legs[0].xyz), 4000, { abs: 1 });
  approx(cb.legLength(res.legs[2].xyz), 4000, { abs: 1 });
  const a1 = cb.latLonOf(cb.pointAt(a, 1000));
  approxLL(res.points[0], a1);
  approxLL(res.points[res.points.length - 1], a1);
  approx(lengthM(res.points), 4000 + 800 + 4000 + 800, { rel: 0.01 });
  approxLL(res.partPoints[1][0], cb.latLonOf(cb.pointAt(b, 5000)), 1e-7);
  assert.equal(cb.connectorsCross(parts), false);
});

test("parts: direction follows the order of the points", async () => {
  const [a, b] = twoParallelLines();
  const res = await cb.combineParts([cb.part(a, 5000, 1000), cb.part(b, 1000, 5000)], fakeRouter);
  const aLeg = res.legs[0].xyz, bLeg = res.legs[2].xyz;
  assert.ok(aLeg[0][0] > aLeg[aLeg.length - 1][0], "A ridden westwards");
  assert.ok(bLeg[0][0] < bLeg[bLeg.length - 1][0], "B ridden eastwards");
});

test("parts: same as the old loop mode", async () => {
  const [a, b] = twoParallelLines();
  const old = await cb.combine(a, b, [{ aAt: 5000, bAt: 5000 }, { aAt: 1000, bAt: 1000 }], fakeRouter, { startAtAStart: false });
  const nw = await cb.combineParts([cb.part(a, 1000, 5000), cb.part(b, 5000, 1000)], fakeRouter);
  assert.deepEqual(nw.points, old.points);
});

test("parts: open has no connector back", async () => {
  const [a, b] = twoParallelLines();
  const res = await cb.combineParts([cb.part(a, 0, 3000), cb.part(b, 3000, b.length)], fakeRouter, { closed: false });
  assert.deepEqual(res.legs.map((l) => l.kind), ["a", "connector", "b"]);
  approxLL(res.points[0], cb.latLonOf(a.xyz[0]));
  approxLL(res.points[res.points.length - 1], cb.latLonOf(b.xyz[b.xyz.length - 1]));
  const rev = await cb.combineParts([cb.part(a, 0, 3000), cb.part(b, 3000, b.length)], fakeRouter, { closed: false, reverse: true });
  assert.deepEqual(rev.points, res.points.slice().reverse());
});

test("parts: the other way round a loop route", async () => {
  const [a, b] = twoLoops();
  const L = a.length;
  const short = await cb.combineParts([cb.part(a, 0.3 * L, 0.2 * L), cb.part(b, 0.8 * L, 0.7 * L)], fakeRouter);
  const longA = await cb.combineParts([cb.part(a, 0.3 * L, 0.2 * L, true), cb.part(b, 0.8 * L, 0.7 * L)], fakeRouter);
  approx(cb.legLength(short.legs[0].xyz), 0.1 * L, { rel: 0.02 });
  approx(cb.legLength(longA.legs[0].xyz), 0.9 * L, { rel: 0.02 });
});

test("parts: three routes", async () => {
  const [a, b] = twoParallelLines();
  const c = cb.makeTrack(east({ northM: 1600, lengthM: 6000 }));
  const res = await cb.combineParts([cb.part(a, 0, 3000), cb.part(b, 3000, 5000), cb.part(c, 5000, 6000)], fakeRouter, { closed: false });
  assert.deepEqual(res.legs.map((l) => l.kind), ["a", "connector", "b", "connector", "c"]);
  assert.equal(cb.connectorsOf(res).length, 2);
});

test("parts need distinct points and two routes", async () => {
  const [a, b] = twoParallelLines();
  await assert.rejects(cb.combineParts([cb.part(a, 0, 3000), cb.part(b, 2000, 2000)], fakeRouter), /route B/);
  await assert.rejects(cb.combineParts([cb.part(a, 0, 3000)], fakeRouter), cb.CombineError);
});

// ------------------------------------------------------------------ approved connectors

test("parts: an approved connector is used as it is, without routing", async () => {
  const [a, b] = twoParallelLines();
  const parts = [cb.part(a, 0, 3000), cb.part(b, 3000, b.length)];
  const [[p, q]] = cb.connectorEnds(parts, false);
  const from = cb.latLonOf(p), to = cb.latLonOf(q);
  const detour = offset(...from, 400, 500); // a bend no router would give for this gap
  const approved = { from, to, points: [[...from, null], [...detour, null], [...to, null]] };
  const res = await cb.combineParts(parts, fakeRouter, { closed: false, connectors: [approved] });
  assert.equal(calls.length, 0);
  const [conn] = cb.connectorsOf(res);
  assert.equal(conn.approved, true);
  approxLL(cb.latLonOf(conn.xyz[1]), detour);
  assert.ok(dist(conn.xyz[0], p) < 0.01 && dist(conn.xyz[conn.xyz.length - 1], q) < 0.01, "from the cut point to the cut point");
});

test("parts: approved and routed connectors mix", async () => {
  const [a, b] = twoParallelLines();
  const parts = [cb.part(a, 1000, 5000), cb.part(b, 5000, 1000)];
  const first = await cb.routeConnector(...cb.connectorEnds(parts)[0], fakeRouter, 25);
  calls = [];
  const approved = { from: cb.latLonOf(first.xyz[0]), to: cb.latLonOf(first.xyz[first.xyz.length - 1]), points: cb.toLatLon(first.xyz) };
  const res = await cb.combineParts(parts, fakeRouter, { connectors: [approved, null] });
  assert.equal(calls.length, 1, "only the connector back is routed");
  const plain = await cb.combineParts(parts, fakeRouter);
  assert.equal(res.points.length, plain.points.length);
  res.points.forEach((pt, i) => approxLL(pt, plain.points[i], 1e-7));
});

test("parts: an approved connector that no longer fits is refused", async () => {
  const [a, b] = twoParallelLines();
  const [[p, q]] = cb.connectorEnds([cb.part(a, 0, 3000), cb.part(b, 3000, b.length)], false);
  const approved = { from: cb.latLonOf(p), to: cb.latLonOf(q), points: [[...cb.latLonOf(p), null], [...cb.latLonOf(q), null]] };
  // Part A now ends 200 m further on.
  await assert.rejects(cb.combineParts([cb.part(a, 0, 3200), cb.part(b, 3000, b.length)], fakeRouter, { closed: false, connectors: [approved] }),
    /Connection 1 no longer fits/);
  const parts = [cb.part(a, 0, 3000), cb.part(b, 3000, b.length)];
  await assert.rejects(cb.combineParts(parts, fakeRouter, { closed: false, connectors: [{ ...approved, from: "x" }] }), /no start or end point/);
  await assert.rejects(cb.combineParts(parts, fakeRouter, { closed: false, connectors: [{ ...approved, points: [[1, "x"], [2, 3]] }] }), /has no route/);
});

test("connector: short gaps are joined directly, longer ones routed", async () => {
  const [a, b] = twoParallelLines();
  const direct = await cb.routeConnector(cb.pointAt(a, 1000), cb.pointAt(a, 1010), fakeRouter, 25);
  assert.equal(direct.routed, false);
  assert.equal(calls.length, 0);
  const routed = await cb.routeConnector(cb.pointAt(a, 1000), cb.pointAt(b, 1000), fakeRouter, 25);
  assert.equal(routed.routed, true);
  assert.equal(calls.length, 1);
  approx(cb.legLength(routed.xyz), 800, { abs: 1 });
});

test("parts: two parts of the same route", async () => {
  const [a, b] = twoParallelLines();
  const res = await cb.combineParts([cb.part(a, 0, 2000), cb.part(b, 2000, 4000), cb.part(a, 4000, 6000)], fakeRouter, { closed: false });
  assert.deepEqual(res.legs.map((l) => l.kind), ["a", "connector", "b", "connector", "c"]);
  approx(lengthM(res.points), 2000 + 800 + 2000 + 800 + 2000, { rel: 0.01 });
});

// ------------------------------------------------------------------ connecting parts

test("order parts: an open chain in the order of the connections", () => {
  assert.deepEqual(cb.orderParts(3, [{ from: 2, to: 0 }, { from: 0, to: 1 }]), { order: [2, 0, 1], closed: false });
  assert.deepEqual(cb.orderParts(2, [{ from: 1, to: 0 }]), { order: [1, 0], closed: false });
});

test("order parts: a closed chain starts at part A", () => {
  assert.deepEqual(cb.orderParts(3, [{ from: 1, to: 2 }, { from: 2, to: 0 }, { from: 0, to: 1 }]), { order: [0, 1, 2], closed: true });
  assert.deepEqual(cb.orderParts(3, [{ from: 0, to: 2 }, { from: 2, to: 1 }, { from: 1, to: 0 }]), { order: [0, 2, 1], closed: true });
});

test("order parts: says what is wrong", () => {
  assert.throws(() => cb.orderParts(3, [{ from: 0, to: 1 }]), /Part C is not connected/);
  assert.throws(() => cb.orderParts(2, []), /Part A, B is not connected/);
  assert.throws(() => cb.orderParts(2, [{ from: 0, to: 0 }]), /cannot be connected to itself/);
  assert.throws(() => cb.orderParts(3, [{ from: 0, to: 1 }, { from: 0, to: 2 }]), /end of part A is connected twice/);
  assert.throws(() => cb.orderParts(3, [{ from: 0, to: 2 }, { from: 1, to: 2 }]), /start of part C is connected twice/);
  // A + B form a loop, C + D a chain: two chains.
  assert.throws(() => cb.orderParts(4, [{ from: 0, to: 1 }, { from: 1, to: 0 }, { from: 2, to: 3 }]), /separate chains/);
  // Two loops.
  assert.throws(() => cb.orderParts(4, [{ from: 0, to: 1 }, { from: 1, to: 0 }, { from: 2, to: 3 }, { from: 3, to: 2 }]), /separate chains/);
  assert.throws(() => cb.orderParts(2, [{ from: 0, to: 5 }]), /does not exist/);
  assert.throws(() => cb.orderParts(1, []), /at least two parts/);
});

test("suggest order: the shortest gaps", () => {
  const [a, b] = twoParallelLines();
  const c = cb.makeTrack(east({ northM: 1600, lengthM: 6000 }));
  // Ridden A 0->2000, B 2000->4000, C 4000->6000 has 800 m gaps; any other order is longer.
  const parts = [cb.part(c, 4000, 6000), cb.part(a, 0, 2000), cb.part(b, 2000, 4000)];
  assert.deepEqual(cb.suggestOrder(parts, false), [{ from: 1, to: 2 }, { from: 2, to: 0 }]);
  const loop = cb.suggestOrder([cb.part(a, 1000, 5000), cb.part(b, 5000, 1000)], true);
  assert.deepEqual(loop, [{ from: 0, to: 1 }, { from: 1, to: 0 }]);
  assert.deepEqual(cb.orderParts(3, cb.suggestOrder(parts, true)).order[0], 0);
  assert.throws(() => cb.suggestOrder([parts[0]]), cb.CombineError);
});

test("connectors cross when one route is the wrong way", () => {
  const [a, b] = twoParallelLines();
  assert.equal(cb.connectorsCross([cb.part(a, 1000, 5000), cb.part(b, 1000, 5000)]), true);
  assert.equal(cb.connectorsCross([cb.part(a, 1000, 5000), cb.part(b, 5000, 1000)]), false);
  assert.equal(cb.connectorsCross([cb.part(a, 1000, 5000), cb.part(b, 1000, 5000)], false), false);
});

// ------------------------------------------------------------------ suggestions

test("suggest a single connection at the closest points", () => {
  const a = cb.makeTrack(east({ lengthM: 5000 }));
  const b = cb.makeTrack(linePoints({ start: offset(...START, 300, 2000), lengthM: 3000, stepM: 20, headingDeg: 0 }));
  const [c] = cb.suggestConnections(a, b, 1);
  approx(c.aAt, 2000, { abs: 50 });
  approx(c.bAt, 0, { abs: 50 });
  approx(dist(xy(a, c.aAt), xy(b, c.bAt)), 300, { abs: 10 });
});

test("suggest two connections far apart", () => {
  const [a, b] = twoParallelLines();
  const [c1, c2] = cb.suggestConnections(a, b, 2);
  assert.ok(Math.abs(c1.aAt - c2.aAt) > 1500);
  assert.ok(Math.abs(c1.bAt - c2.bAt) > 1500);
  for (const c of [c1, c2]) approx(dist(xy(a, c.aAt), xy(b, c.bAt)), 800, { abs: 10 });
});

test("suggest a second connection on short routes", () => {
  const a = cb.makeTrack(east({ lengthM: 600 }));
  const b = cb.makeTrack(east({ northM: 100, lengthM: 600 }));
  const [c1, c2] = cb.suggestConnections(a, b, 2, 10);
  assert.ok(Math.abs(c1.aAt - c2.aAt) > 0.25 * a.length);
});

test("suggest parts: loop and point to point", () => {
  const [a, b] = twoParallelLines();
  const [pa, pb] = cb.suggestParts(a, b, true);
  assert.ok(Math.abs(pa.endAt - pa.startAt) > 1500);
  assert.ok((pa.endAt - pa.startAt) * (pb.endAt - pb.startAt) < 0);
  approx(dist(xy(a, pa.endAt), xy(b, pb.startAt)), 800, { abs: 10 });
  approx(dist(xy(b, pb.endAt), xy(a, pa.startAt)), 800, { abs: 10 });
  assert.equal(cb.connectorsCross([pa, pb]), false);
  const [oa, ob] = cb.suggestParts(a, b, false);
  assert.equal(oa.startAt, 0);
  assert.equal(ob.endAt, b.length);
});

/** A route through corner points given as [north, east] metres from START, every 50 m. */
function polyline(corners) {
  const pts = [];
  for (let k = 0; k < corners.length - 1; k++) {
    const [n0, e0] = corners[k], [n1, e1] = corners[k + 1];
    const steps = Math.max(1, Math.round(Math.hypot(n1 - n0, e1 - e0) / 50));
    for (let i = k ? 1 : 0; i <= steps; i++) {
      const t = i / steps;
      pts.push([...offset(...START, n0 + t * (n1 - n0), e0 + t * (e1 - e0)), 10]);
    }
  }
  return pts;
}

// Two square loops from the same start, A to the east and B to the west; their top
// corners are 400 m apart, far from the start.
const loopA = () => cb.makeTrack(polyline([[0, 0], [0, 4000], [4000, 4000], [4000, 200], [0, 0]]), true);
const loopB = () => cb.makeTrack(polyline([[0, 0], [0, -4000], [4000, -4000], [4000, -200], [0, 0]]), true);

test("out on A, back on B: crossing away from the shared start, B ridden in its direction", async () => {
  const a = loopA(), b = loopB();
  const [pa, pb] = cb.suggestParts(a, b, "outback");
  // A from its start to the crossing, B from the crossing on to its end = its (shared) start.
  assert.equal(pa.startAt, 0);
  assert.equal(pa.otherWay, false);
  assert.equal(pb.endAt, 0);
  assert.equal(pb.otherWay, true);
  assert.ok(cb.withRoute(pa) && cb.withRoute(pb));
  // The crossing is where the routes come closest (at most the 400 m between the top
  // corners), but not near the shared start (at least 20 % of each loop away from it).
  const gap = dist(xy(a, pa.endAt), xy(b, pb.startAt));
  assert.ok(gap <= 400 + 1, `gap ${gap}`);
  const fromStart = (t, at) => Math.min(at, t.length - at);
  assert.ok(fromStart(a, pa.endAt) > 0.2 * a.length);
  assert.ok(fromStart(b, pb.startAt) > 0.2 * b.length);

  const res = await cb.combineParts([pa, pb], fakeRouter, { closed: true });
  const conns = cb.connectorsOf(res);
  assert.equal(conns.length, 2);
  assert.equal(conns[1].routed, false); // already back at the start: joined directly
  assert.equal(calls.length, 1); // only the crossing is routed
  // A up to the crossing + the crossing + the rest of B (projected metres ~ ground metres).
  approx(lengthM(res.points), pa.endAt + gap + (b.length - pb.startAt), { rel: 0.02 });
  approxLL(res.points[0], res.points[res.points.length - 1], 1e-5);
  approxLL(res.points[0], cb.latLonOf(cb.pointAt(a, 0)), 1e-5);
});

test("out on A, back on B: a route B that isn't a loop is ridden backwards to its start", () => {
  const a = loopA();
  const b = cb.makeTrack(polyline([[0, 0], [0, -4000], [4000, -4000], [4000, -200]]), false);
  const [, pb] = cb.suggestParts(a, b, "outback");
  assert.equal(pb.otherWay, false);
  assert.equal(pb.endAt, 0);
  assert.equal(cb.withRoute(pb), false);
});

test("out on A, back on B: short routes still cross away from their starts", () => {
  const a = cb.makeTrack(east({ lengthM: 600 }));
  const b = cb.makeTrack(east({ northM: 100, lengthM: 600 }));
  const c = cb.suggestCrossover(a, b, 10);
  assert.ok(c.aAt > 0.4 * a.length - 10 && c.bAt > 0.4 * b.length - 10);
});

test("straight router", async () => {
  assert.deepEqual(await cb.straightRouter([51.0, 4.4], [51.1, 4.5]), [[51.0, 4.4, null], [51.1, 4.5, null]]);
});

// ---------------------------------------------------------------- new start point

test("restart a loop: starts and ends at the new point", () => {
  const track = cb.makeTrack(loopPoints({ radiusM: 2000, n: 400 }), true);
  const at = track.length / 4;
  const pts = cb.restartLoop(track, at);
  const start = cb.pointAt(track, at);
  assert.ok(dist(pts[0], start) < 0.01);
  assert.ok(dist(pts[pts.length - 1], start) < 0.01);
  approx(cb.legLength(pts), track.length, { rel: 0.001 });
  assert.ok(locateXY(track, pts[5]) > at, "same riding direction");
});

test("restart a loop: reverse, and at the ends", () => {
  const track = cb.makeTrack(loopPoints({ radiusM: 2000, n: 400 }), true);
  const at = track.length / 3;
  const fwd = cb.restartLoop(track, at);
  const rev = cb.restartLoop(track, at, true);
  rev.slice().reverse().forEach((p, i) => approxLL(p, fwd[i], 1e-6));
  assert.ok(locateXY(track, rev[5]) < at);
  for (const d of [0, track.length]) approx(cb.legLength(cb.restartLoop(track, d)), track.length, { rel: 0.001 });
});

test("restart only for loops", () => {
  const track = cb.makeTrack(linePoints({ lengthM: 3000 }), false);
  assert.throws(() => cb.restartLoop(track, 1000), cb.CombineError);
});

test("cumulative helper matches track length", () => {
  const t = cb.makeTrack(east({ lengthM: 1000 }));
  approx(cumulative(t.xyz)[t.xyz.length - 1], t.length);
});
