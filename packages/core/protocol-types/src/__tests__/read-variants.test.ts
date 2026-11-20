/**
 * Every exported `*ReadSchema` is the read twin of its strict schema: the same tree with no
 * object left refusing unknown keys. Structural, so no per-shape fixture is needed here; the reads
 * that consume each twin feed it a response with an extra field in their own suites.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as protocol from "../index";
import { objects, rewrites, strictness } from "./schemaTree";

const twins = Object.entries(protocol)
  .filter(([name, value]) => name.endsWith("ReadSchema") && value instanceof z.ZodType)
  .map(([name, read]) => {
    const strictName = name.replace(/ReadSchema$/, "Schema");
    const strict = (protocol as Record<string, unknown>)[strictName];
    return { name, read: read as z.ZodType, strictName, strict: strict as z.ZodType };
  });

describe("the *ReadSchema twins", () => {
  it("exist for the response shapes a client reads", () => {
    const names = twins.map((t) => t.name);
    for (const wanted of [
      "serverDescriptorReadSchema",
      "profileDocReadSchema",
      "geocodeResultReadSchema",
      "placesQueryResultReadSchema",
      "placeDetailReadSchema",
      "adminStatusReadSchema",
      "adminSettingReadSchema",
      "adminBlocklistFetchResultReadSchema",
      "roomReadSchema",
      "identityReadSchema",
    ]) {
      expect(names).toContain(wanted);
    }
  });

  for (const { name, read, strictName, strict } of twins) {
    it(`${name} is ${strictName} with every object set to drop unknown keys`, () => {
      expect(strict).toBeInstanceOf(z.ZodType);
      expect(strictness(strict)).toContain("strict"); // the twin has a job to do
      expect(strictness(read).every((k) => k === "strip")).toBe(true);
      expect(objects(read).length).toBe(objects(strict).length); // the same tree, nothing dropped
    });

    it(`${name} parses to what it was given: no default or transform, so conformsTo narrows honestly`, () => {
      // `conformsTo` keeps the raw value and claims it has the output type. That is only true while
      // the twin's output equals its input; a signed document in particular must never be rewritten.
      // The one exception is a degradation its strict schema declared: a value this build
      // cannot read, read as absent or as a fallback, or a row left out.
      expect(rewrites(read)).toEqual([]);
    });
  }
});
