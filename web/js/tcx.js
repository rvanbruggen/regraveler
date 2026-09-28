// TCX (Garmin Training Center XML) reading: recorded activities and planned courses.
// Uses the same small XML reader as gpx.js, so it runs in the browser and under Node.

import { GpxError, child, children, parseXml, textOf } from "./gpx.js";

// TCX Sport attribute -> rerouter activity (null: not known, use the batch's activity).
const SPORTS = { running: "hiking", walking: "hiking", hiking: "hiking" };

/** The points of a <Track>: [lat, lon, ele|null], skipping trackpoints without a position. */
function trackPoints(track, out) {
  for (const tp of children(track, "trackpoint")) {
    const pos = child(tp, "position");
    if (!pos) continue;
    const lat = parseFloat(textOf(pos, "latitudedegrees"));
    const lon = parseFloat(textOf(pos, "longitudedegrees"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const e = parseFloat(textOf(tp, "altitudemeters"));
    out.push([lat, lon, Number.isFinite(e) ? e : null]);
  }
  return out;
}

/**
 * Parse TCX content into the same shape as parseGpx, plus {format: "tcx", kind: "activity" |
 * "course", activity, started_at}. Every <Activity> (its laps joined) or <Course> with at
 * least two positions becomes a track.
 */
export function parseTcx(text) {
  if (typeof text !== "string") text = new TextDecoder("utf-8").decode(text);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const db = child(parseXml(text), "trainingcenterdatabase");
  if (!db) throw new GpxError("Could not parse TCX: no <TrainingCenterDatabase> element");

  const tracks = [];
  let kind = null, activity = null, started = null;
  for (const act of children(child(db, "activities") || { children: [] }, "activity")) {
    const pts = [];
    for (const lap of children(act, "lap")) for (const t of children(lap, "track")) trackPoints(t, pts);
    if (pts.length < 2) continue;
    kind = "activity";
    activity ??= SPORTS[(act.attrs.sport || "").toLowerCase()] ?? null;
    const id = textOf(act, "id");
    started ??= id && !Number.isNaN(Date.parse(id)) ? new Date(id).toISOString() : null;
    tracks.push({ name: null, points: pts });
  }
  for (const course of children(child(db, "courses") || { children: [] }, "course")) {
    const pts = [];
    for (const t of children(course, "track")) trackPoints(t, pts);
    if (pts.length < 2) continue;
    kind ??= "course";
    tracks.push({ name: textOf(course, "name"), points: pts });
  }
  // Course points that are places (not turn instructions or climb categories).
  const waypoints = [];
  for (const course of children(child(db, "courses") || { children: [] }, "course")) {
    for (const cp of children(course, "coursepoint")) {
      const type = (textOf(cp, "pointtype") || "Generic").toLowerCase();
      if (/^(left|right|straight|sprint|hors category|\d\w* category)$/.test(type)) continue;
      const pos = child(cp, "position");
      const lat = parseFloat(pos && textOf(pos, "latitudedegrees")), lon = parseFloat(pos && textOf(pos, "longitudedegrees"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      waypoints.push({
        name: textOf(cp, "name"), description: textOf(cp, "notes"), lat, lon,
        symbol: null, type: type === "generic" ? null : type, link: null,
      });
    }
  }
  if (!tracks.length) throw new GpxError("TCX file contains no activity or course with at least two positions");
  return {
    format: "tcx",
    name: tracks.length === 1 ? tracks[0].name : null,
    description: null,
    link: null,
    tracks,
    waypoints,
    kind,
    activity,
    started_at: started,
  };
}
