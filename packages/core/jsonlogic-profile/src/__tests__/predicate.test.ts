import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "../index";

/**
 * The **predicate** half of the profile (`doc/spec/item-properties.md` §6) — the language a room's
 * `accept` gate compiles to, and the language a game writes a transform rule's `when` in.
 *
 * This gets its own suite because a predicate is the one part of the profile a *game* authors by
 * hand and a *different party* executes: the server evaluates `accept` against every contributed
 * item, and a `when` written by one client runs on every other client. No shipped game policy uses
 * a transform `when` today, so without these the ops would be covered only incidentally through
 * `accepts()`.
 *
 * Cases marked TRAP pin behaviour that is surprising but load-bearing. They assert what the profile
 * actually does, not what looks tidy; the rationale for each lives with the matching vector in
 * `conformance.ts`, which is what a second implementation reads.
 */
describe("comparison operators", () => {
  it("orders integers", () => {
    expect(evaluatePredicate({ ">": [{ var: "a" }, 2] }, { a: 3 })).toBe(true);
    expect(evaluatePredicate({ ">": [{ var: "a" }, 3] }, { a: 3 })).toBe(false);
    expect(evaluatePredicate({ ">=": [{ var: "a" }, 3] }, { a: 3 })).toBe(true);
    expect(evaluatePredicate({ "<": [{ var: "a" }, 4] }, { a: 3 })).toBe(true);
    expect(evaluatePredicate({ "<=": [{ var: "a" }, 3] }, { a: 3 })).toBe(true);
  });

  it("compares equality, loose vs strict", () => {
    expect(evaluatePredicate({ "==": [{ var: "a" }, 3] }, { a: 3 })).toBe(true);
    expect(evaluatePredicate({ "!=": [{ var: "a" }, 4] }, { a: 3 })).toBe(true);
    expect(evaluatePredicate({ "===": [{ var: "c" }, "Cat"] }, { c: "Cat" })).toBe(true);
    expect(evaluatePredicate({ "!==": [{ var: "c" }, "Dog"] }, { c: "Cat" })).toBe(true);
  });

  it("TRAP: `==` is LOOSE across types, `===` is not", () => {
    expect(evaluatePredicate({ "==": [1, "1"] }, {})).toBe(true);
    expect(evaluatePredicate({ "===": [1, "1"] }, {})).toBe(false);
    expect(evaluatePredicate({ "!=": [1, "1"] }, {})).toBe(false);
  });

  it("TRAP: a 3-argument comparison is a BETWEEN, not a chain of two", () => {
    expect(evaluatePredicate({ "<": [1, 2, 3] }, {})).toBe(true); // 1 < 2 < 3
    expect(evaluatePredicate({ "<": [1, 5, 3] }, {})).toBe(false); // 5 is not < 3
    expect(evaluatePredicate({ "<=": [1, 1, 1] }, {})).toBe(true);
  });
});

describe("boolean combinators", () => {
  it("and / or / negation", () => {
    const over2 = { ">": [{ var: "a" }, 2] };
    const under10 = { "<": [{ var: "a" }, 10] };
    expect(evaluatePredicate({ and: [over2, under10] }, { a: 5 })).toBe(true);
    expect(evaluatePredicate({ and: [over2, under10] }, { a: 20 })).toBe(false);
    expect(evaluatePredicate({ or: [over2, under10] }, { a: 20 })).toBe(true);
    expect(evaluatePredicate({ "!": [over2] }, { a: 1 })).toBe(true);
    expect(evaluatePredicate({ "!!": [over2] }, { a: 5 })).toBe(true);
  });

  it("nests to arbitrary depth", () => {
    const rule = {
      and: [
        { or: [{ "===": [{ var: "c" }, "Cat"] }, { "===": [{ var: "c" }, "Dog"] }] },
        { ">=": [{ var: "lvl" }, 10] },
      ],
    };
    expect(evaluatePredicate(rule, { c: "Dog", lvl: 12 })).toBe(true);
    expect(evaluatePredicate(rule, { c: "Bird", lvl: 12 })).toBe(false);
    expect(evaluatePredicate(rule, { c: "Dog", lvl: 4 })).toBe(false);
  });

  it("TRAP: an empty array is FALSY here, unlike plain JS", () => {
    expect(evaluatePredicate({ "!!": [{ var: "xs" }] }, { xs: [] })).toBe(false);
    expect(evaluatePredicate({ "!": [{ var: "xs" }] }, { xs: [] })).toBe(true);
    expect(evaluatePredicate({ "!!": [{ var: "xs" }] }, { xs: ["a"] })).toBe(true);
  });
});

describe("membership and iteration", () => {
  it("`in` tests membership of an array literal", () => {
    expect(evaluatePredicate({ in: [{ var: "c" }, ["Cat", "Dog"]] }, { c: "Dog" })).toBe(true);
    expect(evaluatePredicate({ in: [{ var: "c" }, ["Cat", "Dog"]] }, { c: "Bird" })).toBe(false);
  });

  it("`some` tests a collection against a sub-predicate", () => {
    const anyCat = { some: [{ var: ["tags.animal", []] }, { "===": [{ var: "" }, "cat"] }] };
    expect(evaluatePredicate(anyCat, { tags: { animal: ["dog", "cat"] } })).toBe(true);
    expect(evaluatePredicate(anyCat, { tags: { animal: ["dog"] } })).toBe(false);
    expect(evaluatePredicate(anyCat, { tags: { animal: [] } })).toBe(false);
  });

  it("`some` over numbers, the shape a minimum-level gate uses", () => {
    const anyBig = { some: [{ var: "levels" }, { ">=": [{ var: "" }, 50] }] };
    expect(evaluatePredicate(anyBig, { levels: [10, 60] })).toBe(true);
    expect(evaluatePredicate(anyBig, { levels: [10, 20] })).toBe(false);
  });
});

describe("missing data is false, never a throw", () => {
  // An item that simply lacks the field a predicate names must be a clean non-match — a room's
  // accept gate sees arbitrary items, so this is the common case, not an edge case.
  it("an absent var fails a comparison rather than erroring", () => {
    expect(evaluatePredicate({ ">=": [{ var: "nope" }, 1] }, {})).toBe(false);
    expect(evaluatePredicate({ in: [{ var: "nope" }, ["a"]] }, {})).toBe(false);
    expect(
      evaluatePredicate({ some: [{ var: ["nope", []] }, { "===": [{ var: "" }, "a"] }] }, {}),
    ).toBe(false);
  });

  it("a var default stands in for an absent field", () => {
    expect(evaluatePredicate({ ">=": [{ var: ["nope", 5] }, 3] }, {})).toBe(true);
  });
});

describe("the whitelist gate applies to predicates too", () => {
  // `profile.test.ts` already covers WHICH operators the whitelist rejects. What's specific here is the
  // path: an off-profile op authored inside a rule's `when` must throw through `evaluatePredicate`, not
  // silently evaluate — that's the seam a game reaches the evaluator through.
  it("an off-profile op in a predicate throws rather than evaluating", () => {
    expect(() => evaluatePredicate({ if: [true, 1, 2] }, {})).toThrow();
    expect(() =>
      evaluatePredicate({ all: [{ var: "xs" }, { ">": [{ var: "" }, 1] }] }, { xs: [2] }),
    ).toThrow();
  });
});
