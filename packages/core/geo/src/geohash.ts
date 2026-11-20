import { GEOHASH_RE, type LatLng } from "@beaconsgg/protocol-types";
import ngeohash from "ngeohash";

/**
 * The default geohash precision, 7 characters: cells about 150 m on a side at the equator, and
 * narrower east to west away from it. Servers index
 * placed objects at. {@link encode} uses this precision when you pass none.
 */
export const DEFAULT_PRECISION = 7;

/**
 * The geohash precision of the live map channel's cells: 5 characters. A cell is about 4.9 km on a
 * side at the equator and narrower east to west away from it.
 *
 * The value is fixed, and {@link liveCell} and {@link liveCellsForView} use it. The client filters
 * map updates by the viewport, so the cell size decides only how many cells a view watches, not
 * what is drawn.
 *
 * The precision is coarser than the indexing precision and independent of the zoom, so a small pan
 * doesn't change the watched cells. A placed object's index hash (at {@link DEFAULT_PRECISION}) has
 * its live cell as a prefix.
 */
export const LIVE_CELL_PRECISION = 5;

/**
 * The 32 geohash cells of precision 1, which together cover the whole world.
 *
 * Use them for a read that must list everything a server holds wherever it is, such as an operator
 * console listing every room of a type. A room's location need not sit inside the server's
 * advertised coverage, so querying these cells beats guessing the coverage. A player's map should
 * query its view with {@link cellsForView} instead.
 */
export const WORLD_CELLS: readonly string[] = [..."0123456789bcdefghjkmnpqrstuvwxyz"];

/**
 * A rectangle of latitude and longitude in degrees, such as a map view.
 *
 * A box that crosses the antimeridian (longitude ±180) has `minLng` greater than `maxLng`. The
 * functions in this package read that form.
 */
export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/**
 * Encode a point as a geohash of `precision` characters (default {@link DEFAULT_PRECISION}, 7).
 */
export function encode(point: LatLng, precision: number = DEFAULT_PRECISION): string {
  return ngeohash.encode(point.lat, point.lng, precision);
}

/**
 * Return the live map channel cell a point falls in: its geohash at {@link LIVE_CELL_PRECISION}.
 */
export function liveCell(point: LatLng): string {
  return encode(point, LIVE_CELL_PRECISION);
}

/**
 * Return `true` when `value` is a geohash: 1 to 12 characters of the lowercase geohash alphabet.
 *
 * Check input from another player with this, or use {@link decodeCell}, since {@link decode}
 * returns a point for any string.
 *
 * {@link decode} cannot answer the question: `ngeohash.decode` maps whatever it is
 * given through the base-32 table and returns a point for a string that was never a geohash, so a
 * caller measuring with untrusted input gets a confident answer to a meaningless question rather
 * than an error it could catch. A geohash inside an item's `birth` is exactly that kind of input: a
 * signed but radically-trusted birth field a peer's client wrote, which reaches this package the
 * moment anything measures a distance from it.
 *
 * The alphabet and the length cap are `@beaconsgg/protocol-types`'s `GEOHASH_RE`, which the wire's
 * `geohashCellSchema` wraps too, so there is one declaration and no second spelling to drift from.
 * Reaching for it is what gives this package a runtime import of that one (the rest of `geo` takes
 * types only); every consumer already bundles it, and a shared alphabet is worth the edge.
 *
 * Case-sensitive and lowercase-only, matching what every producer here writes. {@link WORLD_CELLS}
 * spells the same alphabet out one cell per character for callers that enumerate the world; a test
 * pins the two, since that is an agreement rather than a shared line.
 */
export function isGeohash(value: string): boolean {
  return GEOHASH_RE.test(value);
}

/**
 * Decode a geohash to the center point of its cell.
 *
 * The function does not check its input, and returns a point even for a string that is not a
 * geohash. Use {@link decodeCell} for any string another client could have written.
 */
export function decode(hash: string): LatLng {
  const { latitude, longitude } = ngeohash.decode(hash);
  return { lat: latitude, lng: longitude };
}

/**
 * Decode a geohash to the center point of its cell, or return `null` when `hash` is missing or not
 * a geohash. Prefer this to {@link decode}.
 *
 * `decode` cannot refuse a
 * string, so every caller holding untrusted input has to remember to ask {@link isGeohash} first,
 * and the cost of forgetting is a confident wrong point rather than an error: a plausible position
 * somewhere on Earth, which is the failure least likely to be caught reading a diff. Four of the
 * five callers in this repo hold input a peer's client wrote (a geohash in an item's birth, a
 * server descriptor's coverage cell), three of them spelled the pairing out by hand, and the fourth
 * had quietly not. Pairing it here means a reader gets it by calling the obvious thing.
 *
 * `decode` keeps its documented contract for the one caller whose input is already schema-checked.
 */
export function decodeCell(hash: string | undefined): LatLng | null {
  return hash !== undefined && isGeohash(hash) ? decode(hash) : null;
}

/**
 * Return the larger cell of `precision` characters that contains `hash`, which is the first
 * `precision` characters of `hash`.
 *
 * Use this to key a cache by area, so that nearby points share one entry. A hash already shorter
 * than `precision` is returned unchanged.
 */
export function coarsen(hash: string, precision: number): string {
  return hash.slice(0, precision);
}

/** Return the bounding box of a geohash cell, in degrees. */
export function cellBounds(hash: string): BBox {
  const [minLat, minLng, maxLat, maxLng] = ngeohash.decode_bbox(hash);
  return { minLat, minLng, maxLat, maxLng };
}

/** Return the 8 cells around a geohash cell, at the same precision: 4 sharing an edge, 4 a corner. */
export function neighbors(hash: string): string[] {
  return ngeohash.neighbors(hash);
}
