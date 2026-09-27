// Ride weather: the forecast along a route for a ride on a given day, start time and speed.
// The weather comes from Open-Meteo (free, no key, allows requests from any page): hourly
// values at points sampled along the route, each read at the moment you pass that point.
// The wind is compared with the riding direction of every stretch: headwind, crosswind or
// tailwind. Everything here is pure (no DOM, no fetch) except the two fetch helpers at the end.

// Open-Meteo forecasts today and the next 15 days.
export const FORECAST_DAYS = 16;
// Weather points along the route: about every SAMPLE_SPACING_M, at most MAX_SAMPLES.
export const SAMPLE_SPACING_M = 5000;
export const MAX_SAMPLES = 21;
// Wind below this (km/h) counts as calm: no headwind or tailwind worth mentioning.
export const CALM_KMH = 5;
// Angle between the wind and the riding direction: up to HEAD_DEG it is a headwind, from
// TAIL_DEG on a tailwind, crosswind in between.
export const HEAD_DEG = 60;
export const TAIL_DEG = 120;
// Suggest riding the route the other way when that lowers the wind score by at least this (km/h).
export const REVERSE_GAIN_KMH = 2;

export const HOURLY = [
  "temperature_2m", "precipitation", "precipitation_probability",
  "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "weather_code",
];
export const DAILY = [
  "weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
  "precipitation_probability_max", "wind_speed_10m_max", "wind_direction_10m_dominant",
];

const RAD = Math.PI / 180;

// ------------------------------------------------------------------ geometry

/** Flat-earth metres between two [lat, lon] points (fine for the short steps of a route). */
function stepMetres(p, q) {
  const k = Math.cos(((p[0] + q[0]) / 2) * RAD);
  return Math.hypot((q[0] - p[0]) * 110540, (q[1] - p[1]) * k * 111320);
}

/** Cumulative metres along a [lat, lon] polyline. */
export function cumulativeMetres(line) {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + stepMetres(line[i - 1], line[i]));
  return out;
}

/** Compass bearing (degrees, 0 = north, 90 = east) of travelling from p to q. */
export function bearing(p, q) {
  const k = Math.cos(((p[0] + q[0]) / 2) * RAD);
  const deg = Math.atan2((q[1] - p[1]) * k, q[0] - p[0]) / RAD;
  return (deg + 360) % 360;
}

/** Point `at` metres along the line. */
function pointAt(line, cum, at) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < at) i++;
  const seg = cum[i] - cum[i - 1];
  const f = seg ? Math.max(0, Math.min(1, (at - cum[i - 1]) / seg)) : 0;
  return [line[i - 1][0] + f * (line[i][0] - line[i - 1][0]), line[i - 1][1] + f * (line[i][1] - line[i - 1][1])];
}

/** Weather points along the route: [{lat, lon, m}] from start to end, evenly spaced. */
export function samplePoints(line, spacing = SAMPLE_SPACING_M, max = MAX_SAMPLES) {
  const cum = cumulativeMetres(line);
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.min(max, Math.round(total / spacing) + 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = (total * i) / (n - 1);
    const [lat, lon] = pointAt(line, cum, m);
    out.push({ lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, m });
  }
  return out;
}

// ------------------------------------------------------------------ wind

/** Smallest angle (0..180) between two directions in degrees. */
export function angleBetween(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** How a wind (blowing FROM `windFrom`, as weather reports give it) hits you riding towards
 * `heading`: {effect: head|cross|tail|calm, head: headwind component in km/h (negative is
 * a tailwind)}. */
export function windEffect(heading, windFrom, speed) {
  const angle = angleBetween(heading, windFrom);
  const head = speed * Math.cos(angle * RAD);
  let effect = "cross";
  if (speed < CALM_KMH) effect = "calm";
  else if (angle <= HEAD_DEG) effect = "head";
  else if (angle >= TAIL_DEG) effect = "tail";
  return { effect, head };
}

/** Extra effort of a headwind component `head` (km/h; negative for a tailwind) when riding at
 * `speed`, in km/h of headwind: air drag grows with the square of the air speed, so a
 * headwind costs more than a tailwind of the same strength gives back. */
export function windEffort(head, speed) {
  const air = speed + head;
  return (air * Math.abs(air) - speed * speed) / (2 * speed);
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
/** "SW" for 225 degrees. */
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

// ------------------------------------------------------------------ time

/** Unix seconds of a local date ("2026-09-28") and time ("09:30") at a place `utcOffset`
 * seconds ahead of UTC. */
export function localToUnix(date, time, utcOffset) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi || 0) / 1000 - utcOffset;
}

/** "09:30" for unix seconds at a place `utcOffset` seconds ahead of UTC. */
export function unixToLocalTime(t, utcOffset) {
  const d = new Date((t + utcOffset) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "2026-09-28" plus `days`. */
export function addDays(date, days) {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** The days with a forecast: today (at the place) and the next FORECAST_DAYS - 1. */
export function forecastWindow(today) {
  return { first: today, last: addDays(today, FORECAST_DAYS - 1) };
}

// ------------------------------------------------------------------ Open-Meteo

const coords = (points) =>
  `latitude=${points.map((p) => p.lat).join(",")}&longitude=${points.map((p) => p.lon).join(",")}`;

/** Hourly forecast for the points, from `firstDate` to `lastDate` (local dates). */
export function hourlyUrl(base, points, firstDate, lastDate) {
  return `${base.replace(/\/+$/, "")}/v1/forecast?${coords(points)}&hourly=${HOURLY.join(",")}` +
    `&start_date=${firstDate}&end_date=${lastDate}&timezone=auto&timeformat=unixtime&wind_speed_unit=kmh`;
}

/** Daily forecast for one point, for all the forecast days. */
export function dailyUrl(base, point) {
  return `${base.replace(/\/+$/, "")}/v1/forecast?${coords([point])}&daily=${DAILY.join(",")}` +
    `&forecast_days=${FORECAST_DAYS}&timezone=auto&wind_speed_unit=kmh`;
}

/** Open-Meteo answers one object for one point and an array for several. */
export const asArray = (json) => (Array.isArray(json) ? json : [json]);

/** The daily forecast as [{date, code, tmax, tmin, rain, prob, wind, dir}]; days without
 * data (the end of the last day) have tmax null. */
export function parseDaily(json) {
  const d = asArray(json)[0].daily;
  return d.time.map((date, i) => ({
    date,
    code: d.weather_code[i], tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i],
    rain: d.precipitation_sum[i], prob: d.precipitation_probability_max[i],
    wind: d.wind_speed_10m_max[i], dir: d.wind_direction_10m_dominant[i],
  }));
}

// Reading an hourly series at any moment. Temperatures and wind are interpolated between the
// hours (wind as a vector, so 350 and 10 degrees average to north, not south); precipitation
// is "the sum of the preceding hour", so a moment takes the value of the hour that ends next.

function bracket(times, t) {
  if (t < times[0] || t > times[times.length - 1]) return null;
  let i = 1;
  while (i < times.length - 1 && times[i] < t) i++;
  const span = times[i] - times[i - 1];
  return { i, f: span ? (t - times[i - 1]) / span : 0 };
}

function lerp(values, b) {
  const a = values[b.i - 1], c = values[b.i];
  if (a == null || c == null) return b.f < 0.5 ? a ?? null : c ?? null;
  return a + b.f * (c - a);
}

/** The weather of one Open-Meteo location at unix time t, or null outside the forecast. */
export function weatherAt(loc, t) {
  const h = loc.hourly;
  const b = bracket(h.time, t);
  if (!b) return null;
  const next = b.f > 0 ? b.i : b.i - 1; // the hour that ends at or after t
  const [u, v] = windVector(lerpWind(h, b));
  const temp = lerp(h.temperature_2m, b);
  if (temp == null) return null;
  return {
    temp,
    rain: h.precipitation[next] ?? 0, // mm in that hour
    prob: h.precipitation_probability[next],
    code: h.weather_code[next],
    gust: lerp(h.wind_gusts_10m, b),
    ...fromVector(u, v),
  };
}

// Wind as a vector pointing where it comes from (so it can be averaged).
const windVector = ({ speed, dir }) => [speed * Math.sin(dir * RAD), speed * Math.cos(dir * RAD)];
const fromVector = (u, v) => ({ speed: Math.hypot(u, v), dir: ((Math.atan2(u, v) / RAD) + 360) % 360 });

function lerpWind(h, b) {
  const at = (i) => windVector({ speed: h.wind_speed_10m[i] ?? 0, dir: h.wind_direction_10m[i] ?? 0 });
  const [u1, v1] = at(b.i - 1), [u2, v2] = at(b.i);
  return fromVector(u1 + b.f * (u2 - u1), v1 + b.f * (v2 - v1));
}

/** Blend two weather readings: `f` = 0 gives a, 1 gives b. */
function blend(a, b, f) {
  if (!a || !b) return a || b;
  const [u1, v1] = windVector(a), [u2, v2] = windVector(b);
  const mix = (x, y) => (x == null || y == null ? x ?? y : x + f * (y - x));
  return {
    temp: mix(a.temp, b.temp), rain: mix(a.rain, b.rain), prob: mix(a.prob, b.prob),
    gust: mix(a.gust, b.gust), code: f < 0.5 ? a.code : b.code,
    ...fromVector(u1 + f * (u2 - u1), v1 + f * (v2 - v1)),
  };
}

// ------------------------------------------------------------------ the ride

/**
 * The weather of one ride.
 * - line: the route geometry [[lat, lon], ...] in its stored direction
 * - samples: samplePoints(line), with `samples[i].loc` the Open-Meteo location of that point
 * - start: unix seconds of the start; speed: average speed in km/h
 * - reverse: ride the route the other way
 * Returns {points, stretches, summary}; summary.complete is false when the ride runs past
 * the end of the forecast.
 */
export function rideWeather({ line, samples, start, speed, reverse = false }) {
  const path = reverse ? [...line].reverse() : line;
  const cum = cumulativeMetres(path);
  const total = cum[cum.length - 1];
  const mps = (speed * 1000) / 3600;
  const timeAt = (m) => start + m / mps;
  // Weather points in riding order, with metres along the ridden direction.
  const pts = (reverse ? [...samples].reverse().map((s) => ({ ...s, m: total - s.m })) : samples)
    .map((s) => ({ ...s, time: timeAt(s.m), w: weatherAt(s.loc, timeAt(s.m)) }));

  /** Weather at metres m (between the two nearest weather points, each read at time t). */
  const weatherAlong = (m, t) => {
    let j = 1;
    while (j < pts.length - 1 && pts[j].m < m) j++;
    const a = pts[j - 1], b = pts[j];
    const f = b.m > a.m ? Math.max(0, Math.min(1, (m - a.m) / (b.m - a.m))) : 0;
    return blend(weatherAt(a.loc, t), weatherAt(b.loc, t), f);
  };

  // Every step of the route, then merged into stretches with the same wind effect.
  const stretches = [];
  const acc = { rain: 0, dist: { head: 0, cross: 0, tail: 0, calm: 0 }, headSum: 0, weighted: 0, weights: 0, halves: [[0, 0], [0, 0]] };
  let complete = true;
  for (let i = 1; i < path.length; i++) {
    const len = cum[i] - cum[i - 1];
    if (len <= 0) continue;
    const mid = (cum[i] + cum[i - 1]) / 2;
    const w = weatherAlong(mid, timeAt(mid));
    if (!w) {
      complete = false;
      continue;
    }
    const { effect, head } = windEffect(bearing(path[i - 1], path[i]), w.dir, w.speed);
    acc.dist[effect] += len;
    acc.headSum += head * len;
    // Wind late in the ride counts a bit more: "into the wind first, while you're fresh".
    const weight = 0.75 + (0.5 * mid) / total;
    acc.weighted += windEffort(head, speed) * len * weight;
    acc.weights += len * weight;
    const half = acc.halves[mid < total / 2 ? 0 : 1];
    half[0] += head * len;
    half[1] += len;
    acc.rain += (w.rain * len) / 1000 / speed; // mm per hour x hours on this step
    const last = stretches[stretches.length - 1];
    if (last && last.effect === effect && last.to === i - 1) {
      last.line.push(path[i]);
      last.to = i;
      last.m += len;
      last.headSum += head * len;
    } else {
      stretches.push({ effect, line: [path[i - 1], path[i]], from: i - 1, to: i, m: len, headSum: head * len });
    }
  }
  for (const s of stretches) s.head = s.headSum / s.m;

  const ws = pts.map((p) => p.w).filter(Boolean);
  const covered = acc.dist.head + acc.dist.cross + acc.dist.tail + acc.dist.calm;
  const mean = (h) => (h[1] ? h[0] / h[1] : 0);
  const summary = {
    start, end: timeAt(total), distanceKm: total / 1000, hours: total / 1000 / speed, complete,
    tempMin: ws.length ? Math.min(...ws.map((w) => w.temp)) : null,
    tempMax: ws.length ? Math.max(...ws.map((w) => w.temp)) : null,
    rainMm: acc.rain,
    rainProb: ws.length ? Math.max(...ws.map((w) => w.prob ?? 0)) : null,
    windMax: ws.length ? Math.max(...ws.map((w) => w.speed)) : null,
    gustMax: ws.length ? Math.max(...ws.map((w) => w.gust ?? 0)) : null,
    windDir: ws.length ? fromVector(...ws.map(windVector).reduce((s, v) => [s[0] + v[0], s[1] + v[1]], [0, 0])).dir : null,
    share: Object.fromEntries(Object.entries(acc.dist).map(([k, v]) => [k, covered ? v / covered : 0])),
    headKm: acc.dist.head / 1000,
    tailKm: acc.dist.tail / 1000,
    meanHead: covered ? acc.headSum / covered : 0, // km/h; negative: tailwind on balance
    firstHalfHead: mean(acc.halves[0]),
    secondHalfHead: mean(acc.halves[1]),
    score: acc.weights ? acc.weighted / acc.weights : 0, // wind effort (km/h): lower is easier
  };
  return { points: pts, stretches, summary };
}

/** Compare the ride with the same ride the other way round (same start time): the reversed
 * ride's summary when it is clearly easier on the wind, else null. */
export function reverseAdvice(ride, reversed) {
  const a = ride.summary, b = reversed.summary;
  if (!a.complete || !b.complete) return null;
  return a.score - b.score >= REVERSE_GAIN_KMH ? b : null;
}

/** Start times to compare: every `stepH` hours from `from` to `to` o'clock, as "HH:00". */
export function startTimes(from = 6, to = 18, stepH = 2) {
  const out = [];
  for (let h = from; h <= to; h += stepH) out.push(`${String(h).padStart(2, "0")}:00`);
  return out;
}

// ------------------------------------------------------------------ fetching

async function getJson(url, fetchFn) {
  let res;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new Error(`the weather service (Open-Meteo) could not be reached (${err.message})`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.error) {
    throw new Error(`the weather service answered: ${json?.reason || res.status}`);
  }
  return json;
}

/** Daily forecast for the route (at its middle point) for the calendar. */
export async function fetchDaily(base, point, fetchFn = fetch) {
  return getJson(dailyUrl(base, point), fetchFn).then((json) => ({
    days: parseDaily(json), utcOffset: asArray(json)[0].utc_offset_seconds, timezone: asArray(json)[0].timezone,
  }));
}

/** Hourly forecasts for the weather points; sets samples[i].loc. */
export async function fetchHourly(base, samples, firstDate, lastDate, fetchFn = fetch) {
  const locs = asArray(await getJson(hourlyUrl(base, samples, firstDate, lastDate), fetchFn));
  if (locs.length !== samples.length) throw new Error("the weather service answered for the wrong number of places");
  samples.forEach((s, i) => (s.loc = locs[i]));
  return { samples, utcOffset: locs[0].utc_offset_seconds };
}
