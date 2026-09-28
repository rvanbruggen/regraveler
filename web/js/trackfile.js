// Route files of any supported format: GPX, TCX and FIT, also gzip-compressed (as in a Strava
// bulk export). The original file is stored as it is; everything that reads a route's file
// goes through parseTrackFile, which recognises the format from the content.

import { isFit, parseFit } from "./fit.js";
import { GpxError, parseGpx } from "./gpx.js";
import { parseTcx } from "./tcx.js";

export const FORMATS = ["gpx", "tcx", "fit"];

/** File names we import: route.gpx, ride.fit, ride.tcx.gz, … */
export const isTrackFileName = (name) => /\.(gpx|tcx|fit)(\.gz)?$/i.test(name);

/** Format of a file name ("gpx", "tcx", "fit"), or null. */
export function formatOfName(name) {
  const m = /\.(gpx|tcx|fit)(\.gz)?$/i.exec(name || "");
  return m ? m[1].toLowerCase() : null;
}

const isGzip = (bytes) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Format of the content: "fit", "tcx", "gpx", "gzip" or null. */
export function detectFormat(data) {
  if (typeof data === "string") data = new TextEncoder().encode(data.slice(0, 2048));
  if (isGzip(data)) return "gzip";
  if (isFit(data)) return "fit";
  const head = new TextDecoder("utf-8").decode(data.subarray(0, 2048));
  if (/<TrainingCenterDatabase[\s>]/.test(head)) return "tcx";
  if (/<gpx[\s>]/.test(head)) return "gpx";
  return null;
}

/**
 * Unpack a gzip-compressed file: {data, name} with the data decompressed and ".gz" removed
 * from the name. Other files are returned as they are.
 */
export async function unwrapFile(data, name) {
  if (!isGzip(data)) return { data, name };
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return { data: out, name: name.replace(/\.gz$/i, "") };
}

/**
 * Parse a route file (bytes or text) in any supported format: {format, name, description,
 * link, tracks: [{name, points}], kind, activity, started_at}. `kind` is "activity" for a
 * recorded ride, "course" for a planned route from a device, null for GPX; `activity` is
 * what the file says (or null).
 */
export function parseTrackFile(data) {
  const format = detectFormat(data);
  if (format === "fit") return parseFit(data);
  if (format === "tcx") return parseTcx(data);
  if (format === "gzip") throw new GpxError("Compressed file: unpack it first");
  // GPX, and anything unknown gets the GPX reader's error message.
  return { format: "gpx", kind: null, activity: null, started_at: null, ...parseGpx(data) };
}

/** Only the waypoints of a route file (a GPX file may have no track at all). */
export function fileWaypoints(data) {
  const format = detectFormat(data);
  if (format === "gpx" || format === null) return parseGpx(data, { waypointsOnly: true }).waypoints;
  return parseTrackFile(data).waypoints || [];
}

/** Extension for a stored file: its own format, else gpx. */
export const extensionOf = (name) => formatOfName(name) || "gpx";

export const MEDIA_TYPES = { gpx: "application/gpx+xml", tcx: "application/vnd.garmin.tcx+xml", fit: "application/vnd.ant.fit" };
