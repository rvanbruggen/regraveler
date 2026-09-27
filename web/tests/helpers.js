// Build synthetic tracks and GPX files for tests (port of tests/helpers.py).

// Metres per degree latitude (approximately; good enough to build test tracks).
export const M_PER_DEG_LAT = 111320.0;

export function offset(lat, lon, northM, eastM) {
  const dlat = northM / M_PER_DEG_LAT;
  const dlon = eastM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [lat + dlat, lon + dlon];
}

/** Points along a straight line. `ele` is a function of distance (m) or null. */
export function linePoints({ start = [51.0, 4.4], lengthM = 5000, stepM = 10, headingDeg = 90, ele = null } = {}) {
  const n = Math.floor(lengthM / stepM + 1e-9);
  const h = (headingDeg * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const d = i * stepM;
    const [lat, lon] = offset(start[0], start[1], d * Math.cos(h), d * Math.sin(h));
    pts.push([lat, lon, ele ? ele(d) : null]);
  }
  return pts;
}

/** Closed circle; start == end. */
export function loopPoints({ center = [51.0, 4.4], radiusM = 2000, n = 400, ele = null } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    const [lat, lon] = offset(center[0], center[1], radiusM * Math.cos(a), radiusM * Math.sin(a));
    pts.push([lat, lon, ele ? ele(i) : null]);
  }
  return pts;
}

/** tracks: [[trackName, points or [segment, ...]], ...] */
export function gpxXml(tracks, { name = null, link = null, useRoute = false } = {}) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="tests" xmlns="http://www.topografix.com/GPX/1/1">'];
  if (name || link) {
    out.push("<metadata>");
    if (name) out.push(`<name>${name}</name>`);
    if (link) out.push(`<link href="${link}"></link>`);
    out.push("</metadata>");
  }
  for (let [tname, segs] of tracks) {
    if (segs.length && typeof segs[0][0] === "number") segs = [segs];
    const pt = ([lat, lon, e], tag) => `<${tag} lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${e != null ? `<ele>${e.toFixed(2)}</ele>` : ""}</${tag}>`;
    if (useRoute) {
      out.push("<rte>");
      if (tname) out.push(`<name>${tname}</name>`);
      for (const seg of segs) for (const p of seg) out.push(pt(p, "rtept"));
      out.push("</rte>");
      continue;
    }
    out.push("<trk>");
    if (tname) out.push(`<name>${tname}</name>`);
    for (const seg of segs) {
      out.push("<trkseg>");
      for (const p of seg) out.push(pt(p, "trkpt"));
      out.push("</trkseg>");
    }
    out.push("</trk>");
  }
  out.push("</gpx>");
  return new TextEncoder().encode(out.join("\n"));
}

/** Seeded pseudo-random numbers (mulberry32), for reproducible noise. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const approx = (actual, expected, { abs = null, rel = null } = {}) => {
  const tol = Math.max(abs ?? 0, rel != null ? Math.abs(expected) * rel : 0, abs == null && rel == null ? 1e-6 * Math.max(1, Math.abs(expected)) : 0);
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`expected ${actual} to be ${expected} ± ${tol}`);
  }
};
