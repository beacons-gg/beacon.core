import { describe, expect, it } from "vitest";
import {
  MAX_MULTIPOLYGON_POLYGONS,
  MAX_RING_POSITIONS,
  placeCategorySchema,
  placeDetailSchema,
  placeGeometrySchema,
  placesQueryResultSchema,
  placeSummarySchema,
} from "../index";

const ring = [
  [-122.34, 47.6],
  [-122.32, 47.6],
  [-122.32, 47.62],
  [-122.34, 47.62],
  [-122.34, 47.6],
];

describe("placeCategorySchema — the game-facing taxonomy (beacon.server places §1)", () => {
  it("accepts every taxonomy bucket", () => {
    for (const c of placeCategorySchema.options) {
      expect(placeCategorySchema.safeParse(c).success).toBe(true);
    }
  });

  it("rejects a raw source tag (games never see OSM vocabulary)", () => {
    expect(placeCategorySchema.safeParse("amenity=cafe").success).toBe(false);
  });
});

describe("placeGeometrySchema — GeoJSON geometry value (beacon.server places §4)", () => {
  it("parses a Polygon with a hole", () => {
    const hole = [
      [-122.334, 47.608],
      [-122.326, 47.608],
      [-122.326, 47.612],
      [-122.334, 47.612],
      [-122.334, 47.608],
    ];
    const r = placeGeometrySchema.safeParse({ type: "Polygon", coordinates: [ring, hole] });
    expect(r.success).toBe(true);
  });

  it("parses a MultiPolygon", () => {
    const r = placeGeometrySchema.safeParse({
      type: "MultiPolygon",
      coordinates: [[ring], [ring]],
    });
    expect(r.success).toBe(true);
  });

  it("rejects an open ring (first must equal last)", () => {
    const open = ring.slice(0, -1);
    expect(placeGeometrySchema.safeParse({ type: "Polygon", coordinates: [open] }).success).toBe(
      false,
    );
  });

  it("rejects a ring with fewer than 4 positions", () => {
    const tiny = [ring[0], ring[1], ring[0]];
    expect(placeGeometrySchema.safeParse({ type: "Polygon", coordinates: [tiny] }).success).toBe(
      false,
    );
  });

  it("rejects out-of-range coordinates and 3-element positions", () => {
    const badLng = [
      [181, 0],
      [182, 0],
      [182, 1],
      [181, 1],
      [181, 0],
    ];
    expect(placeGeometrySchema.safeParse({ type: "Polygon", coordinates: [badLng] }).success).toBe(
      false,
    );
    const withAltitude = ring.map(([lng, lat]) => [lng, lat, 12]);
    expect(
      placeGeometrySchema.safeParse({ type: "Polygon", coordinates: [withAltitude] }).success,
    ).toBe(false);
  });

  it("rejects other GeoJSON geometry types (points ride the wire's {lat,lng})", () => {
    expect(
      placeGeometrySchema.safeParse({ type: "Point", coordinates: [-122.33, 47.61] }).success,
    ).toBe(false);
  });

  it("caps ring positions and MultiPolygon polygon counts (untrusted-input cost guards)", () => {
    // MAX+1 positions, closed (i % MAX makes the last position equal the first).
    const huge = Array.from({ length: MAX_RING_POSITIONS + 1 }, (_, i) => [
      0,
      (i % MAX_RING_POSITIONS) / MAX_RING_POSITIONS,
    ]);
    expect(placeGeometrySchema.safeParse({ type: "Polygon", coordinates: [huge] }).success).toBe(
      false,
    );
    const manyPolygons = Array.from({ length: MAX_MULTIPOLYGON_POLYGONS + 1 }, () => [ring]);
    expect(
      placeGeometrySchema.safeParse({ type: "MultiPolygon", coordinates: manyPolygons }).success,
    ).toBe(false);
  });
});

describe("the read wire — summary/detail/query result (beacon.server places §5)", () => {
  const summary = {
    unique: "01J2X6M0R9V8Q4T5N7B3C1D2E4",
    category: "park",
    name: "Cal Anderson",
    point: { lat: 47.61, lng: -122.32 },
    hasGeometry: true,
    hasDescription: true,
    updatedAt: "2026-07-23T00:00:00Z",
  };

  it("parses a summary (light: no geometry field at all)", () => {
    expect(placeSummarySchema.safeParse(summary).success).toBe(true);
    expect(placeSummarySchema.safeParse({ ...summary, geometry: null }).success).toBe(false);
  });

  it("parses a detail with geometry + provenance, strict on extras", () => {
    const detail = {
      ...summary,
      geometry: { type: "Polygon", coordinates: [ring] },
      sources: [{ source: "osm", attribution: "© OpenStreetMap contributors (ODbL)" }],
    };
    expect(placeDetailSchema.safeParse(detail).success).toBe(true);
    expect(placeDetailSchema.safeParse({ ...detail, extra: 1 }).success).toBe(false);
  });

  it("parses a query result and requires the explicit truncated flag", () => {
    const result = { places: [summary], attribution: ["© OSM"], truncated: false };
    expect(placesQueryResultSchema.safeParse(result).success).toBe(true);
    const { truncated: _dropped, ...noFlag } = result;
    expect(placesQueryResultSchema.safeParse(noFlag).success).toBe(false);
  });
});
