// Web Worker for the heavy geometry work (routes near each other), so the page stays
// responsive with many routes or large distances.

import { proximityPairs } from "./similarity.js";

self.onmessage = (e) => {
  const { id, routes, distanceM } = e.data;
  try {
    self.postMessage({ id, pairs: proximityPairs(routes, distanceM) });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
