/**
 * The `op:`, `policy:` and `rule:` markers: what a server accepts beyond the baseline,
 * and how a client asks. The schema extensions below stand in for the next policy field or value;
 * none exists yet.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BASELINE_OPS,
  BASELINE_POLICY_FEATURES,
  BASELINE_RULE_OPERATORS,
  RULE_OPERATOR_NAMES,
  acceptsOp,
  opRuleSchema,
  policyFeaturesOf,
  policySchema,
  roleSchema,
  ruleOperatorsOf,
  unsupportedPolicyFeatures,
} from "../index";
import { markersOfSchema, unsupportedBySchema } from "../markers";
import { opMarkers, parseUnderstands, policyFeatures, policyMarkers, ruleMarkers } from "../server";

describe("policyFeatures", () => {
  it("still derives every baseline feature, since dropping one refuses what older apps send", () => {
    const live = policyFeatures();
    for (const feature of BASELINE_POLICY_FEATURES) expect(live).toContain(feature);
  });

  it("spells fields as paths and closed values as one more segment, through records and unions", () => {
    const features = policyFeatures();
    expect(features).toContain("ops.max"); // a field under a record: every op's rule is `ops.*`
    expect(features).toContain("ops.role.owner"); // a literal inside a union
    expect(features).toContain("grant.when"); // one rule or an array of them reads the same
    expect(features).toContain("onEmpty.close");
    // Open values are not features: a new one is not an addition.
    expect(features.filter((f) => f.startsWith("claimTtl"))).toEqual(["claimTtl"]);
    expect(features.filter((f) => f.startsWith("derived"))).toEqual(["derived"]);
  });

  it("spells every feature as a legal marker", () => {
    for (const feature of policyFeatures()) {
      expect(parseUnderstands(`policy:${feature}`).has(`policy:${feature}`)).toBe(true);
    }
  });
});

/** A later schema with one new field and two new closed values, for the tests below. */
const later = policySchema.extend({
  cooldown: z.string().optional(),
  onEmpty: z.enum(["close", "archive"]).optional(),
  ops: z.record(
    z.string(),
    opRuleSchema.extend({ role: z.union([roleSchema, z.literal("friends")]) }),
  ),
});

describe("policyMarkers", () => {
  it("advertises a new field and a new value on a closed set, however deep", () => {
    expect(markersOfSchema(later).sort()).toEqual([
      "policy:cooldown",
      "policy:onEmpty.archive",
      "policy:ops.games",
      "policy:ops.role.friends",
    ]);
  });

  it("advertises `ops.games`, the first addition, as one marker a client can parse", () => {
    // `"*"` must not surface as a value feature: `policy:ops.games.*` is outside the marker charset.
    expect(policyMarkers()).toEqual(["policy:ops.games"]);
  });
});

describe("opMarkers", () => {
  it("advertises only the ops beyond the baseline", () => {
    expect(opMarkers([...BASELINE_OPS])).toEqual([]);
    expect(opMarkers(["add", "unreact"])).toEqual(["op:unreact"]);
  });
});

describe("policyFeaturesOf", () => {
  it("names each field a policy sets and each closed value it picks, through the branch it takes", () => {
    const policy = {
      ops: { take: { role: "owner" }, add: { role: ["did:key:z6Mk"] } },
      grant: [{ op: "claim", from: "rewards", count: 1 }],
      onEmpty: "close",
    };
    expect(policyFeaturesOf(policy).sort()).toEqual(
      [
        "ops",
        "ops.role",
        "ops.role.owner",
        "grant",
        "grant.op",
        "grant.from",
        "grant.count",
        "onEmpty",
        "onEmpty.close",
      ].sort(),
    );
  });
});

describe("what a client asks", () => {
  it("takes the baseline as given, from a server that predates markers", () => {
    expect(acceptsOp(undefined, "contribute")).toBe(true);
    const policy = { ops: { contribute: { role: "contributor", max: 5 } }, claimTtl: "30d" };
    expect(unsupportedPolicyFeatures(undefined, policy)).toEqual([]);
    expect(unsupportedPolicyFeatures(["mailbox"], policy)).toEqual([]);
  });

  it("takes an op only where it is advertised, in its own namespace", () => {
    expect(acceptsOp(["mailbox"], "unreact")).toBe(false);
    expect(acceptsOp(["op:unreact"], "unreact")).toBe(true);
    expect(acceptsOp(["policy:unreact"], "unreact")).toBe(false);
  });

  it("names the additions a policy uses that a server has not advertised", () => {
    const policy = {
      ops: { take: { role: "friends" } },
      onEmpty: "archive",
      cooldown: "1h",
    };
    expect(unsupportedBySchema(["mailbox"], policy, later).sort()).toEqual([
      "cooldown",
      "onEmpty.archive",
      "ops.role.friends",
    ]);
    const advertised = ["policy:cooldown", "op:onEmpty.archive", "policy:ops.role.friends"];
    expect(unsupportedBySchema(advertised, policy, later)).toEqual(["onEmpty.archive"]);
  });
});

describe("rule operators", () => {
  it("freezes the baseline and the names", () => {
    expect(Object.isFrozen(BASELINE_RULE_OPERATORS)).toBe(true);
    expect(Object.isFrozen(RULE_OPERATOR_NAMES)).toBe(true);
  });

  it("advertises the operators beyond the baseline: a word as itself, a symbol by name", () => {
    expect(ruleMarkers(BASELINE_RULE_OPERATORS)).toEqual([]);
    expect(ruleMarkers(["+", "if", "%", "?:"])).toEqual(["rule:if", "rule:mod", "rule:ternary"]);
  });

  it("refuses to advertise a symbol with no name rather than dropping it", () => {
    expect(() => ruleMarkers(["^"])).toThrow(/"\^" has no marker name/);
  });

  it("spells every named operator as a legal marker", () => {
    for (const name of Object.values(RULE_OPERATOR_NAMES)) {
      expect(parseUnderstands(`rule:${name}`).has(`rule:${name}`)).toBe(true);
    }
  });

  it("finds the operators in every rule slot placement validates, and only there", () => {
    const policy = {
      ops: { claim: { role: "contributor" } },
      derived: { unlockAt: { max: [{ var: "lockAt" }, 5] } },
      grant: [{ op: "claim", from: "rewards", count: 1, when: { if: [true, 1, 0] } }],
      unlockTransform: [{ when: { some: [[1], { "==": [1, 1] }] }, set: { a: { "%": [5, 2] } } }],
      // `accept` and `lifecycle` are not rule bodies: an operator-like key there is not one.
      accept: { class: ["cat"] },
      lifecycle: { phases: ["open"], transitions: { open: "unlockAt" } },
    };
    expect(ruleOperatorsOf(policy).sort()).toEqual(["max", "var", "if", "some", "==", "%"].sort());
  });

  it("reads one grant rule like several, and skips what is not an operation", () => {
    const one = { ops: {}, grant: { op: "claim", from: "p", count: 1, when: { cat: ["a", "b"] } } };
    expect(ruleOperatorsOf(one)).toEqual(["cat"]);
    expect(ruleOperatorsOf({ ops: {}, derived: { k: { a: 1, b: 2 } } })).toEqual([]);
  });

  it("reports an operator a server has not advertised, as its marker", () => {
    const policy = {
      ops: {},
      derived: { k: { "%": [{ var: "n" }, 2] } },
      grant: { op: "claim", from: "p", count: 1, when: { if: [true, 1, 0] } },
    };
    expect(unsupportedPolicyFeatures(undefined, policy).sort()).toEqual(["rule:if", "rule:mod"]);
    expect(unsupportedPolicyFeatures(["rule:if", "policy:if"], policy)).toEqual(["rule:mod"]);
    expect(unsupportedPolicyFeatures(["rule:if", "rule:mod"], policy)).toEqual([]);
    // An operator this build cannot name is still reported, as written.
    expect(unsupportedPolicyFeatures(undefined, { ops: {}, derived: { k: { "^": [1] } } })).toEqual(
      ["rule:^"],
    );
  });

  it("takes the baseline operators as given", () => {
    const policy = { ops: {}, derived: { k: { "+": [{ sum: [{ var: "contents" }, "x"] }, 1] } } };
    expect(unsupportedPolicyFeatures(undefined, policy)).toEqual([]);
  });
});
