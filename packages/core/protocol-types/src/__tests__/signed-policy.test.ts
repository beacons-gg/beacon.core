/**
 * The policy is a SIGNED shape: the room's minter signs `{unique, kind, policy}`, so a
 * field the parse silently dropped would be a field the signature still covers, and the placement
 * would then read as forged rather than as "this server is older than the app". These tests pin the
 * two properties that keep the diagnosis honest: every object inside a policy refuses what it does
 * not know, and nothing in the tree rewrites what it parses.
 */
import { describe, expect, it } from "vitest";
import { placeParamsSchema, policySchema, type Policy } from "../index";
import { rewrites } from "./schemaTree";

const policy: Policy = {
  type: "box",
  ops: { contribute: { role: "public" }, claim: { role: "contributor", phase: "unlocked" } },
  lifecycle: { phases: ["packing", "unlocked"], transitions: { unlocked: "unlockAt" } },
  derived: { unlockAt: { "+": [1, 2] } },
  accept: { class: ["Widget"], capacity: 8 },
  grant: { op: "claim", from: "rewards", count: 1 },
  unlockTransform: [{ set: { beta: { "+": [1, 1] } } }],
  maxContributors: 4,
  onEmpty: "close",
  claimTtl: "30d",
};

/** The same policy with `field` added at `path`, the way a newer game build would emit it. */
function withUnknown(path: (string | number)[], field: string): unknown {
  const copy = structuredClone(policy) as Record<string, unknown>;
  let target = copy;
  for (const step of path) target = target[step] as Record<string, unknown>;
  target[field] = "something this build predates";
  return copy;
}

describe("a signed policy refuses a field this build does not know", () => {
  it("accepts the policy this build does know", () => {
    expect(policySchema.safeParse(policy).success).toBe(true);
  });

  it.each([
    ["the policy itself", [] as (string | number)[]],
    ["an op rule", ["ops", "claim"]],
    ["the lifecycle", ["lifecycle"]],
    ["the accept predicate", ["accept"]],
    ["a grant rule", ["grant"]],
    ["an unlock-transform rule", ["unlockTransform", 0]],
  ])("refuses an unknown field on %s", (_where, path) => {
    const parsed = policySchema.safeParse(withUnknown(path, "cooldown"));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // Named, and located: the boundary turns this into "this server does not understand X".
      const issue = parsed.error.issues.find((i) => i.code === "unrecognized_keys");
      expect(issue?.path).toEqual(path);
      expect(issue).toMatchObject({ keys: ["cooldown"] });
    }
  });

  it("carries a rule body the engine evaluates without inspecting it", () => {
    // `derived` and `unlockTransform.set` hold opaque JSONLogic. Strictness must not reach inside a
    // rule, or a new operator in a formula would read as an unknown field.
    const deep = structuredClone(policy);
    deep.derived = { unlockAt: { clampedSince: [1, 2, 3] } };
    expect(policySchema.safeParse(deep).success).toBe(true);
  });
});

describe("a signed shape parses to exactly what it was given", () => {
  // The route verifies the minter's signature over the PARSED policy, so any node that rewrote its
  // input (a default filled in, a transform applied) would recreate the false-forgery failure with
  // no unknown field in sight: the bytes checked would not be the bytes signed.
  //
  // Rewrites are the whole risk, which is why this is not a deep-equal of parse output: the signature
  // is over `canonicalJson`, which is JCS, so it sorts keys (order cannot matter) and drops
  // `undefined` values on both sides. What it cannot survive is a value the parse invented or changed.
  it.each([
    ["policySchema", policySchema],
    ["placeParamsSchema", placeParamsSchema],
  ])("%s holds no default, catch or transform", (_name, schema) => {
    expect(rewrites(schema)).toEqual([]);
  });
});
