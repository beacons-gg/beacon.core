/**
 * Every exported schema converts to a valid JSON Schema, which a server's OpenAPI generator builds
 * from. A bound of `Infinity` once came out as `"maxLength": null`, which no validator accepts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as root from "../index";
import * as server from "../server";

const schemas = Object.entries({ ...root, ...server }).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
);

describe("the exported schemas as JSON Schema", () => {
  it("finds the schemas to check", () => {
    expect(schemas.length).toBeGreaterThan(100);
  });

  it.each(schemas)("%s has no bound that is not a number", (_name, schema) => {
    for (const io of ["input", "output"] as const) {
      const json = JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: "any" }));
      expect(json).not.toMatch(/"(max|min)\w*":null/);
    }
  });
});
