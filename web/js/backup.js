// Library backups: one zip with library.json (routes, settings, "not duplicates" decisions)
// and the original GPX files under gpx/<file hash>.gpx. The same format for the browser
// version and the server (app/store.py), so a library moves between them in either direction.
// The browser's storage can be cleared (site data, private windows, low disk space), so
// backups are also how a browser library survives.

import { VERSION } from "./config.js";
import { makeZip, readZip } from "./zip.js";

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
    ...dump.files.map((f) => ({ name: `gpx/${f.hash}.gpx`, data: f.data })),
  ]);
}

/** Read a backup zip: {routes, ignored, settings, files: [{hash, name, data}]} */
export async function readBackup(buffer) {
  const entries = await readZip(buffer);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const json = byName.get("library.json");
  if (!json) throw new Error("This is not a rerouter backup (no library.json in the zip)");
  const manifest = JSON.parse(new TextDecoder().decode(json));
  if (manifest.format !== FORMAT) throw new Error("This is not a rerouter backup");
  const files = manifest.files.map((f) => {
    const data = byName.get(`gpx/${f.hash}.gpx`);
    if (!data) throw new Error(`The backup is incomplete: ${f.name} is missing`);
    return { hash: f.hash, name: f.name, data };
  });
  return { routes: manifest.routes, ignored: manifest.ignored || [], settings: manifest.settings || {}, files, created_at: manifest.created_at };
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
