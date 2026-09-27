import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGpx } from "../js/gpx.js";
import { LinkImportError, fetchRoute, fromGpxFile, fromKomoot, fromRideWithGps, komootPavedPct, parseRouteLink, serviceName } from "../js/linkimport.js";
import { gpxXml, linePoints } from "./helpers.js";

test("recognises RideWithGPS route and ride links", () => {
  for (const url of [
    "https://ridewithgps.com/routes/32381385",
    "https://www.ridewithgps.com/routes/32381385?lang=en",
    "  https://ridewithgps.com/routes/32381385/  ",
    "https://ridewithgps.com/routes/32381385.gpx",
    "https://rwgps.com/routes/32381385",
  ]) {
    assert.deepEqual(parseRouteLink(url),
      { service: "ridewithgps", kind: "route", id: "32381385", url: "https://ridewithgps.com/routes/32381385" }, url);
  }
  const ride = parseRouteLink("https://ridewithgps.com/trips/282565146");
  assert.equal(ride.kind, "ride");
  assert.equal(ride.url, "https://ridewithgps.com/trips/282565146");
});

test("recognises Strava route links and gives the export address", () => {
  const s = parseRouteLink("https://www.strava.com/routes/2188505?hl=en-GB");
  assert.equal(s.service, "strava");
  assert.equal(s.url, "https://www.strava.com/routes/2188505");
  assert.equal(s.exportUrl, "https://www.strava.com/routes/2188505/export_gpx");
});

test("recognises Komoot tour links, with a share token for shared private tours", () => {
  for (const url of [
    "https://www.komoot.com/tour/448966484",
    "https://www.komoot.com/nl-nl/tour/448966484?ref=wtd",
    "https://www.komoot.de/tour/448966484/",
    "https://komoot.com/tour/448966484/zoom",
    "https://www.komoot.com/api/v007/tours/448966484.gpx",
    "https://api.komoot.de/v007/tours/448966484",
  ]) {
    assert.deepEqual(parseRouteLink(url),
      { service: "komoot", kind: "tour", id: "448966484", url: "https://www.komoot.com/tour/448966484", shareToken: null }, url);
  }
  const shared = parseRouteLink("https://www.komoot.com/tour/5?share_token=abC12&ref=wtd");
  assert.equal(shared.shareToken, "abC12");
  assert.equal(shared.url, "https://www.komoot.com/tour/5?share_token=abC12");
  assert.equal(serviceName(shared), "Komoot");
});

test("any other web link is a possible GPX file", () => {
  const w = parseRouteLink("https://www.gravelroutedatabase.be/files/Rondje%20Kempen.gpx#top");
  assert.deepEqual(w, { service: "web", kind: "file", id: null, url: "https://www.gravelroutedatabase.be/files/Rondje%20Kempen.gpx" });
  assert.equal(serviceName(w), "gravelroutedatabase.be");
});

test("rejects what can't be a route, with a useful message", () => {
  assert.throws(() => parseRouteLink("not a url"), LinkImportError);
  assert.throws(() => parseRouteLink("file:///Users/rik/route.gpx"), /Only web links/);
  assert.throws(() => parseRouteLink("ftp://example.com/route.gpx"), /Only web links/);
  assert.throws(() => parseRouteLink("https://ridewithgps.com/users/5"), /not a route/);
  assert.throws(() => parseRouteLink("https://www.strava.com/activities/5"), /not a route/);
  assert.throws(() => parseRouteLink("https://www.komoot.com/collection/940341"), /not a tour/);
});

const rwgpsDoc = {
  route: {
    id: 1, name: "  De gravel van 't Kiel ", description: "", distance: 51247.1, unpaved_pct: 34,
    activity_types: ["cycling:gravel"],
    track_points: [
      { x: 4.4256, y: 51.2024, e: 3.0 },
      { x: 4.4257, y: 51.2025 },
      { x: 4.4258, y: 51.2026, e: 4.5 },
      { y: 51.3 }, // no longitude: skipped
    ],
  },
};

test("converts a RideWithGPS route to a GPX file", () => {
  const r = fromRideWithGps(rwgpsDoc);
  assert.equal(r.name, "De gravel van 't Kiel");
  assert.equal(r.description, null);
  assert.equal(r.activity, "gravel");
  assert.equal(r.paved_pct, 66);
  assert.equal(r.points, 3);
  assert.equal(r.filename, "De gravel van 't Kiel.gpx");
  assert.ok(Math.abs(r.distance_km - 51.2471) < 1e-9);
  const parsed = parseGpx(r.data);
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].name, "De gravel van 't Kiel");
  assert.deepEqual(parsed.tracks[0].points.map((p) => p[2]), [3, null, 4.5]);
  assert.deepEqual(parsed.tracks[0].points[0].slice(0, 2), [51.2024, 4.4256]);
});

test("maps RideWithGPS activities and rides", () => {
  const act = (types) => fromRideWithGps({ route: { ...rwgpsDoc.route, activity_types: types } }).activity;
  assert.equal(act(["cycling:road"]), "road");
  assert.equal(act(["cycling:mountain"]), "mtb");
  assert.equal(act(["hiking"]), "hiking");
  assert.equal(act(["cycling"]), null);
  assert.equal(act(undefined), null);
  const trip = fromRideWithGps({ trip: { name: "Ride", track_points: rwgpsDoc.route.track_points } });
  assert.equal(trip.points, 3);
  assert.equal(trip.paved_pct, null);
});

test("a route without a track is refused", () => {
  assert.throws(() => fromRideWithGps({ route: { name: "x", track_points: [] } }), LinkImportError);
});

const komootTour = {
  id: 448966484, name: "Brüssel -> Antwerpen", sport: "mtb_easy", distance: 53574.2,
  summary: { surfaces: [
    { type: "sb#unpaved", amount: 0.03 }, { type: "sb#cobbles", amount: 0.004 }, { type: "sb#paved", amount: 0.54 },
    { type: "sb#asphalt", amount: 0.41 }, { type: "sf#unknown", amount: 0.016 },
  ] },
};
const komootCoords = { items: [
  { lat: 50.848668, lng: 4.363237, alt: 61.1, t: 0 },
  { lat: 50.848417, lng: 4.363108, alt: 60.9, t: 18368 },
  { lat: 50.848, lng: 4.363 },
] };

test("converts a Komoot tour to a GPX file", () => {
  const r = fromKomoot(komootTour, komootCoords);
  assert.equal(r.name, "Brüssel -> Antwerpen");
  assert.equal(r.activity, "gravel"); // Komoot's "gravel ride" is mtb_easy
  assert.equal(r.paved_pct, 97);
  assert.equal(r.points, 3);
  assert.ok(Math.abs(r.distance_km - 53.5742) < 1e-9);
  const parsed = parseGpx(r.data);
  assert.deepEqual(parsed.tracks[0].points.map((p) => p[2]), [61.1, 60.9, null]);
  assert.throws(() => fromKomoot(komootTour, { items: [] }), /no track/);
});

test("Komoot sports and surfaces", () => {
  const act = (sport) => fromKomoot({ ...komootTour, sport }, komootCoords).activity;
  assert.equal(act("racebike"), "road");
  assert.equal(act("mtb"), "mtb");
  assert.equal(act("e_mtb"), "mtb");
  assert.equal(act("hike"), "hiking");
  assert.equal(act("touringbicycle"), null);
  assert.equal(komootPavedPct([{ type: "sb#compacted", amount: 1 }]), 0);
  assert.equal(komootPavedPct([{ type: "sf#unknown", amount: 0.6 }, { type: "sb#asphalt", amount: 0.4 }]), null);
  assert.equal(komootPavedPct(undefined), null);
});

const gpxFile = gpxXml([["Rondje", linePoints({ lengthM: 1000, stepM: 100 })]]);

test("a GPX file from a link is imported unchanged", () => {
  const r = fromGpxFile(gpxFile, "https://example.org/files/Rondje%20Kempen.gpx?x=1");
  assert.equal(r.data, gpxFile);
  assert.equal(r.filename, "Rondje Kempen.gpx");
  assert.equal(r.name, "Rondje");
  assert.equal(r.points, 11);
  assert.equal(r.paved_pct, null);
  assert.equal(fromGpxFile(gpxFile, "https://example.org/download?id=7").filename, "Rondje.gpx");
  const html = new TextEncoder().encode("<!DOCTYPE html><html><body>Download</body></html>");
  assert.throws(() => fromGpxFile(html, "https://example.org/route"), /doesn't lead to a GPX file/);
});

const fakeFetch = (status, body = {}) => async (url) => {
  fakeFetch.last = url;
  (fakeFetch.all ||= []).push(url);
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  return { ok: status < 400, status, statusText: "", json: async () => body, arrayBuffer: async () => bytes.buffer };
};

test("fetchRoute reads the RideWithGPS JSON document", async () => {
  const link = parseRouteLink("https://ridewithgps.com/routes/1");
  const r = await fetchRoute(link, fakeFetch(200, rwgpsDoc));
  assert.equal(fakeFetch.last, "https://ridewithgps.com/routes/1.json");
  assert.equal(r.link, link);
  assert.equal(r.points, 3);
  await fetchRoute(parseRouteLink("https://ridewithgps.com/trips/9"), fakeFetch(200, rwgpsDoc));
  assert.equal(fakeFetch.last, "https://ridewithgps.com/trips/9.json");
});

test("fetchRoute explains private, missing and Strava routes", async () => {
  const link = parseRouteLink("https://ridewithgps.com/routes/1");
  await assert.rejects(fetchRoute(link, fakeFetch(401)), /not public/);
  await assert.rejects(fetchRoute(link, fakeFetch(404)), /has no route 1/);
  await assert.rejects(fetchRoute(link, async () => { throw new Error("offline"); }), /could not be reached: offline/);
  const strava = parseRouteLink("https://www.strava.com/routes/5");
  await assert.rejects(fetchRoute(strava, fakeFetch(200)), (err) =>
    err instanceof LinkImportError && err.exportUrl === "https://www.strava.com/routes/5/export_gpx");
});

test("fetchRoute reads both Komoot documents, with the share token", async () => {
  fakeFetch.all = [];
  const link = parseRouteLink("https://www.komoot.com/tour/7?share_token=tok");
  const fetchFn = async (url) => fakeFetch(200, url.includes("/coordinates") ? komootCoords : komootTour)(url);
  const r = await fetchRoute(link, fetchFn);
  assert.equal(r.points, 3);
  assert.deepEqual(fakeFetch.all.sort(), [
    "https://www.komoot.com/api/v007/tours/7/coordinates?share_token=tok",
    "https://www.komoot.com/api/v007/tours/7?share_token=tok",
  ]);
  await assert.rejects(fetchRoute(parseRouteLink("https://www.komoot.com/tour/7"), fakeFetch(403)), /private/);
});

test("fetchRoute: a GPX file straight from the site, else through the server", async () => {
  const link = parseRouteLink("https://example.org/r.gpx");
  assert.equal((await fetchRoute(link, fakeFetch(200, gpxFile))).name, "Rondje");
  const blocked = async () => { throw new TypeError("Failed to fetch"); }; // CORS
  // Static site: no server to ask.
  await assert.rejects(fetchRoute(link, blocked), /doesn't let other websites read its files/);
  // On a server: the server fetches it.
  let asked = null;
  const proxy = async (url) => { asked = url; return fakeFetch(200, gpxFile)(url); };
  assert.equal((await fetchRoute(link, blocked, { proxy })).points, 11);
  assert.equal(asked, "https://example.org/r.gpx");
  // The server's refusal is passed on.
  const refusing = async () => ({ ok: false, status: 403, statusText: "", json: async () => ({ detail: "only the public internet" }) });
  await assert.rejects(fetchRoute(link, blocked, { proxy: refusing }), /only the public internet/);
  await assert.rejects(fetchRoute(link, fakeFetch(404)), /nothing at that link/);
  await assert.rejects(fetchRoute(link, fakeFetch(200, new TextEncoder().encode("<html></html>"))), /doesn't lead to a GPX file/);
});
