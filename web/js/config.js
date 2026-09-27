// Settings. The defaults below can be changed by the user in Utilities > Settings (stored
// with the library); `applySettings` copies those over the defaults at start-up.

export const VERSION = "0.11.0";

export const config = {
  // "browser": the library lives in this browser (a static host such as GitHub Pages);
  // "server": it lives in a rerouter server, which serves this page (docker compose).
  MODE: "browser",

  // Start and end within this distance (metres) -> route is a loop.
  LOOP_THRESHOLD_M: 200,
  // Near-duplicate detection: two routes are "very similar" when at least SIMILAR_MIN_OVERLAP
  // of each route lies within SIMILAR_TOLERANCE_M of the other.
  SIMILAR_TOLERANCE_M: 50,
  SIMILAR_MIN_OVERLAP: 0.85,
  // Duplicates view: also list "variants", where one route lies (almost) entirely on another.
  VARIANT_MIN_OVERLAP: 0.9,
  // Map view: default and maximum distance (metres) for "routes near each other".
  PROXIMITY_DISTANCE_M: 100,
  PROXIMITY_MAX_DISTANCE_M: 5000,

  // Combiner: BRouter routing service. The public server at brouter.de allows requests from
  // any web page; point this at your own BRouter to use that instead.
  BROUTER_URL: "https://brouter.de",
  BROUTER_TIMEOUT_S: 60,
  // Profiles offered in the UI (they must exist on the BRouter server); the first is the default.
  BROUTER_PROFILES: ["gravel", "fastbike", "hiking-mountain", "trekking", "mtb", "shortest"],
  // Connection points closer than this are joined directly, without asking BRouter.
  DIRECT_JOIN_M: 25,

  // Surface estimate: map matching through BRouter.
  SURFACE_MATCH_PROFILE: "shortest",
  SURFACE_WAYPOINT_SPACING_M: 300,
  // Estimate automatically after imports and saved combinations. Off by default: on the
  // public BRouter server, estimates for a large import are a lot of requests.
  SURFACE_AUTO_ESTIMATE: false,
  // Pause between BRouter requests of the surface estimate on the shared public server.
  SURFACE_REQUEST_PAUSE_MS: 1000,

  // Ride weather: the forecast service (Open-Meteo, free, no key), and the average speed
  // (km/h) offered for each activity until the user fills in their own.
  OPEN_METEO_URL: "https://api.open-meteo.com",
  WEATHER_SPEEDS: { gravel: 20, road: 25, mtb: 15, hiking: 4.5 },

  // Route names from the places a route visits (GeoNames data in data/places/).
  AUTO_RENAME_ON_IMPORT: true,

  // Activity of a route. The first is the default for imports; each maps to the BRouter
  // profile the combiner uses by default for connectors.
  ACTIVITIES: ["gravel", "road", "mtb", "hiking"],
  ACTIVITY_PROFILES: { gravel: "gravel", road: "fastbike", mtb: "mtb", hiking: "hiking-mountain" },
};

// Settings the user can change (key -> type).
export const USER_SETTINGS = {
  BROUTER_URL: "string",
  SURFACE_AUTO_ESTIMATE: "boolean",
  AUTO_RENAME_ON_IMPORT: "boolean",
  PROXIMITY_DISTANCE_M: "number",
};

const DEFAULTS = { ...config };

/** Different defaults for the server version: its own BRouter (through the server), and
 * surface estimates after imports, as before. Call before applySettings. */
export function useServerDefaults(pageBase) {
  const base = new URL(".", pageBase).href.replace(/\/+$/, "");
  Object.assign(DEFAULTS, { MODE: "server", BROUTER_URL: base, SURFACE_AUTO_ESTIMATE: true });
  Object.assign(config, { MODE: "server" });
}

/** Is BRouter the shared public server (be gentle) or one of our own? */
export const publicBRouter = () => /(^|\.)brouter\.de(:|\/|$)/.test(new URL(config.BROUTER_URL).host + "/");

export function applySettings(settings = {}) {
  for (const [key, type] of Object.entries(USER_SETTINGS)) {
    const v = settings[key];
    config[key] = v === undefined || v === null || v === "" || typeof v !== type ? DEFAULTS[key] : v;
  }
  config.BROUTER_URL = String(config.BROUTER_URL).replace(/\/+$/, "").replace(/\/brouter$/, "");
}

export const defaultSetting = (key) => DEFAULTS[key];
