/**
 * A value this build has never heard of, on a closed set, read off a newer server. A read
 * variant already ignores a new KEY; a new VALUE failed the whole read, and what it should do
 * instead is the field's call, declared on the strict schema. These pin each declaration, and that the
 * strict shapes, which are what a server accepts, still refuse the value.
 */
import { describe, expect, it } from "vitest";
import {
  adminStatusReadSchema,
  adminSettingReadSchema,
  mediaPairs,
  mediaReadSchema,
  mediaSchema,
  pickMedia,
  placeDetailReadSchema,
  placeProposalReadSchema,
  placesQueryResultReadSchema,
  placesQueryResultSchema,
  placeTaxonomyReadSchema,
  readAccessLevel,
  readVariant,
  serverDescriptorReadSchema,
} from "../index";

const place = (unique: string, category: string) => ({
  unique,
  category,
  point: { lat: 1, lng: 2 },
  hasGeometry: false,
  hasDescription: false,
  updatedAt: "2026-09-25T00:00:00.000Z",
});
const A = "01J00000000000000000000000";
const B = "01J00000000000000000000001";

describe("a list leaves out a row it cannot read, not the whole list", () => {
  const result = {
    places: [place(A, "park"), place(B, "volcano")],
    attribution: [],
    truncated: false,
  };

  it("places: the rest still arrive, in order", () => {
    const read = placesQueryResultReadSchema.parse(result);
    expect(read.places.map((p) => p.unique)).toEqual([A]);
  });

  it("the strict shape, which a server accepts, still refuses it", () => {
    expect(placesQueryResultSchema.safeParse(result).success).toBe(false);
  });

  it("a row that is malformed rather than newer is left out the same way", () => {
    // The reader cannot tell the two apart, and one bad row is no reason to lose the rest.
    const read = placesQueryResultReadSchema.parse({
      ...result,
      places: [place(A, "park"), { unique: B }],
    });
    expect(read.places).toHaveLength(1);
  });

  it("an operator's read keeps the place and fails instead, unknown keys still dropped", () => {
    const loud = readVariant(placesQueryResultSchema, { degrade: false });
    expect(loud.safeParse(result).success).toBe(false);
    const known = { ...result, places: [{ ...place(A, "park"), rating: 4 }] };
    expect(loud.parse(known).places).toEqual([place(A, "park")]);
  });

  it("a list that is not a list still fails", () => {
    expect(placesQueryResultReadSchema.safeParse({ ...result, places: "nope" }).success).toBe(
      false,
    );
  });

  it("the taxonomy offers the categories it knows", () => {
    const taxonomy = {
      categories: [
        { category: "park", subcategories: ["dog_park"] },
        { category: "volcano", subcategories: [] },
      ],
    };
    expect(placeTaxonomyReadSchema.parse(taxonomy).categories.map((c) => c.category)).toEqual([
      "park",
    ]);
  });
});

describe("an optional field reads a value it cannot read as absent", () => {
  it("a place's geometry: the place reads without its shape", () => {
    const detail = {
      ...place(A, "park"),
      hasGeometry: true,
      sources: [],
      geometry: { type: "Circle", radius: 3 },
    };
    const read = placeDetailReadSchema.parse(detail);
    expect(read.geometry).toBeUndefined();
    expect(read.unique).toBe(A);
  });

  it("a proposal is not an optional read: an operator must not approve what they cannot see", () => {
    const proposal = {
      id: A,
      proposedBy: "did:key:z6MkProposer",
      credit: false,
      fields: { category: "volcano", name: "Crater" },
      status: "pending",
      createdAt: "2026-09-25T00:00:00.000Z",
    };
    expect(placeProposalReadSchema.safeParse(proposal).success).toBe(false);
  });

  it("a setting's stored reason: the console shows the stored value without one", () => {
    const setting = { key: "a", env: "X", editable: true, provenance: "admin", configured: true };
    const read = adminSettingReadSchema.parse({
      ...setting,
      storedValue: 3,
      storedReason: "quota",
    });
    expect(read).toEqual({ ...setting, storedValue: 3 });
  });

  it("a geometry that is merely missing stays missing, and one it can read is kept", () => {
    const detail = { ...place(A, "park"), hasGeometry: false, sources: [] };
    expect(placeDetailReadSchema.parse(detail)).not.toHaveProperty("geometry");
    const square = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [0, 1],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    expect(placeDetailReadSchema.parse({ ...detail, geometry: square }).geometry).toEqual(square);
  });
});

describe("a required field reads a value it cannot read as its fallback", () => {
  const descriptor = {
    host: "a.example",
    key: "did:key:z6MkServer",
    coverage: [""],
    version: "0.0.1",
    startedAt: "2026-09-25T00:00:00.000Z",
    accessLevel: "friends",
    updated: "2026-09-25T00:00:00.000Z",
    proof: { type: "Ed25519", key: "did:key:z6MkServer", sig: "c2ln" },
  };

  it("an access level reads as private, the most restrictive", () => {
    expect(serverDescriptorReadSchema.parse(descriptor).accessLevel).toBe("private");
    // Only a level it has never heard of: a missing or mistyped one is still an error.
    const { accessLevel: _gone, ...without } = descriptor;
    expect(serverDescriptorReadSchema.safeParse(without).success).toBe(false);
    expect(serverDescriptorReadSchema.safeParse({ ...descriptor, accessLevel: 42 }).success).toBe(
      false,
    );
    expect(
      serverDescriptorReadSchema.parse({ ...descriptor, accessLevel: "request" }).accessLevel,
    ).toBe("request");
  });

  it("readAccessLevel answers the same for the raw signed body a verifier narrows", () => {
    expect(readAccessLevel("friends")).toBe("private");
    expect(readAccessLevel("request")).toBe("request");
  });
});

describe("an operator's own facts do not degrade", () => {
  const counts = {
    rooms: 0,
    profiles: 0,
    places: 0,
    placesRetired: 0,
    conflictsPending: 0,
    snapshots: 0,
    mediaObjects: 0,
    mediaBytes: 0,
    mediaUnreviewed: 0,
  };
  const status = {
    host: "a.example",
    name: "A",
    version: "0.0.2",
    startedAt: "2026-09-25T00:00:00.000Z",
    accessLevel: "open",
    coverage: [""],
    capabilities: [],
    counts,
  };

  it("the console's status card fails on a level it does not know, rather than calling it private", () => {
    expect(adminStatusReadSchema.parse(status).accessLevel).toBe("open"); // the fixture reads
    expect(adminStatusReadSchema.safeParse({ ...status, accessLevel: "friends" }).success).toBe(
      false,
    );
  });

  it("the storage limit is optional, and read when a server sends it", () => {
    expect(adminStatusReadSchema.parse(status).counts.mediaLimitBytes).toBeUndefined();
    const limited = { ...status, counts: { ...counts, mediaLimitBytes: 500_000_000 } };
    expect(adminStatusReadSchema.parse(limited).counts.mediaLimitBytes).toBe(500_000_000);
  });
});

describe("a media role it does not know reads as absent", () => {
  // A newer server may add a role beside `full` and `thumb`. Without the mark a third role failed
  // the read of every room and place that carried one. Absent makes the entry a standalone image,
  // which `pickMedia` and `mediaPairs` already handle.
  const poster = { type: "image", role: "poster", hash: "cG9zdGVy", uris: ["cG9zdGVy@a.example"] };
  const thumb = { type: "image", role: "thumb", hash: "dGh1bWI", uris: ["dGh1bWI@a.example"] };
  const full = { type: "image", role: "full", hash: "ZnVsbA", uris: ["ZnVsbA@a.example"] };

  it("an entry reads without its role, and the strict shape still refuses it", () => {
    const read = mediaReadSchema.parse(poster);
    expect(read.role).toBeUndefined();
    expect(read.hash).toBe(poster.hash);
    expect(mediaSchema.safeParse(poster).success).toBe(false);
  });

  it("a place keeps its place in a query, with the image as a photo of its own", () => {
    const read = placesQueryResultReadSchema.parse({
      places: [place(A, "park"), { ...place(B, "park"), media: [poster, thumb, full] }],
      attribution: [],
      truncated: false,
    });
    expect(read.places.map((p) => p.unique)).toEqual([A, B]);
    const media = read.places[1]!.media;
    expect(pickMedia(media, "thumb")?.hash).toBe(thumb.hash);
    expect(mediaPairs(media).map((photo) => photo.length)).toEqual([1, 2]);
  });

  it("a known role, and no role, read as they are", () => {
    expect(mediaReadSchema.parse(thumb).role).toBe("thumb");
    const { role: _role, ...sound } = { ...full, type: "sound" };
    expect(mediaReadSchema.parse(sound)).not.toHaveProperty("role");
  });
});
