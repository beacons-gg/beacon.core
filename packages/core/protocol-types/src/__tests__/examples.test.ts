/**
 * The example policies `doc/game-author.md` shows. The engine's suite plays them; this holds
 * the property an author copying one relies on before that: it places on any server.
 */
import { describe, expect, it } from "vitest";
import { POT_POLICY } from "../examples";
import { unsupportedPolicyFeatures } from "../index";

describe("the documented example policies", () => {
  it("use only baseline features, so every server places them, including one that advertises nothing", () => {
    expect(unsupportedPolicyFeatures(undefined, POT_POLICY)).toEqual([]);
  });
});
