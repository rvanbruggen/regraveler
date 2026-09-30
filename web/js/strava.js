// Import from your Strava account (Import screen › From your Strava account): the routes you
// made on Strava, private ones too. Routes only: recorded activities come in better through
// Strava's bulk export (the Import screen reads it).
//
// Strava's API v3 answers the browser directly (Access-Control-Allow-Origin: *, also for the
// token endpoint), so this works on the static site and on a rerouter server alike.
//
// Signing in is OAuth only, and the token exchange needs the app's client secret. rerouter has
// no Strava app of its own: the user makes one at strava.com/settings/api (its Authorization
// Callback Domain is the host rerouter runs on; localhost is always allowed) and pastes its
// Client ID and Client Secret here. The page sends the user to Strava to approve read access
// (scope read,read_all: read_all for private routes), Strava sends them back with ?code=…, and
// the page trades the code for an access token (6 hours) and a refresh token. Only that one
// user ever uses the app, so its secret in their own browser is theirs to keep.
//
// Routes: /athletes/<id>/routes (page / per_page), each as GPX from /routes/<id>/export_gpx.
// Route ids are larger than JavaScript's numbers hold exactly: use id_str, never id.
//
// Limits: by default about 100 requests per 15 minutes and 1,000 a day, reset at the whole
// quarter hour (UTC) and at midnight UTC. A 429 answer says so (StravaError.resetAt).

export const STRAVA = "https://www.strava.com";
export const API = `${STRAVA}/api/v3`;
export const SCOPE = "read,read_all";
export const PER_PAGE = 200;
export const MAX_PAGES = 50;
// Refresh the access token when it has less than this left (s).
const REFRESH_MARGIN_S = 300;

export class StravaError extends Error {
  /** status: the HTTP status; resetAt: for 429, when Strava's 15-minute limit resets (ms). */
  constructor(message, { status = null, resetAt = null } = {}) {
    super(message);
    this.status = status;
    this.resetAt = resetAt;
  }
}

/** The address a Strava route is stored under as its source URL (as for an imported link). */
export const sourceUrl = (id) => `${STRAVA}/routes/${id}`;

/** Where Strava sends the user back to: this page, without query or hash. */
export function redirectUri(href) {
  const u = new URL(href);
  return `${u.origin}${u.pathname}`;
}

/** The address that asks the user to let their Strava app read their routes. */
export function authorizeUrl({ clientId, redirectUri: redirect, state }) {
  const q = new URLSearchParams({
    client_id: String(clientId).trim(), redirect_uri: redirect, response_type: "code",
    approval_prompt: "auto", scope: SCOPE, state,
  });
  return `${STRAVA}/oauth/authorize?${q}`;
}

/**
 * The page's address after Strava sent the user back: {code, state, scope, error}, or null when
 * the address is not such a return (no code and no error, or no state).
 */
export function returnFrom(href) {
  const q = new URL(href).searchParams;
  if (!q.get("state") || (!q.get("code") && !q.get("error"))) return null;
  return { code: q.get("code"), state: q.get("state"), scope: q.get("scope") || "", error: q.get("error") };
}

/** Does the scope the user granted include reading private routes? */
export const canReadPrivate = (scope) => String(scope).split(/[ ,]+/).includes("read_all");

/** 429: when the 15-minute limit resets (the next whole quarter hour, UTC; epoch ms). */
export function nextQuarterHour(nowMs) {
  const q = 15 * 60 * 1000;
  return Math.floor(nowMs / q) * q + q;
}

async function postToken(params, fetchFn) {
  let res;
  try {
    res = await fetchFn(`${STRAVA}/oauth/token`, { method: "POST", body: new URLSearchParams(params) });
  } catch (err) {
    throw new StravaError(`Strava could not be reached: ${err.message}`);
  }
  let body = null;
  try { body = await res.json(); } catch (_) { /* no JSON */ }
  if (!res.ok || !body?.access_token) {
    const why = body?.message === "Bad Request" && body?.errors?.[0]
      ? `${body.errors[0].resource} ${body.errors[0].field} ${body.errors[0].code}`
      : body?.message || `${res.status} ${res.statusText || ""}`.trim();
    throw new StravaError(res.status === 400 || res.status === 401
      ? `Strava didn't accept the sign-in (${why}). Check the Client ID and Client Secret, then connect again.`
      : `Strava answered ${why}.`, { status: res.status });
  }
  return body;
}

/** A token answer -> what is kept: {access_token, refresh_token, expires_at, athlete_id, athlete_name, scope}. */
function authFrom(body, previous = {}, scope = null) {
  const a = body.athlete || null;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token || previous.refresh_token,
    expires_at: Number(body.expires_at) || 0,
    athlete_id: a?.id != null ? String(a.id) : previous.athlete_id ?? null,
    athlete_name: a ? [a.firstname, a.lastname].filter(Boolean).join(" ") || null : previous.athlete_name ?? null,
    scope: scope ?? previous.scope ?? "",
  };
}

/** Trade the code Strava sent back for tokens. app: {clientId, clientSecret}. */
export async function exchangeCode(app, code, scope, fetchFn = globalThis.fetch) {
  const body = await postToken({
    client_id: String(app.clientId).trim(), client_secret: String(app.clientSecret).trim(),
    code, grant_type: "authorization_code",
  }, fetchFn);
  return authFrom(body, {}, scope);
}

/** Let Strava forget this app's access (best effort; the tokens are forgotten here anyway). */
export async function deauthorize(auth, fetchFn = globalThis.fetch) {
  try {
    await fetchFn(`${STRAVA}/oauth/deauthorize`, { method: "POST", body: new URLSearchParams({ access_token: auth.access_token }) });
  } catch (_) { /* offline: the user can revoke it on strava.com/settings/apps */ }
}

/**
 * Talks to Strava for one connected account. onAuth(auth) is called with new tokens after a
 * refresh (to keep them). now() in seconds, for tests.
 */
export class StravaClient {
  constructor(app, auth, { fetchFn = globalThis.fetch, onAuth = null, now = () => Date.now() / 1000 } = {}) {
    this.app = app;
    this.auth = auth;
    this.fetchFn = fetchFn;
    this.onAuth = onAuth;
    this.now = now;
  }

  async refresh() {
    const body = await postToken({
      client_id: String(this.app.clientId).trim(), client_secret: String(this.app.clientSecret).trim(),
      refresh_token: this.auth.refresh_token, grant_type: "refresh_token",
    }, this.fetchFn);
    this.auth = authFrom(body, this.auth);
    this.onAuth?.(this.auth);
  }

  async token() {
    if (!this.auth?.access_token) throw new StravaError("Not connected to Strava.", { status: 401 });
    if (this.auth.expires_at - this.now() < REFRESH_MARGIN_S) await this.refresh();
    return this.auth.access_token;
  }

  /** GET an API path; returns the Response. Refreshes the token once on a 401. */
  async get(path, accept = "application/json") {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      let res;
      try {
        res = await this.fetchFn(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
      } catch (err) {
        throw new StravaError(`Strava could not be reached: ${err.message}`);
      }
      if (res.status === 401 && attempt === 0) {
        this.auth = { ...this.auth, expires_at: 0 }; // refresh on the next try
        continue;
      }
      if (res.status === 401) throw new StravaError("Strava no longer accepts this connection. Connect again.", { status: 401 });
      if (res.status === 403) throw new StravaError("Strava says this connection may not read that (was reading private routes allowed?).", { status: 403 });
      if (res.status === 404) throw new StravaError("Strava has no such route (any more), or it is private and reading private routes wasn't allowed.", { status: 404 });
      if (res.status === 429) {
        throw new StravaError("Strava's limit for this quarter of an hour (or this day) is reached.",
          { status: 429, resetAt: nextQuarterHour(this.now() * 1000) });
      }
      if (!res.ok) throw new StravaError(`Strava answered ${res.status} ${res.statusText || ""}`.trim() + ".", { status: res.status });
      return res;
    }
  }

  /** All routes of the connected athlete, summarised. onPage({loaded}) reports progress. */
  async listRoutes({ onPage = null } = {}) {
    if (!this.auth?.athlete_id) {
      const me = await (await this.get("/athlete")).json();
      this.auth = { ...this.auth, athlete_id: String(me.id), athlete_name: [me.firstname, me.lastname].filter(Boolean).join(" ") || null };
      this.onAuth?.(this.auth);
    }
    const items = [];
    const seen = new Set();
    // Stop at an empty page (not at a short one: Strava may hand out fewer than asked for).
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = await (await this.get(`/athletes/${this.auth.athlete_id}/routes?page=${page}&per_page=${PER_PAGE}`)).json();
      if (!Array.isArray(list) || !list.length) break;
      for (const r of list) {
        const it = summarise(r);
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
      onPage?.({ loaded: items.length });
    }
    return items;
  }

  /** One route as Strava's own GPX file (bytes). */
  async routeGpx(id) {
    const res = await this.get(`/routes/${encodeURIComponent(id)}/export_gpx`, "application/gpx+xml, application/xml, */*");
    const data = new Uint8Array(await res.arrayBuffer());
    const head = new TextDecoder().decode(data.subarray(0, 4096));
    if (!/<(\w+:)?gpx[\s>]/i.test(head)) throw new StravaError("Strava sent something that isn't a GPX file for this route.");
    return data;
  }
}

// Strava route types and sub-types -> rerouter's activity.
// type: 1 Ride, 2 Run, 3 Walk, 4 Hike, 5 Trail Run, 6 Gravel Ride, 7 Mountain Bike Ride;
// sub_type: 1 Road, 2 MTB, 3 Gravel, 4 Trail, 5 Mixed.
export function activityOf(type, subType) {
  if (type === 6) return "gravel";
  if (type === 7) return "mtb";
  if ([2, 3, 4, 5].includes(type)) return "hiking";
  if (type === 1) return { 1: "road", 2: "mtb", 3: "gravel" }[subType] || null;
  return null;
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** A route from the list -> {id, name, description, distance_km, gain_m, date, private, activity, url}. */
export function summarise(r) {
  // id_str: the numeric id is rounded by JSON.parse for today's (19-digit) route ids.
  const id = r.id_str ? String(r.id_str) : r.id != null && Number.isSafeInteger(r.id) ? String(r.id) : null;
  const distance = num(r.distance);
  const date = r.created_at || (num(r.timestamp) ? new Date(num(r.timestamp) * 1000).toISOString() : null);
  return {
    id,
    name: String(r.name || "").trim() || `Strava route ${id}`,
    description: String(r.description || "").trim() || null,
    distance_km: distance == null ? null : distance / 1000,
    gain_m: num(r.elevation_gain),
    date,
    private: !!r.private,
    activity: activityOf(num(r.type), num(r.sub_type)),
    url: id ? sourceUrl(id) : null,
  };
}

/** The library routes each Strava route URL was imported as: Map url -> [route, …]. */
export function importedByUrl(routes) {
  const map = new Map();
  for (const r of routes) {
    const m = String(r.source_url || "").match(/^https?:\/\/(?:www\.)?strava\.com\/routes\/(\d+)/i);
    if (!m) continue;
    const url = sourceUrl(m[1]);
    if (!map.has(url)) map.set(url, []);
    map.get(url).push(r);
  }
  return map;
}
