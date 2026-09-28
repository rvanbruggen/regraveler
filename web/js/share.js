// Share links: a route packed into the part of a link after "#", so it goes from one browser to
// another without being stored anywhere (browsers never send that part to a server). The
// track is simplified until the link is short enough for chat apps and email, compressed and
// written in URL-safe base64; a page that opens such a link shows the route read-only, with
// "Download GPX" and "Add to my library".
//
// Privacy: the start and end of a route near home can be left out (cutPrivacy): the shared
// track then begins and ends where it leaves the zone around home.

import { cumulativeDistance, geodesicDistance, simplify, toMetric } from "./geo.js";

export const SHARE_VERSION = 1;
export const TARGET_CHARS = 7000; // the packed route, at most (the link adds the site address)
const TOLERANCES_M = [5, 10, 15, 20, 30, 45, 65, 90, 130, 180, 250];

// ------------------------------------------------------------------ polyline

/**
 * Encode [[lat, lon, ele|null], ...] as three interleaved delta sequences in Google's polyline
 * format: latitude and longitude at 1e-5 degrees (about 1 m), elevation in whole metres
 * (missing elevation: the previous one).
 */
export function encodePolyline(points) {
  let out = "";
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  let plat = 0, plon = 0, pele = 0;
  for (const [lat, lon, ele] of points) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
    const e = ele == null || Number.isNaN(ele) ? pele : Math.round(ele);
    enc(la - plat);
    enc(lo - plon);
    enc(e - pele);
    plat = la;
    plon = lo;
    pele = e;
  }
  return out;
}

export function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0, ele = 0;
  const dec = () => {
    let shift = 0, result = 0, b;
    do {
      if (i >= str.length) throw new ShareError("This link is damaged (cut off?)");
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += dec();
    lon += dec();
    ele += dec();
    out.push([lat / 1e5, lon / 1e5, ele]);
  }
  return out;
}

export class ShareError extends Error {}

// ------------------------------------------------------------------ privacy

/**
 * Leave out the start and end of a route within `radiusM` of home: the track begins where it
 * first leaves the zone and ends where it last is outside it. A route that passes near home
 * in the middle keeps that part (only the ends give away where someone lives). Returns the
 * points, and how many metres were cut off at each end.
 */
export function cutPrivacy(points, home, radiusM) {
  if (!home || !(radiusM > 0)) return { points, cut_start_m: 0, cut_end_m: 0 };
  const inside = (p) => geodesicDistance(p[0], p[1], home.lat, home.lon) <= radiusM;
  let a = 0, b = points.length - 1;
  while (a <= b && inside(points[a])) a++;
  while (b >= a && inside(points[b])) b--;
  if (b - a < 1) throw new ShareError("The whole route lies within the privacy zone around your home: there is nothing to share");
  const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
  const cum = cumulativeDistance(lats, lons);
  return { points: points.slice(a, b + 1), cut_start_m: Math.round(cum[a]), cut_end_m: Math.round(cum[cum.length - 1] - cum[b]) };
}

// ------------------------------------------------------------------ packing

async function deflate(text) {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const toBase64Url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (str) => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

function simplified(points, tol) {
  const xy = points.map(([lat, lon]) => toMetric(lat, lon));
  const keep = new Set(simplify(xy.map((p, i) => [p[0], p[1], i]), tol).map((p) => p[2]));
  return points.filter((_, i) => keep.has(i));
}

/** The surface estimate in km per kind, without its map segments (those are big). */
function surfaceSummary(s) {
  if (!s) return null;
  const km = (k) => Math.round((s[`${k}_km`] || 0) * 10) / 10;
  return { paved_km: km("paved"), cobbles_km: km("cobbles"), unpaved_km: km("unpaved"), unknown_km: km("unknown") };
}

/**
 * Pack a route for a link: {name, activity, distance_km, elevation_gain_m, is_loop, surface,
 * notes, source_url, points: [[lat, lon, ele], ...]}. The track is simplified (5 m, then more)
 * until the packed text is at most `target` characters. Returns {packed, tolerance_m, points}.
 */
export async function packShare(route, { target = TARGET_CHARS } = {}) {
  const base = {
    v: SHARE_VERSION, n: route.name, a: route.activity || null, d: route.distance_km, g: route.elevation_gain_m,
    l: route.is_loop ? 1 : 0, s: surfaceSummary(route.surface), t: route.notes || null, u: route.source_url || null,
  };
  let last = null;
  for (const tol of TOLERANCES_M) {
    const pts = simplified(route.points, tol);
    const packed = toBase64Url(await deflate(JSON.stringify({ ...base, p: encodePolyline(pts) })));
    last = { packed, tolerance_m: tol, points: pts.length };
    if (packed.length <= target) return last;
  }
  return last; // a very long route: as small as it gets
}

/** Unpack a shared route: {name, activity, distance_km, elevation_gain_m, is_loop, surface, notes, source_url, points}. */
export async function unpackShare(packed) {
  let data;
  try {
    data = JSON.parse(await inflate(fromBase64Url(packed)));
  } catch {
    throw new ShareError("This link is damaged or incomplete: ask for it again (a chat app may have cut it off)");
  }
  if (!data || data.v !== SHARE_VERSION || typeof data.p !== "string") {
    throw new ShareError("This link was made by another version of rerouter and can't be read here");
  }
  const points = decodePolyline(data.p);
  if (points.length < 2) throw new ShareError("This link holds no route");
  return {
    name: String(data.n || "Shared route"), activity: data.a || null, distance_km: data.d ?? null,
    elevation_gain_m: data.g ?? null, is_loop: !!data.l, surface: data.s || null, notes: data.t || null,
    source_url: /^https?:\/\//i.test(data.u || "") ? data.u : null, points,
  };
}
