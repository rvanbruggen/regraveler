import { test } from "node:test";
import assert from "node:assert/strict";

import { GpxError, parseGpx, writeGpx } from "../js/gpx.js";
import { computeStats, gainLoss } from "../js/stats.js";
import { approx, gpxXml, linePoints, loopPoints, offset, rng } from "./helpers.js";

// ------------------------------------------------------------------ parsing

test("parse joins segments and splits tracks", () => {
  const a = linePoints({ lengthM: 1000 });
  const b = linePoints({ start: [51.1, 4.4], lengthM: 1000 });
  const parsed = parseGpx(gpxXml([["First", [a.slice(0, 50), a.slice(50)]], ["Second", b]], { link: "https://example.org/r" }));
  assert.deepEqual(parsed.tracks.map((t) => t.name), ["First", "Second"]);
  assert.equal(parsed.tracks[0].points.length, a.length);
  assert.equal(parsed.link, "https://example.org/r");
});

test("parse skips tracks with fewer than two points", () => {
  const data = gpxXml([["Tiny", [[51.0, 4.4, 10.0]]], ["Real", linePoints({ lengthM: 100 })]]);
  assert.deepEqual(parseGpx(data).tracks.map((t) => t.name), ["Real"]);
});

test("parse falls back to routes", () => {
  const parsed = parseGpx(gpxXml([["Planned", linePoints({ lengthM: 500 })]], { useRoute: true }));
  assert.equal(parsed.tracks[0].name, "Planned");
});

test("parse handles a byte order mark", () => {
  const body = gpxXml([["T", linePoints({ lengthM: 100 })]]);
  const data = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
  assert.equal(parseGpx(data).tracks.length, 1);
});

test("parse handles prefixes, comments, CDATA and entities", () => {
  const xml = `<?xml version="1.0"?><!-- exported --><g:gpx xmlns:g="http://www.topografix.com/GPX/1/1">
    <g:trk><g:name><![CDATA[Bos & Heide]]></g:name><g:trkseg>
    <g:trkpt lat='51.0' lon='4.4'><g:ele>10</g:ele></g:trkpt><g:trkpt lat="51.001" lon="4.4"/>
    </g:trkseg></g:trk><g:wpt lat="51" lon="4"><g:link href="https://x.org/?a=1&amp;b=2"/></g:wpt></g:gpx>`;
  const parsed = parseGpx(xml);
  assert.equal(parsed.tracks[0].name, "Bos & Heide");
  assert.deepEqual(parsed.tracks[0].points, [[51.0, 4.4, 10], [51.001, 4.4, null]]);
  assert.equal(parsed.link, "https://x.org/?a=1&b=2");
});

for (const [label, data] of [["not xml", "not xml"], ["empty gpx", "<gpx></gpx>"], ["empty track", gpxXml([["Empty", []]])]]) {
  test(`parse rejects unusable files: ${label}`, () => {
    assert.throws(() => parseGpx(data), GpxError);
  });
}

test("written GPX reads back", () => {
  const pts = linePoints({ lengthM: 200, ele: (d) => d / 10 });
  const back = parseGpx(writeGpx("A & B <test>", pts, "desc"));
  assert.equal(back.tracks[0].name, "A & B <test>");
  assert.equal(back.tracks[0].points.length, pts.length);
  approx(back.tracks[0].points[5][0], pts[5][0], { abs: 1e-7 });
  approx(back.tracks[0].points[5][2], pts[5][2], { abs: 0.05 });
});

// ------------------------------------------------------------------ distance

test("distance of one degree latitude", () => {
  approx(computeStats([[0, 0, null], [1, 0, null]]).distance_km, 110.574, { abs: 0.01 });
});

test("distance of a straight line", () => {
  approx(computeStats(linePoints({ lengthM: 5000, stepM: 10 })).distance_km, 5.0, { rel: 0.005 });
});

test("repeated points do not break stats", () => {
  const pts = linePoints({ lengthM: 1000, ele: (d) => d / 10 }).flatMap((p) => [p, p]);
  const st = computeStats(pts);
  approx(st.distance_km, 1.0, { rel: 0.01 });
  approx(st.elevation_gain_m, 100, { abs: 2 });
});

test("a route needs two points", () => {
  assert.throws(() => computeStats([[51.0, 4.4, 1.0]]), GpxError);
});

// ------------------------------------------------------------------ elevation

test("climb and descent", () => {
  const ele = (d) => (d <= 5000 ? d / 50 : 100 - (d - 5000) / 50);
  const st = computeStats(linePoints({ lengthM: 10000, ele }));
  approx(st.elevation_gain_m, 100, { abs: 3 });
  approx(st.elevation_loss_m, 100, { abs: 3 });
  approx(st.max_elevation_m, 100, { abs: 3 });
  approx(st.min_elevation_m, 0, { abs: 1 });
});

test("GPS noise on a flat route is not counted as climbing", () => {
  // (The Python and JS stats give identical results for identical points; the noise differs
  // because the random generators differ.)
  const r = rng(1);
  const pts = linePoints({ lengthM: 20000, stepM: 5, ele: () => 10 + (r() * 3 - 1.5) });
  let raw = 0;
  for (let i = 1; i < pts.length; i++) raw += Math.max(0, pts[i][2] - pts[i - 1][2]);
  const st = computeStats(pts);
  assert.ok(raw > 1000, "the noise alone would add > 1 km of climbing");
  assert.ok(st.elevation_gain_m < 20, `gain ${st.elevation_gain_m}`);
});

test("real hills survive noise", () => {
  const r = rng(1);
  const hill = (d) => (30 * (1 - Math.cos((2 * Math.PI * d) / 4000))) / 2;
  const st = computeStats(linePoints({ lengthM: 20000, stepM: 5, ele: (d) => hill(d) + (r() * 2 - 1) }));
  approx(st.elevation_gain_m, 150, { rel: 0.1 });
});

test("sparse points are resampled, not skipped", () => {
  const st = computeStats(linePoints({ lengthM: 10000, stepM: 500, ele: (d) => d / 50 }));
  approx(st.elevation_gain_m, 200, { abs: 3 });
});

test("missing elevation everywhere", () => {
  const st = computeStats(linePoints({ lengthM: 1000 }));
  assert.equal(st.elevation_gain_m, null);
  assert.equal(st.elevation_loss_m, null);
  assert.equal(st.min_elevation_m, null);
});

test("missing elevation is interpolated", () => {
  const pts = linePoints({ lengthM: 2000, ele: (d) => d / 20 }).map(([la, lo, e], i) => [la, lo, i % 3 === 0 ? e : null]);
  approx(computeStats(pts).elevation_gain_m, 100, { abs: 3 });
});

test("gain/loss hysteresis", () => {
  assert.deepEqual(gainLoss([0, 0.5, 0, 0.5, 0], 1), [0, 0]);
  assert.deepEqual(gainLoss([0, 10, 0], 1), [10, 10]);
  const [gain, loss] = gainLoss([0, 5, 5.5], 1); // the last partial climb still counts
  approx(gain, 5.5);
  assert.equal(loss, 0);
});

// ------------------------------------------------------------------ loop / bbox / geometry

test("loop detection", () => {
  assert.equal(computeStats(loopPoints()).is_loop, true);
});

for (const [gap, expected] of [[150, true], [300, false]]) {
  test(`loop threshold: ${gap} m gap`, () => {
    const pts = linePoints({ lengthM: 3000, headingDeg: 0 });
    const back = linePoints({ start: pts[pts.length - 1].slice(0, 2), lengthM: 3000, headingDeg: 180 })
      .slice(1)
      .map(([la, lo, e]) => [...offset(la, lo, 0, gap), e]);
    assert.equal(computeStats([...pts, ...back]).is_loop, expected);
  });
}

test("bbox and end points", () => {
  const pts = linePoints({ start: [51.0, 4.4], lengthM: 1000, headingDeg: 45 });
  const st = computeStats(pts);
  const last = pts[pts.length - 1];
  approx(st.start_lat, pts[0][0]);
  approx(st.end_lon, last[1]);
  approx(st.min_lat, 51.0);
  approx(st.min_lon, 4.4);
  approx(st.max_lat, last[0]);
  approx(st.max_lon, last[1]);
});

test("simplified geometry keeps shape and end points", () => {
  const pts = linePoints({ lengthM: 5000, stepM: 10 });
  const st = computeStats(pts);
  assert.ok(st.geometry.length < 10, "a straight line needs only its end points");
  approx(st.geometry[0][0], pts[0][0], { abs: 1e-5 });
  approx(st.geometry[st.geometry.length - 1][1], pts[pts.length - 1][1], { abs: 1e-5 });
  const circle = computeStats(loopPoints({ n: 400 })).geometry;
  assert.ok(circle.length > 20 && circle.length <= 401);
});
