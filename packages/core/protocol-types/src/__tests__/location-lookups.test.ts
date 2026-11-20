import { describe, expect, it } from "vitest";
import { geocodeResultSchema } from "../index";

describe("geocodeResultSchema — reverse-geocode place label (beacon.server location-lookups §4)", () => {
  const base = {
    geohash: "9q8yy",
    source: "nominatim",
    attribution: "© OSM",
    cachedAt: "2026-07-22T00:00:00Z",
  };

  it("parses a full label", () => {
    const r = geocodeResultSchema.safeParse({
      ...base,
      city: "San Francisco",
      state: "California",
      country: "United States",
      countryCode: "US",
      displayName: "San Francisco, California, US",
    });
    expect(r.success).toBe(true);
  });

  it("parses a minimal result (all label fields optional — sparse-coverage cell)", () => {
    expect(geocodeResultSchema.safeParse(base).success).toBe(true);
  });

  it("requires source/attribution/cachedAt (server-produced provenance)", () => {
    expect(geocodeResultSchema.safeParse({ geohash: "9q8yy" }).success).toBe(false);
  });

  it("rejects unknown keys (strict wire)", () => {
    expect(geocodeResultSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("accepts a neighborhood, and still parses without one", () => {
    // Absent is the normal case for a coarse cell, not an error — the server declines to name a
    // neighbourhood it can't vouch for, so every caller has to cope with the field missing.
    expect(
      geocodeResultSchema.safeParse({ ...base, neighborhood: "Capitol Hill", city: "Seattle" })
        .success,
    ).toBe(true);
    expect(geocodeResultSchema.safeParse({ ...base, city: "Seattle" }).success).toBe(true);
  });
});
