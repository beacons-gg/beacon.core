import { describe, expect, it } from "vitest";
import {
  bboxContainsPoint,
  cellsWithinRadius,
  coarsestFitCover,
  DEFAULT_PRECISION,
  destination,
  estimateCellCount,
  isGeohash,
  cellBounds,
  cellsForView,
  coarsen,
  coverageContains,
  coverageIntersects,
  coverageSpecificity,
  coveringCells,
  decode,
  decodeCell,
  encode,
  LIVE_CELL_PRECISION,
  liveCell,
  liveCellsForView,
  neighbors,
  withNeighbors,
  WORLD_CELLS,
  type BBox,
} from "../index";

const seattle = { lat: 47.61, lng: -122.34 };
const view: BBox = { minLat: 47.6, minLng: -122.35, maxLat: 47.62, maxLng: -122.33 };

describe("geohash encode/decode", () => {
  it("encodes to the requested precision", () => {
    expect(encode(seattle, 7)).toHaveLength(7);
    expect(encode(seattle, 5)).toHaveLength(5);
  });

  it("the cell bounds contain the encoded point", () => {
    const b = cellBounds(encode(seattle, 7));
    expect(seattle.lat).toBeGreaterThanOrEqual(b.minLat);
    expect(seattle.lat).toBeLessThanOrEqual(b.maxLat);
    expect(seattle.lng).toBeGreaterThanOrEqual(b.minLng);
    expect(seattle.lng).toBeLessThanOrEqual(b.maxLng);
  });

  it("re-encoding the decoded center reproduces the hash", () => {
    const h = encode(seattle, 7);
    expect(encode(decode(h), 7)).toBe(h);
  });

  it("coarsens a geohash to its containing parent cell (prefix), no-op when already shorter", () => {
    const h = encode(seattle, 7);
    expect(coarsen(h, 5)).toBe(h.slice(0, 5));
    expect(encode(seattle, 5).startsWith(coarsen(h, 5))).toBe(true); // same cell family
    expect(coarsen("abc", 6)).toBe("abc"); // already coarser than precision → unchanged
  });
});

describe("neighbors", () => {
  it("returns 8 distinct neighbors", () => {
    const ns = neighbors(encode(seattle, 5));
    expect(ns).toHaveLength(8);
    expect(new Set(ns).size).toBe(8);
  });
});

describe("covering / query cells", () => {
  it("covering cells are non-empty and the point's cell is included", () => {
    const cells = coveringCells(view, 6);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells).toContain(encode(seattle, 6));
  });

  it("withNeighbors pads the covering set with edge neighbors (a superset)", () => {
    const cells = coveringCells(view, 6);
    const padded = withNeighbors(cells);
    expect(padded.length).toBeGreaterThanOrEqual(cells.length);
    for (const c of cells) expect(padded).toContain(c);
  });
});

describe("coverageIntersects", () => {
  it("a coverage prefix intersects cells within it", () => {
    expect(coverageIntersects(["9q5"], ["9q5cs", "9q5ct"])).toBe(true);
  });

  it("intersects when coverage is finer than the query cell (either-direction prefix)", () => {
    expect(coverageIntersects(["9q5cs"], ["9q5"])).toBe(true);
  });

  it("does not intersect disjoint areas", () => {
    expect(coverageIntersects(["9q5"], ["dr5rs"])).toBe(false);
    expect(coverageIntersects([], ["9q5"])).toBe(false);
  });
});

describe("coverageContains", () => {
  it("contains an object whose geohash starts with a coverage prefix", () => {
    expect(coverageContains(["c23"], encode(seattle, 7))).toBe(true);
    expect(coverageContains(["c23"], "9q5cs1")).toBe(false);
  });
});

describe("coverageSpecificity", () => {
  it("is the length of the longest coverage prefix containing the point", () => {
    expect(coverageSpecificity(["9q", "9q5", "9q5c"], "9q5cs1t")).toBe(4);
  });

  it("ignores coverage prefixes that don't contain the point", () => {
    expect(coverageSpecificity(["9q5cx", "9q5"], "9q5cs1t")).toBe(3); // 9q5cx is not a prefix of the point
    expect(coverageSpecificity(["dr5rs"], "9q5cs1t")).toBe(0);
  });

  it('is 0 for whole-world coverage (empty set or a "" entry)', () => {
    expect(coverageSpecificity([], "9q5cs1t")).toBe(0);
    expect(coverageSpecificity([""], "9q5cs1t")).toBe(0);
  });
});

describe("coveringCells edge cases", () => {
  it("covers an antimeridian-crossing view (Fiji) instead of returning nothing", () => {
    const fiji: BBox = { minLat: -18, minLng: 178, maxLat: -17, maxLng: -178 };
    const cells = coveringCells(fiji, 5);
    expect(cells.length).toBeGreaterThan(0);
    // an object just east of +180 and one just west of -180 both fall in the covered set
    expect(coverageContains(cells, encode({ lat: -17.5, lng: 179.5 }, 5))).toBe(true);
    expect(coverageContains(cells, encode({ lat: -17.5, lng: -179.5 }, 5))).toBe(true);
  });

  it("normalizes an inverted-latitude bbox", () => {
    const inverted: BBox = { minLat: 47.62, minLng: -122.35, maxLat: 47.6, maxLng: -122.33 };
    expect(coveringCells(inverted, 6).length).toBeGreaterThan(0);
  });

  it("returns de-duplicated cells", () => {
    const cells = coveringCells(view, 6);
    expect(new Set(cells).size).toBe(cells.length);
  });
});

describe("cellsForView (zoom-aware, bounded)", () => {
  const wholeWorld: BBox = { minLat: -85, minLng: -179, maxLat: 85, maxLng: 179 };

  it("returns a bounded cell set covering the view's point", () => {
    const { cells, precision } = cellsForView(view, 16);
    expect(cells.length).toBeLessThanOrEqual(64);
    expect(precision).toBeGreaterThanOrEqual(1);
    expect(precision).toBeLessThanOrEqual(7);
    expect(cells).toContain(encode(seattle, precision)); // the point's cell at the chosen precision
  });

  it("coarsens a zoomed-out world view to stay under the cell cap", () => {
    const { cells, precision } = cellsForView(wholeWorld, 1);
    expect(cells.length).toBeLessThanOrEqual(64);
    expect(precision).toBeLessThanOrEqual(2);
  });

  it("coarsens further when maxCells is tighter than the zoom precision would give", () => {
    const fine = cellsForView(view, 16, { maxCells: 10000 }); // effectively uncapped -> zoom precision
    const capped = cellsForView(view, 16, { maxCells: 16 });
    expect(fine.precision).toBe(7);
    expect(capped.precision).toBeLessThan(fine.precision);
    expect(capped.cells.length).toBeLessThanOrEqual(fine.cells.length);
  });

  it("stays bounded and fast for a huge bbox at high zoom (no fine-precision blow-up)", () => {
    const start = performance.now();
    const { cells, precision } = cellsForView(wholeWorld, 18); // pathological: world + max zoom
    expect(performance.now() - start).toBeLessThan(1000);
    expect(cells.length).toBeLessThanOrEqual(64);
    expect(precision).toBeLessThanOrEqual(2);
  });

  it("handles a pole-adjacent view without exploding the cell count", () => {
    const pole: BBox = { minLat: 88, minLng: -179, maxLat: 90, maxLng: 179 };
    const { cells } = cellsForView(pole, 10);
    expect(cells.length).toBeLessThanOrEqual(64);
  });

  it("tolerates non-finite zoom", () => {
    expect(() => cellsForView(view, NaN)).not.toThrow();
    expect(cellsForView(view, NaN).precision).toBeGreaterThanOrEqual(1);
  });
});

describe("live cells (map update channel)", () => {
  const wholeWorld: BBox = { minLat: -85, minLng: -179, maxLat: 85, maxLng: 179 };

  it("liveCell encodes at the fixed live precision, and an object's index hash has it as a prefix", () => {
    const cell = liveCell(seattle);
    expect(cell).toHaveLength(LIVE_CELL_PRECISION);
    expect(encode(seattle, 7).startsWith(cell)).toBe(true); // index hash prefixed by its live cell
  });

  it("covers a normal view with a bounded cell set that includes the point's cell", () => {
    const { cells, capped } = liveCellsForView(view);
    expect(capped).toBe(false);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells).toContain(liveCell(seattle));
  });

  it("caps (signals poll-fallback) for a zoomed-out view without enumerating millions of cells", () => {
    const start = performance.now();
    const { cells, capped } = liveCellsForView(wholeWorld);
    expect(performance.now() - start).toBeLessThan(100); // bailed on the estimate, never enumerated
    expect(capped).toBe(true);
    expect(cells).toEqual([]);
  });
});

describe("cellsForView's precision for a zoom", () => {
  it("is coarser when zoomed out, finer at street level", () => {
    const spot: BBox = { minLat: 47.6062, minLng: -122.3321, maxLat: 47.6062, maxLng: -122.3321 };
    const at = (zoom: number) => cellsForView(spot, zoom, { maxCells: 10_000 }).precision;
    expect(at(19)).toBe(8);
    expect(at(12)).toBe(5);
    expect(at(2)).toBe(2);
    expect(at(Number.NaN)).toBe(2);
  });
});

describe("estimateCellCount — the enumerate-guard estimate", () => {
  it("stays tiny for a city view and explodes for a world bbox", () => {
    const city: BBox = { minLat: 47.6, minLng: -122.35, maxLat: 47.62, maxLng: -122.33 };
    const world: BBox = { minLat: -85, minLng: -180, maxLat: 85, maxLng: 180 };
    expect(estimateCellCount(city, 5)).toBeLessThan(64);
    expect(estimateCellCount(world, 5)).toBeGreaterThan(100_000);
  });

  it("handles an antimeridian-crossing bbox (minLng > maxLng) as a 1° span, not 359°", () => {
    const fiji: BBox = { minLat: -17, minLng: 179.5, maxLat: -16, maxLng: -179.5 };
    // ~23×23 precision-5 cells for a 1°×1° area — a 359° misread would be in the hundreds of thousands.
    const estimate = estimateCellCount(fiji, 5);
    expect(estimate).toBeGreaterThan(100);
    expect(estimate).toBeLessThan(2000);
  });
});

describe("bboxContainsPoint — the wrap-aware bbox predicate", () => {
  it("handles plain and antimeridian-crossing boxes", () => {
    const seattle: BBox = { minLat: 47.6, minLng: -122.35, maxLat: 47.62, maxLng: -122.33 };
    expect(bboxContainsPoint({ lat: 47.61, lng: -122.34 }, seattle)).toBe(true);
    expect(bboxContainsPoint({ lat: 47.7, lng: -122.34 }, seattle)).toBe(false);
    const fiji: BBox = { minLat: -17, minLng: 179.5, maxLat: -16, maxLng: -179.5 };
    expect(bboxContainsPoint({ lat: -16.5, lng: -179.9 }, fiji)).toBe(true);
    expect(bboxContainsPoint({ lat: -16.5, lng: 178 }, fiji)).toBe(false);
  });
});

describe("cellsWithinRadius — a radius, not a cell's worth of luck", () => {
  const covers = (cells: string[], point: { lat: number; lng: number }): boolean =>
    cells.some((c) => encode(point, c.length) === c);

  it("covers the whole circle it was asked for, on every bearing", () => {
    const cells = cellsWithinRadius(seattle, 402); // the game's 0.25 mi interact radius
    for (let bearing = 0; bearing < 360; bearing += 5) {
      expect(covers(cells, destination(seattle, bearing, 402))).toBe(true);
    }
  });

  // The bug this function exists for. The old sweep queried a point's own cell plus its eight edge
  // neighbours, which is not a radius: at the indexing precision those cells are ~153m tall and, at
  // this latitude, ~103m wide. So an object at the edge of the range the game lets you ACT at was
  // never in the query set, and an empty result looks exactly like an empty neighbourhood.
  it("finds what a cell plus its neighbours provably misses", () => {
    const padded = withNeighbors([encode(seattle)]);
    const edge = destination(seattle, 90, 402); // due east, at the interact radius
    expect(covers(padded, edge)).toBe(false);
    expect(covers(cellsWithinRadius(seattle, 402), edge)).toBe(true);
  });

  it("stays inside its cell budget by coarsening, and coarser still matches finer object hashes", () => {
    const cells = cellsWithinRadius(seattle, 402);
    expect(cells.length).toBeLessThanOrEqual(32);
    // Prefix intersection is what makes coarsening free: a query cell of any precision matches an
    // object indexed at DEFAULT_PRECISION inside it.
    expect(coverageIntersects([encode(seattle)], cells)).toBe(true);
  });

  it("scales to a big radius without blowing the budget", () => {
    for (const meters of [50, 402, 5_000, 50_000]) {
      const cells = cellsWithinRadius(seattle, meters);
      expect(cells.length).toBeLessThanOrEqual(32);
      expect(cells.length).toBeGreaterThan(0);
      expect(covers(cells, destination(seattle, 45, meters))).toBe(true);
    }
  });

  it("throws loudly on a non-finite radius instead of querying a bogus world cell", () => {
    expect(() => cellsWithinRadius(seattle, Number.NaN)).toThrow("non-finite");
  });

  it("covers an object at 99.99% of the radius in the haversine metric itself", () => {
    // The constant-mismatch regression: meters-per-degree must come from the same sphere the
    // later distance cut measures on. The target is placed via that sphere directly, NOT via
    // destination(), which shares the module constant and would make the assertion vacuous.
    const anchor = { lat: 47.6001435, lng: -122.316 };
    const target = { lat: anchor.lat + 402.3 / ((Math.PI * 6_371_000) / 180), lng: anchor.lng };
    expect(covers(cellsWithinRadius(anchor, 402.336), target)).toBe(true);
  });

  it("covers a circle that straddles the antimeridian", () => {
    // 179.999 sits ~110m from the line, so the 402m circle genuinely wraps (179.99 was ~1.06km
    // out: an ordinary non-wrap box, and the assertions passed vacuously).
    const fiji = { lat: -17.7, lng: 179.999 };
    const cells = cellsWithinRadius(fiji, 402);
    expect(cells.length).toBeGreaterThan(0);
    for (const bearing of [90, 270])
      expect(covers(cells, destination(fiji, bearing, 402))).toBe(true);
  });
});

describe("isGeohash (decode answers for anything, so callers with untrusted input need this)", () => {
  it("accepts a real geohash", () => {
    expect(isGeohash("c23nb62w2")).toBe(true);
  });

  it("rejects characters outside the base-32 alphabet", () => {
    // `a`, `i`, `l` and `o` are deliberately absent from the geohash alphabet.
    expect(isGeohash("!!!!!")).toBe(false);
    expect(isGeohash("c23nb62wa")).toBe(false);
    expect(isGeohash("hello")).toBe(false);
  });

  it("rejects uppercase, which no producer here emits", () => {
    expect(isGeohash("C23NB62W2")).toBe(false);
  });

  it("rejects the empty string, which is not a cell", () => {
    expect(isGeohash("")).toBe(false);
  });

  it("carries the wire's length cap, because it IS the wire's cap", () => {
    // Both this and `geohashCellSchema` wrap `GEOHASH_RE`, so there is no second spelling to drift.
    expect(isGeohash("b".repeat(12))).toBe(true);
    expect(isGeohash("b".repeat(13))).toBe(false);
  });

  it("agrees with WORLD_CELLS, the table `encode` emits from", () => {
    // The one relationship the consolidation did NOT collapse, so it gets a test rather than a
    // shared line. Set equality, in BOTH directions, which is what "an agreement" has to mean here:
    // asserting only that every cell is accepted catches the table shrinking and misses the regex
    // GROWING, and that is the direction with a consequence. A character the regex gained but the
    // table lacked would leave `admin.service.ts`'s boundary-less export scanning 32 of 33 cells and
    // silently shipping most of the dataset, with nothing anywhere to say so.
    expect(WORLD_CELLS).toHaveLength(32);
    for (let code = 32; code < 127; code++) {
      const char = String.fromCharCode(code);
      expect(isGeohash(char)).toBe(WORLD_CELLS.includes(char));
    }
  });

  it("guards the sharp edge it exists for", () => {
    // This is the whole reason the function is here: decode does not throw on junk, it returns a
    // real-looking point, so a caller measuring a distance from untrusted input gets a confident
    // answer to a meaningless question unless it asks first.
    const point = decode("!!!!!");
    expect(Number.isFinite(point.lat)).toBe(true);
    expect(isGeohash("!!!!!")).toBe(false);
  });
});

describe("decodeCell (the guarded decode, so a caller cannot forget the pairing)", () => {
  it("decodes a real geohash to the same point decode does", () => {
    expect(decodeCell("c23nb62w2")).toEqual(decode("c23nb62w2"));
  });

  it("refuses junk instead of answering for it", () => {
    // The bug it exists to make unwritable: decode("!!!!!") is a confident point near the pole.
    expect(decodeCell("!!!!!")).toBeNull();
    expect(decodeCell("C23NB62W2")).toBeNull();
    expect(decodeCell("b".repeat(13))).toBeNull();
  });

  it("takes undefined, since every caller's field is optional", () => {
    expect(decodeCell(undefined)).toBeNull();
    expect(decodeCell("")).toBeNull();
  });
});

describe("coarsestFitCover", () => {
  it("fits the budget, finest first", () => {
    const cover = coarsestFitCover(view, { maxCells: 16, precision: 7 });
    expect(cover.length).toBeLessThanOrEqual(16);
    expect(cover.length).toBeGreaterThan(0);
    // One finer precision would not fit.
    const precision = cover[0]!.length;
    expect(coveringCells(view, precision + 1).length).toBeGreaterThan(16);
  });

  it("starts at DEFAULT_PRECISION when no precision is given", () => {
    expect(coarsestFitCover(view, { maxCells: 10_000 })[0]).toHaveLength(DEFAULT_PRECISION);
  });

  it("loosens only the estimate with estimateSlack, never the real count", () => {
    const tight = coarsestFitCover(view, { maxCells: 4, precision: 7, estimateSlack: 8 });
    expect(tight.length).toBeLessThanOrEqual(4);
  });

  it("falls back to precision 1, whatever the budget", () => {
    const world: BBox = { minLat: -85, minLng: -179, maxLat: 85, maxLng: 179 };
    expect(coarsestFitCover(world, { maxCells: 1 }).every((cell) => cell.length === 1)).toBe(true);
  });
});

describe("liveCellsForView's options", () => {
  it("reads maxCells from its options", () => {
    expect(liveCellsForView(view, { maxCells: 1 })).toEqual({ cells: [], capped: true });
    expect(liveCellsForView(view, {})).toEqual(liveCellsForView(view));
  });
});
