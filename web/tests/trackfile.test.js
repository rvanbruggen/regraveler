import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { decodeFit, parseFit } from "../js/fit.js";
import { GpxError } from "../js/gpx.js";
import { computeStats } from "../js/stats.js";
import { parseTcx } from "../js/tcx.js";
import { detectFormat, formatOfName, isTrackFileName, parseTrackFile, unwrapFile } from "../js/trackfile.js";
import { approx, fitFile, gpxXml, linePoints, tcxXml } from "./helpers.js";

const pts = linePoints({ lengthM: 2000, stepM: 20, ele: (d) => 10 + d / 100 });

function samePoints(got, want) {
  assert.equal(got.length, want.length);
  for (let i = 0; i < want.length; i += 7) {
    approx(got[i][0], want[i][0], { abs: 1e-6 });
    approx(got[i][1], want[i][1], { abs: 1e-6 });
    approx(got[i][2], want[i][2], { abs: 0.2 }); // FIT altitude is in steps of 0.2 m
  }
}

// ------------------------------------------------------------------ FIT

test("FIT: a Wahoo-style activity (little-endian, developer fields)", () => {
  const p = parseFit(fitFile(pts, { devFields: true }));
  assert.equal(p.format, "fit");
  assert.equal(p.kind, "activity");
  assert.equal(p.activity, null); // plain cycling: the batch's activity decides
  assert.equal(p.started_at, "2026-09-14T08:00:00.000Z");
  assert.equal(p.crc_ok, true);
  samePoints(p.tracks[0].points, pts);
});

test("FIT: a Garmin-style run (big-endian, enhanced altitude)", () => {
  const p = parseFit(fitFile(pts, { bigEndian: true, sport: 1, enhancedAltitude: true }));
  assert.equal(p.activity, "hiking");
  samePoints(p.tracks[0].points, pts);
});

test("FIT: compressed timestamps, records without a position, missing altitude", () => {
  const withGaps = pts.map((q, i) => (i === 5 ? [q[0], q[1], null] : q));
  const times = [];
  decodeFit(fitFile(withGaps, { compressed: true }), (msg, f) => msg === 20 && times.push(f[253]));
  // Every record has a time, one second apart, also those with a compressed header.
  assert.equal(times.length, pts.length);
  assert.ok(times.every((t, i) => !i || t === times[i - 1] + 1));

  const p = parseFit(fitFile(withGaps, { compressed: true, noPositionAt: [0, 10, 11] }));
  assert.equal(p.tracks[0].points.length, pts.length - 3);
  assert.equal(p.tracks[0].points[4][2], null); // point 5 (4 after dropping point 0) has no altitude
});

test("FIT: a course has its name, and the sub-sport picks the activity", () => {
  const p = parseFit(fitFile(pts, { fileType: 6, courseName: "Kempen loop", subSport: 46 }));
  assert.equal(p.kind, "course");
  assert.equal(p.name, "Kempen loop");
  assert.equal(p.tracks[0].name, "Kempen loop");
  assert.equal(p.activity, "gravel");
  assert.equal(parseFit(fitFile(pts, { subSport: 8 })).activity, "mtb");
  assert.equal(parseFit(fitFile(pts, { subSport: 7 })).activity, "road");
});

test("FIT: a bad checksum is reported but the ride is still read; a cut-off file keeps what it has", () => {
  const bad = parseFit(fitFile(pts, { fixCrc: false }));
  assert.equal(bad.crc_ok, false);
  assert.equal(bad.tracks[0].points.length, pts.length);
  const full = fitFile(pts);
  const cut = parseFit(full.slice(0, full.length - 200));
  assert.equal(cut.crc_ok, false);
  assert.ok(cut.tracks[0].points.length > pts.length / 2);
});

test("FIT: not FIT, or no positions", () => {
  assert.throws(() => parseFit(new TextEncoder().encode("hello world, not a fit file")), GpxError);
  assert.throws(() => parseFit(fitFile(pts.slice(0, 3), { noPositionAt: [0, 1] })), /no track/);
});

// ------------------------------------------------------------------ TCX

test("TCX: an activity over several laps, skipping trackpoints without a position", () => {
  const p = parseTcx(tcxXml(pts, { laps: 3, noPositionAt: [0, 50] }));
  assert.equal(p.format, "tcx");
  assert.equal(p.kind, "activity");
  assert.equal(p.activity, null);
  assert.equal(p.started_at, "2026-09-14T08:00:00.000Z");
  assert.equal(p.tracks.length, 1);
  assert.equal(p.tracks[0].points.length, pts.length - 2);
  assert.equal(parseTcx(tcxXml(pts, { sport: "Running" })).activity, "hiking");
});

test("TCX: a course", () => {
  const p = parseTcx(tcxXml(pts, { course: "Rondje Mol" }));
  assert.equal(p.kind, "course");
  assert.equal(p.name, "Rondje Mol");
  samePoints(p.tracks[0].points, pts);
});

// ------------------------------------------------------------------ any format

test("the format is recognised from the content, not the name", () => {
  assert.equal(detectFormat(fitFile(pts)), "fit");
  assert.equal(detectFormat(tcxXml(pts)), "tcx");
  assert.equal(detectFormat(gpxXml([["t", pts]])), "gpx");
  assert.equal(detectFormat(new Uint8Array(gzipSync(fitFile(pts)))), "gzip");
  for (const data of [fitFile(pts), tcxXml(pts), gpxXml([["t", pts]])]) {
    samePoints(parseTrackFile(data).tracks[0].points, pts);
  }
  assert.equal(parseTrackFile(gpxXml([["t", pts]])).kind, null);
  assert.throws(() => parseTrackFile(new TextEncoder().encode("<html></html>")), GpxError);
});

test("file names and gzip", async () => {
  assert.ok(isTrackFileName("Ride.FIT") && isTrackFileName("a.tcx.gz") && isTrackFileName("r.gpx"));
  assert.ok(!isTrackFileName("notes.txt") && !isTrackFileName("x.zip"));
  assert.equal(formatOfName("Morning.fit.gz"), "fit");
  const raw = fitFile(pts);
  const { data, name } = await unwrapFile(new Uint8Array(gzipSync(raw)), "12345.fit.gz");
  assert.equal(name, "12345.fit");
  assert.deepEqual(data, raw);
  const same = await unwrapFile(raw, "a.fit");
  assert.equal(same.data, raw);
});

test("a FIT ride gives the same stats as the same ride in GPX", () => {
  const a = computeStats(parseTrackFile(fitFile(pts)).tracks[0].points);
  const b = computeStats(parseTrackFile(gpxXml([["t", pts]])).tracks[0].points);
  approx(a.distance_km, b.distance_km, { abs: 0.001 });
  approx(a.elevation_gain_m, b.elevation_gain_m, { abs: 1 });
});
