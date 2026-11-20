import type { JsonLogicRule } from "@beaconsgg/protocol-types";

export interface ConformanceVector {
  name: string;
  rule: JsonLogicRule;
  data: unknown;
  expected: number | boolean;
}

// A two-item contents set, reused across the aggregator and derived-state vectors. Each item carries
// its stats under `levels`; `alpha` / `beta` / `gamma` are placeholders, not any game's stats.
const contents = [
  { levels: { alpha: 2, beta: 24, gamma: 3 } },
  { levels: { alpha: 5, beta: 24, gamma: 1 } },
];

/**
 * The conformance test-vector suite (`doc/spec/item-properties.md` §4.4) — the real interop spec.
 * Every server's JSONLogic evaluator + the 4 aggregators must produce these exact outputs.
 */
export const CONFORMANCE_VECTORS: readonly ConformanceVector[] = [
  // ── arithmetic (integer only) ──
  { name: "add", rule: { "+": [2, 3, 4] }, data: {}, expected: 9 },
  { name: "subtract", rule: { "-": [10, 3] }, data: {}, expected: 7 },
  { name: "multiply", rule: { "*": [6, 7] }, data: {}, expected: 42 },
  { name: "negative result", rule: { "+": [5, -12] }, data: {}, expected: -7 },

  // ── scalar bounds / clamp ──
  { name: "scalar min", rule: { min: [9, 3, 7] }, data: {}, expected: 3 },
  { name: "scalar max", rule: { max: [9, 3, 7] }, data: {}, expected: 9 },
  {
    name: "clamp(x, 0, 14d) low",
    rule: { min: [{ max: [{ var: "x" }, 0] }, 1209600] },
    data: { x: -5 },
    expected: 0,
  },
  {
    name: "clamp(x, 0, 14d) high",
    rule: { min: [{ max: [{ var: "x" }, 0] }, 1209600] },
    data: { x: 9999999 },
    expected: 1209600,
  },

  // ── aggregators over a collection by key ──
  {
    name: "sum alpha",
    rule: { sum: [{ var: "contents" }, "alpha"] },
    data: { contents },
    expected: 7,
  },
  {
    name: "min alpha",
    rule: { min: [{ var: "contents" }, "alpha"] },
    data: { contents },
    expected: 2,
  },
  {
    name: "max alpha",
    rule: { max: [{ var: "contents" }, "alpha"] },
    data: { contents },
    expected: 5,
  },
  {
    name: "count contents",
    rule: { count: [{ var: "contents" }, "alpha"] },
    data: { contents },
    expected: 2,
  },
  {
    // An opaque item (its game payload is private) exposes its stats through `match.levels`.
    name: "sum reads an opaque item's match.levels projection",
    rule: { sum: [{ var: "contents" }, "alpha"] },
    data: {
      contents: [{ match: { levels: { alpha: 4 } } }, { match: { levels: { alpha: 6 } } }],
    },
    expected: 10,
  },

  // ── empty-collection identities (§4.3) ──
  {
    name: "sum empty -> 0",
    rule: { sum: [{ var: "c" }, "alpha"] },
    data: { c: [] },
    expected: 0,
  },
  {
    name: "count empty -> 0",
    rule: { count: [{ var: "c" }, "alpha"] },
    data: { c: [] },
    expected: 0,
  },
  {
    name: "min empty -> 0",
    rule: { min: [{ var: "c" }, "alpha"] },
    data: { c: [] },
    expected: 0,
  },
  {
    name: "max empty -> 0",
    rule: { max: [{ var: "c" }, "alpha"] },
    data: { c: [] },
    expected: 0,
  },

  // ── derived state: a time window from its contents (`doc/spec/item-properties.md` §7) ──
  // `alpha` pulls the start earlier (−1800 s/unit), `beta` pulls the end earlier (−3600 s/unit),
  // each clamped by `max` so the window can't invert.
  {
    name: "startAt = max(createdAt, createdAt + 1d - 1800*sum(alpha))",
    rule: {
      max: [
        { var: "createdAt" },
        {
          "+": [
            { var: "createdAt" },
            86400,
            { "*": [{ sum: [{ var: "contents" }, "alpha"] }, -1800] },
          ],
        },
      ],
    },
    data: { createdAt: 1000000, contents },
    expected: 1073800, // 1000000 + 86400 - 1800*7
  },
  {
    name: "endAt = max(startAt, startAt + 7d - 3600*sum(beta))",
    rule: {
      max: [
        { var: "startAt" },
        {
          "+": [
            { var: "startAt" },
            604800,
            { "*": [{ sum: [{ var: "contents" }, "beta"] }, -3600] },
          ],
        },
      ],
    },
    data: { startAt: 1073800, contents },
    expected: 1505800, // 1073800 + 604800 - 3600*48
  },

  // ── predicate ops (`doc/spec/item-properties.md` §6) ──
  {
    name: "class in list",
    rule: { in: [{ var: "class" }, ["Widget"]] },
    data: { class: "Widget" },
    expected: true,
  },
  {
    name: "class not in list",
    rule: { in: [{ var: "class" }, ["Widget"]] },
    data: { class: "Other" },
    expected: false,
  },
  {
    name: "minLevel >=",
    rule: { ">=": [{ var: "levels.gamma" }, 1] },
    data: { levels: { gamma: 3 } },
    expected: true,
  },
  {
    name: "and of two bounds",
    rule: { and: [{ ">=": [{ var: "a" }, 1] }, { "<": [{ var: "b" }, 10] }] },
    data: { a: 2, b: 4 },
    expected: true,
  },
  {
    name: "some element >= threshold",
    rule: { some: [{ var: "vals" }, { ">=": [{ var: "" }, 5] }] },
    data: { vals: [1, 6, 3] },
    expected: true,
  },
  {
    name: "some element fails threshold",
    rule: { some: [{ var: "vals" }, { ">=": [{ var: "" }, 5] }] },
    data: { vals: [1, 2, 3] },
    expected: false,
  },
  {
    name: "some over an empty collection",
    rule: { some: [{ var: "vals" }, { ">=": [{ var: "" }, 5] }] },
    data: { vals: [] },
    expected: false,
  },
  { name: "or short-circuits to true", rule: { or: [false, true] }, data: {}, expected: true },
  { name: "or of two false", rule: { or: [false, false] }, data: {}, expected: false },
  {
    name: "and of two bounds, one failing",
    rule: { and: [{ ">=": [{ var: "a" }, 1] }, { "<": [{ var: "b" }, 10] }] },
    data: { a: 2, b: 40 },
    expected: false,
  },
  { name: "not", rule: { "!": [{ ">=": [{ var: "a" }, 5] }] }, data: { a: 1 }, expected: true },
  {
    name: "strict equality on strings",
    rule: { "===": [{ var: "c" }, "Cat"] },
    data: { c: "Cat" },
    expected: true,
  },
  {
    name: "strict inequality",
    rule: { "!==": [{ var: "c" }, "Cat"] },
    data: { c: "Dog" },
    expected: true,
  },
  { name: "less than", rule: { "<": [{ var: "a" }, 5] }, data: { a: 4 }, expected: true },
  {
    name: "less than or equal, boundary",
    rule: { "<=": [{ var: "a" }, 5] },
    data: { a: 5 },
    expected: true,
  },
  {
    name: "greater than, boundary is exclusive",
    rule: { ">": [{ var: "a" }, 5] },
    data: { a: 5 },
    expected: false,
  },

  // ── the cross-implementation traps. These pin behaviour a second implementation is most likely to
  //    get subtly different; they are the reason this suite exists rather than a shared library. ──
  {
    // json-logic `==` is JS loose equality: a number equals its string form. A strongly-typed impl must
    // reproduce this exactly, or agree with us to keep `==` off mixed types entirely.
    name: "TRAP: `==` is loose across types",
    rule: { "==": [1, "1"] },
    data: {},
    expected: true,
  },
  {
    name: "TRAP: `===` is strict across types",
    rule: { "===": [1, "1"] },
    data: {},
    expected: false,
  },
  {
    // A 3-argument comparison is a BETWEEN (lo < mid < hi), not two chained comparisons.
    name: "TRAP: 3-arg `<` is a between",
    rule: { "<": [1, 2, 3] },
    data: {},
    expected: true,
  },
  {
    name: "TRAP: 3-arg `<` between, upper fails",
    rule: { "<": [1, 5, 3] },
    data: {},
    expected: false,
  },
  {
    // `Boolean([])` is TRUE in JS but an empty collection is FALSY to json-logic's truthiness.
    name: "TRAP: an empty array is falsy",
    rule: { "!!": [{ var: "xs" }] },
    data: { xs: [] },
    expected: false,
  },
  {
    name: "TRAP: a non-empty array is truthy",
    rule: { "!!": [{ var: "xs" }] },
    data: { xs: [0] },
    expected: true,
  },
  {
    // An absent field must be a clean non-match — an accept gate sees arbitrary items.
    name: "missing var fails a comparison rather than erroring",
    rule: { ">=": [{ var: "nope" }, 1] },
    data: {},
    expected: false,
  },
  {
    name: "var default stands in for an absent field",
    rule: { ">=": [{ var: ["nope", 5] }, 3] },
    data: {},
    expected: true,
  },
];
