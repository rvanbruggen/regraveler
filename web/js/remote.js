// The self-hosted version: the rerouter server's storage API as a Library backend (see
// db.js). The server only stores what the page computes; all the logic runs in the page.

export class ServerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Is this page served by a rerouter server? Returns its /api/info, or null (a static host
 * such as GitHub Pages, where the library lives in the browser).
 */
export async function detectServer(base = document.baseURI) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(new URL("api/info", base), { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    const info = await res.json();
    return info && info.app === "rerouter" ? info : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class RemoteBackend {
  constructor(base) {
    this.base = base;
    this.remote = true;
  }

  async request(path, { method = "GET", json, body, headers = {}, raw = false } = {}) {
    const opts = { method, headers: { ...headers } };
    if (json !== undefined) {
      opts.body = JSON.stringify(json);
      opts.headers["Content-Type"] = "application/json";
    } else if (body !== undefined) opts.body = body;
    let res;
    try {
      res = await fetch(new URL(path, this.base), opts);
    } catch (err) {
      throw new ServerError(`The rerouter server is not reachable: ${err.message}`, 0);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const detail = (await res.json()).detail;
        if (detail) msg = typeof detail === "string" ? detail : JSON.stringify(detail);
      } catch (_) {}
      throw new ServerError(msg, res.status);
    }
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }

  /** Routes, "not duplicates" pairs and settings in one request (see Library.reload). */
  async loadAll() {
    const lib = await this.request("api/library");
    return [
      lib.routes,
      lib.ignored.map((key) => ({ key })),
      Object.entries(lib.settings).map(([key, value]) => ({ key, value })),
    ];
  }

  async all(store) {
    const [routes, ignored, settings] = await this.loadAll();
    if (store === "routes") return routes;
    if (store === "ignored") return ignored;
    if (store === "settings") return settings;
    throw new Error("The files are not listed from the server; download a backup instead");
  }

  async get(store, key) {
    if (store !== "files") throw new Error(`Cannot read ${store} one by one from the server`);
    const res = await this.request(`api/files/${encodeURIComponent(key)}`, { raw: true }).catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
    if (!res) return undefined;
    const name = decodeURIComponent(res.headers.get("X-File-Name") || "") || `${key}.gpx`;
    return { hash: key, name, data: new Uint8Array(await res.arrayBuffer()) };
  }

  async put(store, records, { base = {} } = {}) {
    if (store === "routes") {
      const res = await this.request("api/routes", { method: "PUT", json: { routes: records, base } });
      res.routes.forEach((r, i) => (records[i].updated_at = r.updated_at));
      return res.routes.map((r) => r.id);
    }
    if (store === "files") {
      for (const f of records) {
        const q = new URLSearchParams({ name: f.name || "", folder: f.folder || "" });
        await this.request(`api/files/${encodeURIComponent(f.hash)}?${q}`, {
          method: "PUT", body: f.data, headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return records.map((f) => f.hash);
    }
    if (store === "ignored") {
      await this.request("api/ignored", { method: "PUT", json: { keys: records.map((r) => r.key) } });
      return records.map((r) => r.key);
    }
    if (store === "settings") {
      await this.request("api/settings", { method: "PUT", json: { settings: Object.fromEntries(records.map((r) => [r.key, r.value])) } });
      return records.map((r) => r.key);
    }
    throw new Error(`Unknown store ${store}`);
  }

  async delete(store, keys) {
    if (store === "routes") await this.request("api/routes/delete", { method: "POST", json: { ids: keys } });
    else if (store === "ignored") await this.request("api/ignored/delete", { method: "POST", json: { keys } });
    // Files: the server keeps the originals in its GPX folder, whatever happens to the routes.
  }

  async clear() {
    await this.request("api/library/clear", { method: "POST" });
  }

  // ---------------------------------------------------------------- server-only

  /** The whole library as a backup zip, packed by the server (Blob). */
  async backup() {
    return (await this.request("api/backup", { raw: true })).blob();
  }

  /** Replace the library with a backup zip (bytes). */
  async restore(bytes) {
    return this.request("api/restore", { method: "POST", body: bytes, headers: { "Content-Type": "application/zip" } });
  }

  /**
   * GPX files in the server's GPX folder that are not in the library yet:
   * {files: [{path, size}], ignored: how many more are ignored}
   */
  async diskFiles() {
    return this.request("api/disk-files");
  }

  /** Don't offer these files again: [{path, reason}] (every copy of each file). */
  async ignoreDiskFiles(files) {
    return this.request("api/disk-files/ignore", { method: "POST", json: { files } });
  }

  /** Offer the ignored files again. */
  async unignoreDiskFiles() {
    return this.request("api/disk-files/unignore", { method: "POST" });
  }

  async diskFile(path) {
    const res = await this.request(`api/disk-files/content?${new URLSearchParams({ path })}`, { raw: true });
    return new Uint8Array(await res.arrayBuffer());
  }
}
