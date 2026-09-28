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
export function gpxXml(tracks, { name = null, link = null, useRoute = false, waypoints = [] } = {}) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="tests" xmlns="http://www.topografix.com/GPX/1/1">'];
  if (name || link) {
    out.push("<metadata>");
    if (name) out.push(`<name>${name}</name>`);
    if (link) out.push(`<link href="${link}"></link>`);
    out.push("</metadata>");
  }
  for (const w of waypoints) {
    out.push(`<wpt lat="${w.lat}" lon="${w.lon}">${w.name ? `<name>${w.name}</name>` : ""}${w.desc ? `<desc>${w.desc}</desc>` : ""}` +
      `${w.sym ? `<sym>${w.sym}</sym>` : ""}${w.type ? `<type>${w.type}</type>` : ""}</wpt>`);
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

// ------------------------------------------------------------------ FIT and TCX test files

const FIT_EPOCH_S = 631065600;

/**
 * A FIT file with the given points [[lat, lon, ele|null], ...] (one per second), built like a
 * device would: file_id, (course), session and record messages. Options exercise the parts of
 * the format real files use: big-endian definitions (Garmin), developer fields (Wahoo), the
 * enhanced altitude field, compressed timestamps, records without a position.
 */
export function fitFile(points, {
  bigEndian = false, fileType = 4, sport = 2, subSport = 0, courseName = null, devFields = false,
  enhancedAltitude = false, compressed = false, noPositionAt = [], start = "2026-09-14T08:00:00Z", fixCrc = true,
  coursePoints = [],
} = {}) {
  const out = [];
  const little = !bigEndian;
  const num = (v, size, signed = false) => {
    const b = new DataView(new ArrayBuffer(size));
    if (size === 1) b.setUint8(0, v);
    else if (size === 2) signed ? b.setInt16(0, v, little) : b.setUint16(0, v, little);
    else signed ? b.setInt32(0, v, little) : b.setUint32(0, v, little);
    return [...new Uint8Array(b.buffer)];
  };
  // fields: [fieldNumber, size, baseType]; dev: [[fieldNumber, size, devIndex]]
  const define = (local, global, fields, dev = null) => {
    out.push(0x40 | (dev ? 0x20 : 0) | local, 0, little ? 0 : 1, ...num(global, 2), fields.length);
    for (const f of fields) out.push(...f);
    if (dev) {
      out.push(dev.length);
      for (const d of dev) out.push(...d);
    }
  };
  const t0 = Math.round(Date.parse(start) / 1000) - FIT_EPOCH_S;

  define(0, 0, [[0, 1, 0x00], [1, 2, 0x84], [4, 4, 0x86]]);
  out.push(0, fileType, ...num(32, 2), ...num(t0, 4));
  if (courseName) {
    define(1, 31, [[5, 16, 0x07]]);
    const name = [...new TextEncoder().encode(courseName)].slice(0, 15);
    out.push(1, ...name, ...new Array(16 - name.length).fill(0));
  }
  define(2, 18, [[2, 4, 0x86], [5, 1, 0x00], [6, 1, 0x00]]);
  out.push(2, ...num(t0, 4), sport, subSport);
  // An unknown manufacturer message, to be skipped.
  define(5, 65280, [[0, 4, 0x86], [1, 3, 0x0d]]);
  out.push(5, ...num(12345, 4), 1, 2, 3);

  if (coursePoints.length) {
    define(6, 32, [[2, 4, 0x85], [3, 4, 0x85], [5, 1, 0x00], [6, 16, 0x07]]);
    for (const cp of coursePoints) {
      const name = [...new TextEncoder().encode(cp.name || "")].slice(0, 15);
      out.push(6, ...num(Math.round((cp.lat / 180) * 2 ** 31), 4, true), ...num(Math.round((cp.lon / 180) * 2 ** 31), 4, true),
        cp.type ?? 0, ...name, ...new Array(16 - name.length).fill(0));
    }
  }
  const alt = enhancedAltitude ? [78, 4, 0x86] : [2, 2, 0x84];
  const posFields = [[0, 4, 0x85], [1, 4, 0x85], alt, [3, 1, 0x02]];
  const dev = devFields ? [[0, 4, 0], [1, 2, 0]] : null;
  define(3, 20, [[253, 4, 0x86], ...posFields], dev);
  // Records with a compressed timestamp header (local types 0-3 only; 2 is free again after the session).
  if (compressed) define(2, 20, posFields, dev);
  const semi = (deg) => Math.round((deg / 180) * 2 ** 31);
  points.forEach(([lat, lon, ele], i) => {
    const t = t0 + i;
    const noPos = noPositionAt.includes(i);
    const fields = [
      ...num(noPos ? 0x7fffffff : semi(lat), 4, true), ...num(noPos ? 0x7fffffff : semi(lon), 4, true),
      ...(ele == null ? num(enhancedAltitude ? 0xffffffff : 0xffff, alt[1]) : num(Math.round((ele + 500) * 5), alt[1])),
      120,
    ];
    const devBytes = devFields ? [9, 9, 9, 9, 7, 7] : [];
    if (compressed && i > 0) out.push(0x80 | (2 << 5) | (t & 0x1f), ...fields, ...devBytes);
    else out.push(3, ...num(t, 4), ...fields, ...devBytes);
  });

  const data = new Uint8Array(out);
  const file = new Uint8Array(14 + data.length + 2);
  const view = new DataView(file.buffer);
  file.set([14, 0x20], 0);
  view.setUint16(2, 2132, true);
  view.setUint32(4, data.length, true);
  file.set([0x2e, 0x46, 0x49, 0x54], 8);
  view.setUint16(12, fitCrcHelper(file, 0, 12), true);
  file.set(data, 14);
  view.setUint16(14 + data.length, fixCrc ? fitCrcHelper(file, 0, 14 + data.length) : 0, true);
  return file;
}

function fitCrcHelper(bytes, start, end) {
  const T = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  let crc = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    let t = T[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ t ^ T[b & 0xf];
    t = T[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ t ^ T[(b >> 4) & 0xf];
  }
  return crc;
}

/** A TCX file: an activity (laps of trackpoints, some without a position) or a course. */
export function tcxXml(points, { course = null, sport = "Biking", start = "2026-09-14T08:00:00Z", noPositionAt = [], laps = 1, coursePoints = [] } = {}) {
  const tp = (p, i) => {
    const time = new Date(Date.parse(start) + i * 1000).toISOString();
    const pos = noPositionAt.includes(i) ? "" :
      `<Position><LatitudeDegrees>${p[0].toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p[1].toFixed(7)}</LongitudeDegrees></Position>`;
    return `<Trackpoint><Time>${time}</Time>${pos}${p[2] != null ? `<AltitudeMeters>${p[2]}</AltitudeMeters>` : ""}<HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>`;
  };
  const per = Math.ceil(points.length / laps);
  const chunks = Array.from({ length: laps }, (_, k) => points.slice(k * per, (k + 1) * per).map((p, j) => tp(p, k * per + j)).join(""));
  const body = course
    ? `<Courses><Course><Name>${course}</Name><Track>${chunks.join("")}</Track>${coursePoints.map((cp) =>
        `<CoursePoint><Name>${cp.name}</Name><Time>${start}</Time><Position><LatitudeDegrees>${cp.lat}</LatitudeDegrees>` +
        `<LongitudeDegrees>${cp.lon}</LongitudeDegrees></Position><PointType>${cp.type}</PointType></CoursePoint>`).join("")}</Course></Courses>`
    : `<Activities><Activity Sport="${sport}"><Id>${start}</Id>${chunks.map((c) => `<Lap StartTime="${start}"><Track>${c}</Track></Lap>`).join("")}</Activity></Activities>`;
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">${body}</TrainingCenterDatabase>`);
}
