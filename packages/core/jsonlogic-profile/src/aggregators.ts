/**
 * The 4 custom aggregators (`doc/spec/item-properties.md` §4.3): `sum` / `min` / `max` / `count`
 * over a collection, by level key. The json-logic-js operations that call them are in
 * `operations.ts`.
 */

/**
 * Read a numeric level for `key` from a collection item. A game's own item model exposes stats at
 * `levels[key]`; an **opaque item** (its game payload is private) exposes them via its
 * `match.levels` projection — the same generic projection the accept gate reads, so a derived
 * aggregate over opaque `contents` stays readable without the engine interpreting the payload.
 * Falls back to a flat `item[key]`.
 */
function levelValue(item: unknown, key: string): unknown {
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    const levels = obj["levels"];
    if (typeof levels === "object" && levels !== null && key in levels) {
      return (levels as Record<string, unknown>)[key];
    }
    const match = obj["match"];
    if (typeof match === "object" && match !== null) {
      const matchLevels = (match as Record<string, unknown>)["levels"];
      if (typeof matchLevels === "object" && matchLevels !== null && key in matchLevels) {
        return (matchLevels as Record<string, unknown>)[key];
      }
    }
    if (key in obj) return obj[key];
  }
  return undefined;
}

function numericValues(collection: readonly unknown[], key: string): number[] {
  const out: number[] = [];
  for (const item of collection) {
    const value = levelValue(item, key);
    // Integer-only contract (`doc/spec/item-properties.md` §4.4): non-safe-integer values
    // (floats, NaN, numeric strings) are ignored so a float in `data` can't make the
    // result diverge across implementations.
    if (Number.isSafeInteger(value)) out.push(value as number);
  }
  return out;
}

export type AggregatorKind = "sum" | "min" | "max" | "count";

/** Aggregate `key` across `collection`. Empty-collection identities: all -> 0 (§4.3). */
export function aggregate(
  collection: readonly unknown[],
  key: string,
  kind: AggregatorKind,
): number {
  const values = numericValues(collection, key);
  switch (kind) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "count":
      return values.length;
    case "min":
      // Empty -> 0: the additive identity for the common `+ min(...)` usage.
      return values.length > 0 ? Math.min(...values) : 0;
    case "max":
      return values.length > 0 ? Math.max(...values) : 0;
  }
}
