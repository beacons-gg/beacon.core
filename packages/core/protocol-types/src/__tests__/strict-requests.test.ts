/**
 * Every shape a server accepts refuses a key it does not know, at any depth. A dropped key is a
 * request that succeeds without what the sender asked for; a refused one comes back named, so a
 * newer client learns the server is behind. These tests pin that for every params schema the
 * package exports, and then that the refusal names the field for each shape that once stripped it
 * silently. That their read twins still drop the key is `read-variants.test.ts`'s, for every twin.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as wire from "../index";
import { unknownFields } from "../server";
import { strictness } from "./schemaTree";

// Every params schema, found by name so a new one is covered without being listed, plus the request
// shapes that are not named for params.
const requestShapes: [string, z.ZodType][] = [
  ...Object.entries(wire).filter(
    (entry): entry is [string, z.ZodType] =>
      /ParamsSchema$/.test(entry[0]) && entry[1] instanceof z.ZodType,
  ),
  ["opEnvelopeSchema", wire.opEnvelopeSchema],
  ["cellsSubscribeSchema", wire.cellsSubscribeSchema],
  ["mediaUploadSchema", wire.mediaUploadSchema],
];

describe("a request shape refuses what it does not know, at every depth", () => {
  it("finds the request shapes", () => {
    // A rename that stopped matching the filter would pass the test below with nothing in it.
    expect(requestShapes.length).toBeGreaterThan(30);
  });

  it.each(requestShapes)("%s is strict all the way down", (_name, schema) => {
    expect(strictness(schema).filter((keys) => keys !== "strict")).toEqual([]);
  });
});

const mintedBy = { id: "did:key:z6MkMinter", sig: "c2ln" };
const media = { type: "image", role: "thumb", hash: "aGFzaA", uris: ["aGFzaA@a.example"] };

describe("the shapes that once stripped an unknown field name it", () => {
  it.each([
    ["react params", wire.reactParamsSchema, { target: "r1", kind: "heart" }, []],
    ["scout cancel params", wire.scoutCancelParamsSchema, { unique: "s1" }, []],
    ["a location", wire.latLngSchema, { lat: 1, lng: 2 }, []],
    ["a mintedBy", wire.mintedBySchema, mintedBy, []],
    ["a media entry", wire.mediaSchema, media, []],
    ["a media credit", wire.mediaSchema, { ...media, credit: { author: "A" } }, ["credit"]],
    ["an item", wire.opaqueItemSchema, { unique: "i1", birth: {} }, []],
    [
      "an item's match",
      wire.opaqueItemSchema,
      { unique: "i1", birth: {}, match: { class: "c" } },
      ["match"],
    ],
  ] as const)("%s", (_what, schema, known, at) => {
    expect(schema.safeParse(known).success).toBe(true);
    const withNew = structuredClone(known) as Record<string, unknown>;
    let target = withNew;
    for (const key of at) target = target[key] as Record<string, unknown>;
    target["addedLater"] = true;
    const parsed = schema.safeParse(withNew);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(unknownFields(parsed.error)).toEqual([[...at, "addedLater"].join(".")]);
  });
});

describe("unknownFields", () => {
  const refused = (value: unknown) => {
    const parsed = wire.reactParamsSchema.safeParse(value);
    if (parsed.success) throw new Error("expected a refusal");
    return parsed.error;
  };

  it("places the path inside a larger request, as an add or contribute names its item", () => {
    const parsed = wire.opaqueItemSchema.safeParse({ unique: "i1", birth: {}, tint: 2 });
    if (parsed.success) throw new Error("expected a refusal");
    expect(unknownFields(parsed.error, ["item"])).toEqual(["item.tint"]);
  });

  it("names nothing when something else is wrong too, so a client bug is not read as a version gap", () => {
    expect(unknownFields(refused({ target: "r1", burst: 2 }))).toEqual([]);
  });
});
