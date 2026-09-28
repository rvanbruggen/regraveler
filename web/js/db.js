// Storage. The Library keeps the routes in memory and writes through a backend:
//   IdbBackend      IndexedDB in this browser (the personal version, e.g. on GitHub Pages)
//   RemoteBackend   the rerouter server's storage API (js/remote.js; the self-hosted version)
//   MemoryBackend   for tests
//
// Object stores:
//   routes    {id, name, ..., file_hash, track_index, geometry, ...}   (keyPath id, auto increment)
//   files     {hash, name, data}   the original GPX files (bytes), never modified (keyPath hash)
//   ignored   {key: "a_b", a_id, b_id}   pairs marked "not duplicates" (keyPath key)
//   settings  {key, value}
//   docs      {key: "<kind>:<id>", kind, id, ...}   other documents: places (POIs) and their
//             lists ("poi", "poi_list"), later collections; ids are made in the page
//
// Everything except the file texts is loaded into memory at start-up (hundreds of routes are
// a few MB at most); writes go straight through to the backend.

const DB_NAME = "rerouter";
const DB_VERSION = 2; // 2: the docs store
const STORES = { routes: "id", files: "hash", ignored: "key", settings: "key", docs: "key" };

/** A new document id: short, unique enough for one library, no secure context needed. */
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const docKey = (kind, id) => `${kind}:${id}`;

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const completion = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });

class IdbBackend {
  static async open() {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath, autoIncrement: name === "routes" });
        }
      }
    };
    const b = new IdbBackend();
    b.db = await req(open);
    return b;
  }
  async all(store) {
    return req(this.db.transaction(store).objectStore(store).getAll());
  }
  async get(store, key) {
    return req(this.db.transaction(store).objectStore(store).get(key));
  }
  /** Put several records (in one transaction); returns their keys. */
  async put(store, records) {
    const tx = this.db.transaction(store, "readwrite");
    const done = completion(tx);
    const os = tx.objectStore(store);
    const keys = await Promise.all(records.map((r) => req(os.put(r))));
    await done;
    return keys;
  }
  async delete(store, keys) {
    const tx = this.db.transaction(store, "readwrite");
    const done = completion(tx);
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    await done;
  }
  async clear() {
    const tx = this.db.transaction(Object.keys(STORES), "readwrite");
    const done = completion(tx);
    for (const s of Object.keys(STORES)) tx.objectStore(s).clear();
    await done;
  }
}

export class MemoryBackend {
  constructor() {
    this.stores = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()]));
    this.nextId = 1;
  }
  async all(store) {
    return [...this.stores[store].values()].map((r) => structuredClone(r));
  }
  async get(store, key) {
    const r = this.stores[store].get(key);
    return r === undefined ? undefined : structuredClone(r);
  }
  async put(store, records) {
    return records.map((r) => {
      const keyPath = STORES[store];
      if (store === "routes" && r.id == null) r.id = this.nextId++;
      if (store === "routes") this.nextId = Math.max(this.nextId, r.id + 1);
      this.stores[store].set(r[keyPath], structuredClone(r));
      return r[keyPath];
    });
  }
  async delete(store, keys) {
    for (const k of keys) this.stores[store].delete(k);
  }
  async clear() {
    for (const s of Object.values(this.stores)) s.clear();
    this.nextId = 1;
  }
}

/** The library: routes in memory, persisted through a backend. */
export class Library {
  constructor(backend) {
    this.backend = backend;
    this.routes = new Map(); // id -> route
    this.ignored = new Set(); // "a_b" with a < b
    this.settings = {};
    this.docs = new Map(); // "kind:id" -> document
  }

  static async open(backend = null) {
    const lib = new Library(backend || (await IdbBackend.open()));
    await lib.reload();
    return lib;
  }

  async reload() {
    const [routes, ignored, settings, docs = []] = this.backend.loadAll
      ? await this.backend.loadAll()
      : await Promise.all(["routes", "ignored", "settings", "docs"].map((s) => this.backend.all(s)));
    this.routes = new Map(routes.map((r) => [r.id, r]));
    this.ignored = new Set(ignored.map((r) => r.key));
    this.settings = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    this.docs = new Map(docs.map((d) => [d.key, d]));
  }

  all() {
    return [...this.routes.values()];
  }

  get(id) {
    return this.routes.get(Number(id)) || null;
  }

  /** Stored in a server (not in this browser)? */
  get remote() {
    return !!this.backend.remote;
  }

  /**
   * Save new or changed routes; new routes get an id. `base`: the updated_at each existing
   * route had when it was loaded, so a server can refuse to overwrite a route that was
   * changed elsewhere in the meantime.
   */
  async saveRoutes(routes) {
    if (!routes.length) return routes;
    const now = new Date().toISOString();
    const base = {};
    for (const r of routes) if (r.id != null) base[r.id] = r.updated_at ?? null;
    // Stored without transient fields (anything starting with "_").
    const records = routes.map((r) => ({
      ...Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_"))),
      updated_at: now,
    }));
    const ids = await this.backend.put("routes", records, { base });
    routes.forEach((r, i) => {
      r.id = ids[i];
      r.updated_at = records[i].updated_at; // a server may set its own
      this.routes.set(r.id, r);
    });
    return routes;
  }

  /** Remove routes; their GPX files go too when no other route uses them. */
  async deleteRoutes(ids) {
    const gone = ids.map(Number).filter((id) => this.routes.has(id));
    const hashes = new Set(gone.map((id) => this.routes.get(id).file_hash));
    gone.forEach((id) => this.routes.delete(id));
    for (const r of this.routes.values()) hashes.delete(r.file_hash);
    await this.backend.delete("routes", gone);
    if (hashes.size) await this.backend.delete("files", [...hashes]);
    const pairs = [...this.ignored].filter((k) => k.split("_").map(Number).some((id) => gone.includes(id)));
    if (pairs.length) {
      pairs.forEach((k) => this.ignored.delete(k));
      await this.backend.delete("ignored", pairs);
    }
    return gone.length;
  }

  /**
   * Store an original GPX file (bytes, never modified). `folder`: where a server keeps it
   * in its GPX folder ("uploads/<source>" or "derived"); ignored in a browser.
   */
  async putFile(hash, name, data, folder = null) {
    await this.backend.put("files", [{ hash, name, data, folder }]);
  }

  async getFile(hash) {
    return (await this.backend.get("files", hash)) || null;
  }

  async allFiles() {
    return this.backend.all("files");
  }

  // Duplicates marked "not duplicates".
  static pairKey(a, b) {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }
  isIgnored(a, b) {
    return this.ignored.has(Library.pairKey(a, b));
  }
  async ignorePairs(pairs) {
    const recs = [];
    for (const [a, b] of pairs) {
      const key = Library.pairKey(a, b);
      if (this.ignored.has(key)) continue;
      this.ignored.add(key);
      recs.push({ key, a_id: Math.min(a, b), b_id: Math.max(a, b) });
    }
    if (recs.length) await this.backend.put("ignored", recs);
    return recs.length;
  }
  async resetIgnored() {
    const keys = [...this.ignored];
    this.ignored.clear();
    await this.backend.delete("ignored", keys);
    return keys.length;
  }

  async setSetting(key, value) {
    this.settings[key] = value;
    await this.backend.put("settings", [{ key, value }]);
  }

  // Other documents ({kind, id, ...}): places and their lists.
  docsOf(kind) {
    return [...this.docs.values()].filter((d) => d.kind === kind);
  }
  getDoc(kind, id) {
    return this.docs.get(docKey(kind, id)) || null;
  }
  /** Save new or changed documents (each needs a kind; new ones get an id). */
  async saveDocs(docs) {
    if (!docs.length) return docs;
    const now = new Date().toISOString();
    for (const d of docs) {
      if (!d.kind) throw new Error("A document needs a kind");
      d.id ??= newId();
      d.key = docKey(d.kind, d.id);
      d.updated_at = now;
    }
    await this.backend.put("docs", docs.map((d) => ({ ...d })));
    for (const d of docs) this.docs.set(d.key, d);
    return docs;
  }
  async deleteDocs(docs) {
    const keys = docs.map((d) => (typeof d === "string" ? d : d.key)).filter((k) => this.docs.has(k));
    if (!keys.length) return 0;
    keys.forEach((k) => this.docs.delete(k));
    await this.backend.delete("docs", keys);
    return keys.length;
  }

  /** Everything, for a backup. */
  async dump() {
    return {
      routes: this.all(),
      ignored: [...this.ignored],
      settings: this.settings,
      docs: [...this.docs.values()],
      files: await this.allFiles(),
    };
  }

  /** Replace everything with a backup's contents. */
  async restore({ routes = [], ignored = [], settings = {}, files = [], docs = [] }) {
    await this.backend.clear();
    if (files.length) await this.backend.put("files", files);
    if (routes.length) await this.backend.put("routes", routes);
    if (ignored.length) {
      await this.backend.put("ignored", ignored.map((key) => {
        const [a, b] = key.split("_").map(Number);
        return { key, a_id: a, b_id: b };
      }));
    }
    const entries = Object.entries(settings);
    if (entries.length) await this.backend.put("settings", entries.map(([key, value]) => ({ key, value })));
    if (docs.length) await this.backend.put("docs", docs.map((d) => ({ ...d, key: docKey(d.kind, d.id) })));
    await this.reload();
  }

  async clear() {
    await this.backend.clear();
    await this.reload();
  }
}
