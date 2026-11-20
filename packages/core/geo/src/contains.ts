// @beaconsgg/geo — point-in-area containment over GeoJSON Polygon/MultiPolygon geometry
// (beacon.server `doc/spec/places.md` §9). Pure + RN-safe. This is shared gameplay-facing math: the
// client gates "inside the park?" locally (radical trust — the server can't verify location claims)
// and the server uses the same function for query-side filtering, so both sides MUST agree —
// `CONTAINMENT_VECTORS` (contains-conformance.ts) pins the algorithm against drift.
import type { GeoPosition, LatLng, PlaceGeometry } from "@beaconsgg/protocol-types";
import type { BBox } from "./geohash";

/**
 * Containment is evaluated in raw lng/lat coordinate space (edges are straight lines in degrees,
 * the GeoJSON/turf convention), not along great circles — indistinguishable at the park/plaza
 * scale places use. On-boundary points are deterministic (identical IEEE-754 math on every JS
 * runtime) but not specified as in/out — gameplay must not hinge on centimeter-exact edges.
 */

type Ring = readonly GeoPosition[];

/** Shift a longitude into an antimeridian-crossing ring's continuous frame (west side +360). */
const unwrapLng = (lng: number): number => (lng < 0 ? lng + 360 : lng);

/** Whether consecutive vertices jump >180° of longitude — the ring wraps across ±180. */
function crossesAntimeridian(ring: Ring): boolean {
  for (let i = 1; i < ring.length; i++) {
    const prev = ring[i - 1];
    const curr = ring[i];
    if (prev && curr && Math.abs(curr[0] - prev[0]) > 180) return true;
  }
  return false;
}

/** Even-odd ray cast (winding-agnostic). `unwrap` evaluates in the +360-shifted frame. */
function inRing(px: number, py: number, ring: Ring, unwrap: boolean): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const ax = unwrap ? unwrapLng(a[0]) : a[0];
    const bx = unwrap ? unwrapLng(b[0]) : b[0];
    const ay = a[1];
    const by = b[1];
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** A geometry's polygons as ring lists (a Polygon is a one-element MultiPolygon). */
function polygonsOf(geometry: PlaceGeometry): readonly Ring[][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

/**
 * Return `true` when `point` is inside a place's area: inside a polygon's outer ring and outside
 * that polygon's holes. Use this on the client to check whether the player is inside a park.
 *
 * The winding order of the rings does not matter, and rings that cross the antimeridian work. A
 * point exactly on an edge may count as inside or outside, so don't let gameplay depend on it.
 * Servers run the same function, and `CONTAINMENT_VECTORS` pins its answers.
 *
 * The check visits every vertex once. To test many places, filter them first by bounding box with
 * {@link geometryBBox}. Rings that cross the antimeridian are evaluated in a frame shifted by 360,
 * keyed off the exterior ring; holes share their exterior's frame by construction.
 */
export function containsPoint(point: LatLng, geometry: PlaceGeometry): boolean {
  for (const rings of polygonsOf(geometry)) {
    const exterior = rings[0];
    if (!exterior) continue;
    const unwrap = crossesAntimeridian(exterior);
    const px = unwrap ? unwrapLng(point.lng) : point.lng;
    if (!inRing(px, point.lat, exterior, unwrap)) continue;
    // Indexed hole scan (no slice copy / closure — this is client-hot-path candidate math).
    let inHole = false;
    for (let h = 1; h < rings.length && !inHole; h++) {
      const hole = rings[h];
      if (hole && inRing(px, point.lat, hole, unwrap)) inHole = true;
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Return the bounding box of a place's area, from its outer rings. A box that crosses the
 * antimeridian has `minLng > maxLng`, the form `coveringCells` reads.
 *
 * When any exterior ring crosses ±180, all vertices are evaluated in the unwrapped frame. For a
 * pathological MultiPolygon spanning both a crossing polygon and a far-away one this can
 * over-cover, which is safe for its consumer (cell indexing enumerates extra cells, never misses
 * one) and unreachable for real places (a POI doesn't span Fiji and Italy).
 */
export function geometryBBox(geometry: PlaceGeometry): BBox {
  const polygons = polygonsOf(geometry);
  const unwrap = polygons.some((rings) => {
    const exterior = rings[0];
    return exterior !== undefined && crossesAntimeridian(exterior);
  });

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const rings of polygons) {
    for (const [lngRaw, lat] of rings[0] ?? []) {
      const lng = unwrap ? unwrapLng(lngRaw) : lngRaw;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  // Re-wrap an unwrapped east bound back past the antimeridian (yields the minLng > maxLng form).
  if (maxLng > 180) maxLng -= 360;
  return { minLat, minLng, maxLat, maxLng };
}
