# @beaconsgg/geo

**[C] client-bound (RN-safe).** The package computes geohash coverage and answers cell queries.

## Status

Stable. The server and the React Native or Expo client run this package unchanged. The package is
pure TypeScript over [`ngeohash`](https://github.com/sunng87/node-geohash) with no Node built-ins.

Besides `ngeohash`, the package imports `GEOHASH_RE` from `@beaconsgg/protocol-types` at runtime.
The wire type declares the alphabet and the length cap of a geohash cell once, and `isGeohash` wraps
that declaration instead of keeping a second copy. Every other module here imports types only. The
cost is that a consumer can no longer use this package as a leaf without zod. No consumer pays that
cost today, since all of them already import `@beaconsgg/protocol-types` at runtime.

## What the package does

The package is the spatial primitive the client and the server share. The **client** turns a map
viewport into a set of geohash cells that cover the viewport. The **server** indexes rooms by cell
and tests whether a query intersects a room's coverage.

## Exports

| Purpose                 | Functions                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encode and decode       | `encode(point, precision)`, `isGeohash(value)`, `cellBounds(hash)` and `coarsen(hash, precision)`. **`decodeCell(hash)`** returns `LatLng \| null` and is the guarded decode to use by default. `decode(hash)` is unguarded and returns garbage for garbage, so use it only on input a schema already checked.               |
| Cover a viewport        | `coveringCells(bbox, precision)`, `withNeighbors(cells)` and `cellsForView(bbox, zoom, opts)`                                                                                                                                                                                                  |
| Cover a **radius**      | `cellsWithinRadius(point, meters, opts)` gives the query set for "what is near me". `bboxAround(point, meters)` is the box that set covers.                                                                                                                                                                                       |
| Guard the cost          | `estimateCellCount(bbox, precision)` estimates from the span. A caller with a fixed precision **must** estimate first and stop when the count is too high, before it lists any cells.                                                                                                                                          |
| Live map cells          | `liveCell(point)` and `liveCellsForView(bbox, { maxCells? })`, which returns `{ cells, capped }`                                                                                                                                                                                                                                     |
| Neighbors               | `neighbors(hash)` and `withNeighbors(cells)`                                                                                                                                                                                                                                                                                    |
| Coverage tests          | `coverageIntersects(coverage, cells)`, `coverageContains(coverage, hash)` and `coverageSpecificity(coverage, hash)`                                                                                                                                                                                                             |
| Containment in places   | `containsPoint(point, geometry)` runs an even-odd point-in-polygon test over a GeoJSON `Polygon` or `MultiPolygon`, with holes and across the antimeridian. `geometryBBox(geometry)` emits the wrapped `minLng > maxLng` form that `coveringCells` splits on. `CONTAINMENT_VECTORS` is the conformance suite the client and the server both pass. |
| Spatial math            | `distanceMeters(a, b)`, `destination(point, bearing, meters)`, `avoidOverlap(target, obstacles, minSepM)`, `bboxAround(point, meters)` and `METERS_PER_MILE`                                                                                                                                                                   |
| Types                   | `BBox`, `LatLng`, `ViewCellOptions`, `ViewCells`, `LiveCells` and `ContainmentVector`. `LatLng` is re-exported from `@beaconsgg/protocol-types`.                                                                                                                                                                              |

`DEFAULT_PRECISION = 7` gives room-index cells of about 150 m. `LIVE_CELL_PRECISION = 5` gives live
channel cells of about 4.9 km, and `MAX_LIVE_CELLS = 64` is the default cap on the cells of a live
subscription.

**Containment is shared gameplay math.** The server can't verify where a player says they are, so
the client checks "is the player inside this park" with the exact function the server uses to filter
queries. `CONTAINMENT_VECTORS` pins the algorithm so the two never drift apart (the server's places
spec, beacon.server `doc/spec/places.md` §9). The test runs in raw longitude and latitude space as
GeoJSON and turf do. That space is correct at the scale of a place. Behavior on the boundary is
deterministic and unspecified, so gameplay must not depend on edges exact to the centimeter. `BBox`
and `LatLng` from [`@beaconsgg/protocol-types`](../protocol-types) are the shared geometry types.

## `cellsWithinRadius`: a real radius

**A cell plus its edge neighbors is not a radius.** A proximity search built that way covers
whatever the index precision happens to give. At precision 7 that is about 150 m, and less from east
to west away from the equator. The caller meant some other distance, and the search returns less
than asked with no error. `cellsWithinRadius` closes that trap, and its doc comment explains the
details:

- `bboxAround` draws the box around the circle;
- `coarsestFitCover(bbox, { maxCells, precision?, estimateSlack? })` fits a budget of cells per point;
- the extra coverage costs nothing, because discovery intersects cells by prefix;
- callers then cut the results to the true distance, as the client's `discoverAround` does.

## `cellsForView`: the safe view query

`cellsForView` builds the cells the client sends for each gesture. The function picks a precision
from `zoom` and then **coarsens until the set fits `maxCells`** (default 64). The set is built
coarsest first, so the function never lists a fine grid over a huge box and never hangs.
`cellsForView` handles two edge cases that raw `bboxes` doesn't:

- **Antimeridian.** A box with `minLng > maxLng` splits into `[minLng,180]` and `[-180,maxLng]`, and
  the function joins the two. A view across the date line still returns coverage instead of zero
  cells.
- **Inverted or out-of-range** latitudes and a `zoom` that isn't finite are normalized or clamped.

## Live map cells: the update channel

`liveCell(point)` and `liveCellsForView(bbox, { maxCells? })` drive the publish and subscribe channel
for live map updates. `liveCell` encodes a point at the **fixed** `LIVE_CELL_PRECISION` (5, cells of
about 4.9 km) to make the `cell:<geohash>` room key. `liveCellsForView` returns `{ cells, capped }`.
`cells` is the set of those rooms that covers a view, padded with edge neighbors.

- **A fixed precision of its own.** Zoom doesn't set the live precision, as it does for
  `cellsForView`. The live precision is coarser than the index precision (`DEFAULT_PRECISION`) and
  separate from the discovery precision, so small pans don't churn subscriptions. A placed room's
  index hash always has its live cell as a prefix. The client still filters incoming changes by its
  own viewport, so the precision tunes only how finely subscriptions and fan-out are split. The
  precision never changes what the map draws.
- **A cost guard that estimates first.** With a fixed precision, a view zoomed far out could make
  `ngeohash` list _millions_ of cells. `liveCellsForView` therefore **estimates** the count from the
  box's span first. Over the cap the function returns `capped: true` with empty `cells` before it
  lists anything, the same discipline as the coarsest-first build of `cellsForView`. The cap
  defaults to `MAX_LIVE_CELLS` (64). When the result is `capped`, the caller polls discovery instead
  of subscribing.

## How the client and the server use the package

- The client calls `cellsForView(viewport, zoom)` and asks the server for the rooms and the scouts
  in those cells.
- The client calls `liveCellsForView(viewport)` and subscribes to those `cell:<geohash>` rooms for
  live updates, or polls when the result is `capped`. A placement publishes to the room that
  `liveCell(point)` names.
- The server stores each room's `coverage` cells and answers discovery and listings with
  `coverageIntersects(coverage, cells)`.

## Scripts

```bash
pnpm --filter @beaconsgg/geo build       # tsc -> dist
pnpm --filter @beaconsgg/geo typecheck   # tsc --noEmit
pnpm --filter @beaconsgg/geo test        # vitest
```
