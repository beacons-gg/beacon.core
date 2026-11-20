import { describe, expect, it } from "vitest";
import {
  placeAtlasImportParamsSchema,
  placeAtlasInspectParamsSchema,
  placeAtlasPreviewReadSchema,
  placeAtlasPreviewSchema,
  placeAtlasSurveyParamsSchema,
  placeAtlasSurveyReadSchema,
  placeSnapshotParamsSchema,
  placeSnapshotStatsSchema,
} from "../index";

const PUBLISHER = "did:key:z6MkjM2XWuaAFdy8gRGo12PEp1F9AUD97NrxJTx6JiHsYcZc";
const URL = "https://atlas.example.org/us-west/";

describe("places.atlas.import options", () => {
  it("accepts every option, and none", () => {
    const options = {
      skipTypes: [{ category: "park", subcategory: "trail" }, { category: "landmark" }],
      requirePhotos: true,
      requireName: true,
      requireDescription: false,
      importPhotos: false,
      retireMissing: false,
      retireFiltered: true,
      retireUnselectedTypes: true,
    };
    expect(
      placeAtlasImportParamsSchema.safeParse({ url: URL, publisher: PUBLISHER, options }).success,
    ).toBe(true);
    expect(placeAtlasImportParamsSchema.safeParse({ url: URL, publisher: PUBLISHER }).success).toBe(
      true,
    );
  });

  it("refuses an unknown option and a type the taxonomy does not have", () => {
    const parse = (options: object) =>
      placeAtlasImportParamsSchema.safeParse({ url: URL, publisher: PUBLISHER, options }).success;
    expect(parse({ requirePhotoz: true })).toBe(false);
    expect(parse({ skipTypes: [{ category: "park", subcategory: "NOT A SLUG" }] })).toBe(false);
    expect(parse({ skipTypes: [{ category: "not-a-category" }] })).toBe(false);
    expect(parse({ skipTypes: [] })).toBe(false);
  });

  it("is recorded on the run, with the filtered count", () => {
    expect(
      placeSnapshotParamsSchema.safeParse({
        source: "atlas:us-west",
        boundary: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
        options: { requireName: true },
      }).success,
    ).toBe(true);
    const stats = {
      chunksDone: 1,
      chunksTotal: 1,
      fetched: 3,
      created: 1,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      retired: 0,
      conflicts: 0,
      imagesIngested: 0,
    };
    expect(placeSnapshotStatsSchema.safeParse(stats).success).toBe(true);
    expect(placeSnapshotStatsSchema.safeParse({ ...stats, filtered: 2 }).success).toBe(true);
    expect(placeSnapshotStatsSchema.safeParse({ ...stats, imagesStorageFull: 40 }).success).toBe(
      true,
    );
  });
});

describe("places.atlas.survey", () => {
  it("names exactly one target", () => {
    expect(placeAtlasSurveyParamsSchema.safeParse({ url: URL, cells: ["9q5"] }).success).toBe(true);
    expect(placeAtlasSurveyParamsSchema.safeParse({ cells: ["9q5"] }).success).toBe(false);
    expect(placeAtlasSurveyParamsSchema.safeParse({ url: URL, path: "us-west" }).success).toBe(
      false,
    );
  });

  it("reads a running survey and a finished one", () => {
    expect(
      placeAtlasSurveyReadSchema.safeParse({ status: "running", tilesDone: 3, tilesTotal: 32 })
        .success,
    ).toBe(true);
    const done = placeAtlasSurveyReadSchema.parse({
      status: "done",
      tilesDone: 32,
      tilesTotal: 32,
      result: {
        cells: 32,
        places: 3,
        tileBytes: 1200,
        photoFiles: 2,
        mediaBytesEstimate: 120_000,
        buckets: [
          {
            category: "park",
            supported: true,
            variants: [
              { hasPhotos: true, hasName: true, hasDescription: false, places: 1, photoFiles: 2 },
            ],
          },
        ],
        sources: [{ id: "osm", places: 3 }],
      },
    });
    expect(done.result?.buckets[0]?.variants[0]?.photoFiles).toBe(2);
  });
});

describe("the Atlas preview", () => {
  const base = {
    volume: "us-west",
    version: "2026-08",
    places: 225084,
    cells: 50989,
    publisher: PUBLISHER,
    media: 53188,
    mediaBytes: 3435732584,
    pin: "new",
  };

  it("still accepts an older server's preview, without the details", () => {
    expect(placeAtlasPreviewSchema.safeParse(base).success).toBe(true);
  });

  it("carries the details the operator chooses from", () => {
    const preview = {
      ...base,
      versionUrl: "https://atlas.example.org/us-west/2026-08",
      revision: 1,
      createdAt: "2026-08-11T05:31:29.069Z",
      bounds: { minLat: 31.27, minLng: -131.69, maxLat: 55.35, maxLng: -102.04 },
      coverage: ["9q", "c2"],
      cellPrecision: 5,
      tileBytes: 64996416,
      geometryCells: 16296,
      retired: 0,
      categories: ["park", "landmark"],
      subcategories: ["trail"],
      sources: [
        {
          id: "osm",
          name: "OpenStreetMap",
          attribution: "© OpenStreetMap contributors (ODbL)",
          license: "ODbL 1.0",
          licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
        },
      ],
      inputs: [{ source: "osm", artifact: "us-west-260724.osm.pbf" }],
    };
    expect(placeAtlasPreviewSchema.safeParse(preview).success).toBe(true);
    // A newer server's extra field is dropped on read, not refused.
    expect(placeAtlasPreviewReadSchema.parse({ ...preview, later: 1 })).not.toHaveProperty("later");
  });

  it("names its version by an http or https URL only", () => {
    const preview = { ...base, versionUrl: "javascript:alert(1)" };
    expect(placeAtlasPreviewSchema.safeParse(preview).success).toBe(false);
    // A server's resolved URL, such as a presigned one, has no length cap.
    const long = `https://atlas.example.org/us-west/2026-08/?sig=${"a".repeat(3000)}`;
    expect(placeAtlasPreviewSchema.safeParse({ ...base, versionUrl: long }).success).toBe(true);
  });
});

describe("an Atlas volume URL", () => {
  it("is http or https: a javascript: or data: URL names no volume", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/plain,volume",
      "ftp://atlas.example.org/v/",
    ]) {
      expect(placeAtlasInspectParamsSchema.safeParse({ url }).success).toBe(false);
    }
    expect(placeAtlasInspectParamsSchema.safeParse({ url: URL }).success).toBe(true);
    expect(
      placeAtlasInspectParamsSchema.safeParse({ url: "http://127.0.0.1:8080/v/" }).success,
    ).toBe(true);
  });
});
