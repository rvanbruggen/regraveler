import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { config } from "../js/config.js";
import { Library, MemoryBackend } from "../js/db.js";
import * as places from "../js/places.js";
import * as svc from "../js/service.js";
import { allStations, connections, planCandidates, setStationsLoader, stationsNear, transitousId } from "../js/trains.js";
import { gpxXml, linePoints, loopPoints, offset } from "./helpers.js";

const HOME = [50.88, 4.70];
const at = (n, e) => offset(...HOME, n, e);
// Stations: one at home, one 20 km east (E), one 30 km north (N), one 40 km north-east (NE),
// a Dutch one without a derivable id (Breda-ish).
const STATIONS = [
  ["Thuis", ...at(800, 0), "8833001"],
  ["Oost", ...at(0, 20000), "8831401"],
  ["Noord", ...at(30000, 0), "8821006"],
  ["Noordoost", ...at(40000, 40000), "8821717"],
  ["Breda", 51.595, 4.780, "8400131"],
];

beforeEach(async () => {
  svc.setLibrary(await Library.open(new MemoryBackend()));
  places.setPlacesLoader(async () => [], []);
  places.setAdminLoader(async () => ({ regions: {}, provinces: {} }));
  setStationsLoader(async () => STATIONS);
  config.AUTO_RENAME_ON_IMPORT = false;
  config.SURFACE_AUTO_ESTIMATE = false;
});

/** A straight route from a to b (metres from HOME), or a loop around a centre. */
function line(fromN, fromE, toN, toE) {
  const len = Math.hypot(toN - fromN, toE - fromE);
  const heading = (Math.atan2(toE - fromE, toN - fromN) * 180) / Math.PI;
  return linePoints({ start: at(fromN, fromE), lengthM: len, stepM: 200, headingDeg: heading, ele: () => 10 });
}

async function add(name, pts) {
  const { routes } = await svc.importGpx(gpxXml([["t", pts]]), `${name}.gpx`);
  return svc.route(routes[0].id);
}

test("stations near a point, and the timetable id of a station", async () => {
  const list = await allStations();
  assert.deepEqual(stationsNear(list, ...at(0, 19500), 2000).map((x) => x.station.name), ["Oost"]);
  assert.equal(await transitousId(list[1]), "be-sncb_S8831401", "Belgian: from the UIC code");
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    return { ok: true, status: 200, json: async () => [
      { type: "STOP", id: "nl-far", lat: 51.7, lon: 4.9 },
      { type: "STOP", id: "nl-OpenOV_stoparea:17911", lat: 51.5951, lon: 4.7802 },
    ] };
  };
  assert.equal(await transitousId(list[4], { fetchFn }), "nl-OpenOV_stoparea:17911", "elsewhere: looked up by name, the nearest");
  assert.match(asked[0], /geocode\?text=Breda&type=STOP&place=51\.595,4\.78/);
});

test("candidates for the four patterns, from library routes", async () => {
  const list = await allStations();
  const home = { lat: HOME[0], lon: HOME[1] };
  const homeStation = list[0];
  const out = await add("Out", line(0, 1000, 0, 19800)); // from home to Oost
  const inn = await add("In", line(30000, 300, 1000, 0)); // from Noord home
  const both = await add("Both", line(29800, 0, 40000, 39700)); // Noord to Noordoost
  const loop = await add("Loop", loopPoints({ center: at(0, 22000), radiusM: 2000, n: 200 }).map(([la, lo]) => [la, lo, 5])); // past Oost
  const near = await add("Near", loopPoints({ center: at(0, 2000), radiusM: 1500, n: 100 }).map(([la, lo]) => [la, lo, 5])); // by home
  const c = planCandidates(svc.library().all(), list, { home, homeStation, maxStationM: 3000, homeReachM: 5000 });
  const got = Object.fromEntries(c.map((x) => [`${x.pattern}:${x.route_id}`, x]));
  assert.equal(got[`ride-out:${out.id}`].to.name, "Oost");
  assert.equal(got[`ride-out:${out.id}`].reversed, false);
  // The same route ridden the other way round: train out to Oost, ride home.
  assert.deepEqual([got[`train-out:${out.id}`].from.name, got[`train-out:${out.id}`].reversed], ["Oost", true]);
  assert.equal(got[`train-out:${inn.id}`].from.name, "Noord");
  assert.deepEqual([got[`train-both:${both.id}`].from.name, got[`train-both:${both.id}`].to.name], ["Noord", "Noordoost"]);
  assert.equal(got[`loop:${loop.id}`].from.name, "Oost");
  assert.ok(got[`loop:${loop.id}`].start_at_m >= 0);
  assert.ok(!c.some((x) => x.route_id === near.id), "a loop by home is no train ride");
  // Only some patterns, and a km range.
  const some = planCandidates(svc.library().all(), list, { home, homeStation, patterns: ["loop"], minKm: 5, maxKm: 20 });
  assert.deepEqual(some.map((x) => x.pattern), ["loop"]);
  assert.ok(some[0].ride_km >= 12 && some[0].ride_km <= 20);
});

const iso = (h, m) => new Date(2026, 9, 3, h, m).toISOString();
function transitous(itineraries) {
  return async (url) => ({ ok: true, status: 200, json: async () => ({ itineraries: itineraries(url) }) });
}

test("connections: trains with their times, the transfers limited here, iRail when Transitous fails", async () => {
  const [, oost, noord] = await allStations();
  const fetchFn = transitous(() => [
    { startTime: iso(9, 5), endTime: iso(9, 50), duration: 2700, transfers: 0, legs: [{ mode: "REGIONAL_RAIL", routeShortName: "IC 1507", from: { name: "Oost" }, to: { name: "Noord" }, startTime: iso(9, 5), endTime: iso(9, 50) }] },
    { startTime: iso(8, 40), endTime: iso(9, 55), duration: 4500, transfers: 2, legs: [{ mode: "WALK" }, { mode: "RAIL", routeShortName: "L 1", from: { name: "Oost" }, to: { name: "X" }, startTime: iso(8, 40), endTime: iso(9, 0) }] },
  ]);
  const c = await connections(oost, noord, new Date(2026, 9, 3, 8, 30), { maxTransfers: 1, fetchFn });
  assert.equal(c.length, 1, "2 transfers is more than allowed");
  assert.deepEqual([c[0].trains, c[0].minutes, c[0].transfers, c[0].dep.getHours()], [["IC 1507"], 45, 0, 9]);

  // Transitous down: iRail, for two Belgian stations.
  const dep = Math.round(new Date(2026, 9, 3, 10, 0).getTime() / 1000);
  const urls = [];
  const iRailFallback = async (url) => {
    urls.push(url);
    if (url.includes("transitous")) return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ connection: [
      { departure: { time: String(dep), vehicleinfo: { shortname: "IC 2129" } }, arrival: { time: String(dep + 3600) }, vias: { number: "1", via: [{ departure: { vehicleinfo: { shortname: "S33 2960" } } }] } },
    ] }) };
  };
  const c2 = await connections(oost, noord, new Date(2026, 9, 3, 9, 30), { fetchFn: iRailFallback });
  assert.deepEqual([c2[0].trains, c2[0].transfers, c2[0].minutes], [["IC 2129", "S33 2960"], 1, 60]);
  assert.match(urls[1], /irail\.be\/v1\/connections\/\?from=BE\.NMBS\.008831401&to=BE\.NMBS\.008821006.*date=031026&time=0930&timesel=departure/);
  // Not Belgian on both sides: no fallback, the error stays.
  const [, , , , breda] = await allStations();
  await assert.rejects(connections(oost, breda, new Date(), { fetchFn: iRailFallback }), /Could not find|Transitous/);
});

test("a day out: leave home, the train, the ride, the train home, and back at home", async () => {
  await svc.setHome({ lat: HOME[0], lon: HOME[1] });
  const loop = await add("Loop Oost", loopPoints({ center: at(0, 22000), radiusM: 3000, n: 300 }).map(([la, lo]) => [la, lo, 5]));
  // Trains every hour at :10 (out) and :40 (back), 30 minutes, no transfers.
  const fetchFn = transitous((url) => {
    const t = new Date(new URL(url).searchParams.get("time"));
    const out = new URL(url).searchParams.get("fromPlace").endsWith("8833001");
    const next = new Date(t);
    next.setMinutes(out ? 10 : 40, 0, 0);
    if (next < t) next.setHours(next.getHours() + 1);
    const arr = new Date(next.getTime() + 30 * 60000);
    return [{ startTime: next.toISOString(), endTime: arr.toISOString(), duration: 1800, transfers: 0,
      legs: [{ mode: "RAIL", routeShortName: out ? "IC 1" : "IC 2", from: { name: "a" }, to: { name: "b" }, startTime: next.toISOString(), endTime: arr.toISOString() }] }];
  });
  const res = await svc.trainRides({ date: "2026-10-03", start: "08:00", speed_kmh: 20, patterns: ["loop"] }, { fetchFn });
  assert.equal(res.home_station, "Thuis");
  assert.equal(res.trips.length, 1);
  const t = res.trips[0];
  assert.equal(t.route_name, "Loop Oost");
  assert.deepEqual(t.legs.map((l) => l.kind), ["ride", "train", "ride", "train", "ride"]);
  // 1 km to the station (3 min at 20 km/h), train at 08:10 (10 min margin: 08:13 → the 09:10),
  // ride the loop (~19 km, ~57 min), train back at the next :40, 1 km home.
  const hm = (d) => d.toTimeString().slice(0, 5);
  assert.equal(hm(t.legs[1].conn.dep), "09:10");
  assert.equal(hm(t.legs[2].start), "09:40");
  assert.ok(t.legs[3].conn.dep >= new Date(t.legs[2].end.getTime() + 10 * 60000));
  assert.equal(t.back, t.legs[4].end);
  assert.ok(t.day_hours > 3 && t.day_hours < 5, `${t.day_hours} h`);

  // The riding part as a route: station → loop from there → station (straight connectors).
  const gpx = await svc.trainTripGpx(t, "Treinrit", { straight: true });
  assert.match(gpx.text, /Train ride: Loop Oost, from Oost to Oost \(IC 1 Thuis → Oost; IC 2 Oost → Thuis\)/);
  const saved = await svc.trainTripSave(t, "Treinrit", { straight: true });
  assert.deepEqual(svc.route(saved.id).derived_from, [loop.id]);
  assert.ok(svc.route(saved.id).tags.includes("train"));

  await svc.setHome(null);
  await assert.rejects(svc.trainRides({ date: "2026-10-03" }, { fetchFn }), /Set your home first/);
});
