import type { LatLng, Movement } from "@beaconsgg/protocol-types";

/**
 * Scout movement interpolation for the relay model: position is **not streamed**; every client
 * interpolates locally from the signed movement descriptor (`doc/spec/discovery.md` §5). Pure
 * great-circle math (no turf, no Node built-ins) so it's RN-safe. `speedKmh` is in **kilometers per
 * hour**; `nowMs` is passed in so the function stays pure/testable.
 *
 * Privacy note (why there is no `progress` / origin): a relayed `Movement` carries only
 * `lastKnownLocation` — the last point the owner *reported* — and `destination`, i.e. the current
 * "now path". It is **not** the scout's true deployment origin; the owner withholds that so an
 * observer can't infer where the scout (and thus the owner) came from. So we deliberately do not
 * expose a fraction-of-journey `progress` or any "start" position — `lastKnownLocation` is a
 * waypoint, not a journey start, and treating it as one would invite leaking the origin.
 */

export interface InterpolatedPosition {
  lat: number;
  lng: number;
  /** Bearing toward the destination, degrees (0 = N, 90 = E). 0 when stationary. */
  heading: number;
}

const R_KM = 6371; // the same sphere as `@beaconsgg/geo`'s `distanceMeters`
const KM_PER_MILE = 1.609344;
const MS_PER_HOUR = 3_600_000;

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Great-circle distance in kilometers (haversine), the unit a scout's speed is in. */
function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle distance in miles (haversine). */
export function haversineMiles(a: LatLng, b: LatLng): number {
  return haversineKm(a, b) / KM_PER_MILE;
}

/**
 * Shortest-path angular interpolation between two headings (degrees), result in [0, 360). Eases
 * the **short way** around the 360/0 seam — 350° → 10° goes through 0°, not the long way through
 * 180°. A render loop uses this to rotate a directional sprite smoothly toward the per-frame target
 * heading (from `interpolateScout`) instead of snapping. It is a pure function; the frame-to-frame
 * state (the sprite's previous heading) lives in the consumer's animation loop, not here — e.g.
 * `prev = lerpAngle(prev, pos.heading, 0.2)` each frame.
 */
export function lerpAngle(from: number, to: number, t: number): number {
  const diff = ((((to - from) % 360) + 540) % 360) - 180;
  return (((from + diff * t) % 360) + 360) % 360;
}

/** Initial bearing from `a` to `b`, degrees in [0, 360). */
export function bearing(a: LatLng, b: LatLng): number {
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point a fraction `t` (0..1) of the way along the great circle from `a` to `b`. */
export function intermediatePoint(a: LatLng, b: LatLng, t: number): LatLng {
  const la1 = toRad(a.lat);
  const lo1 = toRad(a.lng);
  const la2 = toRad(b.lat);
  const lo2 = toRad(b.lng);
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((la2 - la1) / 2) ** 2 +
          Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2,
      ),
    );
  if (d === 0) return { lat: a.lat, lng: a.lng };
  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
  const z = A * Math.sin(la1) + B * Math.sin(la2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDeg(Math.atan2(y, x)),
  };
}

/**
 * How long the trip takes end to end, in ms, or null if the scout isn't traveling (no destination, or
 * a speed of zero). The *length* of a journey, with no reference to when it started.
 *
 * Split out from {@link arrivalMs} because the two questions are asked at different moments and only
 * one of them needs a clock. "When does it land?" belongs to a scout already under way, whose
 * `locationTimestamp` is the instant the answer is measured from. "How long would this take?" is asked
 * about a journey nobody has begun, where there is no such instant and inventing one only to subtract
 * it back out is a workaround for this function not existing. `arrivalMs` is now that instant plus
 * this, so the two can't drift.
 *
 * Takes only the three fields it reads, so a caller with a candidate route rather than a signed
 * descriptor doesn't have to fabricate a timestamp to ask.
 */
export function tripMs(
  movement: Pick<Movement, "lastKnownLocation" | "destination" | "speedKmh">,
): number | null {
  if (!movement.destination || movement.speedKmh <= 0) return null;
  const totalKm = haversineKm(movement.lastKnownLocation, movement.destination);
  return (totalKm / movement.speedKmh) * MS_PER_HOUR;
}

/**
 * The estimated arrival time (ms epoch), or null if the scout isn't traveling. The trip's length,
 * measured from the instant it was reported at.
 *
 * The timestamp is validated before the route is measured, because parsing it is the cheaper of the
 * two and an unparseable one ends the question either way.
 */
export function arrivalMs(movement: Movement): number | null {
  const startMs = Date.parse(movement.locationTimestamp);
  if (!Number.isFinite(startMs)) return null;
  const trip = tripMs(movement);
  return trip == null ? null : startMs + trip;
}

/** Has the scout reached its destination by `nowMs`? */
export function hasArrived(movement: Movement, nowMs: number): boolean {
  const arrival = arrivalMs(movement);
  return arrival !== null && nowMs >= arrival;
}

/**
 * The scout's interpolated position at `nowMs`. Returns the last-known location if there's no
 * destination or the data is unusable; the destination once arrived; otherwise the great-circle
 * point reached at the descriptor's speed.
 */
export function interpolateScout(movement: Movement, nowMs: number): InterpolatedPosition {
  const start = movement.lastKnownLocation;
  const dest = movement.destination;
  if (!dest) return { lat: start.lat, lng: start.lng, heading: 0 };

  const startMs = Date.parse(movement.locationTimestamp);
  const totalKm = haversineKm(start, dest);
  if (!Number.isFinite(startMs) || totalKm === 0 || movement.speedKmh <= 0) {
    return { lat: start.lat, lng: start.lng, heading: bearing(start, dest) };
  }

  const elapsedHours = Math.max(0, (nowMs - startMs) / MS_PER_HOUR);
  const t = Math.min(1, (movement.speedKmh * elapsedHours) / totalKm);
  const p = intermediatePoint(start, dest, t);
  return { lat: p.lat, lng: p.lng, heading: bearing(p, dest) };
}

/** Great-circle miles from the scout's interpolated position to its destination, or null if none. */
export function remainingMiles(movement: Movement, nowMs: number): number | null {
  if (!movement.destination) return null;
  return haversineMiles(interpolateScout(movement, nowMs), movement.destination);
}
