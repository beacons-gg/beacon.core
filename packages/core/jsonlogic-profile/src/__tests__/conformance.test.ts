import { describe, expect, it } from "vitest";
import { CONFORMANCE_VECTORS, evaluate, validateRule } from "../index";

describe("conformance vectors (the interop spec)", () => {
  it.each(CONFORMANCE_VECTORS)("$name", ({ rule, data, expected }) => {
    // Every vector's rule must itself be in-profile…
    expect(validateRule(rule).ok).toBe(true);
    // …and evaluate to exactly the expected output.
    expect(evaluate(rule, data)).toBe(expected);
  });
});
