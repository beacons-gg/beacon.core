import ngeohash from "ngeohash";
import type { LatLng } from "@beaconsgg/protocol-types";
import { DEFAULT_PRECISION, LIVE_CELL_PRECISION, neighbors, type BBox } from "./geohash";
import { bboxAround } from "./spatial";

/**
 * List the geohash cells of `precision` characters that cover a bounding box, each once.
 *
 * A box with `minLat` above `maxLat` is turned the right way up, and a box that crosses the
 * antimeridian (`minLng > maxLng`) is covered on both sides. The number of cells grows about 32
 * times with each extra character of precision. For a map view, use {@link cellsForView}, which
 * limits the count.
 *
 * An antimeridian box is split into `[minLng, 180]` and `[-180, maxLng]` and the halves unioned.
 * Without the split, ngeohash's longitude step goes negative and returns no cells
 * (`doc/spec/discovery.md` §3.1).
 */
export function coveringCells(bbox: BBox, precision: number): string[] {
  const minLat = Math.min(bbox.minLat, bbox.maxLat);
  const maxLat = Math.max(bbox.minLat, bbox.maxLat);

  if (bbox.minLng > bbox.maxLng) {
    const west = ngeohash.bboxes(minLat, bbox.minLng, maxLat, 180, precision);
    const east = ngeohash.bboxes(minLat, -180, maxLat, bbox.maxLng, precision);
    return [...new Set([...west, ...east])];
  }
  return [...new Set(ngeohash.bboxes(minLat, bbox.minLng, maxLat, bbox.maxLng, precision))];
}

/**
 * Return `cells` with each cell's 8 neighbors added, each cell once: the margin a discovery query
 * adds around a view (`doc/spec/discovery.md` §3.1).
 */
export function withNeighbors(cells: readonly string[]): string[] {
  const set = new Set<string>(cells);
  for (const cell of cells) {
    for (const n of neighbors(cell)) set.add(n);
  }
  return [...set];
}

/**
 * Return the geohash precision to query a map at, from the map's zoom level: from 2 when zoomed out
 * to 8 at street level.
 *
 * The steps are zoom 5 for precision 3, 8 for 4, 11 for 5, 13 for 6, 16 for 7 and 18 for 8. A zoom
 * that is not a finite number gives 2, the coarsest, so a bad zoom never asks for millions of
 * cells. The steps are a tuning choice and may change (`doc/spec/discovery.md` §3.1).
 */
function precisionForZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 2;
  if (zoom >= 18) return 8;
  if (zoom >= 16) return 7;
  if (zoom >= 13) return 6;
  if (zoom >= 11) return 5;
  if (zoom >= 8) return 4;
  if (zoom >= 5) return 3;
  return 2;
}

/** The options of {@link cellsForView}. */
export interface ViewCellOptions {
  /** The most cells to return. The precision is lowered until the cells fit. Defaults to 64. */
  maxCells?: number;
  /** Add each covering cell's neighbors. Defaults to `true`. */
  withNeighbors?: boolean;
}

/** The result of {@link cellsForView}: the cells to query, and the precision they are at. */
export interface ViewCells {
  /** The geohash cells to send in a discovery read. */
  cells: string[];
  /** The geohash precision of `cells`, after any lowering to fit `maxCells`. */
  precision: number;
}

/**
 * List the cells to send in a discovery read for a map view, at a precision chosen from `zoom` and
 * lowered until the list fits `maxCells` (default 64).
 *
 * The precision for a zoom runs from 2 when zoomed out to 8 at street level. The steps are a tuning
 * choice and may change, so read the precision from the result.
 *
 * Pass `cells` to `client.discoverCells`. A coarser cell still matches the rooms inside it, since
 * discovery matches by geohash prefix. The limit keeps a zoomed-out view from producing a cell list
 * too long for a URL (`doc/spec/discovery.md` §3.1). At precision 1 the result is returned even
 * when it holds more than `maxCells`.
 *
 * The cells are built from the coarsest precision up, stopping at the first precision over
 * `maxCells`. That bounds the work as well as the output: `bboxes` is never called at a fine
 * precision over a huge box, which could list millions of cells. The count grows about 32 times per
 * level (5 bits per geohash character), so the precision that breaks the limit lists at most about
 * 32 times `maxCells` cells.
 */
export function cellsForView(bbox: BBox, zoom: number, options: ViewCellOptions = {}): ViewCells {
  const maxCells = options.maxCells ?? 64;
  const pad = options.withNeighbors ?? true;
  const target = Math.max(1, Math.min(precisionForZoom(zoom), 9));
  const build = (precision: number): string[] => {
    const base = coveringCells(bbox, precision);
    return pad ? withNeighbors(base) : base;
  };

  let best: ViewCells = { cells: build(1), precision: 1 };
  for (let precision = 2; precision <= target; precision++) {
    const cells = build(precision);
    if (cells.length > maxCells) break; // finer than this would only grow
    best = { cells, precision };
  }
  return best;
}

/**
 * The default limit of {@link liveCellsForView}: 64 live cells per view. For a view that needs
 * more, the function reports `capped`, and your game polls discovery instead.
 */
export const MAX_LIVE_CELLS = 64;

/** The result of {@link liveCellsForView}: the live cells to watch, or `capped` for a view too wide. */
export interface LiveCells {
  /** The live map channel cells that cover the view, with their neighbors. Empty when `capped`. */
  cells: string[];
  /**
   * `true` when the view needs more cells than the limit. Watch no cells and poll discovery with
   * `pollDiscovery` from `@beaconsgg/client-sdk` instead.
   */
  capped: boolean;
}

/**
 * Estimate, from the box's size alone, how many cells `coveringCells(bbox, precision)` would list.
 *
 * Call this before {@link coveringCells} at a fixed precision, and stop when the estimate is over
 * your limit: listing the cells of a world-sized box at a fine precision takes millions of cells.
 * The result is an estimate and not a bound, so check the real count again after listing.
 */
export function estimateCellCount(bbox: BBox, precision: number): number {
  const latSpan = Math.abs(bbox.maxLat - bbox.minLat);
  const lngSpan =
    bbox.minLng > bbox.maxLng ? 360 - (bbox.minLng - bbox.maxLng) : bbox.maxLng - bbox.minLng;
  // A P-char geohash = 5P bits, split lng=ceil(5P/2) / lat=floor(5P/2).
  const bits = 5 * precision;
  const cols = Math.ceil((lngSpan / 360) * 2 ** Math.ceil(bits / 2));
  const rows = Math.ceil((latSpan / 180) * 2 ** Math.floor(bits / 2));
  return cols * rows;
}

/** The options of {@link coarsestFitCover}. */
export interface FitCoverOptions {
  /** The most cells to return. Precision 1 is the fallback, so up to 32 cells can come back. */
  maxCells: number;
  /** The finest precision to try. Defaults to {@link DEFAULT_PRECISION}. */
  precision?: number | undefined;
  /**
   * How far the size estimate may run over `maxCells` before the cells of a precision are listed,
   * as a factor. Defaults to 1. The real count is always checked against `maxCells`.
   */
  estimateSlack?: number | undefined;
}

/**
 * Cover `bbox` with as fine a precision as fits `maxCells`, trying from `precision` down.
 *
 * Each precision is estimated with {@link estimateCellCount} before its cells are listed, and the
 * real count is checked after. `estimateSlack` loosens only the estimate check. Precision 1 is the
 * fallback, so the result is never empty, but it may then hold up to 32 cells whatever `maxCells`
 * is. A caller that splits one budget across many points must count on that floor.
 *
 * The estimate can overshoot about 2 times at cell edges, which is what `estimateSlack` is for; the
 * exact `maxCells` check always holds. For SQL prefix scoping, over-selection at edges is inherent,
 * so callers keep a precise check.
 *
 * @param fit - `maxCells`, and optionally the starting `precision` and `estimateSlack`.
 */
export function coarsestFitCover(bbox: BBox, fit: FitCoverOptions): string[] {
  const budget = fit.maxCells * (fit.estimateSlack ?? 1);
  for (let precision = fit.precision ?? DEFAULT_PRECISION; precision > 1; precision--) {
    if (estimateCellCount(bbox, precision) <= budget) {
      const cover = coveringCells(bbox, precision);
      if (cover.length <= fit.maxCells) return cover;
    }
  }
  return coveringCells(bbox, 1);
}

/** Default cell budget for {@link cellsWithinRadius}, per point. A budget rather than a fixed
 *  precision for the reason {@link cellsForView} keeps one (its own default is 64): the caller
 *  knows the radius it wants, not how many cells that costs, and the cost swings by latitude and by
 *  radius. Sized so several points (you plus your deployed scouts) union to well inside a server's
 *  per-query cap; overridable, since only the caller knows how many points it is about to union. */
const RADIUS_CELL_BUDGET = 32;

/**
 * List the geohash cells that cover everything within `meters` of `point`, for a "what is near me"
 * read.
 *
 * The cells are as fine as fits `maxCells` (default 32), starting from `precision` (default {@link
 * DEFAULT_PRECISION}). Below 32 the limit may not hold, since precision 1 always has up to 32
 * cells. The cells always cover more than the circle, so filter the results by `distanceMeters`
 * when you need the exact radius.
 *
 * A cell plus its neighbors is not a radius: `withNeighbors` pads by one cell in each direction, so
 * at {@link DEFAULT_PRECISION} it guarantees only about 150 m of reach, and less than that east to
 * west away from the equator, where the cells narrow with cos(lat). A search
 * built that way covers whatever the indexing precision happens to buy, which is smaller than the
 * distances a game calls "near", and it fails by silently returning less rather than by erroring.
 * Taking the radius as a parameter makes the search area a decision instead of a side effect.
 *
 * The cover is always too large, in two ways: the box circumscribes the circle, and a coarsened
 * cell reaches past the box. Neither loses anything, because discovery intersection is
 * prefix-based: a coarser query cell still matches finer object hashes. A caller that needs the
 * exact radius filters the results by true distance, which is cheap once the set is small; see
 * `discoverAround`.
 *
 * @throws `Error` when `meters` is not a finite number.
 */
export function cellsWithinRadius(
  point: LatLng,
  meters: number,
  options: { precision?: number; maxCells?: number } = {},
): string[] {
  // Loud, not empty: a NaN radius (undefined arithmetic upstream) would otherwise propagate to a
  // bbox of NaNs and the precision-1 fallback's single bogus cell, querying a Pacific quadrant and
  // filtering everything out. Silent-empty is the exact failure class this function exists to kill.
  if (!Number.isFinite(meters))
    throw new Error(`cellsWithinRadius: non-finite radius (${meters} m)`);
  return coarsestFitCover(bboxAround(point, meters), {
    precision: options.precision,
    maxCells: options.maxCells ?? RADIUS_CELL_BUDGET,
  });
}

/** The options of {@link liveCellsForView}. */
export interface LiveCellOptions {
  /** The most cells to watch before the view is `capped`. Defaults to {@link MAX_LIVE_CELLS}. */
  maxCells?: number | undefined;
}

/**
 * List the live map channel cells to watch for a map view with their neighbors, or report `capped`
 * when the view needs more than `maxCells` (default {@link MAX_LIVE_CELLS}).
 *
 * Return the cells from the `cellsToWatch` function of the client's `subscribeMap`. On `capped`,
 * return `[]` there and poll discovery instead. The neighbors make sure a placement just over a
 * cell edge still reaches a view that overlaps that edge.
 *
 * The precision is fixed at {@link LIVE_CELL_PRECISION}, so the count is estimated before any cell
 * is listed: a zoomed-out view would otherwise list millions of cells.
 *
 * @param options - `maxCells`, the most cells to watch (default {@link MAX_LIVE_CELLS}).
 */
export function liveCellsForView(bbox: BBox, options: LiveCellOptions = {}): LiveCells {
  const maxCells = options.maxCells ?? MAX_LIVE_CELLS;
  if (estimateCellCount(bbox, LIVE_CELL_PRECISION) > maxCells) return { cells: [], capped: true };

  const cells = withNeighbors(coveringCells(bbox, LIVE_CELL_PRECISION));
  if (cells.length > maxCells) return { cells: [], capped: true };
  return { cells, capped: false };
}

/**
 * Return `true` when `point` is inside `bbox`, edges included. A box that crosses the antimeridian
 * (`minLng > maxLng`) is read as one box across ±180.
 */
// Every consumer (cover, containment, boundary filters) must read the wrap the same way, so the
// predicate lives here.
export function bboxContainsPoint(point: { lat: number; lng: number }, bbox: BBox): boolean {
  const inLat = point.lat >= bbox.minLat && point.lat <= bbox.maxLat;
  const inLng =
    bbox.minLng > bbox.maxLng
      ? point.lng >= bbox.minLng || point.lng <= bbox.maxLng
      : point.lng >= bbox.minLng && point.lng <= bbox.maxLng;
  return inLat && inLng;
}

/** Two cells intersect iff one is a geohash prefix of the other (same area, any precision). */
function prefixRelated(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Return `true` when a server's `coverage` overlaps any of `cells`: one is a prefix of the other,
 * at any precision.
 *
 * `serversForCells` in `@beaconsgg/client-sdk` uses this to send a read only to servers that cover
 * the view (`doc/spec/discovery.md` §3.2). An empty `coverage` overlaps nothing in this function,
 * but `serversForCells` treats a server with no coverage as covering the whole world.
 */
export function coverageIntersects(coverage: readonly string[], cells: readonly string[]): boolean {
  return coverage.some((c) => cells.some((q) => prefixRelated(c, q)));
}

/**
 * Return `true` when one of the `coverage` cells contains the geohash `hash`: the cell is a prefix
 * of `hash`.
 */
export function coverageContains(coverage: readonly string[], hash: string): boolean {
  return coverage.some((prefix) => hash.startsWith(prefix));
}

/**
 * Return how closely a server's `coverage` fits the point `hash`: the length of the longest
 * coverage cell that contains `hash`, or `0` when none does.
 *
 * `selectCoveringServer` in `@beaconsgg/client-sdk` sends a placement to the server with the
 * highest value. Whole-world coverage (an empty list, or a `""` entry) scores `0`. So does coverage
 * finer than `hash`, since it cannot be shown to contain the point.
 */
export function coverageSpecificity(coverage: readonly string[], hash: string): number {
  let best = 0;
  for (const prefix of coverage) {
    if (prefix.length > best && hash.startsWith(prefix)) best = prefix.length;
  }
  return best;
}
