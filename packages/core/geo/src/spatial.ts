// @beaconsgg/geo — spatial math over lat/lng points (distance, offset, overlap avoidance, the box a
// radius spans). Pure + RN-safe; distinct from the geohash *cell* helpers, though `bboxAround` is
// the bridge to them. Used to keep auto-placed rooms (a client picking the spot on the player's
// behalf) from stacking on top of existing ones on the map, and to turn "within N of here" into
// something queryable.
import type { LatLng } from "@beaconsgg/protocol-types";
import type { BBox } from "./geohash";

const EARTH_RADIUS_M = 6_371_000;
/** Meters per degree of latitude, derived from the SAME sphere the haversine helpers measure on
 *  (pi x R / 180, ~111,195); longitude scales this by cos(lat). Derived rather than the textbook
 *  111,320 because a box built here gets CUT by a haversine filter later: the hand-me-down
 *  constant was ~0.11% larger, which shaved `bboxAround` thin in the filter's own metric, and
 *  when a geohash cell boundary fell inside that sliver a genuinely in-range object encoded to a
 *  cell outside the query set (review finding, verified by construction at 47.6N). */
const M_PER_DEG_LAT = (Math.PI * EARTH_RADIUS_M) / 180;
/**
 * The number of meters in a statute mile: 1609.344.
 *
 * The cell helpers work in meters, and `haversineMiles` in `@beaconsgg/scout-interp` works in
 * miles.
 */
export const METERS_PER_MILE = 1_609.344;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
/** Fold a longitude back into [-180, 180). */
const wrapLng = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180;

/** Return the great-circle distance between two points in meters, by the haversine formula. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Return the point `meters` away from `point` in the direction `bearingDeg`, in degrees clockwise
 * from north (0 is north, 90 is east).
 *
 * The math is a flat approximation, accurate to well under a meter over tens of meters, so use it
 * only for short offsets. The longitude is not wrapped and can pass ±180 near the antimeridian.
 */
export function destination(point: LatLng, bearingDeg: number, meters: number): LatLng {
  const north = meters * Math.cos(toRad(bearingDeg));
  const east = meters * Math.sin(toRad(bearingDeg));
  return {
    lat: point.lat + north / M_PER_DEG_LAT,
    lng: point.lng + east / (M_PER_DEG_LAT * Math.cos(toRad(point.lat))),
  };
}

/**
 * Move `target` to a nearby point at least `minSepM` meters from every point in `obstacles`, so
 * that a room your game places for the player does not land on top of another.
 *
 * A `target` already clear is returned unchanged. Otherwise the function tries rings around
 * `target`, at `minSepM` times 1, 2 and so on up to `rings` (default 4), with `bearings` points on
 * each ring (default 8). The function returns the first clear point, or `target` itself when every
 * point is taken, since a small overlap is better than a placement that fails.
 */
export function avoidOverlap(
  target: LatLng,
  obstacles: readonly LatLng[],
  minSepM: number,
  { rings = 4, bearings = 8 }: { rings?: number; bearings?: number } = {},
): LatLng {
  const clear = (p: LatLng): boolean => obstacles.every((o) => distanceMeters(p, o) >= minSepM);
  if (clear(target)) return target;
  for (let ring = 1; ring <= rings; ring += 1) {
    for (let i = 0; i < bearings; i += 1) {
      const candidate = destination(target, (360 / bearings) * i, minSepM * ring);
      if (clear(candidate)) return candidate;
    }
  }
  return target;
}

/**
 * Return a bounding box that contains every point within `meters` of `point`, to turn a radius into
 * a box the cell helpers can cover.
 *
 * The box covers more than the circle at its corners, so filter by `distanceMeters` when you need
 * the exact circle. A box that crosses the antimeridian comes back with `minLng > maxLng`. Near a
 * pole the box can span every longitude.
 *
 * The math is equirectangular, the same local planar approximation {@link destination} uses.
 *
 * The box circumscribes the circle on purpose: it over-covers at the corners by up to √2, which is
 * the safe direction for a search area. A caller that needs the exact circle filters by true
 * distance afterwards, on a small set; one that under-covered would silently miss things and look
 * like it was working.
 *
 * The longitude half-width is taken at the latitude nearest the pole, because a meter buys more
 * degrees of longitude the further from the equator you are, so measuring at `point.lat` alone
 * would leave the corners of a tall box uncovered. Toward the poles that width grows without bound,
 * so past a half-turn the box is the whole longitude band. Otherwise the edges wrap into [-180,
 * 180), so a box spanning the antimeridian comes out as `minLng > maxLng`, which is the form
 * `coveringCells` and `bboxContainsPoint` already read.
 */
export function bboxAround(point: LatLng, meters: number): BBox {
  const dLat = Math.abs(meters) / M_PER_DEG_LAT;
  const minLat = Math.max(-90, point.lat - dLat);
  const maxLat = Math.min(90, point.lat + dLat);
  const cosLat = Math.cos(toRad(Math.max(Math.abs(minLat), Math.abs(maxLat))));
  // The `cosLat` guard looks redundant against the `dLng >= 180` test below: dividing by zero gives
  // Infinity, which that test would catch. It is here for the one case that does NOT: a zero-metre
  // box exactly at a pole divides 0 by 0, and `NaN >= 180` is false, so the wrap arithmetic would
  // return a bbox of NaNs.
  const dLng = cosLat <= 0 ? 180 : Math.abs(meters) / (M_PER_DEG_LAT * cosLat);
  if (dLng >= 180) return { minLat, minLng: -180, maxLat, maxLng: 180 };
  return { minLat, minLng: wrapLng(point.lng - dLng), maxLat, maxLng: wrapLng(point.lng + dLng) };
}
