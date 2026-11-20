import type { JsonLogicRule } from "@beaconsgg/protocol-types";
import * as jsonLogic from "json-logic-js";
import { ensureOperations } from "./operations";
import { assertValidRule } from "./profile";

type ApplyRule = Parameters<typeof jsonLogic.apply>[0];

/**
 * Evaluate a profile rule against `data`. The whitelist is enforced HERE: every rule is run
 * through `validateRule` first (throwing on any off-profile operator), so a caller can't reach
 * an inline-handled op like `if`/`map`/`reduce` even though json-logic-js still knows them.
 * `evaluateFormula` / `evaluatePredicate` inherit this gate.
 */
export function evaluate(rule: JsonLogicRule, data: unknown): unknown {
  ensureOperations();
  assertValidRule(rule);
  return jsonLogic.apply(rule as ApplyRule, data);
}

/**
 * Evaluate a formula and assert the result is a safe integer — the integer guard at
 * evaluation time (catches a non-integer that slips in via `data`, even though literals
 * and division are blocked at validation time).
 */
export function evaluateFormula(rule: JsonLogicRule, data: unknown): number {
  const result = evaluate(rule, data);
  if (typeof result !== "number" || !Number.isSafeInteger(result)) {
    throw new Error(`formula did not produce a safe integer: ${String(result)}`);
  }
  return result;
}

/** Evaluate a predicate, coercing the result to boolean. */
export function evaluatePredicate(rule: JsonLogicRule, data: unknown): boolean {
  return Boolean(evaluate(rule, data));
}
