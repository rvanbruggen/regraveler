import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Library, MemoryBackend } from "../js/db.js";
import { sha256, sha256Fallback } from "../js/sha256.js";
import * as svc from "../js/service.js";
import { config } from "../js/config.js";
import { gpxXml, linePoints } from "./helpers.js";

const nodeHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const enc = (s) => new TextEncoder().encode(s);

// Pages opened over plain HTTP (the self-hosted version on the home network) have no
// crypto.subtle. Simulate that by hiding the global crypto object.
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
function withoutSubtle() {
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true, writable: true });
}
afterEach(() => Object.defineProperty(globalThis, "crypto", realCrypto));

test("fallback matches the FIPS 180-4 test vectors", () => {
  assert.equal(sha256Fallback(enc("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Fallback(enc("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Fallback(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
  assert.equal(sha256Fallback(enc("a".repeat(1_000_000))), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("fallback matches node's SHA-256 around every padding boundary", () => {
  for (let n = 0; n <= 200; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    assert.equal(sha256Fallback(bytes), nodeHash(bytes), `length ${n}`);
  }
});

test("sha256 uses the fallback when crypto.subtle is missing, with the same result", async () => {
  const bytes = enc("<gpx>route</gpx>");
  const withSubtle = await sha256(bytes);
  withoutSubtle();
  assert.equal(globalThis.crypto.subtle, undefined);
  assert.equal(await sha256(bytes), withSubtle);
  assert.equal(await sha256(bytes.buffer), withSubtle); // ArrayBuffer input too
});

test("importing works on a page without crypto.subtle (plain HTTP)", async () => {
  svc.setLibrary(await Library.open(new MemoryBackend()));
  config.AUTO_RENAME_ON_IMPORT = false;
  const data = gpxXml([["t", linePoints({ start: [51.0, 4.4], lengthM: 5000, stepM: 100, headingDeg: 90, ele: () => 10 })]]);
  const expected = nodeHash(typeof data === "string" ? enc(data) : data);
  withoutSubtle();
  const res = await svc.importGpx(data, "Plain http.gpx");
  assert.equal(res.status, "imported", res.message);
  const [r] = svc.listRoutes("");
  assert.equal(r.file_hash, expected);
  // The same file again is still recognised as a duplicate.
  assert.equal((await svc.importGpx(data, "Again.gpx")).status, "duplicate");
});
