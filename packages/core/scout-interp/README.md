# @beaconsgg/scout-interp

**[C] client-bound (RN-safe).** This package interpolates a moving scout's position from the
scout's signed movement descriptor along a great circle.

## Status

Stable. The server and the React Native or Expo client run this package unchanged. The package is
pure great-circle math with **no turf, no `ngeohash` and no Node built-ins**. Nothing in the package
reads the wall clock, calls `Math.random` or depends on the locale.

## What the package does

A scout's position is **never streamed**. Every client interpolates the scout **locally** from the
signed `Movement` descriptor it already holds
([`doc/spec/discovery.md`](../../../doc/spec/discovery.md) §5). The **server** runs the same math
only to **filter discovery**. The server decides whether a scout is inside the queried cells right
now and never renders a position. Both sides compute from the same descriptor and the same clock,
so they agree on where a scout _is_ at a given instant without any traffic per position.

Determinism is the invariant. `interpolateScout(movement, nowMs)` is a **pure function**. The
caller always passes `nowMs` in, so the same `(movement, nowMs)` gives a bit-identical result
everywhere. `speedKmh` is in **kilometers per hour**. The descriptor's `locationTimestamp` (ISO
8601) is the instant the scout was at `lastKnownLocation`, and the package measures the path from
that instant.

The package is math only and keeps no animation state, frame loop or cache. The React Native client
drives `interpolateScout` from a **render loop that runs every frame**, and one loop animates every
visible unit. The **consumer** holds the loop's state, such as the current frame time and each
sprite's previous heading.

## Exports

The functions take `Movement` and `LatLng` from [`@beaconsgg/protocol-types`](../protocol-types).

| Export                              | Purpose                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `interpolateScout(movement, nowMs)` | The scout's `InterpolatedPosition` at `nowMs`. With no destination the result is `lastKnownLocation` with heading `0`. With a destination but no usable speed or timestamp the result is `lastKnownLocation`, heading for the destination. After arrival the result is the destination, with no extrapolation. Otherwise the result is the great-circle point reached at `speedKmh`, heading for the destination. |
| `InterpolatedPosition`              | The result shape `{ lat, lng, heading }`. `heading` is the bearing toward the destination in degrees (0 is north and 90 is east), and `0` when the scout has no destination.                                                                                            |
| `haversineMiles(a, b)`              | The great-circle distance between two `LatLng` values in **miles**. The `asin` input is clamped to its domain.                                                                                                                                                    |
| `bearing(a, b)`                     | The initial great-circle heading from `a` to `b` in degrees, in `[0, 360)`.                                                                                                                                                                                        |
| `intermediatePoint(a, b, t)`        | The `LatLng` a fraction `t` (0 to 1) of the way along the great circle from `a` to `b`. A 3D Cartesian slerp takes the short arc, so poles and the antimeridian are safe.                                                                                         |
| `arrivalMs(movement)`               | The epoch milliseconds at which the scout reaches its destination. `null` when the scout is stationary: no destination, `speedKmh <= 0` or a timestamp that doesn't parse.                                                                                        |
| `tripMs(movement)`                  | How long the whole path takes in milliseconds, from `lastKnownLocation`, `destination` and `speedKmh` alone. `null` with no destination or `speedKmh <= 0`. A caller can ask this about a route that has no timestamp yet. |
| `hasArrived(movement, nowMs)`       | Whether the scout has reached its destination by `nowMs`.                                                                                                                                                                                                          |
| `remainingMiles(movement, nowMs)`   | The great-circle miles from the position at `nowMs` to the destination, or `null` when the scout has no destination. With a destination but no usable speed the distance runs from `lastKnownLocation`. The distance is always **to the destination** and never from an origin, so the result leaks no path or progress.                                   |
| `lerpAngle(from, to, t)`            | Interpolation between two headings in degrees along the shorter way round, with the result in `[0, 360)`.                                                                                                                                                         |

### `lerpAngle`: smooth headings across the seam

`lerpAngle(from, to, t)` eases the **short way** around the seam between 360° and 0°. From `350°`
to `10°` the heading passes through `0°` and never takes the long way through `180°`. A render loop
calls `lerpAngle` to turn a directional sprite smoothly toward the target `heading` that
`interpolateScout` gives each frame. The function is pure, so the consumer's animation loop keeps
the sprite's previous heading. A loop runs `prev = lerpAngle(prev, pos.heading, 0.2)` each frame,
for example.

## Privacy: no progress and no origin

The public API has **no `progress`** (the fraction of the trip done) and **no start position**, on
purpose.

A relayed `Movement` carries only `lastKnownLocation` and `destination`. `lastKnownLocation` is the
last point the owner _reported_. That pair is the current **path from now**, and the scout's real
starting point is not part of the pair. The owner withholds the real origin so that an observer can't
infer where the scout came from. The owner's own location would follow from the scout's origin.
`lastKnownLocation` is a **waypoint** on the trip. A `progress` measured from that waypoint would
treat the waypoint as the start of the trip and invite a leak of the origin. The package therefore computes the position from the current path
and stops there.

## Boundaries

- **`nowMs <= start`** clamps to `lastKnownLocation`, and **`nowMs >= arrival`** clamps to the
  destination. Nothing extrapolates past either end.
- The result is the last known location when the scout has **no destination**, `speedKmh <= 0` or
  a `locationTimestamp` that doesn't parse. `arrivalMs` then returns `null`.
- A path that crosses the **antimeridian** takes the short way by Cartesian slerp and doesn't wrap
  around the globe.
- **Poles** and **identical or degenerate endpoints** return early, so `asin` and `atan2` never
  produce `NaN`.

## Scripts

```bash
pnpm --filter @beaconsgg/scout-interp build       # tsc -> dist
pnpm --filter @beaconsgg/scout-interp typecheck   # tsc --noEmit
pnpm --filter @beaconsgg/scout-interp test        # vitest
```
