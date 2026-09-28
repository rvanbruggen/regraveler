// GPX reading and writing. A small XML tokenizer instead of DOMParser, so the same code runs
// in the browser, in a Web Worker and under Node tests.

export class GpxError extends Error {}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Local name of a tag: "gpx:trkpt" -> "trkpt". */
const local = (name) => name.slice(name.indexOf(":") + 1).toLowerCase();

/**
 * Parse XML into a light tree: {name, attrs, children, text}. Handles comments, CDATA,
 * processing instructions, DOCTYPE and namespace prefixes. Throws GpxError on garbage.
 */
export function parseXml(text) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  const n = text.length;
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let sawElement = false;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      stack[stack.length - 1].text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      stack[stack.length - 1].text += text.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    tagRe.lastIndex = lt;
    const m = tagRe.exec(text);
    if (!m) throw new GpxError("Could not parse GPX: malformed XML");
    sawElement = true;
    const closing = text[lt + 1] === "/";
    const name = local(m[1]);
    if (closing) {
      // Tolerate unbalanced files: pop up to the matching element.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
    } else {
      const attrs = {};
      for (const a of m[2].matchAll(attrRe)) attrs[local(a[1])] = decodeEntities(a[3] ?? a[4] ?? "");
      const node = { name, attrs, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!m[3]) stack.push(node);
    }
    i = tagRe.lastIndex;
  }
  if (!sawElement) throw new GpxError("Could not parse GPX: not an XML file");
  return root;
}

export const child = (node, name) => node.children.find((c) => c.name === name);
export const children = (node, name) => node.children.filter((c) => c.name === name);
const clean = (s) => {
  if (s == null) return null;
  s = s.trim();
  return s || null;
};
export const textOf = (node, name) => {
  const c = node && child(node, name);
  return c ? clean(c.text) : null;
};

function point(node) {
  const lat = parseFloat(node.attrs.lat);
  const lon = parseFloat(node.attrs.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const e = textOf(node, "ele");
  const ele = e == null ? null : parseFloat(e);
  return [lat, lon, Number.isFinite(ele) ? ele : null];
}

function linkOf(node) {
  const l = node && child(node, "link");
  return l ? clean(l.attrs.href) : null;
}

/**
 * Parse GPX content into tracks: {name, description, link, tracks: [{name, points}]}.
 * Every <trk> with at least two points becomes a track (its segments are joined).
 * Files without tracks fall back to <rte> routes. Points are [lat, lon, ele|null].
 */
export function parseGpx(text) {
  if (typeof text !== "string") text = new TextDecoder("utf-8").decode(text);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const root = parseXml(text);
  const gpx = child(root, "gpx");
  if (!gpx) throw new GpxError("Could not parse GPX: no <gpx> element");

  const tracks = [];
  for (const trk of children(gpx, "trk")) {
    const pts = [];
    for (const seg of children(trk, "trkseg")) {
      for (const p of children(seg, "trkpt")) {
        const q = point(p);
        if (q) pts.push(q);
      }
    }
    if (pts.length >= 2) tracks.push({ name: textOf(trk, "name"), points: pts });
  }
  if (!tracks.length) {
    for (const rte of children(gpx, "rte")) {
      const pts = children(rte, "rtept").map(point).filter(Boolean);
      if (pts.length >= 2) tracks.push({ name: textOf(rte, "name"), points: pts });
    }
  }
  if (!tracks.length) throw new GpxError("GPX file contains no track or route with at least two points");

  const meta = child(gpx, "metadata");
  let link = linkOf(meta) || linkOf(gpx);
  if (!link) for (const trk of children(gpx, "trk")) if ((link = linkOf(trk))) break;
  if (!link) for (const wpt of children(gpx, "wpt")) if ((link = linkOf(wpt))) break;
  return {
    name: textOf(meta, "name") ?? textOf(gpx, "name"),
    description: textOf(meta, "desc") ?? textOf(gpx, "desc"),
    link: link || null,
    tracks,
  };
}

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

/** A GPX 1.1 file with one track. points: [[lat, lon, ele|null], ...] */
export function writeGpx(name, points, description = null, creator = "rerouter") {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd" version="1.1" creator="${escapeXml(creator)}">`,
    "  <metadata>",
    `    <name>${escapeXml(name)}</name>`,
  ];
  if (description) out.push(`    <desc>${escapeXml(description)}</desc>`);
  out.push("  </metadata>", "  <trk>", `    <name>${escapeXml(name)}</name>`);
  if (description) out.push(`    <desc>${escapeXml(description)}</desc>`);
  out.push("    <trkseg>");
  for (const [lat, lon, ele] of points) {
    const e = ele == null || Number.isNaN(ele) ? "" : `<ele>${(Math.round(ele * 10) / 10).toFixed(1)}</ele>`;
    out.push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${e}</trkpt>`);
  }
  out.push("    </trkseg>", "  </trk>", "</gpx>", "");
  return out.join("\n");
}
