// Library backups: one zip with library.json (routes, settings, "not duplicates" decisions)
// and the original route files under gpx/<file hash>.<gpx|tcx|fit>. The same format for the browser
// version and the server (app/store.py), so a library moves between them in either direction.
// The browser's storage can be cleared (site data, private windows, low disk space), so
// backups are also how a browser library survives.
//
// A backup can also hold only some routes (kind "selection"): made from the selected routes in
// the library, and added to a library without replacing what is there. The example route sets
// on the public site (data/seeds/, see tools/build_seeds.py) are such selections.

import { VERSION } from "./config.js";
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
export async function makeSelection(library, ids, { title = null, description = null, personal = true } = {}) {
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
  };
  return makeZip([
    { name: "library.json", data: JSON.stringify(manifest) },
    ...files.map((f) => ({ name: fileEntry(f), data: f.data })),
  ]);
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
    routes: manifest.routes, ignored: manifest.ignored || [], settings: manifest.settings || {}, files,
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
  return { added: records.length, skipped: data.routes.length - records.length, ids: records.map((r) => r.id) };
}
