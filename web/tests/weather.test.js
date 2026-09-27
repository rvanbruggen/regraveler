import { test } from "node:test";
import assert from "node:assert/strict";

import * as wx from "../js/weather.js";
import { approx, linePoints, loopPoints } from "./helpers.js";

const latlon = (points) => points.map((p) => [p[0], p[1]]);
const DAY = "2026-09-28";
const OFFSET = 7200; // Brussels in summer time
const T0 = wx.localToUnix(DAY, "00:00", OFFSET);

/** A fake Open-Meteo location: 48 hours from T0, values from functions of the hour. */
function fakeLoc({ temp = () => 15, rain = () => 0, prob = () => 0, speed = () => 20, dir = () => 270, gust = () => 30 } = {}) {
  const hours = [...Array(48).keys()];
  return {
    utc_offset_seconds: OFFSET,
    hourly: {
      time: hours.map((h) => T0 + h * 3600),
      temperature_2m: hours.map(temp), precipitation: hours.map(rain),
      precipitation_probability: hours.map(prob), wind_speed_10m: hours.map(speed),
      wind_direction_10m: hours.map(dir), wind_gusts_10m: hours.map(gust), weather_code: hours.map(() => 3),
    },
  };
}

const withLoc = (samples, loc) => samples.map((s) => ({ ...s, loc }));

test("bearing and angles", () => {
  approx(wx.bearing([51, 4.4], [51.01, 4.4]), 0, { abs: 0.01 });
  approx(wx.bearing([51, 4.4], [51, 4.41]), 90, { abs: 0.01 });
  approx(wx.bearing([51, 4.4], [50.99, 4.4]), 180, { abs: 0.01 });
  approx(wx.bearing([51, 4.4], [51, 4.39]), 270, { abs: 0.01 });
  assert.equal(wx.angleBetween(350, 10), 20);
  assert.equal(wx.angleBetween(90, 270), 180);
  assert.equal(wx.compass(225), "SW");
  assert.equal(wx.compass(359), "N");
});

test("wind effect: from where the wind blows", () => {
  // Riding east (90) with a wind from the east is a headwind.
  assert.equal(wx.windEffect(90, 90, 20).effect, "head");
  approx(wx.windEffect(90, 90, 20).head, 20, { abs: 1e-9 });
  assert.equal(wx.windEffect(90, 270, 20).effect, "tail");
  approx(wx.windEffect(90, 270, 20).head, -20, { abs: 1e-9 });
  assert.equal(wx.windEffect(90, 0, 20).effect, "cross");
  assert.equal(wx.windEffect(90, 90, 3).effect, "calm");
});

test("wind effort: a headwind costs more than a tailwind gives back", () => {
  assert.equal(wx.windEffort(0, 20), 0);
  approx(wx.windEffort(10, 20), 12.5, { abs: 1e-9 });
  approx(wx.windEffort(-10, 20), -7.5, { abs: 1e-9 });
});

test("local time and unix time", () => {
  const t = wx.localToUnix("2026-09-28", "09:30", OFFSET);
  assert.equal(t, Date.UTC(2026, 8, 28, 7, 30) / 1000);
  assert.equal(wx.unixToLocalTime(t, OFFSET), "09:30");
  assert.equal(wx.addDays("2026-09-28", 15), "2026-10-13");
  assert.deepEqual(wx.forecastWindow("2026-09-27"), { first: "2026-09-27", last: "2026-10-12" });
});

test("sample points: spaced along the route, first and last at the ends", () => {
  const line = latlon(linePoints({ lengthM: 42000, stepM: 100 }));
  const s = wx.samplePoints(line);
  assert.equal(s.length, 9); // every ~5 km over 42 km
  approx(s[0].m, 0, { abs: 1e-9 });
  approx(s[s.length - 1].m, 42000, { rel: 0.01 });
  approx(s[0].lat, line[0][0], { abs: 1e-4 });
  approx(s[s.length - 1].lon, line[line.length - 1][1], { abs: 1e-4 });
  // Very long routes are capped; very short ones still get start and end.
  assert.equal(wx.samplePoints(latlon(linePoints({ lengthM: 400000, stepM: 1000 }))).length, wx.MAX_SAMPLES);
  assert.equal(wx.samplePoints(latlon(linePoints({ lengthM: 500, stepM: 10 }))).length, 2);
});

test("weatherAt interpolates in time; rain is the hour that ends next", () => {
  const loc = fakeLoc({ temp: (h) => h, rain: (h) => (h === 10 ? 2 : 0), dir: (h) => (h < 9 ? 350 : 10) });
  const w = wx.weatherAt(loc, T0 + 9.5 * 3600);
  approx(w.temp, 9.5, { abs: 1e-9 });
  assert.equal(w.rain, 2); // 09:30 falls in the hour 09:00-10:00, reported at 10:00
  approx(w.dir, 10, { abs: 1e-6 }); // both hours 10 -> 10
  const between = wx.weatherAt(loc, T0 + 8.5 * 3600); // 350 and 10: north, not south
  assert.ok(wx.angleBetween(between.dir, 0) < 1e-6, `got ${between.dir}`);
  approx(between.speed, 20 * Math.cos(10 * Math.PI / 180), { rel: 1e-6 });
  assert.equal(wx.weatherAt(loc, T0 - 60), null);
  assert.equal(wx.weatherAt(loc, T0 + 48 * 3600), null);
});

test("ride east into an east wind: all headwind; reversed: all tailwind", () => {
  const line = latlon(linePoints({ lengthM: 20000, stepM: 100, headingDeg: 90 }));
  const samples = withLoc(wx.samplePoints(line), fakeLoc({ dir: () => 90 }));
  const start = wx.localToUnix(DAY, "09:00", OFFSET);
  const ride = wx.rideWeather({ line, samples, start, speed: 20 });
  approx(ride.summary.share.head, 1, { abs: 1e-9 });
  approx(ride.summary.meanHead, 20, { rel: 1e-3 });
  approx(ride.summary.hours, 1, { rel: 0.01 });
  assert.equal(wx.unixToLocalTime(ride.summary.end, OFFSET), "10:00");
  assert.equal(ride.stretches.length, 1);
  const back = wx.rideWeather({ line, samples, start, speed: 20, reverse: true });
  approx(back.summary.share.tail, 1, { abs: 1e-9 });
  approx(back.summary.meanHead, -20, { rel: 1e-3 });
  // Weather points come in riding order, with the time you pass them.
  assert.ok(back.points[0].m === 0 && back.points[0].lon > back.points[1].lon);
  assert.equal(wx.reverseAdvice(ride, back), back.summary);
  assert.equal(wx.reverseAdvice(back, ride), null);
});

test("each point is read at the time you pass it", () => {
  const line = latlon(linePoints({ lengthM: 40000, stepM: 100 }));
  const samples = withLoc(wx.samplePoints(line), fakeLoc({ temp: (h) => h }));
  const ride = wx.rideWeather({ line, samples, start: wx.localToUnix(DAY, "08:00", OFFSET), speed: 20 });
  approx(ride.summary.tempMin, 8, { abs: 1e-6 });
  approx(ride.summary.tempMax, 10, { abs: 0.01 }); // 40 km at 20 km/h: at the end at 10:00
});

test("rain during the ride: mm per hour times hours spent in it", () => {
  const line = latlon(linePoints({ lengthM: 40000, stepM: 100 }));
  // 3 mm between 09:00 and 10:00, dry otherwise; the ride is 08:00-10:00.
  const samples = withLoc(wx.samplePoints(line), fakeLoc({ rain: (h) => (h === 10 ? 3 : 0), prob: (h) => (h === 10 ? 70 : 10) }));
  const ride = wx.rideWeather({ line, samples, start: wx.localToUnix(DAY, "08:00", OFFSET), speed: 20 });
  approx(ride.summary.rainMm, 3, { rel: 0.02 });
  assert.equal(ride.summary.rainProb, 70);
});

test("a loop in a steady wind: the other way round is no easier", () => {
  // Reversing flips both the order and the sign of the wind: tailwind out, headwind home
  // stays tailwind out, headwind home. Out-and-backs are even the same ride both ways.
  const out = linePoints({ lengthM: 10000, stepM: 100, headingDeg: 90 });
  const line = latlon([...out, ...[...out].reverse().slice(1)]);
  const samples = withLoc(wx.samplePoints(line), fakeLoc({ dir: () => 270 }));
  const start = wx.localToUnix(DAY, "10:00", OFFSET);
  const ride = wx.rideWeather({ line, samples, start, speed: 20 });
  approx(ride.summary.meanHead, 0, { abs: 0.5 }); // a loop in a steady wind evens out...
  assert.ok(ride.summary.secondHalfHead > 15); // ...but here the headwind comes last
  const back = wx.rideWeather({ line, samples, start, speed: 20, reverse: true });
  approx(back.summary.score, ride.summary.score, { abs: 0.1 });
  assert.equal(wx.reverseAdvice(ride, back), null);

  const loop = latlon(loopPoints({ radiusM: 3000, n: 400 }));
  const loopSamples = withLoc(wx.samplePoints(loop), fakeLoc({ dir: () => 45 }));
  const a = wx.rideWeather({ line: loop, samples: loopSamples, start, speed: 20 });
  const b = wx.rideWeather({ line: loop, samples: loopSamples, start, speed: 20, reverse: true });
  approx(a.summary.score, b.summary.score, { abs: 1 });
  assert.equal(wx.reverseAdvice(a, b), null);
});

test("wind that picks up during the ride: advice to ride the loop the other way", () => {
  // A 5 x 10 km rectangle from its south-west corner: east, north, west, south. A north wind,
  // calm until 09:30 and strong after. This way the north leg (into the wind) falls in the
  // strong wind; the other way round it comes first, while it is still calm.
  const pts = [];
  const legs = [[90, 5000], [0, 10000], [270, 5000], [180, 10000]];
  let at = [51.0, 4.4];
  for (const [heading, lengthM] of legs) {
    const leg = linePoints({ start: at, lengthM, stepM: 100, headingDeg: heading });
    pts.push(...(pts.length ? leg.slice(1) : leg));
    at = leg[leg.length - 1];
  }
  const line = latlon(pts);
  const samples = withLoc(wx.samplePoints(line), fakeLoc({ dir: () => 0, speed: (h) => (h < 10 ? 2 : 40) }));
  const start = wx.localToUnix(DAY, "09:00", OFFSET);
  const ride = wx.rideWeather({ line, samples, start, speed: 20 });
  const other = wx.rideWeather({ line, samples, start, speed: 20, reverse: true });
  assert.ok(other.summary.score < ride.summary.score - wx.REVERSE_GAIN_KMH,
    `${other.summary.score} vs ${ride.summary.score}`);
  assert.equal(wx.reverseAdvice(ride, other), other.summary);
  assert.equal(wx.reverseAdvice(other, ride), null);
  assert.ok(ride.summary.headKm > other.summary.headKm);
});

test("a ride past the end of the forecast is marked incomplete", () => {
  const line = latlon(linePoints({ lengthM: 100000, stepM: 500 }));
  const samples = withLoc(wx.samplePoints(line), fakeLoc());
  const ride = wx.rideWeather({ line, samples, start: T0 + 45 * 3600, speed: 20 });
  assert.equal(ride.summary.complete, false);
  assert.equal(wx.reverseAdvice(ride, ride), null);
});

test("Open-Meteo requests and answers", async () => {
  const samples = [{ lat: 51.2, lon: 4.4, m: 0 }, { lat: 51.1, lon: 4.5, m: 1 }];
  const url = wx.hourlyUrl("https://api.open-meteo.com/", samples, "2026-09-28", "2026-09-29");
  assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=51.2,51.1&longitude=4.4,4.5&hourly=/);
  assert.match(url, /start_date=2026-09-28&end_date=2026-09-29&timezone=auto&timeformat=unixtime/);
  const fakeFetch = async () => ({ ok: true, json: async () => [fakeLoc(), fakeLoc()] });
  const res = await wx.fetchHourly("https://x", samples, "2026-09-28", "2026-09-29", fakeFetch);
  assert.equal(res.utcOffset, OFFSET);
  assert.ok(samples[1].loc.hourly);
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ error: true, reason: "out of range" }) });
  await assert.rejects(wx.fetchHourly("https://x", samples, "a", "b", failing), /out of range/);

  const daily = {
    utc_offset_seconds: OFFSET, timezone: "Europe/Brussels",
    daily: {
      time: ["2026-09-27", "2026-09-28"], weather_code: [3, null], temperature_2m_max: [20, null],
      temperature_2m_min: [10, null], precipitation_sum: [0.5, null], precipitation_probability_max: [30, null],
      wind_speed_10m_max: [15, null], wind_direction_10m_dominant: [200, null],
    },
  };
  const d = await wx.fetchDaily("https://x", samples[0], async () => ({ ok: true, json: async () => daily }));
  assert.equal(d.days.length, 2);
  assert.deepEqual(d.days[0], { date: "2026-09-27", code: 3, tmax: 20, tmin: 10, rain: 0.5, prob: 30, wind: 15, dir: 200 });
  assert.equal(d.days[1].tmax, null);
});
