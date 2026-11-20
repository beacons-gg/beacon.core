// Internal to the package: the index does not re-export this module. The json-logic-js wiring
// behind `evaluate`, which changes the library's process-wide operation table. json-logic-js
// evaluates an operation's arguments before calling it, so the operations receive resolved values
// (the array from `{var:"contents"}` and the key string). `min` and `max` double as scalar bounds
// and aggregate only when called as `(collection, key)`.
import * as jsonLogic from "json-logic-js";
import { aggregate } from "./aggregators";

/** The json-logic-js operation for `sum`. */
function sumOp(...args: unknown[]): number {
  const [collection, key] = args;
  if (!Array.isArray(collection) || typeof key !== "string") return 0;
  return aggregate(collection, key, "sum");
}

/** The json-logic-js operation for `count`. */
function countOp(...args: unknown[]): number {
  const [collection, key] = args;
  if (!Array.isArray(collection)) return 0;
  if (typeof key !== "string") return collection.length;
  return aggregate(collection, key, "count");
}

function scalarMinMax(args: unknown[], kind: "min" | "max"): number {
  // Integers only: drop non-safe-integer args (no string coercion). Empty -> 0 (the
  // documented identity), so `{min:[]}` is 0, never ±Infinity.
  const ints = args.filter((a): a is number => Number.isSafeInteger(a));
  if (ints.length === 0) return 0;
  return kind === "min" ? Math.min(...ints) : Math.max(...ints);
}

/** The json-logic-js operation for `min`. */
function minOp(...args: unknown[]): number {
  if (args.length === 2 && Array.isArray(args[0]) && typeof args[1] === "string") {
    return aggregate(args[0], args[1], "min");
  }
  return scalarMinMax(args, "min");
}

/** The json-logic-js operation for `max`. */
function maxOp(...args: unknown[]): number {
  if (args.length === 2 && Array.isArray(args[0]) && typeof args[1] === "string") {
    return aggregate(args[0], args[1], "max");
  }
  return scalarMinMax(args, "max");
}

/**
 * Native json-logic-js ops outside the profile, removed from the operation table as a
 * best-effort hygiene measure. NOTE: this is *not* the whitelist boundary. json-logic-js
 * handles `if`/`?:`/`and`/`or`/`map`/`reduce`/`filter`/`all`/`none`/`some` via an inline branch
 * that runs *before* the table lookup, so removing them is a no-op for those. The authoritative
 * whitelist is `validateRule`, which `evaluate` runs first (`evaluate.ts`).
 */
const EXCLUDED_NATIVE_OPS = [
  "/",
  "%",
  "if",
  "?:",
  "cat",
  "substr",
  "log",
  "method",
  "map",
  "reduce",
  "filter",
  "all",
  "none",
  "merge",
  "missing",
  "missing_some",
];

let operationsRegistered = false;

/**
 * Configure the json-logic-js singleton (idempotent): register the 4 aggregators
 * (`min`/`max` dual-dispatch as scalar bounds OR aggregator-by-key) and best-effort-remove the
 * native ops outside the profile. The actual whitelist is enforced by `validateRule` (run by
 * `evaluate`), not by this removal (see `EXCLUDED_NATIVE_OPS`).
 */
export function ensureOperations(): void {
  if (operationsRegistered) return;
  jsonLogic.add_operation("sum", sumOp);
  jsonLogic.add_operation("count", countOp);
  jsonLogic.add_operation("min", minOp);
  jsonLogic.add_operation("max", maxOp);
  for (const op of EXCLUDED_NATIVE_OPS) jsonLogic.rm_operation(op);
  operationsRegistered = true;
}
