import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

// The feature pages and the sitemap are made by tools/build_feature_pages.py.
const web = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, web), "utf-8");
const pages = readdirSync(new URL("features/", web)).filter((f) => f.endsWith(".html")).sort();

test("the sitemap lists the start page and every feature page, and nothing else", () => {
  const locs = [...read("sitemap.xml").matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]).sort();
  const expected = ["https://rerouter.eu/", ...pages.map((f) => `https://rerouter.eu/features/${f === "index.html" ? "" : f}`)].sort();
  assert.deepEqual(locs, expected);
});

test("every feature page has its own canonical address, title and description", () => {
  const titles = new Set();
  for (const f of pages) {
    const html = read(`features/${f}`);
    const canonical = `https://rerouter.eu/features/${f === "index.html" ? "" : f}`;
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`), `${f}: canonical`);
    const title = html.match(/<title>(.*?)<\/title>/)?.[1];
    assert.ok(title && !titles.has(title), `${f}: a title of its own`);
    titles.add(title);
    assert.match(html, /<meta name="description" content="[^"]{50,}">/, `${f}: description`);
    JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  }
});

test("the feature pages only link to files that exist, and into views the app opens", () => {
  const views = read("js/app.js").match(/const UTILITIES = \[([^\]]*)\]/)[1] + read("js/app.js").match(/const LINKABLE_VIEWS = \[([^\]]*)\]/)[1];
  for (const f of pages) {
    const html = read(`features/${f}`);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^https?:/.test(href)) continue;
      const view = href.match(/#view=(\w+)$/)?.[1];
      if (view) assert.ok(views.includes(`"${view}"`), `${f}: view ${view}`);
      const path = href.replace(/#.*$/, "");
      if (path && !path.endsWith("/")) assert.ok(existsSync(new URL(`features/${path}`, web)), `${f}: ${href}`);
    }
  }
});

test("the app links to the feature pages", () => {
  assert.ok(read("index.html").includes('href="features/index.html"'));
});
