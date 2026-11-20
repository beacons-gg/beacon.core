import type { GeoPosition, LatLng, PlaceGeometry } from "@beaconsgg/protocol-types";

/** One test case of {@link CONTAINMENT_VECTORS}: a place's area, a point and the expected answer. */
export interface ContainmentVector {
  /** What the case tests, such as `park center inside`. */
  name: string;
  /** The place's area. */
  geometry: PlaceGeometry;
  /** The point to test. */
  point: LatLng;
  /** What `containsPoint(point, geometry)` must return. */
  expected: boolean;
}

// A simple rectangular "park" ring around Seattle's Cal Anderson block. GeoJSON order: [lng, lat].
const parkRing: GeoPosition[] = [
  [-122.34, 47.6],
  [-122.32, 47.6],
  [-122.32, 47.62],
  [-122.34, 47.62],
  [-122.34, 47.6],
];
// A "pond" ring in the park's middle (a hole).
const pondRing: GeoPosition[] = [
  [-122.334, 47.608],
  [-122.326, 47.608],
  [-122.326, 47.612],
  [-122.334, 47.612],
  [-122.334, 47.608],
];

const park: PlaceGeometry = { type: "Polygon", coordinates: [parkRing] };
const parkWithPond: PlaceGeometry = { type: "Polygon", coordinates: [parkRing, pondRing] };

// A concave C-shape (opens east): the notch is outside despite being inside the outer bbox.
const cShape: PlaceGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 2],
      [3, 2],
      [3, 3],
      [0, 3],
      [0, 0],
    ],
  ],
};

// Two disjoint squares as one MultiPolygon (a split campus).
const campus: PlaceGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [10, 10],
        [11, 10],
        [11, 11],
        [10, 11],
        [10, 10],
      ],
    ],
    [
      [
        [13, 10],
        [14, 10],
        [14, 11],
        [13, 11],
        [13, 10],
      ],
    ],
  ],
};

// An antimeridian-crossing square (Fiji): longitudes wrap 179.5 -> -179.5.
const fiji: PlaceGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [179.5, -17],
      [-179.5, -17],
      [-179.5, -16],
      [179.5, -16],
      [179.5, -17],
    ],
  ],
};

// The same park with its exterior wound clockwise — even-odd containment must be winding-agnostic
// (GeoJSON prescribes CCW exteriors, but real-world data won't always comply).
const clockwisePark: PlaceGeometry = {
  type: "Polygon",
  coordinates: [[...parkRing].reverse()],
};

/**
 * The test cases every implementation of `containsPoint` must pass, so a client and a server agree
 * on whether a point is inside a place.
 *
 * Run them against your own implementation if you write one in another language (beacon.server
 * `doc/spec/places.md` §9).
 */
export const CONTAINMENT_VECTORS: readonly ContainmentVector[] = [
  // ── plain polygon ──
  {
    name: "park center inside",
    geometry: park,
    point: { lat: 47.61, lng: -122.33 },
    expected: true,
  },
  {
    name: "east of park outside",
    geometry: park,
    point: { lat: 47.61, lng: -122.31 },
    expected: false,
  },
  {
    name: "north of park outside",
    geometry: park,
    point: { lat: 47.63, lng: -122.33 },
    expected: false,
  },
  { name: "far away outside", geometry: park, point: { lat: -33.86, lng: 151.2 }, expected: false },

  // ── holes ──
  {
    name: "in the pond hole -> outside",
    geometry: parkWithPond,
    point: { lat: 47.61, lng: -122.33 },
    expected: false,
  },
  {
    name: "in the park, not the pond",
    geometry: parkWithPond,
    point: { lat: 47.602, lng: -122.33 },
    expected: true,
  },

  // ── concavity ──
  {
    name: "in the C notch -> outside",
    geometry: cShape,
    point: { lat: 1.5, lng: 2 },
    expected: false,
  },
  { name: "in the C arm -> inside", geometry: cShape, point: { lat: 0.5, lng: 2 }, expected: true },
  {
    name: "in the C spine -> inside",
    geometry: cShape,
    point: { lat: 1.5, lng: 0.5 },
    expected: true,
  },

  // ── MultiPolygon ──
  {
    name: "first campus square",
    geometry: campus,
    point: { lat: 10.5, lng: 10.5 },
    expected: true,
  },
  {
    name: "second campus square",
    geometry: campus,
    point: { lat: 10.5, lng: 13.5 },
    expected: true,
  },
  {
    name: "between campus squares -> outside",
    geometry: campus,
    point: { lat: 10.5, lng: 12 },
    expected: false,
  },

  // ── antimeridian ──
  {
    name: "fiji east of ±180 inside",
    geometry: fiji,
    point: { lat: -16.5, lng: 179.9 },
    expected: true,
  },
  {
    name: "fiji west of ±180 inside",
    geometry: fiji,
    point: { lat: -16.5, lng: -179.9 },
    expected: true,
  },
  {
    name: "west of fiji outside",
    geometry: fiji,
    point: { lat: -16.5, lng: 178.9 },
    expected: false,
  },
  {
    name: "east of fiji outside",
    geometry: fiji,
    point: { lat: -16.5, lng: -178.9 },
    expected: false,
  },

  // ── winding order ──
  {
    name: "clockwise exterior still contains",
    geometry: clockwisePark,
    point: { lat: 47.61, lng: -122.33 },
    expected: true,
  },
];
