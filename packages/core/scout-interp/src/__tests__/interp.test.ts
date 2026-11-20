import type { Movement } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import {
  arrivalMs,
  tripMs,
  bearing,
  hasArrived,
  haversineMiles,
  interpolateScout,
  lerpAngle,
  remainingMiles,
} from "../index";

const SEATTLE = { lat: 47.61, lng: -122.34 };
const PORTLAND = { lat: 45.52, lng: -122.68 };

const START_MS = Date.parse("2026-06-29T00:00:00Z");

// ~234 km Seattle->Portland at 160 km/h -> ~1.46h travel.
const traveling: Movement = {
  lastKnownLocation: SEATTLE,
  locationTimestamp: "2026-06-29T00:00:00Z",
  destination: PORTLAND,
  speedKmh: 160,
};

describe("haversineMiles / bearing", () => {
  it("computes a sane distance (Seattle->Portland ~145mi)", () => {
    const d = haversineMiles(SEATTLE, PORTLAND);
    expect(d).toBeGreaterThan(120);
    expect(d).toBeLessThan(175);
  });

  it("bearing points roughly south", () => {
    expect(bearing(SEATTLE, PORTLAND)).toBeGreaterThan(135);
    expect(bearing(SEATTLE, PORTLAND)).toBeLessThan(225);
  });
});

describe("interpolateScout", () => {
  it("returns the start at t=0", () => {
    const p = interpolateScout(traveling, START_MS);
    expect(p.lat).toBeCloseTo(SEATTLE.lat, 3);
    expect(p.lng).toBeCloseTo(SEATTLE.lng, 3);
  });

  it("returns the destination once arrived (and clamps past it)", () => {
    const p = interpolateScout(traveling, START_MS + 5 * 3_600_000);
    expect(p.lat).toBeCloseTo(PORTLAND.lat, 3);
    expect(p.lng).toBeCloseTo(PORTLAND.lng, 3);
  });

  it("interpolates between endpoints partway through", () => {
    const arrival = arrivalMs(traveling)!;
    const mid = interpolateScout(traveling, (START_MS + arrival) / 2);
    expect(mid.lat).toBeLessThan(SEATTLE.lat);
    expect(mid.lat).toBeGreaterThan(PORTLAND.lat);
    // roughly halfway in latitude
    expect(mid.lat).toBeCloseTo((SEATTLE.lat + PORTLAND.lat) / 2, 1);
  });

  it("returns the last-known location when there is no destination", () => {
    const stationary: Movement = {
      lastKnownLocation: SEATTLE,
      locationTimestamp: "2026-06-29T00:00:00Z",
      speedKmh: 0,
    };
    const p = interpolateScout(stationary, START_MS + 10_000);
    expect(p).toEqual({ lat: SEATTLE.lat, lng: SEATTLE.lng, heading: 0 });
  });
});

describe("lerpAngle (heading smoothing across the 360/0 seam)", () => {
  it("returns the endpoints at t=0 and t=1", () => {
    expect(lerpAngle(20, 80, 0)).toBeCloseTo(20);
    expect(lerpAngle(20, 80, 1)).toBeCloseTo(80);
  });

  it("takes the short way across 0 (350 -> 10 passes through 0, not 180)", () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0); // midpoint is 0°, not 180°
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0); // symmetric
    expect(lerpAngle(350, 10, 1)).toBeCloseTo(10);
  });

  it("interpolates linearly within a hemisphere", () => {
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45);
  });

  it("always returns a normalized heading in [0, 360)", () => {
    const v = lerpAngle(350, 10, 0.5);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(360);
  });
});

describe("tripMs", () => {
  it("is the length of the journey, and arrivalMs is the start plus it", () => {
    // The invariant the split exists for: one arithmetic, read two ways.
    const trip = tripMs(traveling)!;
    expect(trip).toBeGreaterThan(0);
    expect(arrivalMs(traveling)).toBe(START_MS + trip);
  });

  it("reads only the route, so a bare one and a full descriptor agree", () => {
    // That it can't read the clock is the parameter's job, not a test's: a timestamp isn't in the
    // type, so a caller with a candidate route and no stamp can ask, and the compiler says so.
    const { lastKnownLocation, destination, speedKmh } = traveling;
    expect(tripMs({ lastKnownLocation, destination, speedKmh })).toBe(tripMs(traveling));
  });

  it("is null for a scout with nowhere to go or no speed to get there", () => {
    expect(tripMs({ ...traveling, speedKmh: 0 })).toBeNull();
    const { lastKnownLocation, speedKmh } = traveling;
    expect(tripMs({ lastKnownLocation, speedKmh })).toBeNull();
  });

  it("reads the speed in kilometers per hour", () => {
    // One degree of the equator is pi x 6371 / 180 km, so at that many km/h the trip takes an hour.
    const oneDegreeKm = (Math.PI * 6371) / 180;
    const trip = tripMs({
      lastKnownLocation: { lat: 0, lng: 0 },
      destination: { lat: 0, lng: 1 },
      speedKmh: oneDegreeKm,
    });
    expect(trip).toBeCloseTo(3_600_000, 3);
  });
});

describe("arrivalMs / hasArrived", () => {
  it("estimates arrival and reports arrival state", () => {
    const arrival = arrivalMs(traveling)!;
    expect(arrival).toBeGreaterThan(START_MS);
    expect(hasArrived(traveling, START_MS)).toBe(false);
    expect(hasArrived(traveling, arrival + 1)).toBe(true);
  });

  it("returns null for an unparseable timestamp, which only arrivalMs can refuse", () => {
    // The one line left that is arrivalMs's alone now that the route math is `tripMs`. Untested, a
    // later fold of one into the other would return NaN with a green suite.
    expect(tripMs(traveling)).toBeGreaterThan(0); // the route measures fine; only the stamp doesn't
    expect(arrivalMs({ ...traveling, locationTimestamp: "not a date" })).toBeNull();
  });

  it("returns null arrival for a stationary scout", () => {
    expect(
      arrivalMs({
        lastKnownLocation: SEATTLE,
        locationTimestamp: "2026-06-29T00:00:00Z",
        speedKmh: 0,
      }),
    ).toBeNull();
  });
});

describe("remainingMiles", () => {
  it("is the full distance at departure and ~0 once arrived", () => {
    const atStart = remainingMiles(traveling, START_MS)!;
    expect(atStart).toBeCloseTo(haversineMiles(SEATTLE, PORTLAND), 5);
    expect(remainingMiles(traveling, START_MS + 10 * 60 * 60 * 1000)!).toBeCloseTo(0, 5);
  });

  it("is null for a scout with no destination", () => {
    expect(
      remainingMiles(
        { lastKnownLocation: SEATTLE, locationTimestamp: "2026-06-29T00:00:00Z", speedKmh: 0 },
        START_MS,
      ),
    ).toBeNull();
  });
});
