// Helper for the Python tests (tests/test_backup_format.py): make a backup with the page's
// code, or read one, so both sides are checked against the same format.
//   node backup_cli.mjs make <out.zip> <file.gpx>...   import the files, write a backup
//   node backup_cli.mjs read <backup.zip>              print a summary as JSON
import fs from "node:fs";
import path from "node:path";

import { makeBackup, readBackup } from "../../js/backup.js";
import { config } from "../../js/config.js";
import { Library, MemoryBackend } from "../../js/db.js";
import * as svc from "../../js/service.js";

const [cmd, target, ...files] = process.argv.slice(2);
if (cmd === "make") {
  config.AUTO_RENAME_ON_IMPORT = false;
  svc.setLibrary(await Library.open(new MemoryBackend()));
  for (const f of files) await svc.importGpx(new Uint8Array(fs.readFileSync(f)), path.basename(f), { tags: ["test"] });
  await svc.ignoreDuplicates(svc.listRoutes("").map((r) => r.id).slice(0, 2));
  const blob = await makeBackup(svc.library());
  fs.writeFileSync(target, Buffer.from(await blob.arrayBuffer()));
} else if (cmd === "read") {
  const b = await readBackup(new Uint8Array(fs.readFileSync(target)));
  console.log(JSON.stringify({
    routes: b.routes.map((r) => ({ id: r.id, name: r.name, file_hash: r.file_hash, tags: r.tags })),
    ignored: b.ignored,
    files: b.files.map((f) => ({ hash: f.hash, name: f.name, size: f.data.length })),
  }));
} else {
  console.error("usage: backup_cli.mjs make <out.zip> <file.gpx>... | read <backup.zip>");
  process.exit(2);
}
