// Library backups: one zip with library.json (routes, settings, "not duplicates" decisions)
// and the original route files under gpx/<file hash>.<gpx|tcx|fit>. The same format for the browser
// version and the server (app/store.py), so a library moves between them in either direction.
// The browser's storage can be cleared (site data, private windows, low disk space), so
// backups are also how a browser library survives.
//
// A backup can also hold only some routes (kind "selection"): made from the selected routes in
// the library, and added to a library without replacing what is there. The example route sets
// on the public site (data/seeds/, see tools/build_seeds.py) are such selections.

import { VERSION, config } from "./config.js";
import { newId } from "./db.js";
import { pointInPolygon } from "./geo.js";
import { DEFAULT_CATEGORIES, isDuplicatePlace, placesAlong } from "./poi.js";
import { makeZip, readZip } from "./zip.js";
import { extensionOf } from "./trackfile.js";

/**
 * Where an original file is in the zip: gpx/<hash>.<its own extension> (gpx, tcx or fit; the
 * folder keeps its name so backups from before TCX/FIT support read the same way).
 */
const fileEntry = (f) => `gpx/${f.hash}.${extensionOf(f.name)}`;

export const FORMAT = "rerouter-backup";

/** Zip of the whole library (a Blob). */
export async function makeBackup(library) {
  if (library.remote) return library.backend.backup();
  const dump = await library.dump();
  const files = dump.files.map((f) => ({ hash: f.hash, name: f.name }));
  const manifest = {
    format: FORMAT,
    version: 1,
    app_version: VERSION,
    created_at: new Date().toISOString(),
    routes: dump.routes,
    ignored: dump.ignored,
    settings: dump.settings,
    docs: dump.docs,
    files,
  };
  return makeZip([
    { name: "library.json", data: JSON.stringify(manifest) },
    ...dump.files.map((f) => ({ name: fileEntry(f), data: f.data })),
  ]);
}

/** A route as stored (without transient fields, which start with "_"). */
const stored = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_")));

/**
 * Zip of some routes (a Blob), with their GPX files and the "not duplicates" decisions between
 * them; no settings. `title` and `description` describe the set (e.g. for an example set).
 * `personal: false` leaves out the notes and quality ratings (for a set that is shared).
 * Built in the page, so it works for a server library too (its files are fetched one by one).
 */
export async function makeSelection(library, ids, { title = null, description = null, personal = true, places = true } = {}) {
  const routes = ids.map((id) => library.get(id)).filter(Boolean);
  if (!routes.length) throw new Error("No routes selected");
  const inSet = new Set(routes.map((r) => r.id));
  const files = [];
  for (const hash of new Set(routes.map((r) => r.file_hash))) {
    const f = await library.getFile(hash);
    if (!f) throw new Error(`The GPX file of ${routes.find((r) => r.file_hash === hash).name} is missing`);
    files.push({ hash, name: f.name, data: f.data });
  }
  const manifest = {
    format: FORMAT,
    version: 1,
    kind: "selection",
    title: title || null,
    description: description || null,
    app_version: VERSION,
    created_at: new Date().toISOString(),
    routes: routes.map((r) => (personal ? stored(r) : { ...stored(r), notes: null, quality_rating: null })),
    ignored: [...library.ignored].filter((k) => k.split("_").every((id) => inSet.has(Number(id)))),
    settings: {},
    files: files.map((f) => ({ hash: f.hash, name: f.name })),
    ...(places ? placesOfSet(library, routes, personal) : {}),
  };
  manifest.docs = [...(manifest.docs || []), ...catalogOfSet(library, routes)];
  return makeZip([
    { name: "library.json", data: JSON.stringify(manifest) },
    ...files.map((f) => ({ name: fileEntry(f), data: f.data })),
  ]);
}

/**
 * The places along a set's routes, with their lists and the categories of your own they use:
 * {docs, categories}. Without `personal`, the places' notes are left out too.
 */
function placesOfSet(library, routes, personal) {
  const all = library.docsOf("poi");
  const near = new Map();
  for (const r of routes) {
    for (const { place } of placesAlong(r.geometry, r.distance_km, all, config.PLACES_NEAR_ROUTE_M)) near.set(place.key, place);
  }
  if (!near.size) return {};
  const places = [...near.values()].map((p) => (personal ? { ...p } : { ...p, notes: null }));
  const lists = [...new Set(places.map((p) => p.list_id))].map((id) => library.getDoc("poi_list", id)).filter(Boolean);
  const used = new Set(places.map((p) => p.category));
  const builtIn = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
  const saved = Array.isArray(library.settings.POI_CATEGORIES) ? library.settings.POI_CATEGORIES : [];
  return { docs: [...lists, ...places], categories: saved.filter((c) => used.has(c.id) && !builtIn.has(c.id)) };
}

/**
 * The collections that hold routes of the set (only those routes; their parent collections
 * too, for the path) and the areas the set's routes start in.
 */
function catalogOfSet(library, routes) {
  const ids = new Set(routes.map((r) => r.id));
  const colls = library.docsOf("collection");
  const byId = new Map(colls.map((c) => [c.id, c]));
  const keep = new Map();
  for (const c of colls) {
    const inSet = c.route_ids.filter((id) => ids.has(id));
    if (!inSet.length) continue;
    keep.set(c.id, { ...c, route_ids: inSet });
    for (let p = byId.get(c.parent_id); p && !keep.has(p.id); p = byId.get(p.parent_id)) keep.set(p.id, { ...p, route_ids: [] });
  }
  const areas = library.docsOf("area").filter((a) => routes.some((r) => pointInPolygon(r.start_lat, r.start_lon, a.polygon)));
  return [...keep.values(), ...areas];
}

/**
 * Add the collections and areas of a set (or a backup) to a library: collections with the
 * same name in the same place are merged (routes by their new ids, `idMap`: id in the set ->
 * id in the library), areas the library already has (by name) are left as they are.
 */
async function addCatalog(library, docs, idMap) {
  const colls = docs.filter((d) => d.kind === "collection");
  const byId = new Map(colls.map((c) => [c.id, c]));
  const depth = (c) => {
    let n = 0;
    for (let p = c, seen = new Set(); p?.parent_id && !seen.has(p.id); p = byId.get(p.parent_id)) seen.add(p.id), n++;
    return n;
  };
  const mine = library.docsOf("collection");
  const target = new Map(); // id in the set -> collection in the library
  let added = 0;
  for (const c of [...colls].sort((a, b) => depth(a) - depth(b))) {
    const parent = c.parent_id ? target.get(c.parent_id)?.id ?? null : null;
    let t = mine.find((m) => (m.parent_id || null) === parent && m.name.toLowerCase() === String(c.name).toLowerCase());
    if (!t) {
      [t] = await library.saveDocs([{ kind: "collection", name: c.name, parent_id: parent, route_ids: [] }]);
      mine.push(t);
      added++;
    }
    target.set(c.id, t);
    const more = (c.route_ids || []).map((id) => idMap.get(id)).filter((id) => id != null && !t.route_ids.includes(id));
    if (more.length) {
      t.route_ids = [...t.route_ids, ...more];
      await library.saveDocs([t]);
    }
  }
  const names = new Set(library.docsOf("area").map((a) => a.name.toLowerCase()));
  const areas = docs.filter((d) => d.kind === "area" && Array.isArray(d.polygon) && !names.has(String(d.name).toLowerCase()));
  if (areas.length) await library.saveDocs(areas.map((a) => ({ kind: "area", name: a.name, polygon: a.polygon })));
  return { collections: added, areas: areas.length };
}

/**
 * Add the places of a set (or a backup) to a library: lists with the same name are merged,
 * places already there (same name within 25 m, in that list) skipped, categories of your own
 * added when the library doesn't have them. Returns how many places were added.
 */
async function addPlaces(library, docs = [], categories = []) {
  const lists = docs.filter((d) => d.kind === "poi_list");
  const places = docs.filter((d) => d.kind === "poi");
  if (!places.length) return 0;
  const saved = Array.isArray(library.settings.POI_CATEGORIES) ? library.settings.POI_CATEGORIES : [];
  const newCats = categories.filter((c) => c && c.id && !saved.some((x) => x.id === c.id || x.label.toLowerCase() === String(c.label).toLowerCase()));
  if (newCats.length) await library.setSetting("POI_CATEGORIES", [...saved, ...newCats]);
  const listId = new Map(); // id in the set -> id in the library
  const mine = library.docsOf("poi_list");
  const created = [];
  for (const l of lists) {
    const same = mine.find((x) => x.name.toLowerCase() === String(l.name).toLowerCase());
    if (same) listId.set(l.id, same.id);
    else {
      const id = mine.some((x) => x.id === l.id) ? newId() : l.id;
      created.push({ kind: "poi_list", id, name: l.name, source: l.source || null, visible: true, created_at: new Date().toISOString() });
      listId.set(l.id, id);
    }
  }
  if (created.length) await library.saveDocs(created);
  const existing = library.docsOf("poi");
  const fresh = [];
  for (const p of places) {
    const list_id = listId.get(p.list_id) ?? p.list_id;
    if (isDuplicatePlace(p, [...existing, ...fresh].filter((x) => x.list_id === list_id))) continue;
    fresh.push({ ...p, id: undefined, key: undefined, updated_at: undefined, list_id });
  }
  const clean = fresh.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
  for (let i = 0; i < clean.length; i += 200) await library.saveDocs(clean.slice(i, i + 200));
  return clean.length;
}

/** Read a backup zip: {routes, ignored, settings, files: [{hash, name, data}], kind, title, description} */
export async function readBackup(buffer) {
  const entries = await readZip(buffer);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const json = byName.get("library.json");
  if (!json) throw new Error("This is not a rerouter backup (no library.json in the zip)");
  const manifest = JSON.parse(new TextDecoder().decode(json));
  if (manifest.format !== FORMAT) throw new Error("This is not a rerouter backup");
  const files = manifest.files.map((f) => {
    const data = byName.get(fileEntry(f)) ?? byName.get(`gpx/${f.hash}.gpx`);
    if (!data) throw new Error(`The backup is incomplete: ${f.name} is missing`);
    return { hash: f.hash, name: f.name, data };
  });
  return {
    routes: manifest.routes, ignored: manifest.ignored || [], settings: manifest.settings || {}, docs: manifest.docs || [],
    categories: manifest.categories || [], files,
    created_at: manifest.created_at, kind: manifest.kind || "library", title: manifest.title || null, description: manifest.description || null,
  };
}

/**
 * Replace the library with a backup (bytes of the zip). Returns what was in the backup.
 * A server library is restored by the server (the GPX files end up in its GPX folder).
 */
export async function restoreBackup(library, buffer) {
  const data = await readBackup(buffer);
  if (library.remote) {
    await library.backend.restore(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
    await library.reload();
  } else await library.restore(data);
  return data;
}

/**
 * Add the routes of a backup (what readBackup returns) to the library, keeping what is there:
 * routes get new ids, and routes the library already has (same file and track, or the same
 * track in another file) are skipped. "Derived from" links and "not duplicates" decisions are
 * carried over where both routes end up in the library. Settings are left alone.
 * Returns {added, skipped, ids}.
 */
export async function addBackup(library, data) {
  const all = library.all();
  const byFileTrack = new Map(all.map((r) => [`${r.file_hash}:${r.track_index}`, r.id]));
  const byTrack = new Map(all.filter((r) => r.track_hash).map((r) => [r.track_hash, r.id]));
  const slugs = new Set(all.map((r) => r.slug));
  const idMap = new Map(); // id in the backup -> id in the library
  const fresh = [];
  for (const r of data.routes) {
    const have = byFileTrack.get(`${r.file_hash}:${r.track_index}`) ?? (r.track_hash ? byTrack.get(r.track_hash) : undefined);
    if (have != null) idMap.set(r.id, have);
    else fresh.push(r);
  }
  // The files first, so a route never points at a missing file.
  const known = new Set(all.map((r) => r.file_hash));
  const needed = new Set(fresh.map((r) => r.file_hash));
  for (const f of data.files) {
    if (needed.has(f.hash) && !known.has(f.hash)) await library.putFile(f.hash, f.name, f.data, "restored");
  }
  const records = fresh.map((r) => {
    const rec = { ...stored(r), derived_from: [] };
    delete rec.id;
    delete rec.updated_at;
    let slug = rec.slug || "route", n = 2;
    while (slugs.has(slug)) slug = `${rec.slug || "route"}-${n++}`;
    slugs.add(slug);
    rec.slug = slug;
    return rec;
  });
  await library.saveRoutes(records);
  fresh.forEach((r, i) => idMap.set(r.id, records[i].id));
  const linked = [];
  fresh.forEach((r, i) => {
    const parents = (r.derived_from || []).map((id) => idMap.get(id)).filter((id) => id != null);
    if (parents.length) {
      records[i].derived_from = parents;
      linked.push(records[i]);
    }
  });
  if (linked.length) await library.saveRoutes(linked);
  const pairs = data.ignored
    .map((k) => k.split("_").map((id) => idMap.get(Number(id))))
    .filter(([a, b]) => a != null && b != null && a !== b);
  if (pairs.length) await library.ignorePairs(pairs);
  // Places: those of a set, or of a whole backup (its own categories are in its settings).
  const categories = data.categories?.length ? data.categories : data.settings?.POI_CATEGORIES || [];
  const placesAdded = await addPlaces(library, data.docs || [], categories);
  const cat = await addCatalog(library, data.docs || [], idMap);
  return {
    added: records.length, skipped: data.routes.length - records.length, ids: records.map((r) => r.id),
    places: placesAdded, collections: cat.collections, areas: cat.areas,
  };
}
