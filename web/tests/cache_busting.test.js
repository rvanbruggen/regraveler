import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { VERSION } from "../js/config.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf-8");

test("the import map loads every module with the current version", () => {
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
  const files = readdirSync(new URL("../js/", import.meta.url)).filter((f) => f.endsWith(".js")).sort();
  assert.deepEqual(Object.keys(map).sort(), files.map((f) => `./js/${f}`), "every js/ file, and no others");
  for (const [from, to] of Object.entries(map)) assert.equal(to, `${from}?v=${VERSION}`);
});

test("the page's script and style sheet carry the current version", () => {
  assert.match(html, new RegExp(`<script type="module" src="js/app\\.js\\?v=${VERSION.replaceAll(".", "\\.")}">`));
  assert.match(html, new RegExp(`<link rel="stylesheet" href="style\\.css\\?v=${VERSION.replaceAll(".", "\\.")}">`));
});
