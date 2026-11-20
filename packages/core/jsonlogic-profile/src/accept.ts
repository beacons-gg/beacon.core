import type { AcceptPredicate } from "@beaconsgg/protocol-types";

/** The categorical fields an `accept` predicate matches against (an item's `match` projection). */
export interface AcceptCandidate {
  class?: string;
  tags?: Record<string, readonly string[]>;
  levels?: Record<string, number>;
}

/**
 * Room admission (`doc/spec/item-properties.md` §6):
 *   - `class`     — item's class ∈ listed classes (OR; omitted list = any);
 *   - `tags`      — item shares ANY value for ANY listed key (OR across keys). A key mapped
 *                   to an **empty list** is a wildcard: the item need only *have* that key (any value) —
 *                   e.g. `{ animal: [] }` accepts any animal-tagged item;
 *   - `minLevels` — item meets ALL listed minimums (AND).
 *
 * Capacity is a property of *room state*, not the item — checked via `withinCapacity`.
 */
export function accepts(accept: AcceptPredicate, item: AcceptCandidate): boolean {
  if (accept.class && accept.class.length > 0) {
    if (item.class === undefined || !accept.class.includes(item.class)) return false;
  }

  if (accept.tags && Object.keys(accept.tags).length > 0) {
    const itemTags = item.tags ?? {};
    let matched = false;
    for (const [key, wanted] of Object.entries(accept.tags)) {
      const have = itemTags[key];
      if (!have || have.length === 0) continue;
      // An empty `wanted` list is a wildcard — the item merely having the key (with any value) matches.
      if (wanted.length === 0 || wanted.some((w) => have.includes(w))) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  if (accept.minLevels) {
    const levels = item.levels ?? {};
    for (const [key, min] of Object.entries(accept.minLevels)) {
      if ((levels[key] ?? 0) < min) return false;
    }
  }

  return true;
}

/** Capacity check (`doc/spec/item-properties.md` §6) — a property of room state. */
export function withinCapacity(currentCount: number, capacity: number | undefined): boolean {
  if (capacity === undefined) return true;
  return currentCount < capacity;
}
