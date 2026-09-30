import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGpx } from "../js/gpx.js";
import { RWGPS_API, RwgpsError, fetchOne, importedByUrl, listAll, sourceUrl, summarise } from "../js/rwgps.js";
import { linePoints } from "./helpers.js";

const CREDS = { apiKey: " key1 ", authToken: "tok2" };
const noSleep = async () => {};

/** A fake fetch: answers(url) -> {status, body, headers}; records the requests. */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, headers: opts?.headers });
    const a = answers(url, calls.length);
    return {
      status: a.status ?? 200, ok: (a.status ?? 200) < 300, statusText: a.statusText ?? "",
      headers: { get: (h) => a.headers?.[h] ?? null },
      json: async () => a.body,
    };
  };
  fn.calls = calls;
  return fn;
}

const route = (id, extra = {}) => ({ id, name: `Route ${id}`, distance: 12345, elevation_gain: 210.4, created_at: "2025-04-01T10:00:00Z", updated_at: "2026-01-02T10:00:00Z", ...extra });

test("lists every page, following next_page_url, with the key and token", async () => {
  const fetchFn = fakeFetch((url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const ids = page === 1 ? [1, 2] : page === 2 ? [3] : [];
    return { body: { routes: ids.map((id) => route(id)), meta: { pagination: { record_count: 3, page_count: 2, next_page_url: page === 1 ? `${RWGPS_API}/routes.json?page=2&page_size=200` : null } } } };
  });
  const progress = [];
  const items = await listAll("routes", CREDS, { fetchFn, sleepFn: noSleep, onPage: (p) => progress.push(p) });
  assert.deepEqual(items.map((i) => i.id), ["1", "2", "3"]);
  assert.equal(fetchFn.calls.length, 2);
  assert.equal(fetchFn.calls[0].headers["x-rwgps-api-key"], "key1");
  assert.equal(fetchFn.calls[0].headers["x-rwgps-auth-token"], "tok2");
  assert.match(fetchFn.calls[0].url, /\/api\/v1\/routes\.json\?page=1&page_size=200$/);
  assert.deepEqual(progress.at(-1), { loaded: 3, total: 3 });
});

test("falls back to page_count when there is no next_page_url, and stops on an empty page", async () => {
  const fetchFn = fakeFetch((url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return { body: { trips: page <= 2 ? [route(page * 10)] : [], meta: { pagination: { page_count: 5 } } } };
  });
  const items = await listAll("trips", CREDS, { fetchFn, sleepFn: noSleep });
  assert.deepEqual(items.map((i) => i.id), ["10", "20"]);
  assert.equal(fetchFn.calls.length, 3);
  assert.match(fetchFn.calls[0].url, /\/trips\.json/);
});

test("never sends the key and token to another site", async () => {
  const fetchFn = fakeFetch(() => ({ body: { routes: [route(1)], meta: { pagination: { next_page_url: "https://evil.example/steal" } } } }));
  await assert.rejects(listAll("routes", CREDS, { fetchFn, sleepFn: noSleep }), /another site/);
  assert.equal(fetchFn.calls.length, 1);
});

test("explains a refused token, and waits and retries when asked to slow down", async () => {
  await assert.rejects(listAll("routes", CREDS, { fetchFn: fakeFetch(() => ({ status: 401, body: {} })), sleepFn: noSleep }),
    (err) => err instanceof RwgpsError && err.status === 401 && /API key and auth token/.test(err.message));
  const waits = [];
  const fetchFn = fakeFetch((url, n) => (n === 1 ? { status: 429, headers: { "Retry-After": "2" } } : { body: { routes: [], meta: {} } }));
  assert.deepEqual(await listAll("routes", CREDS, { fetchFn, sleepFn: async (ms) => waits.push(ms) }), []);
  assert.deepEqual(waits, [2000]);
  await assert.rejects(listAll("routes", CREDS, { fetchFn: fakeFetch(() => ({ status: 429 })), sleepFn: noSleep }), /slow down/);
});

test("summarises routes and rides for the list", () => {
  assert.deepEqual(summarise("routes", route(7)), {
    kind: "routes", id: "7", name: "Route 7", distance_km: 12.345, gain_m: 210.4,
    date: "2025-04-01T10:00:00Z", updated_at: "2026-01-02T10:00:00Z", url: "https://ridewithgps.com/routes/7",
  });
  const ride = summarise("trips", { id: 9, name: " ", departed_at: "2026-05-05T07:00:00Z", created_at: "2026-05-06T07:00:00Z" });
  assert.equal(ride.name, "RideWithGPS ride 9");
  assert.equal(ride.date, "2026-05-05T07:00:00Z");
  assert.equal(ride.distance_km, null);
  assert.equal(ride.url, "https://ridewithgps.com/trips/9");
});

test("fetches one route's track as a GPX file", async () => {
  const pts = linePoints({ lengthM: 1000, stepM: 100, ele: (d) => 10 + d / 100 });
  const fetchFn = fakeFetch(() => ({ body: { route: { id: 5, name: "Kempen", description: "nice", unpaved_pct: 40, track_points: pts.map(([y, x, e]) => ({ x, y, e })) } } }));
  const r = await fetchOne("routes", "5", CREDS, { fetchFn, sleepFn: noSleep });
  assert.equal(fetchFn.calls[0].url, `${RWGPS_API}/routes/5.json`);
  assert.equal(r.name, "Kempen");
  assert.equal(r.description, "nice");
  assert.equal(r.paved_pct, 60);
  const gpx = parseGpx(r.data);
  assert.equal(gpx.tracks[0].points.length, pts.length);
});

test("finds what is already in the library by source URL, from either kind of link", () => {
  const map = importedByUrl([
    { id: 1, source_url: "https://ridewithgps.com/routes/5" },
    { id: 2, source_url: "https://www.ridewithgps.com/trips/6?x=1" },
    { id: 3, source_url: "https://rwgps.com/routes/5" },
    { id: 4, source_url: "https://www.komoot.com/tour/5" },
    { id: 5, source_url: null },
  ]);
  assert.deepEqual(map.get(sourceUrl("routes", 5)).map((r) => r.id), [1, 3]);
  assert.deepEqual(map.get(sourceUrl("trips", "6")).map((r) => r.id), [2]);
  assert.equal(map.size, 2);
});
