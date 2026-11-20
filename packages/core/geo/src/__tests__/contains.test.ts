import { describe, expect, it } from "vitest";
import type { PlaceGeometry } from "@beaconsgg/protocol-types";
import {
  CONTAINMENT_VECTORS,
  containsPoint,
  coveringCells,
  geometryBBox,
  type BBox,
} from "../index";

describe("containsPoint conformance vectors", () => {
  for (const vector of CONTAINMENT_VECTORS) {
    it(vector.name, () => {
      expect(containsPoint(vector.point, vector.geometry)).toBe(vector.expected);
    });
  }
});

type Ring = [number, number][];
/** A closed rectangular ring in GeoJSON [lng, lat] order. */
const ring = (west: number, south: number, east: number, north: number): Ring => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

describe("geometryBBox", () => {
  it("bounds a simple polygon", () => {
    const geometry: PlaceGeometry = {
      type: "Polygon",
      coordinates: [ring(-122.34, 47.6, -122.32, 47.62)],
    };
    expect(geometryBBox(geometry)).toEqual({
      minLat: 47.6,
      minLng: -122.34,
      maxLat: 47.62,
      maxLng: -122.32,
    } satisfies BBox);
  });

  it("unions a MultiPolygon over its exterior rings", () => {
    const geometry: PlaceGeometry = {
      type: "MultiPolygon",
      coordinates: [[ring(10, 10, 11, 11)], [ring(13, 10, 14, 12)]],
    };
    expect(geometryBBox(geometry)).toEqual({ minLat: 10, minLng: 10, maxLat: 12, maxLng: 14 });
  });

  it("returns the wrapped minLng > maxLng form across the antimeridian", () => {
    const fiji: PlaceGeometry = { type: "Polygon", coordinates: [ring(179.5, -17, -179.5, -16)] };
    const bbox = geometryBBox(fiji);
    expect(bbox).toEqual({ minLat: -17, minLng: 179.5, maxLat: -16, maxLng: -179.5 });
    expect(bbox.minLng).toBeGreaterThan(bbox.maxLng);
  });

  it("feeds coveringCells across the antimeridian without losing cells", () => {
    const fiji: PlaceGeometry = { type: "Polygon", coordinates: [ring(179.5, -17, -179.5, -16)] };
    const cells = coveringCells(geometryBBox(fiji), 3);
    expect(cells.length).toBeGreaterThan(0);
    // Cells from both sides of the line: east-hemisphere geohashes near Fiji start with 'r',
    // west-hemisphere ones with '2'.
    expect(cells.some((c) => c.startsWith("r"))).toBe(true);
    expect(cells.some((c) => c.startsWith("2"))).toBe(true);
  });

  it("ignores holes (they lie within the exterior)", () => {
    const geometry: PlaceGeometry = {
      type: "Polygon",
      coordinates: [ring(0, 0, 4, 4), ring(1, 1, 2, 2)],
    };
    expect(geometryBBox(geometry)).toEqual({ minLat: 0, minLng: 0, maxLat: 4, maxLng: 4 });
  });
});
