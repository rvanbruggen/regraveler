// Places (points of interest): cafés, water, stations, photo spots, … Pure functions: reading
// place lists from Google My Maps (KML/KMZ and CSV exports) and other CSV files, suggesting a
// category, and finding the places along a route. Stored as documents (db.js) by service.js.

import { closestOnSegment, cumulative, lineToMetric, toMetric } from "./geo.js";
import { child, children, GpxError, parseXml, textOf } from "./gpx.js";
import { fileWaypoints, isTrackFileName, unwrapFile } from "./trackfile.js";
import { readZip } from "./zip.js";

export class PlacesError extends GpxError {}

/**
 * Built-in categories; imports and the user can add more (kept in the POI_CATEGORIES
 * setting). `words`: what a layer or icon name has in it for the category to be suggested
 * (Dutch, English, French; matched on word starts).
 */
export const DEFAULT_CATEGORIES = [
  { id: "water", label: "Drinking water", symbol: "💧", color: "#1a73e8", words: ["water", "drinking", "drinkwater", "fontein", "fountain", "kraantje", "bron", "source", "fontaine"] },
  { id: "toilet", label: "Toilet", symbol: "🚻", color: "#6d4c41", words: ["toilet", "wc", "restroom", "sanitair", "toilette", "shower"] },
  { id: "cafe", label: "Café / bar", symbol: "☕", color: "#8e24aa", words: ["café", "cafe", "bar", "bars", "pub", "kroeg", "beer", "bier", "coffee", "koffie", "estaminet", "brasserie", "tavern", "taverne", "herberg"] },
  { id: "food", label: "Restaurant / food", symbol: "🍴", color: "#e65100", words: ["restaurant", "food", "eten", "snack", "bakery", "bakker", "boulangerie", "pizza", "lunch", "fork"] },
  { id: "frituur", label: "Frituur", symbol: "🍟", color: "#f9a825", words: ["frituur", "frit", "frites", "friet", "friterie", "fritkot", "frietkot", "snackbar"] },
  { id: "bike", label: "Bike shop / repair", symbol: "🔧", color: "#2e7d32", words: ["bike", "bikes", "fiets", "bicycle", "velo", "vélo", "repair", "herstel", "cycling"] },
  { id: "station", label: "Train station", symbol: "🚉", color: "#37474f", words: ["station", "train", "trein", "gare", "railway", "spoor"] },
  { id: "sight", label: "Sight / museum", symbol: "🏛", color: "#c62828", words: ["museum", "musea", "sight", "sights", "bezienswaardig", "monument", "church", "kerk", "castle", "kasteel", "attraction", "landmark", "places to see"] },
  { id: "photo", label: "Photo spot", symbol: "📷", color: "#00838f", words: ["photo", "foto", "view", "uitzicht", "viewpoint", "panorama", "camera", "scenic", "overlook", "summit"] },
  { id: "shelter", label: "Shelter / picnic", symbol: "⛺", color: "#558b2f", words: ["shelter", "picnic", "picknick", "schuil", "bench", "rest area"] },
  { id: "lodging", label: "Hotel / lodging", symbol: "🛏", color: "#3949ab", words: ["hotel", "hotels", "b&b", "lodging", "camping", "campground", "campsite", "hostel", "overnachten", "bed"] },
  { id: "parking", label: "Parking", symbol: "🅿", color: "#546e7a", words: ["parking", "parkeren"] },
  { id: "other", label: "Other", symbol: "📍", color: "#757575", words: [] },
];

// Colours for categories made from an import (a new layer name), in turn.
export const EXTRA_COLORS = ["#ad1457", "#6a1b9a", "#00695c", "#9e9d24", "#ef6c00", "#4e342e", "#283593", "#0277bd"];

const norm = (s) => String(s || "").toLowerCase().normalize("NFC");

/** The category whose words appear in `text` (a layer name, an icon file name), or null. */
export function matchCategory(text, categories = DEFAULT_CATEGORIES) {
  const t = ` ${norm(text).replace(/[^\p{L}\p{N}&]+/gu, " ")} `;
  for (const c of categories) {
    for (const w of c.words || []) {
      const word = norm(w).replace(/[^\p{L}\p{N}&]+/gu, " ").trim();
      // Word starts: "kroegtijgers" matches "kroeg", "rebar" doesn't match "bar".
      if (word && t.includes(` ${word}`)) return c.id;
    }
  }
  return null;
}

/** A category id for a new category called `label`. */
export function categoryId(label) {
  const id = norm(label).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return id.slice(0, 30) || "category";
}

// ------------------------------------------------------------------ KML / KMZ

const stripHtml = (s) =>
  s == null ? null : s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim() || null;

/** "lon,lat[,alt]" -> [lat, lon] or null. */
function kmlPoint(text) {
  const [lon, lat] = String(text || "").trim().split(/[\s]+/)[0].split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

/**
 * Read a KML document: {name, layers: [{name, places: [{name, description, lat, lon, icon}]}],
 * skipped} with one layer per folder (places outside folders go in a layer named after the
 * document). Only points are places; lines and areas are counted in `skipped`.
 */
export function parseKml(text) {
  const d = readKml(text);
  if (!d.layers.length) throw new PlacesError("No places (points) in this file");
  return d;
}

/** The areas (polygons) in a KML document: [{name, polygon: [[lat, lon], ...]}] (outer rings). */
export function parseKmlAreas(text) {
  const { areas } = readKml(text);
  if (!areas.length) throw new PlacesError("No areas (polygons) in this file");
  return areas;
}

/** Read the areas of a KML or KMZ file (e.g. drawn in Google My Maps). */
export async function readAreasFile(bytes, filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".kmz")) {
    const entries = await readZip(bytes);
    const kml = entries.find((e) => e.name.toLowerCase() === "doc.kml") || entries.find((e) => /\.kml$/i.test(e.name));
    if (!kml) throw new PlacesError("No KML document in this KMZ file");
    return parseKmlAreas(kml.data);
  }
  if (lower.endsWith(".kml")) return parseKmlAreas(bytes);
  throw new PlacesError("Areas can be imported from KML or KMZ files (e.g. from Google My Maps)");
}

function readKml(text) {
  if (typeof text !== "string") text = new TextDecoder("utf-8").decode(text);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const kml = child(parseXml(text), "kml");
  if (!kml) throw new PlacesError("Not a KML file (no <kml> element)");
  const doc = child(kml, "document") || kml;
  const docName = textOf(doc, "name");

  // Icon of each style; a StyleMap points to the style of its "normal" state.
  const icons = new Map(), maps = new Map();
  const walkStyles = (node) => {
    for (const s of children(node, "style")) {
      const icon = child(child(s, "iconstyle") || { children: [] }, "icon");
      icons.set(s.attrs.id, icon ? textOf(icon, "href") : null);
    }
    for (const m of children(node, "stylemap")) {
      const normal = children(m, "pair").find((p) => textOf(p, "key") === "normal");
      if (normal) maps.set(m.attrs.id, (textOf(normal, "styleurl") || "").replace(/^#/, ""));
    }
    for (const f of children(node, "folder")) walkStyles(f);
  };
  walkStyles(doc);
  const iconOf = (styleUrl) => {
    let id = (styleUrl || "").replace(/^#/, "");
    if (maps.has(id)) id = maps.get(id);
    return icons.get(id) ?? (id || null);
  };

  const layers = [], areas = [];
  let skipped = 0;
  const ringOf = (poly) => {
    const outer = child(poly, "outerboundaryis");
    const ring = outer && child(outer, "linearring");
    const coords = ring ? textOf(ring, "coordinates") : null;
    const pts = (coords || "").trim().split(/\s+/).map((t) => t.split(",").map(Number))
      .filter(([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon)).map(([lon, lat]) => [lat, lon]);
    return pts.length >= 3 ? pts : null;
  };
  const placesIn = (node) => {
    const out = [];
    for (const pm of children(node, "placemark")) {
      // Areas: a Polygon, or the polygons of a MultiGeometry (the first one).
      const multi = child(pm, "multigeometry");
      const poly = child(pm, "polygon") || (multi && child(multi, "polygon"));
      if (poly) {
        const ring = ringOf(poly);
        if (ring) areas.push({ name: textOf(pm, "name") || "Area", polygon: ring });
      }
      const point = child(pm, "point");
      const ll = point && kmlPoint(textOf(point, "coordinates"));
      if (!ll) {
        skipped++;
        continue;
      }
      out.push({
        name: textOf(pm, "name") || "Unnamed place",
        description: stripHtml(textOf(pm, "description")),
        lat: ll[0],
        lon: ll[1],
        icon: iconOf(textOf(pm, "styleurl")),
      });
    }
    return out;
  };
  const top = placesIn(doc);
  if (top.length) layers.push({ name: docName || "Places", places: top });
  const walkFolders = (node, prefix) => {
    for (const f of children(node, "folder")) {
      const name = [prefix, textOf(f, "name") || "Folder"].filter(Boolean).join(" / ");
      const places = placesIn(f);
      if (places.length) layers.push({ name, places });
      walkFolders(f, name);
    }
  };
  walkFolders(doc, null);
  return { name: docName, layers, skipped, areas };
}

/** Read a KMZ file (a zip with a KML document inside). */
export async function parseKmz(bytes) {
  const entries = await readZip(bytes);
  const kml = entries.find((e) => e.name.toLowerCase() === "doc.kml") || entries.find((e) => /\.kml$/i.test(e.name));
  if (!kml) throw new PlacesError("No KML document in this KMZ file");
  return parseKml(kml.data);
}

// ------------------------------------------------------------------ CSV

/** Split CSV text into rows of fields (quotes, doubled quotes, newlines in quotes). */
export function parseCsv(text, sep = null) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!sep) {
    const first = text.slice(0, text.search(/\r?\n|$/));
    const count = (c) => first.split(c).length - 1;
    sep = count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ",";
  }
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return { rows, sep };
}

const HEADERS = {
  name: ["name", "naam", "nom", "title", "titel", "place", "plaats"],
  lat: ["lat", "latitude", "breedte", "breedtegraad", "y"],
  lon: ["lon", "lng", "long", "longitude", "lengte", "lengtegraad", "x"],
  latlon: ["latlon", "lat,lon", "lat lon", "coordinates", "coördinaten", "coordinaten", "location", "locatie", "gps"],
  wkt: ["wkt", "geometry", "geometrie"],
  category: ["category", "categorie", "type", "soort", "kind", "catégorie"],
  notes: ["notes", "note", "description", "beschrijving", "omschrijving", "notities", "opmerking", "desc"],
  url: ["url", "link", "website", "web", "photos", "foto's", "album"],
};

const num = (s, decimalComma) => {
  s = String(s ?? "").trim();
  if (decimalComma) s = s.replace(",", ".");
  return s === "" ? NaN : Number(s);
};

/**
 * Read places from CSV: a Google My Maps layer export (WKT "POINT (lon lat)", name,
 * description) or any table with name and lat/lon (or "lat, lon" in one column) columns,
 * optionally category/type, notes/description and url/link. `filename` gives the list and
 * layer names ("Map name - Layer.csv" from My Maps). Returns the same shape as parseKml.
 */
export function parsePlacesCsv(text, filename = "places.csv") {
  if (typeof text !== "string") text = new TextDecoder("utf-8").decode(text);
  const { rows, sep } = parseCsv(text);
  if (rows.length < 2) throw new PlacesError("No places in this CSV file (it needs a header row and at least one place)");
  const header = rows[0].map((h) => norm(h).trim());
  const col = (key) => header.findIndex((h) => HEADERS[key].includes(h));
  const c = Object.fromEntries(Object.keys(HEADERS).map((k) => [k, col(k)]));
  if (c.name < 0) c.name = header.findIndex((h, i) => !Object.values(c).includes(i)); // first unknown column
  if (c.wkt < 0 && c.latlon < 0 && (c.lat < 0 || c.lon < 0)) {
    throw new PlacesError("No coordinates found: the CSV needs lat and lon columns (or WKT, or one \"lat, lon\" column)");
  }
  const decimalComma = sep === ";";
  const places = [];
  let skipped = 0;
  for (const raw of rows.slice(1)) {
    let r = raw;
    // An unquoted comma inside a name (My Maps writes `Poppemieke, Café`): too many fields.
    // Join the extra ones back into the name column.
    if (r.length > header.length && c.name >= 0) {
      const extra = r.length - header.length;
      r = [...r.slice(0, c.name), r.slice(c.name, c.name + extra + 1).join(sep), ...r.slice(c.name + extra + 1)];
    }
    let lat = NaN, lon = NaN;
    if (c.wkt >= 0) {
      const m = /POINT\s*Z?\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(r[c.wkt] || "");
      if (m) [lon, lat] = [Number(m[1]), Number(m[2])];
    } else if (c.latlon >= 0) {
      const parts = String(r[c.latlon] || "").split(/[;,\s]+/).filter(Boolean);
      [lat, lon] = [Number(parts[0]), Number(parts[1])];
    } else {
      lat = num(r[c.lat], decimalComma);
      lon = num(r[c.lon], decimalComma);
    }
    if (!(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) {
      skipped++;
      continue;
    }
    const text = (k) => (c[k] >= 0 ? String(r[c[k]] ?? "").trim() || null : null);
    places.push({
      name: text("name") || "Unnamed place", description: text("notes"), url: text("url"),
      category: text("category"), lat, lon, icon: null,
    });
  }
  if (!places.length) throw new PlacesError("No places with valid coordinates in this CSV file");
  // "Kroegtijgers en Fritleeuwen- Fritleeuwen.csv" (My Maps): map name, then layer name.
  const stem = filename.replace(/\.csv$/i, "");
  const m = /^(.*\S)\s*-\s+(\S.*)$/.exec(stem);
  return { name: m ? m[1] : stem, layers: [{ name: m ? m[2] : stem, places }], skipped };
}

/**
 * The waypoints of a route file (GPX <wpt>, FIT or TCX course points) as places: one layer
 * named after the file (or `name`), same shape as parseKml. The waypoint's symbol and type
 * ("Drinking Water", "Restroom", "water") go into `category` for suggestCategory.
 */
export function waypointPlaces(waypoints, name) {
  const places = waypoints.map((w) => ({
    name: w.name || w.type || w.symbol || "Waypoint",
    description: w.description || null,
    url: w.link || null,
    category: [w.symbol, w.type].filter(Boolean).join(" ") || null,
    lat: w.lat, lon: w.lon, icon: null,
  }));
  if (!places.length) throw new PlacesError("No waypoints in this file");
  return { name, layers: [{ name, places }], skipped: 0 };
}

/** Read a places file by its name: .kml, .kmz, .csv, or a route file's waypoints. */
export async function readPlacesFile(bytes, filename) {
  const lower = filename.toLowerCase();
  if (isTrackFileName(lower)) {
    const { data, name } = await unwrapFile(bytes, filename);
    return waypointPlaces(fileWaypoints(data), name.replace(/\.\w+$/, ""));
  }
  if (lower.endsWith(".kmz")) return parseKmz(bytes);
  if (lower.endsWith(".kml")) return parseKml(bytes);
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) return parsePlacesCsv(bytes, filename);
  throw new PlacesError("Places can be imported from KML, KMZ (Google My Maps) or CSV files, or the waypoints of a GPX, TCX or FIT file");
}

/** Files that are only lists of places (route files can hold waypoints too, see readPlacesFile). */
export const isPlacesFileName = (name) => /\.(kml|kmz|csv)$/i.test(name);

/**
 * Suggested category for one place of a layer: its own category column (CSV), its icon, the
 * layer's name; null when nothing matches (the page then offers a new category named after
 * the layer).
 */
export function suggestCategory(place, layerName, categories = DEFAULT_CATEGORIES) {
  if (place.category) {
    const byLabel = categories.find((c) => norm(c.label) === norm(place.category) || c.id === norm(place.category));
    if (byLabel) return byLabel.id;
    const m = matchCategory(place.category, categories);
    if (m) return m;
  }
  const iconName = place.icon ? place.icon.split("/").pop().replace(/\.\w+$/, "").replace(/[-_]/g, " ") : "";
  return matchCategory(iconName, categories) || matchCategory(layerName, categories);
}

// ------------------------------------------------------------------ along a route

/**
 * Places within `maxM` metres of a route: [{place, km, off_m}] in riding order. `km` is
 * where along the route it is (scaled to the route's own distance), `off_m` how far from
 * the route. A place passed twice (out and back) is listed once, where it is nearest.
 */
export function placesAlong(geometry, distanceKm, places, maxM = 200) {
  if (!geometry || geometry.length < 2 || !places.length) return [];
  const xy = lineToMetric(geometry);
  const cum = cumulative(xy);
  const total = cum[cum.length - 1] || 1;
  const scale = (distanceKm * 1000) / total;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const out = [];
  for (const place of places) {
    const [px, py] = toMetric(place.lat, place.lon);
    if (px < minX - maxM || px > maxX + maxM || py < minY - maxM || py > maxY + maxM) continue;
    let best = Infinity, at = 0;
    for (let i = 0; i < xy.length - 1; i++) {
      const c = closestOnSegment(px, py, xy[i][0], xy[i][1], xy[i + 1][0], xy[i + 1][1]);
      if (c.d < best) {
        best = c.d;
        at = cum[i] + c.t * (cum[i + 1] - cum[i]);
      }
    }
    if (best <= maxM) out.push({ place, km: Math.round((at * scale) / 100) / 10, off_m: Math.round(best) });
  }
  return out.sort((a, b) => a.km - b.km);
}

/** Is there already a place with this name within `withinM` metres (for re-imports)? */
export function isDuplicatePlace(p, existing, withinM = 25) {
  const [x, y] = toMetric(p.lat, p.lon);
  return existing.some((e) => {
    if (norm(e.name).trim() !== norm(p.name).trim()) return false;
    const [ex, ey] = toMetric(e.lat, e.lon);
    return Math.hypot(ex - x, ey - y) <= withinM;
  });
}

/**
 * Places that a leg from `from` to `to` ([lat, lon]) can pass with a small detour (as the
 * crow flies: via the place minus straight on): [{place, detour_km}], smallest first. The
 * allowed detour defaults to 2 km or half the leg, whichever is more.
 */
export function placesNearLeg(from, to, places, maxDetourM = null) {
  const a = toMetric(from[0], from[1]), b = toMetric(to[0], to[1]);
  const direct = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const max = maxDetourM ?? Math.max(2000, direct / 2);
  const out = [];
  for (const place of places) {
    const [x, y] = toMetric(place.lat, place.lon);
    const detour = Math.hypot(x - a[0], y - a[1]) + Math.hypot(b[0] - x, b[1] - y) - direct;
    if (detour <= max) out.push({ place, detour_km: Math.round(detour / 100) / 10 });
  }
  return out.sort((p, q) => p.detour_km - q.detour_km);
}

// ------------------------------------------------------------------ OpenStreetMap

/**
 * OpenStreetMap tags per category: [key, values regex]. Asked from the Overpass API (osm.js);
 * parkings and "other" are left out (far too many).
 */
export const OSM_TAGS = {
  water: [["amenity", "drinking_water|water_point"]],
  toilet: [["amenity", "toilets"]],
  cafe: [["amenity", "cafe|bar|pub|biergarten"]],
  food: [["amenity", "restaurant|fast_food"]],
  frituur: [["amenity", "fast_food"]], // with a chips/friture cuisine, see osmCategory
  bike: [["shop", "bicycle"], ["amenity", "bicycle_repair_station"]],
  station: [["railway", "station|halt"]],
  sight: [["tourism", "attraction|museum"], ["historic", "castle|ruins|monument|archaeological_site"]],
  photo: [["tourism", "viewpoint"]],
  shelter: [["amenity", "shelter"], ["tourism", "picnic_site"]],
  lodging: [["tourism", "hotel|guest_house|hostel|camp_site|chalet|alpine_hut"]],
};
export const OSM_DEFAULT_CATEGORIES = ["water", "toilet", "bike", "station", "shelter", "photo"];

const FRIES = /fri(es|te|ture|terie)|chips|friet/i;

/** The category of an OSM element's tags (null: none we show). */
export function osmCategory(tags = {}) {
  if (tags.amenity === "fast_food" && FRIES.test(tags.cuisine || "")) return "frituur";
  if (tags.railway && tags.station === "subway") return null;
  // Bus stop shelters (most shelters in Belgium) are no place to stop on a ride.
  if (tags.amenity === "shelter" && /public_transport|bus_stop|tram_stop/.test(tags.shelter_type || "")) return null;
  for (const [cat, rules] of Object.entries(OSM_TAGS)) {
    if (cat === "frituur") continue;
    if (rules.some(([k, v]) => tags[k] && new RegExp(`^(${v})$`).test(tags[k]))) return cat;
  }
  return null;
}

/**
 * An Overpass QL query for the categories in one or more bounding boxes [south, west, north,
 * east]. (Bounding boxes, not "around" a route line: Overpass answers those far faster, from
 * its indexes; the places near the route are picked out afterwards with placesAlong. Tested
 * on a 295 km route: one box 11 s, "around" the line timed out after 26 s.)
 */
export function overpassQuery(categories, { bbox = null, bboxes = null } = {}) {
  const boxes = bboxes || [bbox];
  const rules = new Map(); // "key=values" once, even if two categories share it
  for (const c of categories) {
    for (const [k, v] of OSM_TAGS[c] || []) rules.set(`${k}\u0000${v}`, [k, v]);
  }
  if (!rules.size) throw new PlacesError("Choose at least one category to look for on OpenStreetMap");
  const parts = boxes.flatMap((b) => [...rules.values()].map(([k, v]) => `nwr["${k}"~"^(${v})$"](${b.map((x) => x.toFixed(5)).join(",")});`));
  return `[out:json][timeout:40];(${parts.join("")});out center tags;`;
}

/**
 * Bounding boxes covering a route with `padM` metres to spare: the route's own box, or for a
 * long diagonal route, consecutive stretches whose boxes stay under `maxArea` square degrees.
 */
export function routeBoxes(geometry, { padM = 250, maxArea = 0.15 } = {}) {
  const boxOf = (pts) => {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const [la, lo] of pts) {
      s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo);
    }
    const dLat = padM / 111320, dLon = padM / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
    return [s - dLat, w - dLon, n + dLat, e + dLon];
  };
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  const split = (pts) => {
    const b = boxOf(pts);
    if (area(b) <= maxArea || pts.length < 4) return [b];
    const mid = Math.floor(pts.length / 2);
    return [...split(pts.slice(0, mid + 1)), ...split(pts.slice(mid))];
  };
  return split(geometry);
}

/**
 * Places from an Overpass answer, for the wanted categories: [{osm_id, name, lat, lon,
 * category, notes, url, osm_url}]. Unnamed ones get their category's name ("Drinking water").
 */
export function osmPlaces(answer, categories, labels = {}) {
  const wanted = new Set(categories);
  const out = [];
  for (const e of answer?.elements || []) {
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    const tags = e.tags || {};
    const category = osmCategory(tags);
    if (lat == null || lon == null || !category || !wanted.has(category)) continue;
    const notes = [
      tags.opening_hours && `Open: ${tags.opening_hours}`,
      tags.cuisine && `Cuisine: ${tags.cuisine.replace(/;/g, ", ")}`,
      tags.fee && `Fee: ${tags.fee}`,
      tags.description,
    ].filter(Boolean).join("\n") || null;
    const osmUrl = `https://www.openstreetmap.org/${e.type}/${e.id}`;
    out.push({
      osm_id: `${e.type}/${e.id}`, name: tags.name || tags.brand || labels[category] || category,
      lat, lon, category, notes, url: /^https?:\/\//i.test(tags.website || "") ? tags.website : osmUrl, osm_url: osmUrl,
    });
  }
  return out;
}
