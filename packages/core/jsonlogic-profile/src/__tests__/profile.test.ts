import { BASELINE_RULE_OPERATORS } from "@beaconsgg/protocol-types";
import { parseUnderstands, ruleMarkers } from "@beaconsgg/protocol-types/server";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_OPERATORS,
  accepts,
  aggregate,
  evaluate,
  evaluateFormula,
  evaluatePredicate,
  validateRule,
  withinCapacity,
} from "../index";

describe("the operator set is the rule markers' vocabulary", () => {
  it("still allows every baseline operator: dropping one refuses what older apps place", () => {
    for (const operator of BASELINE_RULE_OPERATORS)
      expect(ALLOWED_OPERATORS.has(operator)).toBe(true);
  });

  it("names every operator beyond the baseline as a legal marker, no two alike", () => {
    const markers = ruleMarkers(ALLOWED_OPERATORS);
    for (const marker of markers) expect(parseUnderstands(marker).has(marker)).toBe(true);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("refuses an operator named like an Object.prototype key, reading no prototype", () => {
    expect(validateRule({ toString: 1 }).error).toBe('operator not allowed: "toString"');
  });
});

describe("validateRule — whitelist enforcement", () => {
  it("accepts profile operators", () => {
    expect(validateRule({ "+": [{ var: "x" }, 1] }).ok).toBe(true);
    expect(validateRule({ sum: [{ var: "contents" }, "power"] }).ok).toBe(true);
    expect(validateRule({ min: [{ max: [{ var: "x" }, 0] }, 100] }).ok).toBe(true);
    expect(validateRule({ ">=": [{ var: "a" }, 1] }).ok).toBe(true);
  });

  it("rejects division and modulo", () => {
    expect(validateRule({ "/": [10, 2] }).ok).toBe(false);
    expect(validateRule({ "%": [10, 3] }).ok).toBe(false);
  });

  it("rejects conditionals and string/iteration ops", () => {
    expect(validateRule({ if: [true, 1, 0] }).ok).toBe(false);
    expect(validateRule({ cat: ["a", "b"] }).ok).toBe(false);
    expect(validateRule({ map: [{ var: "xs" }, { "+": [{ var: "" }, 1] }] }).ok).toBe(false);
  });

  it("rejects an unknown operator and multi-key objects", () => {
    expect(validateRule({ frobnicate: [1] }).ok).toBe(false);
    expect(validateRule({ "+": [1], "-": [1] }).ok).toBe(false);
  });
});

describe("validateRule — var path can't smuggle a forbidden op", () => {
  it("rejects a sub-rule in a var path", () => {
    expect(validateRule({ var: [{ "/": [10, 2] }] }).ok).toBe(false);
    expect(validateRule({ var: [{ cat: ["a", "b"] }] }).ok).toBe(false);
  });
  it("accepts literal var paths and a [path, default] form", () => {
    expect(validateRule({ var: "a.b" }).ok).toBe(true);
    expect(validateRule({ var: "" }).ok).toBe(true);
    expect(validateRule({ var: 0 }).ok).toBe(true);
    expect(validateRule({ var: ["a", 0] }).ok).toBe(true);
  });
});

describe("validateRule — `in` is membership only (no substring)", () => {
  it("rejects a string haystack", () => {
    expect(validateRule({ in: ["cat", "concatenate"] }).ok).toBe(false);
  });
  it("accepts an array-literal haystack", () => {
    expect(validateRule({ in: [{ var: "class" }, ["Widget"]] }).ok).toBe(true);
  });
});

describe("validateRule — depth / size caps (DoS)", () => {
  it("rejects an over-deep rule instead of throwing", () => {
    let rule: unknown = { var: "x" };
    for (let i = 0; i < 40; i++) rule = { "+": [rule, 1] };
    const result = validateRule(rule);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nesting/);
  });
  it("rejects an over-wide rule", () => {
    const rule = { "+": Array.from({ length: 1100 }, () => 1) };
    expect(validateRule(rule).ok).toBe(false);
  });
});

describe("validateRule — integer guard", () => {
  it("rejects non-integer numeric literals", () => {
    expect(validateRule({ "+": [1, 1.5] }).ok).toBe(false);
    expect(validateRule(0.1).ok).toBe(false);
  });

  it("accepts integers (incl. negatives) and rejects unsafe magnitudes", () => {
    expect(validateRule({ "+": [-86400, 86400] }).ok).toBe(true);
    expect(validateRule(Number.MAX_SAFE_INTEGER + 2).ok).toBe(false);
  });
});

describe("aggregators", () => {
  const contents = [{ levels: { power: 2 } }, { levels: { power: 5 } }, { levels: {} }];

  it("sum/min/max/count over a key", () => {
    expect(aggregate(contents, "power", "sum")).toBe(7);
    expect(aggregate(contents, "power", "min")).toBe(2);
    expect(aggregate(contents, "power", "max")).toBe(5);
    expect(aggregate(contents, "power", "count")).toBe(2);
  });

  it("empty-collection identities are all 0", () => {
    for (const kind of ["sum", "min", "max", "count"] as const) {
      expect(aggregate([], "power", kind)).toBe(0);
    }
  });

  it("reads flat fields too (not only `levels`)", () => {
    expect(aggregate([{ power: 3 }, { power: 4 }], "power", "sum")).toBe(7);
  });

  it("ignores non-integer values (integer-only contract, no float divergence)", () => {
    expect(aggregate([{ levels: { p: 0.1 } }, { levels: { p: 0.2 } }], "p", "sum")).toBe(0);
    expect(aggregate([{ p: 3 }, { p: 2.5 }, { p: "9" }], "p", "sum")).toBe(3);
  });
});

describe("eval-time integer guard / evaluator enforcement", () => {
  it("scalar min/max over empty or non-integer args -> 0 (never ±Infinity)", () => {
    expect(evaluate({ min: [] }, {})).toBe(0);
    expect(evaluate({ max: [] }, {})).toBe(0);
    // a numeric-string var is dropped, not coerced to a float
    expect(evaluate({ min: [{ var: "a" }, { var: "b" }] }, { a: "3.5", b: 5 })).toBe(5);
  });

  it("the evaluator itself rejects excluded native ops (defense-in-depth)", () => {
    expect(() => evaluate({ "/": [10, 2] }, {})).toThrow();
    expect(() => evaluate({ cat: ["a", "b"] }, {})).toThrow();
  });

  it("blocks inline-handled ops too — `evaluate` gates on validateRule, not op-removal", () => {
    // json-logic-js handles these via an inline branch BEFORE the operation table, so removing
    // them from the table is a no-op; the validateRule gate inside evaluate is what stops them.
    expect(() => evaluate({ if: [true, 1, 0] }, {})).toThrow();
    expect(() => evaluate({ map: [{ var: "xs" }, 1] }, { xs: [1, 2] })).toThrow();
    expect(() => evaluate({ reduce: [{ var: "xs" }, { "+": [1, 1] }, 0] }, { xs: [1] })).toThrow();
    // substring `in` (string haystack) is off-profile and must throw, not silently match
    expect(() => evaluate({ in: ["cat", "concatenate"] }, {})).toThrow();
  });
});

describe("evaluate / integer guard at eval time", () => {
  it("evaluateFormula returns the integer result", () => {
    expect(evaluateFormula({ "+": [{ var: "x" }, 1] }, { x: 41 })).toBe(42);
  });

  it("evaluateFormula throws when data injects a non-integer", () => {
    expect(() => evaluateFormula({ "+": [{ var: "x" }, 1] }, { x: 1.5 })).toThrow();
  });

  it("evaluatePredicate coerces to boolean", () => {
    expect(evaluatePredicate({ ">=": [{ var: "a" }, 1] }, { a: 3 })).toBe(true);
    expect(evaluatePredicate({ ">=": [{ var: "a" }, 1] }, { a: 0 })).toBe(false);
  });

  it("min/max dual-dispatch: scalar vs aggregator", () => {
    expect(evaluate({ min: [9, 3, 7] }, {})).toBe(3);
    expect(evaluate({ min: [{ var: "c" }, "power"] }, { c: [{ power: 8 }, { power: 4 }] })).toBe(4);
  });
});

describe("accepts (room admission)", () => {
  const accept = {
    class: ["Widget"],
    tags: { animal: ["cat", "dog"] },
    minLevels: { alpha: 1 },
  };

  it("accepts a matching item", () => {
    expect(
      accepts(accept, {
        class: "Widget",
        tags: { animal: ["cat"] },
        levels: { alpha: 3 },
      }),
    ).toBe(true);
  });

  it("rejects on wrong class", () => {
    expect(
      accepts(accept, { class: "Other", tags: { animal: ["cat"] }, levels: { alpha: 3 } }),
    ).toBe(false);
  });

  it("rejects when no tag matches", () => {
    expect(
      accepts(accept, {
        class: "Widget",
        tags: { animal: ["fish"] },
        levels: { alpha: 3 },
      }),
    ).toBe(false);
  });

  it("rejects when a minLevel is unmet", () => {
    expect(
      accepts(accept, {
        class: "Widget",
        tags: { animal: ["cat"] },
        levels: { alpha: 0 },
      }),
    ).toBe(false);
  });

  it("an empty predicate accepts anything", () => {
    expect(accepts({}, { class: "Whatever" })).toBe(true);
  });

  describe("empty tag list is a wildcard (has the key with any value)", () => {
    const anyAnimal = { class: ["Widget"], tags: { animal: [] } };

    it("accepts any value under the wildcard key", () => {
      expect(accepts(anyAnimal, { class: "Widget", tags: { animal: ["fox"] } })).toBe(true);
      expect(accepts(anyAnimal, { class: "Widget", tags: { animal: ["cat"] } })).toBe(true);
    });

    it("rejects an item missing the wildcard key entirely", () => {
      expect(accepts(anyAnimal, { class: "Widget", tags: { color: ["red"] } })).toBe(false);
      expect(accepts(anyAnimal, { class: "Widget" })).toBe(false);
    });

    it("rejects an item whose wildcard key is present but empty", () => {
      expect(accepts(anyAnimal, { class: "Widget", tags: { animal: [] } })).toBe(false);
    });
  });

  it("withinCapacity respects the limit", () => {
    expect(withinCapacity(2, 10)).toBe(true);
    expect(withinCapacity(10, 10)).toBe(false);
    expect(withinCapacity(999, undefined)).toBe(true);
  });
});
