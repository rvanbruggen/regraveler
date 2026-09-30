# Combine routes: redesign plan

Status: proposal, 2026-09-30. Nothing is built yet.

## Goal

Replace today's "pick A and B, pick a pattern, drag four points" screen with a step-by-step
wizard:

1. **Pick routes.** Choose 2 or more routes, using the Browse panel (collections, smart
   collections, areas, activities).
2. **Keep parts.** On each route, mark the stretch (or stretches) to keep, from one point to another.
3. **Connect.** Say "connect the end of this part to the start of that part", by clicking.
4. **Suggest.** The app routes each connection (BRouter) and suggests a route for it.
5. **Validate.** The user accepts each suggestion, picks an alternative, or changes it.
6. **Save.** The app makes one combined route, to save or download.

## Evaluation: is it feasible?

Yes. Most of the engine is already there, so the work is mainly in the UI.

What exists (facts from the code):

- **The engine already handles N parts.** `combineParts(parts, router, {closed, vias})` in
  `web/js/combiner.js` rides a list of parts in order and joins them with connectors. Each part
  is `{track, startAt, endAt, otherWay}`. The comment says: "the general form both of the above
  are built on".
- **The service accepts 2–6 parts.** `runCombine` in `web/js/service.js` takes
  `req.parts: [{route_id, start, end, other_way}]`, with `MAX_PARTS = 6`, and handles
  `closed`, `reverse`, `profile`, `prefer_unpaved`, `straight` and `vias` (a place per
  connector). `combinePreview`, `combineSave` and `combineGpx` all go through it.
- **The same route can appear twice.** Only `new Set(ids).size < 2` is checked, so two parts
  from one route are allowed, as long as at least two routes are used.
- **One Browse panel, moved between views.** `app.js:113-115` moves the single `#catalog`
  element into the Library or Map view. Clicking a node sets the library filters (`setFilters`).
- **BRouter can give alternatives.** The request already sends `alternativeidx=0`
  (`web/js/brouter.js:31`). BRouter accepts the values 0–3, so we can offer up to 4 route
  choices per connection.

What is missing or has to change:

- **The combine UI** (`app.js` about lines 2994–3530, `index.html` `#view-combine`) is built
  around exactly two routes (A/B), four points (a1, a2, b1, b2) and three patterns. It has to
  be rewritten, not extended.
- **Connectors are computed and joined in one step.** `stitch()` routes each connector while
  it builds the result, so there is no way to show a connector, let the user approve it, and
  then keep that exact geometry. We need a separate "route one connector" call, and
  `combineParts` must be able to take connector geometries that were already approved.
- **Only one BRouter result is used.** `brouter.route()` needs an `alternative` argument.
- **The Browse panel drives the library filters.** It has no "pick" mode yet (see step 1).
- **Roadmap conflict.** `docs/ROADMAP.md` lists "combining N routes" under "Dropped for now".
  This plan brings it back, so the roadmap needs an update.

## Design, step by step

### Step 1 — Pick routes

- The side panel shows the Browse panel (moved in, the same way as on the Map). Clicking a
  collection, area and so on filters the list and the background lines on the map.
- Under it: the filtered routes, each with a checkbox, plus a click on a line on the map
  toggles that route. The chosen routes get a colour each (a palette of 6) and are listed as
  chips.
- Library entry point: select routes in the table → a new **Combine…** button in `#sel-bar`
  opens the wizard with them. The route panel's existing **Combine…** button (`#d-combine`)
  keeps working and adds the route to the selection.
- Limit: 6 routes (the current `MAX_PARTS`), so that the number of BRouter calls stays low.

Implementation: give `renderCatalog()` a mode. In `"filter"` mode (today) a click calls
`setFilters`. In `"pick"` mode the click goes to a callback, and the combine view keeps its own
filter state, so the library filters are not touched.

### Step 2 — Keep parts

- The user works on one route at a time (tabs or chips). Click a start point on the line, then
  an end point. The stretch between them is highlighted, and both ends can be dragged along
  the route (as today, snapped with `locate`, refusing clicks more than `MAX_SNAP_M` away).
- The riding direction is the order of the two clicks. For a loop route, a toggle "the other
  way round" sets `otherWay`.
- "Whole route" button: start 0 to the end.
- A route may have more than one kept part (for example, one stretch going out and another
  coming back).
- Optional help: a **Suggest** button that uses today's `suggestConnections` and
  `suggestCrossover` to pre-fill the parts.

Data: `parts: [{id, route_id, start: [lat, lon], end: [lat, lon], other_way}]`. This is
already the shape `runCombine` takes.

### Step 3 — Connect

- Each part has two end markers, "in" (start) and "out" (end). The user clicks an "out"
  marker, then an "in" marker of another part. A dashed straight line shows the pending
  connection.
- Rules: each end is used at most once. The connections must make one chain through all
  parts. The last "out" to the first "in" closes a loop (`closed: true`).
- Clicking a connection removes it. **Auto-connect** proposes the order with the shortest
  total straight-line gap and warns when lines cross (the existing `connectorsCross` does this).
- When the chain is complete, the order of the parts follows from it. The engine needs no
  change for this, only the parts sorted into that order.

### Step 4 — Suggest a route for each connection

- For each connection, one BRouter call (`alternativeidx=0`), queued like today (one request
  at a time). Gaps of `DIRECT_JOIN_M` (25 m) or less are joined directly, as today.
- The side panel lists the connections with distance, and the map shows them in the connector
  orange.
- The existing controls stay: profile, prefer unpaved, straight lines, and "through a place"
  (`vias`).

### Step 5 — Validate

- For each connection: **Accept**, **Alternative** (fetches `alternativeidx` 1, 2, 3 and
  shows them side by side), **Through a place…** (today's via), or **Straight**.
- The result can only be saved when every connection is accepted. The approved geometry is
  kept, so the save does not route again and give a different line.

### Step 6 — Generate and save

- Build the route from the parts and the approved connector geometries. Show the stats, the
  "Your ride" steps, and the elevation profile. Then **Save as new route** or
  **Download GPX** (today's `combineSave` and `combineGpx`, extended).
- The saved route records `derived_from` (all source routes), as today.

## Code changes

**`web/js/brouter.js`**
- `route(..., alternative = 0)` sends `alternativeidx=${alternative}`.

**`web/js/combiner.js`**
- Split `stitch()`: `connectorGap(parts, i)` gives the two end points of connector i, and
  `routeConnector(p, q, router, directJoinM, via)` (today's `connector`) is exported.
- `combineParts(parts, router, {connectors})`: when `connectors[k]` holds an approved
  geometry, use it instead of routing. The rest stays the same.
- New `orderParts(parts, links)`: turns the user's connections into a part order plus
  `closed`, or explains what is missing ("part C is not connected", "two separate chains").
- New `suggestOrder(parts)`: the shortest chain for auto-connect (brute force is fine for 6
  or fewer parts: at most 6! × 2 orders).

**`web/js/service.js`**
- `combineConnector({from, to, profile, prefer_unpaved, via, alternative})` gives
  `{points, distance_m}`.
- `runCombine` accepts `connectors: [[[lat, lon, ele], ...] | null]` and uses them when given.
- `combineSuggest` stays as the optional "suggest parts" helper.

**`web/js/app.js` and `web/index.html`**
- Rewrite the `#view-combine` side panel as a 4-step wizard: Routes → Parts → Connect →
  Review. Back and forward are always possible. Changing a part clears only the connections
  that touch it.
- State: `cb = {step, routeIds, parts, links, connectors: [{points, alt, accepted, via}], ...}`,
  kept in the URL hash as far as it is useful (routes and parts), as today.
- `renderCatalog(mode, onPick)` for pick mode.
- A **Combine…** button in the library selection bar.

**Tests** (`web/tests/combiner.test.js`, `service.test.js`)
- `orderParts`: open chain, closed loop, missing link, branching, two chains.
- `combineParts` with approved connectors: no router calls; the geometry is used as given.
- 3 routes end to end with a fake router.
- Existing tests keep passing: the A/B service API stays usable as the 2-part case.

## Phasing

Each phase is a release that works on its own.

1. **Engine and service** (S): the alternatives, approved connectors, `orderParts` and
   `suggestOrder`, and tests. No UI change.
2. **Wizard, steps 1–3 and 6** (M–L): pick N routes with Browse, mark parts, connect them,
   and save. Connectors are routed automatically, as today.
3. **Validate** (S–M): accept or choose an alternative per connection, and keep the approved
   geometry.
4. **Polish** (S): Auto-connect, the "suggest parts" helper, the library **Combine…** button,
   the help text and screenshots (`docs/screenshots/combine.webp`), the changelog and the
   roadmap update.

## Open questions

1. **Keep the three quick patterns** ("Out on A, back on B", "Two crossings", "A then B") as
   one-click presets in step 2? My suggestion: yes, as a "Suggest" menu, because they are
   quick for the common two-route case.
2. **More than one part from the same route:** allow it now, or later? The engine already
   allows it; the UI cost is small.
3. **Limit of 6 routes:** fine, or higher? Each extra route adds 1–4 BRouter calls on the
   public server.
4. **Mobile:** clicking two markers precisely on a phone is fiddly. Is a "choose from list"
   fallback for connections acceptable?
