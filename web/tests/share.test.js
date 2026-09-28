import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { config } from "../js/config.js";
import { Library, MemoryBackend } from "../js/db.js";
import * as places from "../js/places.js";
import * as svc from "../js/service.js";
import { cutPrivacy, decodePolyline, encodePolyline, packShare, unpackShare } from "../js/share.js";
import { approx, gpxXml, linePoints, offset, rng } from "./helpers.js";

const START = [51.0, 4.4];

beforeEach(async () => {
  svc.setLibrary(await Library.open(new MemoryBackend()));
  places.setPlacesLoader(async () => [], []);
  places.setAdminLoader(async () => ({ regions: {}, provinces: {} }));
  config.AUTO_RENAME_ON_IMPORT = false;
  config.SURFACE_AUTO_ESTIMATE = false;
});

test("polyline: positions to about a metre, elevation in metres, missing elevation kept as the last", () => {
  const pts = [[51.123456, 4.654321, 12.4], [51.12346, 4.65433, null], [50.9, -0.1, -3.6]];
  const back = decodePolyline(encodePolyline(pts));
  assert.deepEqual(back, [[51.12346, 4.65432, 12], [51.12346, 4.65433, 12], [50.9, -0.1, -4]]);
  assert.throws(() => decodePolyline(encodePolyline(pts).slice(0, -2)), /damaged/);
});

test("pack and unpack: a long route is simplified until the link is short enough", async () => {
  const pts = linePoints({ start: START, lengthM: 150000, stepM: 20, headingDeg: 60, ele: (d) => 20 + 30 * Math.sin(d / 3000) });
  // GPS-like wiggles (seeded), so simplifying has something to remove.
  const rand = rng(7);
  const zig = pts.map(([la, lo, e]) => [la + (rand() - 0.5) * 0.0002, lo + (rand() - 0.5) * 0.0003, e + rand() * 3]);
  const route = { name: "Lange rit", activity: "gravel", distance_km: 150, elevation_gain_m: 700, is_loop: false,
    surface: { paved_km: 100, unpaved_km: 50, cobbles_km: 0, unknown_km: 0, segments: [["paved", zig.map(([a, b]) => [a, b])]] },
    notes: "Mooi", source_url: "https://x.example/r", points: zig };
  const small = await packShare(route, { target: 3000 });
  assert.ok(small.packed.length <= 3000, `${small.packed.length} chars`);
  assert.ok(small.tolerance_m > 5);
  assert.match(small.packed, /^[A-Za-z0-9_-]+$/, "URL-safe");
  const back = await unpackShare(small.packed);
  assert.deepEqual([back.name, back.activity, back.distance_km, back.notes, back.source_url], ["Lange rit", "gravel", 150, "Mooi", "https://x.example/r"]);
  assert.deepEqual(back.surface, { paved_km: 100, cobbles_km: 0, unpaved_km: 50, unknown_km: 0 }, "no map segments in a link");
  assert.deepEqual(back.points[0].slice(0, 2), [Math.round(zig[0][0] * 1e5) / 1e5, Math.round(zig[0][1] * 1e5) / 1e5]);
  await assert.rejects(unpackShare(small.packed.slice(0, 100)), /damaged/);
  await assert.rejects(unpackShare("not-a-link"), /damaged/);
});

test("the privacy zone: the start and end near home are left out, not the middle", () => {
  const home = { lat: START[0], lon: START[1] };
  // Out 5 km east, back again, past home in the middle? No: a loop from home.
  const out = linePoints({ start: START, lengthM: 5000, stepM: 50, ele: () => 1 });
  const back = [...out].reverse();
  const loop = [...out, ...back.slice(1)];
  const res = cutPrivacy(loop, home, 500);
  approx(res.cut_start_m, 500, { abs: 60 });
  approx(res.cut_end_m, 500, { abs: 60 });
  assert.ok(res.points.every(([la, lo]) => Math.hypot((la - home.lat) * 111000, (lo - home.lon) * 70000) > 400));
  assert.equal(cutPrivacy(loop, null, 500).points, loop, "no home: nothing left out");
  assert.throws(() => cutPrivacy(out.slice(0, 5), home, 500), /nothing to share/);
});

test("share a library route: link to the public site, privacy, notes on request; open it and add it", async () => {
  const out = linePoints({ start: START, lengthM: 8000, stepM: 50, ele: (d) => 10 + d / 200 });
  const { routes: [r] } = await svc.importGpx(gpxXml([["t", out]]), "Rondje.gpx", { notes: "Geheime tip", source_url: "https://src.example/1" });
  await svc.updateRoute(r.id, { name: "Rondje" });

  const plain = await svc.shareRoute(r.id);
  assert.match(plain.link, /^https:\/\/rerouter\.eu\/#share=[A-Za-z0-9_-]+$/);
  assert.equal(plain.cut_start_m, 0, "no home set: nothing to cut");
  const shared = await unpackShare(plain.link.split("#share=")[1]);
  assert.deepEqual([shared.name, shared.notes, shared.source_url], ["Rondje", null, null], "notes and source only when asked");
  approx(shared.distance_km, 8, { abs: 0.05 });

  await svc.setHome({ lat: START[0], lon: START[1] });
  assert.equal(svc.home().radius_m, 500);
  const priv = await svc.shareRoute(r.id, { notes: true, source: true, base: "http://localhost:8125/index.html#view=map" });
  assert.match(priv.link, /^http:\/\/localhost:8125\/index\.html#share=/);
  approx(priv.cut_start_m, 500, { abs: 60 });
  const s2 = await unpackShare(priv.link.split("#share=")[1]);
  assert.deepEqual([s2.notes, s2.source_url], ["Geheime tip", "https://src.example/1"]);
  approx(s2.distance_km, 7.5, { abs: 0.1 });
  assert.equal((await svc.shareRoute(r.id, { privacy: false })).cut_start_m, 0, "privacy can be switched off");

  // The receiver: a GPX, and the route in their library (once).
  const gpx = svc.sharedGpx(s2);
  assert.equal(gpx.filename, "rondje.gpx");
  svc.setLibrary(await Library.open(new MemoryBackend()));
  const added = await svc.addSharedRoute(s2);
  const got = svc.route(added.id);
  assert.deepEqual([got.name, got.source_name, got.source_url, got.notes], ["Rondje", "shared link", "https://src.example/1", "Geheime tip"]);
  await assert.rejects(svc.addSharedRoute(s2), /already have this route/);
  await assert.rejects(svc.setHome({ lat: 51, lon: 4, radius_m: 99999 }), /0 to 5000/);
});
