/**
 * The bounded JSONLogic profile (`doc/spec/item-properties.md` §4 / beacon.server
 * `doc/spec/room-operation.md` §8.3): a whitelist of native ops + our 4 aggregators, integers only,
 * no division.
 *
 * Validation enforces two things the server relies on:
 *   - **whitelist** — reject any operator outside the profile (no `/`, `if`, string ops, iteration);
 *   - **integer guard** — reject non-integer / unsafe numeric literals at authoring time.
 *
 * The whitelist is platform vocabulary, like the room ops: placement refuses an operator outside
 * it, so an operator added here is one an older server refuses. The server advertises each one
 * beyond `BASELINE_RULE_OPERATORS` as a `rule:` marker (`markers.ts` in
 * `@beaconsgg/protocol-types`), and a symbolic operator needs a name in `RULE_OPERATOR_NAMES` before a
 * test lets it ship.
 */

export const ALLOWED_OPERATORS: ReadonlySet<string> = new Set([
  // data access
  "var",
  // arithmetic (integer only). FOOTGUN: `+`/`*` parseFloat their operands, so an inlined boolean → NaN;
  // put a conditional bonus in a `when` predicate, never inline it into arithmetic.
  "+",
  "-",
  "*",
  // scalar bounds (variadic) — also serve as aggregators by argument shape
  "min",
  "max",
  // aggregators (collection × key -> int)
  "sum",
  "count",
  // predicate / boolean (`doc/spec/item-properties.md` §6)
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "and",
  "or",
  "!",
  "!!",
  "in",
  "some",
]);

/** Common excluded operators, with a human hint for better error messages (§4.3). */
const EXCLUDED_HINTS: Record<string, string> = {
  "/": "division — the cross-impl rounding trap (§4.4)",
  "%": "modulo is excluded",
  avg: "average implies division",
  if: "conditionals live in predicates, not formulas",
  "?:": "conditionals live in predicates, not formulas",
  cat: "string ops are excluded",
  substr: "string ops are excluded",
  map: "iteration is excluded",
  reduce: "iteration is excluded",
  filter: "iteration is excluded",
  all: "use `some` only",
  none: "use `some` only",
  merge: "excluded",
  method: "excluded",
  log: "excluded",
};

export interface ValidationResult {
  ok: boolean;
  /** Human-readable description of the first violation (absent when ok). */
  error?: string;
  /** JSON-path-ish location of the violation (absent when ok). */
  path?: string;
}

const OK: ValidationResult = { ok: true };

/** Bounds on rule shape — a deeply nested / huge rule must fail validation, not crash the evaluator. */
export const MAX_RULE_DEPTH = 32;
export const MAX_RULE_NODES = 1000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(error: string, path: string): ValidationResult {
  return { ok: false, error, path };
}

function isValidVarPath(value: unknown): boolean {
  // A `var` path is a literal data path: a string, or an integer array index. Never a sub-rule.
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

/** Validate that a rule uses only profile operators + integer literals. Returns the first violation. */
export function validateRule(rule: unknown): ValidationResult {
  return walk(rule, "$", 0, { nodes: 0 });
}

/** Throwing variant — for where an invalid rule is a programming/policy error. */
export function assertValidRule(rule: unknown): void {
  const result = validateRule(rule);
  if (!result.ok) {
    throw new Error(`Invalid JSONLogic at ${result.path}: ${result.error}`);
  }
}

interface NodeCounter {
  nodes: number;
}

function walk(node: unknown, path: string, depth: number, counter: NodeCounter): ValidationResult {
  if (depth > MAX_RULE_DEPTH) return fail(`rule nesting exceeds ${MAX_RULE_DEPTH}`, path);
  if (++counter.nodes > MAX_RULE_NODES) return fail(`rule exceeds ${MAX_RULE_NODES} nodes`, path);

  if (node === null) return OK;
  const t = typeof node;

  if (t === "number") {
    const n = node as number;
    if (!Number.isInteger(n) || !Number.isSafeInteger(n)) {
      return fail(`non-integer / unsafe numeric literal: ${n}`, path);
    }
    return OK;
  }
  if (t === "string" || t === "boolean") return OK;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = walk(node[i], `${path}[${i}]`, depth + 1, counter);
      if (!r.ok) return r;
    }
    return OK;
  }

  if (isPlainObject(node)) {
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      return fail(`rule must be a single-operator object (got ${keys.length} keys)`, path);
    }
    const op = keys[0] as string;
    if (!ALLOWED_OPERATORS.has(op)) {
      const hint = Object.hasOwn(EXCLUDED_HINTS, op) ? EXCLUDED_HINTS[op] : undefined;
      return fail(`operator not allowed: "${op}"${hint ? ` — ${hint}` : ""}`, path);
    }

    const args = node[op];

    if (op === "var") {
      // `var` resolves a literal data path; the path itself must never be a sub-rule
      // (otherwise a forbidden op smuggled into the path escapes the whitelist).
      const pathArg = Array.isArray(args) ? args[0] : args;
      if (!isValidVarPath(pathArg)) {
        return fail("`var` path must be a literal string or integer index", `${path}.var[0]`);
      }
      if (Array.isArray(args)) {
        if (args.length > 2) return fail("`var` takes at most [path, default]", `${path}.var`);
        if (args.length === 2) return walk(args[1], `${path}.var[1]`, depth + 1, counter);
      }
      return OK;
    }

    if (op === "in") {
      // Pin membership semantics: json-logic-js `in` is `indexOf`, so a string 2nd operand
      // means *substring* matching (a cross-impl trap). Require an array-literal haystack.
      if (!Array.isArray(args) || args.length !== 2) {
        return fail("`in` takes [needle, haystack]", `${path}.in`);
      }
      if (!Array.isArray(args[1])) {
        return fail("`in` haystack must be an array literal (no substring `in`)", `${path}.in[1]`);
      }
    }

    return walk(args, `${path}.${op}`, depth + 1, counter);
  }

  return fail(`unsupported node type: ${t}`, path);
}
