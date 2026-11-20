import { describe, expect, it } from "vitest";
import { avoidOverlap, bboxAround, destination, distanceMeters, METERS_PER_MILE } from "../spatial";

const SEATTLE = { lat: 47.61, lng: -122.34 };

describe("distanceMeters", () => {
  it("is ~0 for a point to itself", () => {
    expect(distanceMeters(SEATTLE, SEATTLE)).toBeCloseTo(0, 6);
  });

  it("measures a known short hop (100m north) to within a meter", () => {
    const north = destination(SEATTLE, 0, 100);
    expect(distanceMeters(SEATTLE, north)).toBeCloseTo(100, 0);
  });

  it("is symmetric", () => {
    const other = { lat: 47.62, lng: -122.33 };
    expect(distanceMeters(SEATTLE, other)).toBeCloseTo(distanceMeters(other, SEATTLE), 6);
  });
});

describe("destination", () => {
  it("north increases latitude, east increases longitude", () => {
    expect(destination(SEATTLE, 0, 50).lat).toBeGreaterThan(SEATTLE.lat);
    expect(destination(SEATTLE, 90, 50).lng).toBeGreaterThan(SEATTLE.lng);
  });

  it("round-trips: the moved point is `meters` away along any bearing", () => {
    for (const bearing of [0, 45, 90, 200, 315]) {
      expect(distanceMeters(SEATTLE, destination(SEATTLE, bearing, 30))).toBeCloseTo(30, 0);
    }
  });
});

describe("avoidOverlap", () => {
  it("returns the target unchanged when nothing is nearby", () => {
    expect(avoidOverlap(SEATTLE, [], 25)).toEqual(SEATTLE);
    const far = { lat: 47.7, lng: -122.2 };
    expect(avoidOverlap(SEATTLE, [far], 25)).toEqual(SEATTLE);
  });

  it("shifts to a clear spot when an obstacle sits on the target", () => {
    const shifted = avoidOverlap(SEATTLE, [SEATTLE], 25);
    expect(shifted).not.toEqual(SEATTLE);
    // The chosen spot clears the min separation from the obstacle...
    expect(distanceMeters(shifted, SEATTLE)).toBeGreaterThanOrEqual(25);
    // ...and stays reasonably close (within the outermost ring).
    expect(distanceMeters(shifted, SEATTLE)).toBeLessThanOrEqual(25 * 4 + 1);
  });

  it("clears ALL obstacles, not just the first", () => {
    const near = [SEATTLE, destination(SEATTLE, 90, 10), destination(SEATTLE, 180, 10)];
    const shifted = avoidOverlap(SEATTLE, near, 20);
    for (const o of near) expect(distanceMeters(shifted, o)).toBeGreaterThanOrEqual(20);
  });

  it("falls back to the target in a hopelessly crowded area rather than failing", () => {
    // Ring candidates at every bearing/radius are themselves blocked → no clear spot → returns target.
    const wall = [];
    for (let r = 1; r <= 5; r += 1)
      for (let b = 0; b < 360; b += 15) wall.push(destination(SEATTLE, b, 20 * r));
    wall.push(SEATTLE);
    expect(avoidOverlap(SEATTLE, wall, 25, { rings: 4, bearings: 8 })).toEqual(SEATTLE);
  });
});

describe("bboxAround — a radius as a box the cell helpers can cover", () => {
  it("contains every point on the circle, on every bearing", () => {
    const box = bboxAround(SEATTLE, 400);
    for (let bearing = 0; bearing < 360; bearing += 5) {
      const edge = destination(SEATTLE, bearing, 400);
      expect(edge.lat).toBeGreaterThanOrEqual(box.minLat);
      expect(edge.lat).toBeLessThanOrEqual(box.maxLat);
      expect(edge.lng).toBeGreaterThanOrEqual(box.minLng);
      expect(edge.lng).toBeLessThanOrEqual(box.maxLng);
    }
  });

  it("widens with latitude, because a metre buys more longitude nearer the pole", () => {
    const width = (lat: number): number => {
      const b = bboxAround({ lat, lng: 0 }, 400);
      return b.maxLng - b.minLng;
    };
    expect(width(0)).toBeLessThan(width(47.61));
    expect(width(47.61)).toBeLessThan(width(70));
    // Latitude is the constant half: same metres, same degrees, anywhere.
    const equator = bboxAround({ lat: 0, lng: 0 }, 400);
    const north = bboxAround({ lat: 70, lng: 0 }, 400);
    expect(north.maxLat - north.minLat).toBeCloseTo(equator.maxLat - equator.minLat, 6);
  });

  it("takes the longitude width at the latitude nearest the pole, so tall boxes cover their corners", () => {
    // Measuring at the centre latitude alone would leave the far corners outside the box.
    const far = { lat: 60, lng: 0 };
    const box = bboxAround(far, 20_000);
    const corner = destination({ lat: box.maxLat, lng: 0 }, 90, 20_000);
    // With meters-per-degree shared between builder and prober, the far corner lands exactly ON
    // the boundary; allow float rounding, not a real sliver (which would be degrees, not 1e-12).
    expect(corner.lng).toBeLessThanOrEqual(box.maxLng + 1e-12);
  });

  it("crosses the antimeridian in the wrap form (minLng > maxLng), not as out-of-range degrees", () => {
    const box = bboxAround({ lat: 0, lng: 179.999 }, 400);
    expect(box.minLng).toBeGreaterThan(box.maxLng);
    expect(box.maxLng).toBeGreaterThanOrEqual(-180);
    expect(box.minLng).toBeLessThanOrEqual(180);
  });

  it("collapses to the whole longitude band near the poles rather than emitting nonsense", () => {
    const box = bboxAround({ lat: 89.9999, lng: 10 }, 100_000);
    expect(box.minLng).toBe(-180);
    expect(box.maxLng).toBe(180);
    expect(box.maxLat).toBeLessThanOrEqual(90);
  });

  it("never emits NaN, including a zero-metre box exactly at a pole", () => {
    for (const box of [bboxAround({ lat: 90, lng: 0 }, 0), bboxAround({ lat: -90, lng: 180 }, 0)]) {
      for (const v of [box.minLat, box.maxLat, box.minLng, box.maxLng])
        expect(Number.isNaN(v)).toBe(false);
    }
  });

  it("clamps latitude at the poles", () => {
    const box = bboxAround({ lat: 89.99, lng: 0 }, 100_000);
    expect(box.maxLat).toBe(90);
  });
});

describe("METERS_PER_MILE", () => {
  it("is the statute mile, so a game range in miles converts in one place", () => {
    expect(METERS_PER_MILE).toBeCloseTo(1609.344, 3);
    // The interact radius the game actually uses.
    expect(0.25 * METERS_PER_MILE).toBeCloseTo(402.336, 3);
  });
});
