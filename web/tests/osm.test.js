import { test } from "node:test";
import assert from "node:assert/strict";

import { config } from "../js/config.js";
import { OverpassUnavailable, runQuery } from "../js/osm.js";
import { osmCategory, osmPlaces, overpassQuery, routeBoxes } from "../js/poi.js";

const ANSWER = {
  elements: [
    { type: "node", id: 1, lat: 51.0, lon: 4.4, tags: { amenity: "drinking_water" } },
    { type: "way", id: 2, center: { lat: 51.01, lon: 4.41 }, tags: { amenity: "fast_food", cuisine: "friture", name: "Frituur Nr 1", opening_hours: "Mo-Su 11:00-22:00" } },
    { type: "node", id: 3, lat: 51.02, lon: 4.42, tags: { amenity: "cafe", name: "Koffie", website: "https://koffie.example" } },
    { type: "node", id: 4, lat: 51.03, lon: 4.43, tags: { railway: "station", station: "subway", name: "Metro" } },
    { type: "node", id: 5, tags: { amenity: "toilets" } }, // no position
  ],
};

test("OSM tags to categories, and places from an answer", () => {
  assert.equal(osmCategory({ amenity: "fast_food", cuisine: "burger;fries" }), "frituur");
  assert.equal(osmCategory({ amenity: "fast_food", cuisine: "pizza" }), "food");
  assert.equal(osmCategory({ shop: "bicycle" }), "bike");
  assert.equal(osmCategory({ historic: "castle" }), "castle");
  assert.equal(osmCategory({ historic: "castle", tourism: "attraction" }), "castle", "before sight");
  assert.equal(osmCategory({ amenity: "monastery" }), "abbey");
  assert.equal(osmCategory({ tourism: "museum" }), "sight");
  assert.equal(osmCategory({ railway: "station", station: "subway" }), null);
  assert.equal(osmCategory({ amenity: "parking" }), null);
  assert.equal(osmCategory({ amenity: "shelter", shelter_type: "public_transport" }), null, "a bus shelter");
  assert.equal(osmCategory({ amenity: "shelter", shelter_type: "picnic_shelter" }), "shelter");
  const ps = osmPlaces(ANSWER, ["water", "frituur", "cafe", "station", "toilet"], { water: "Drinking water" });
  assert.deepEqual(ps.map((p) => [p.name, p.category]), [["Drinking water", "water"], ["Frituur Nr 1", "frituur"], ["Koffie", "cafe"]]);
  assert.equal(ps[1].notes, "Open: Mo-Su 11:00-22:00\nCuisine: friture");
  assert.equal(ps[1].url, "https://www.openstreetmap.org/way/2");
  assert.equal(ps[2].url, "https://koffie.example");
  assert.deepEqual(osmPlaces(ANSWER, ["water"]).map((p) => p.osm_id), ["node/1"]);
});

test("Overpass queries: areas, each rule once per area", () => {
  const q = overpassQuery(["food", "frituur", "bike"], { bbox: [50.8, 4.6, 50.9, 4.7] });
  assert.match(q, /^\[out:json\]\[timeout:40\];\(/);
  // restaurant|fast_food, fast_food (for frituur), shop=bicycle, bicycle_repair_station.
  assert.equal((q.match(/nwr\[/g) || []).length, 4);
  assert.match(q, /nwr\["shop"~"\^\(bicycle\)\$"\]\(50\.80000,4\.60000,50\.90000,4\.70000\);/);
  const twice = overpassQuery(["water", "water"], { bboxes: [[51, 4.4, 51.1, 4.5], [51.1, 4.5, 51.2, 4.6]] });
  assert.equal((twice.match(/nwr\[/g) || []).length, 2, "one rule, two boxes");
  assert.match(twice, /\(51\.10000,4\.50000,51\.20000,4\.60000\);/);
  assert.throws(() => overpassQuery([], { bbox: [0, 0, 1, 1] }), /at least one category/);
});

test("the Overpass servers are asked in turn; all busy gives a clear message", async () => {
  const asked = [];
  const fake = (answers) => async (url, init) => {
    asked.push([url, init.method, decodeURIComponent(init.body.slice(5)).slice(0, 10)]);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { ok: a.status === 200, status: a.status, json: async () => a.body };
  };
  const got = await runQuery("[out:json];x", { fetchFn: fake([{ status: 504 }, new Error("network down"), { status: 200, body: ANSWER }]) });
  assert.equal(got, ANSWER);
  assert.deepEqual(asked.map((a) => a[0]), config.OVERPASS_URLS);
  assert.equal(asked[0][1], "POST");
  assert.equal(asked[0][2], "[out:json]");

  asked.length = 0;
  await assert.rejects(
    runQuery("[out:json];y", { fetchFn: fake([{ status: 504 }, { status: 429 }, { status: 200, body: { remark: "runtime error: timed out", elements: [] } }]) }),
    (err) => err instanceof OverpassUnavailable && /busy/.test(err.message) && /HTTP 504/.test(err.message));
  // On a server: only its proxy is asked.
  asked.length = 0;
  await runQuery("[out:json];z", { proxyUrl: "http://localhost/api/overpass", fetchFn: fake([{ status: 200, body: ANSWER }]) });
  assert.deepEqual(asked.map((a) => a[0]), ["http://localhost/api/overpass"]);
});

test("route boxes: one for a compact route, several for a long diagonal one", () => {
  const compact = [[51.0, 4.4], [51.1, 4.5], [51.0, 4.6]];
  const [b] = routeBoxes(compact, { padM: 250 });
  assert.ok(b[0] < 51.0 && b[0] > 50.99 && b[3] > 4.6 && b[3] < 4.61);
  const diagonal = Array.from({ length: 101 }, (_, i) => [50 + i * 0.02, 3 + i * 0.03]); // 2° × 3°
  const boxes = routeBoxes(diagonal);
  assert.ok(boxes.length >= 8, `${boxes.length} boxes`);
  assert.ok(boxes.every((x) => (x[2] - x[0]) * (x[3] - x[1]) <= 0.16));
  const total = boxes.reduce((t, x) => t + (x[2] - x[0]) * (x[3] - x[1]), 0);
  assert.ok(total < 1.5, "far less than the 6 square degrees of one box");
});
