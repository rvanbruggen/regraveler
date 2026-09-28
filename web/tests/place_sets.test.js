// The example place sets published with the site (data/place-sets/, index built by
// tools/build_place_sets.py): each reads cleanly, as many places as the index says, and
// imports into its own category.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Library, MemoryBackend } from "../js/db.js";
import { DEFAULT_CATEGORIES, parsePlacesCsv } from "../js/poi.js";
import * as svc from "../js/service.js";

const DIR = new URL("../data/place-sets/", import.meta.url);
const { sets } = JSON.parse(readFileSync(new URL("index.json", DIR), "utf-8"));

test("the index lists the sets in order", () => {
  assert.ok(sets.length > 0);
  const prefix = (f) => Number(/^(\d+)-/.exec(f)?.[1] ?? Infinity);
  assert.deepEqual(sets.map((s) => s.file), [...sets].sort((a, b) => prefix(a.file) - prefix(b.file)).map((s) => s.file));
  for (const s of sets) {
    assert.ok(s.file.endsWith(".csv") && s.title && s.category && s.count > 0, JSON.stringify(s));
    assert.ok(DEFAULT_CATEGORIES.some((c) => c.id === s.category), `${s.file}: unknown category ${s.category}`);
  }
});

for (const set of sets) {
  test(`place set ${set.file}: reads cleanly, ${set.count} places, all in ${set.category}`, async () => {
    const parsed = parsePlacesCsv(readFileSync(new URL(set.file, DIR), "utf-8"), set.file);
    const places = parsed.layers.flatMap((l) => l.places);
    assert.equal(parsed.skipped, 0);
    assert.equal(places.length, set.count);
    for (const p of places) {
      assert.ok(p.name && p.name !== "Unnamed place", `a place without a name in ${set.file}`);
      assert.equal(p.description, null, `${p.name}: no descriptions in published sets`);
      // Belgium, the south of the Netherlands and the north of France (no stray points in Romania).
      assert.ok(p.lat > 49.4 && p.lat < 51.9 && p.lon > 1.5 && p.lon < 6.5, `${p.name} lies at ${p.lat}, ${p.lon}`);
    }

    svc.setLibrary(await Library.open(new MemoryBackend()));
    const layers = parsed.layers.map(() => ({ include: true, category: set.category }));
    const first = await svc.importPlaces(parsed, { listName: set.title, source: set.file, layers });
    assert.equal(first.added, set.count);
    assert.equal(first.list.name, set.title);
    assert.ok(svc.allPlaces().every((p) => p.category === set.category && p.list_id === first.list.id));
    const again = await svc.importPlaces(parsed, { listName: set.title, source: set.file, layers });
    assert.equal(again.added, 0, "adding a set twice adds nothing");
    assert.equal(again.list.id, first.list.id);
  });
}
