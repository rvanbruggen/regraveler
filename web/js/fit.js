// FIT file reading (Garmin, Wahoo, …): the positions, elevation and times of a recorded ride
// (activity) or a planned route (course). Own decoder, no dependencies, so it runs in the
// browser, in a Web Worker and under Node tests.
//
// A FIT file is a header, then records: definition messages (the layout of a "local message
// type": global message number, byte order, fields and developer fields) and data messages
// laid out by the last definition of their local type. We read only what we need and skip
// the rest by its declared size, so unknown and manufacturer messages are harmless.

import { GpxError } from "./gpx.js";

const FIT_EPOCH_S = 631065600; // 1989-12-31T00:00:00Z, the FIT time origin
const SEMICIRCLE = 180 / 2 ** 31;

// Global message numbers and field numbers we read.
const MSG = { FILE_ID: 0, SESSION: 18, RECORD: 20, SPORT: 12, COURSE: 31, COURSE_POINT: 32 };
const TIMESTAMP = 253;

// file_id.type
const FILE_TYPES = { 4: "activity", 6: "course" };

// course_point.type -> words for a place category (poi.js matches them). Turn instructions
// (left, right, forks, …), climb categories, sprints and distance markers are no places.
const COURSE_POINT_WORDS = {
  0: "", 1: "summit", 2: "valley", 3: "water", 4: "food", 5: "danger", 9: "first aid",
  27: "camping", 28: "aid station", 29: "rest area", 31: "service", 32: "food", 33: "water",
  35: "checkpoint", 36: "shelter", 37: "meeting spot", 38: "viewpoint", 39: "toilet",
  40: "shower", 41: "bike", 44: "tunnel", 45: "bridge", 48: "store", 51: "station", 53: "info",
};

// Base types: size, reader, invalid value.
const BASE = {
  0x00: [1, "u8", 0xff], 0x01: [1, "s8", 0x7f], 0x02: [1, "u8", 0xff], 0x07: [1, "str", null],
  0x0a: [1, "u8", 0], 0x0d: [1, "u8", 0xff], 0x83: [2, "s16", 0x7fff], 0x84: [2, "u16", 0xffff],
  0x8b: [2, "u16", 0], 0x85: [4, "s32", 0x7fffffff], 0x86: [4, "u32", 0xffffffff], 0x8c: [4, "u32", 0],
  0x88: [4, "f32", null], 0x89: [8, "f64", null],
};

/** FIT CRC-16 over bytes[start, end). */
export function fitCrc(bytes, start = 0, end = bytes.length, crc = 0) {
  const T = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    let t = T[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ t ^ T[b & 0xf];
    t = T[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ t ^ T[(b >> 4) & 0xf];
  }
  return crc;
}

/** Is this the start of a FIT file? */
export const isFit = (bytes) =>
  bytes.length >= 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54; // ".FIT"

function readValue(view, pos, kind, little, size) {
  switch (kind) {
    case "u8": return view.getUint8(pos);
    case "s8": return view.getInt8(pos);
    case "u16": return view.getUint16(pos, little);
    case "s16": return view.getInt16(pos, little);
    case "u32": return view.getUint32(pos, little);
    case "s32": return view.getInt32(pos, little);
    case "f32": return view.getFloat32(pos, little);
    case "f64": return view.getFloat64(pos, little);
    case "str": {
      let end = pos;
      while (end < pos + size && view.getUint8(end) !== 0) end++;
      return new TextDecoder("utf-8").decode(new Uint8Array(view.buffer, view.byteOffset + pos, end - pos)) || null;
    }
    default: return null;
  }
}

/**
 * Decode the messages of a FIT file. Calls onMessage(globalNumber, fields) for every data
 * message, with fields as {fieldNumber: value} (first element of arrays; invalid values
 * left out; the timestamp of compressed-timestamp messages filled in).
 * Returns {crcOk}. Throws GpxError when the file is not FIT or is cut off in the header.
 */
export function decodeFit(input, onMessage) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isFit(bytes)) throw new GpxError("Not a FIT file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let crcOk = true;
  let start = 0;
  // A file can hold several FIT files one after the other (chained).
  while (start + 12 <= bytes.length && isFit(bytes.subarray(start))) {
    const headerSize = bytes[start];
    if (headerSize < 12 || start + headerSize > bytes.length) throw new GpxError("Damaged FIT file (header)");
    const dataSize = view.getUint32(start + 4, true);
    const end = Math.min(bytes.length, start + headerSize + dataSize);
    if (end + 2 <= bytes.length) crcOk &&= fitCrc(bytes, start, end) === view.getUint16(end, true);
    else crcOk = false;
    const defs = new Map(); // local type -> {global, little, fields: [[num, size, kind, invalid]], devSize}
    let lastTimestamp = null;
    let p = start + headerSize;
    try {
      while (p < end) {
        const h = bytes[p++];
        let def;
        let compressedOffset = null;
        if (h & 0x80) {
          // Compressed timestamp header: local type in bits 5-6, time offset in bits 0-4.
          def = defs.get((h >> 5) & 0x3);
          compressedOffset = h & 0x1f;
        } else if (h & 0x40) {
          const little = bytes[p + 1] === 0;
          const global = view.getUint16(p + 2, little);
          const n = bytes[p + 4];
          p += 5;
          const fields = [];
          for (let i = 0; i < n; i++, p += 3) {
            const [bsize, kind, invalid] = BASE[bytes[p + 2]] || [0, null, null];
            fields.push([bytes[p], bytes[p + 1], kind, invalid, bsize]);
          }
          let devSize = 0;
          if (h & 0x20) {
            const nd = bytes[p++];
            for (let i = 0; i < nd; i++, p += 3) devSize += bytes[p + 1];
          }
          defs.set(h & 0x0f, { global, little, fields, devSize });
          continue;
        } else def = defs.get(h & 0x0f);
        if (!def) throw new GpxError("Damaged FIT file (data before its definition)");
        const values = {};
        for (const [num, size, kind, invalid, bsize] of def.fields) {
          // Arrays and odd sizes: read the first element when the size fits the base type.
          if (kind && (kind === "str" || (bsize && size >= bsize && size % bsize === 0)) && p + size <= end) {
            const v = readValue(view, p, kind, def.little, size);
            if (v !== invalid && v != null && !(typeof v === "number" && Number.isNaN(v))) values[num] = v;
          }
          p += size;
        }
        p += def.devSize;
        if (compressedOffset != null && lastTimestamp != null) {
          values[TIMESTAMP] = lastTimestamp + ((compressedOffset - (lastTimestamp & 0x1f)) & 0x1f);
        }
        if (values[TIMESTAMP] != null) lastTimestamp = values[TIMESTAMP];
        onMessage(def.global, values);
      }
    } catch (err) {
      if (err instanceof GpxError) throw err;
      // Cut off in the middle of a message (a device that stopped writing): keep what we have.
      if (!(err instanceof RangeError)) throw err;
      crcOk = false;
    }
    start = end + 2;
  }
  return { crcOk };
}

// FIT sport / sub_sport -> rerouter activity (null: not known, use the batch's activity).
function activityOf(sport, subSport) {
  if (sport === 1 || sport === 11 || sport === 17) return "hiking"; // running, walking, hiking
  if (sport === 2) {
    if (subSport === 8 || subSport === 9) return "mtb"; // mountain, downhill
    if (subSport === 7) return "road";
    if (subSport === 11 || subSport === 46) return "gravel"; // cyclocross, gravel cycling
  }
  return null;
}

const isoTime = (fitSeconds) => (fitSeconds == null ? null : new Date((fitSeconds + FIT_EPOCH_S) * 1000).toISOString());

/**
 * Parse a FIT file into the same shape as parseGpx, plus what the file says about itself:
 * {format: "fit", name, description, link, tracks: [{name, points}], kind: "activity" |
 *  "course" | null, activity, started_at, crc_ok}. Points are [lat, lon, ele|null].
 */
export function parseFit(input) {
  const points = [], waypoints = [];
  let kind = null, name = null, sport = null, subSport = null, started = null, firstTime = null;
  const { crcOk } = decodeFit(input, (msg, f) => {
    if (msg === MSG.RECORD) {
      if (f[0] == null || f[1] == null) return; // no position (e.g. indoors, or before a fix)
      const alt = f[78] ?? f[2];
      const lat = f[0] * SEMICIRCLE, lon = f[1] * SEMICIRCLE;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      points.push([lat, lon, alt == null ? null : Math.round((alt / 5 - 500) * 10) / 10]);
      if (firstTime == null && f[TIMESTAMP] != null) firstTime = f[TIMESTAMP];
    } else if (msg === MSG.FILE_ID) {
      kind = FILE_TYPES[f[0]] ?? kind;
    } else if (msg === MSG.SESSION) {
      sport ??= f[5] ?? null;
      subSport ??= f[6] ?? null;
      started ??= f[2] ?? null;
    } else if (msg === MSG.SPORT) {
      sport ??= f[0] ?? null;
      subSport ??= f[1] ?? null;
      name ??= f[3] ?? null;
    } else if (msg === MSG.COURSE_POINT) {
      const type = f[5] ?? 0;
      if (f[2] == null || f[3] == null || !(type in COURSE_POINT_WORDS)) return;
      if (type === 0 && !f[6]) return; // a generic point without a name
      waypoints.push({
        name: f[6] || null, description: null, lat: f[2] * SEMICIRCLE, lon: f[3] * SEMICIRCLE,
        symbol: null, type: COURSE_POINT_WORDS[type] || null, link: null,
      });
    } else if (msg === MSG.COURSE) {
      name = f[5] ?? name;
      sport ??= f[4] ?? null;
      subSport ??= f[7] ?? null;
    }
  });
  if (points.length < 2) throw new GpxError("FIT file contains no track with at least two positions");
  return {
    format: "fit",
    name,
    description: null,
    link: null,
    tracks: [{ name, points }],
    waypoints,
    kind,
    activity: activityOf(sport, subSport),
    started_at: isoTime(started ?? firstTime),
    crc_ok: crcOk,
  };
}
