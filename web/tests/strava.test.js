import { test } from "node:test";
import assert from "node:assert/strict";

import {
  API, STRAVA, StravaClient, StravaError, activityOf, authorizeUrl, canReadPrivate, exchangeCode, importedByUrl,
  nextQuarterHour, redirectUri, returnFrom, sourceUrl, summarise,
} from "../js/strava.js";
import { gpxXml, linePoints } from "./helpers.js";

const APP = { clientId: " 12345 ", clientSecret: "s3cret" };
const BIG_ID = "3412345678901234567"; // today's route ids don't fit a JavaScript number

/** A fake fetch: answer(url, opts, n) -> {status, body, text}; records the requests. */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const a = answer(url, opts, calls.length) || {};
    const status = a.status ?? 200;
    const bytes = new TextEncoder().encode(a.text ?? JSON.stringify(a.body ?? {}));
    return {
      status, ok: status < 300, statusText: "",
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  fn.calls = calls;
  return fn;
}

const auth = (extra = {}) => ({ access_token: "acc", refresh_token: "ref", expires_at: 10_000, athlete_id: "77", athlete_name: "Rik", scope: "read,read_all", ...extra });

test("the sign-in address and the return from Strava", () => {
  assert.equal(redirectUri("https://rerouter.eu/app/?x=1#view=import"), "https://rerouter.eu/app/");
  const u = new URL(authorizeUrl({ clientId: " 12345 ", redirectUri: "http://localhost:8000/", state: "abc" }));
  assert.equal(u.origin + u.pathname, `${STRAVA}/oauth/authorize`);
  assert.equal(u.searchParams.get("client_id"), "12345");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:8000/");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("scope"), "read,read_all");
  assert.equal(u.searchParams.get("state"), "abc");

  assert.deepEqual(returnFrom("https://rerouter.eu/?state=abc&code=C0DE&scope=read,read_all"),
    { code: "C0DE", state: "abc", scope: "read,read_all", error: null });
  assert.equal(returnFrom("https://rerouter.eu/?state=abc&error=access_denied").error, "access_denied");
  assert.equal(returnFrom("https://rerouter.eu/#view=import"), null);
  assert.equal(returnFrom("https://rerouter.eu/?code=C0DE"), null); // no state: not ours
  assert.ok(canReadPrivate("read,read_all"));
  assert.ok(!canReadPrivate("read"));
});

test("trades the code for tokens, with the app's id and secret", async () => {
  const fetchFn = fakeFetch(() => ({ body: { access_token: "a1", refresh_token: "r1", expires_at: 5000, athlete: { id: 77, firstname: "Rik", lastname: "V" } } }));
  const a = await exchangeCode(APP, "C0DE", "read,read_all", fetchFn);
  assert.deepEqual(a, { access_token: "a1", refresh_token: "r1", expires_at: 5000, athlete_id: "77", athlete_name: "Rik V", scope: "read,read_all" });
  const { url, opts } = fetchFn.calls[0];
  assert.equal(url, `${STRAVA}/oauth/token`);
  assert.equal(opts.method, "POST");
  assert.equal(opts.body.get("client_id"), "12345");
  assert.equal(opts.body.get("client_secret"), "s3cret");
  assert.equal(opts.body.get("code"), "C0DE");
  assert.equal(opts.body.get("grant_type"), "authorization_code");

  const bad = fakeFetch(() => ({ status: 400, body: { message: "Bad Request", errors: [{ resource: "Application", field: "client_secret", code: "invalid" }] } }));
  await assert.rejects(exchangeCode(APP, "C0DE", "", bad), (err) => err instanceof StravaError && /client_secret invalid/.test(err.message));
});

test("refreshes an expiring token before a request, and keeps the new one", async () => {
  const kept = [];
  const fetchFn = fakeFetch((url) => (url.endsWith("/oauth/token")
    ? { body: { access_token: "a2", refresh_token: "r2", expires_at: 99_999 } }
    : { body: [] }));
  const c = new StravaClient(APP, auth({ expires_at: 1100 }), { fetchFn, onAuth: (a) => kept.push(a), now: () => 1000 });
  await c.listRoutes();
  assert.equal(fetchFn.calls[0].opts.body.get("grant_type"), "refresh_token");
  assert.equal(fetchFn.calls[0].opts.body.get("refresh_token"), "ref");
  assert.equal(fetchFn.calls[1].opts.headers.Authorization, "Bearer a2");
  assert.equal(kept.at(-1).refresh_token, "r2");
  assert.equal(kept.at(-1).athlete_id, "77"); // kept from before
});

test("a refused token is refreshed once, then the request is tried again", async () => {
  const fetchFn = fakeFetch((url, opts, n) => {
    if (url.endsWith("/oauth/token")) return { body: { access_token: "a2", refresh_token: "r2", expires_at: 99_999 } };
    return n === 1 ? { status: 401 } : { body: [] };
  });
  const c = new StravaClient(APP, auth(), { fetchFn, now: () => 1000 });
  assert.deepEqual(await c.listRoutes(), []);
  assert.deepEqual(fetchFn.calls.map((x) => x.url.replace(STRAVA, "")), [
    "/api/v3/athletes/77/routes?page=1&per_page=200", "/oauth/token", "/api/v3/athletes/77/routes?page=1&per_page=200",
  ]);
});

test("lists every page until an empty one, by id_str", async () => {
  const fetchFn = fakeFetch((url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    if (page === 1) return { text: `[{"id": ${BIG_ID}, "id_str": "${BIG_ID}", "name": "Kempen", "distance": 42000, "elevation_gain": 150, "type": 1, "sub_type": 3, "private": true, "created_at": "2025-06-01T08:00:00Z"}, {"id": 5, "id_str": "5", "name": "Two"}]` };
    if (page === 2) return { body: [{ id: 6, id_str: "6", name: "Three" }] };
    return { body: [] };
  });
  const progress = [];
  const items = await new StravaClient(APP, auth(), { fetchFn, now: () => 1000 }).listRoutes({ onPage: (p) => progress.push(p.loaded) });
  assert.deepEqual(items.map((i) => i.id), [BIG_ID, "5", "6"]);
  assert.equal(items[0].url, `${STRAVA}/routes/${BIG_ID}`);
  assert.equal(items[0].activity, "gravel");
  assert.equal(items[0].private, true);
  assert.deepEqual(progress, [2, 3]);
  assert.equal(fetchFn.calls.length, 3);
});

test("asks who the athlete is when that isn't known yet", async () => {
  const kept = [];
  const fetchFn = fakeFetch((url) => (url === `${API}/athlete` ? { body: { id: 42, firstname: "Rik" } } : { body: [] }));
  await new StravaClient(APP, auth({ athlete_id: null }), { fetchFn, onAuth: (a) => kept.push(a), now: () => 1000 }).listRoutes();
  assert.match(fetchFn.calls[1].url, /\/athletes\/42\/routes/);
  assert.equal(kept[0].athlete_id, "42");
});

test("a 429 says when the 15-minute limit resets", async () => {
  const now = Date.UTC(2026, 8, 30, 14, 7, 30) / 1000;
  const fetchFn = fakeFetch(() => ({ status: 429 }));
  await assert.rejects(new StravaClient(APP, auth({ expires_at: now + 9999 }), { fetchFn, now: () => now }).routeGpx("5"),
    (err) => err instanceof StravaError && err.status === 429 && err.resetAt === Date.UTC(2026, 8, 30, 14, 15));
  assert.equal(nextQuarterHour(Date.UTC(2026, 0, 1, 23, 59)), Date.UTC(2026, 0, 2, 0, 0));
});

test("downloads a route's GPX, and refuses what isn't one", async () => {
  const gpx = new TextDecoder().decode(gpxXml([["Kempen", linePoints({ lengthM: 500, stepM: 100 })]]));
  const fetchFn = fakeFetch((url) => (url.includes(BIG_ID) ? { text: gpx } : { text: "<html>nope</html>" }));
  const c = new StravaClient(APP, auth(), { fetchFn, now: () => 1000 });
  const data = await c.routeGpx(BIG_ID);
  assert.equal(new TextDecoder().decode(data), gpx);
  assert.equal(fetchFn.calls[0].url, `${API}/routes/${BIG_ID}/export_gpx`);
  await assert.rejects(c.routeGpx("5"), /isn't a GPX file/);
});

test("route types become activities", () => {
  assert.equal(activityOf(6, null), "gravel");
  assert.equal(activityOf(7, null), "mtb");
  assert.equal(activityOf(1, 1), "road");
  assert.equal(activityOf(1, 2), "mtb");
  assert.equal(activityOf(1, 5), null);
  assert.equal(activityOf(4, null), "hiking");
  assert.equal(activityOf(3, 4), "hiking");
});

test("summarises a route, without trusting a rounded numeric id", () => {
  const r = summarise({ id: Number(BIG_ID), name: "", timestamp: 1_700_000_000 });
  assert.equal(r.id, null); // no id_str and the number is not exact: unusable
  const ok = summarise({ id: 12, name: " ", timestamp: 1_700_000_000, description: " Nice " });
  assert.equal(ok.id, "12");
  assert.equal(ok.name, "Strava route 12");
  assert.equal(ok.description, "Nice");
  assert.equal(ok.date, new Date(1_700_000_000_000).toISOString());
});

test("finds what is already in the library by source URL", () => {
  const map = importedByUrl([
    { id: 1, source_url: `https://www.strava.com/routes/${BIG_ID}` },
    { id: 2, source_url: `https://strava.com/routes/${BIG_ID}/export_gpx` },
    { id: 3, source_url: "https://ridewithgps.com/routes/5" },
  ]);
  assert.deepEqual(map.get(sourceUrl(BIG_ID)).map((r) => r.id), [1, 2]);
  assert.equal(map.size, 1);
});
