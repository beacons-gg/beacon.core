# @beaconsgg/jsonlogic-profile

A whitelisted JSONLogic profile: bounded math on integers only, which the client and the server
evaluate the same way. Objects use the profile to derive state from other objects, and rooms use the
profile to decide which items they admit.

## Status

Stable. The server and the React Native or Expo client run this package unchanged.

The package is **client-bound [C] (RN-safe)** and pure TypeScript over
[`json-logic-js`](https://github.com/jwadhams/json-logic-js) with no Node built-ins. A client can
preview the math one object applies to another with the **same engine** the server uses for
contended state, so a phone and the server always get the same answer.

## What the package does

Beacon needs one shared expression language for the math that one object applies to another. A room
derives a time window from the stats of its contents, for example, or decides whether to accept an
incoming item. Plain JSONLogic is too large for that job:

- division rounds differently across implementations;
- conditionals and iteration let a rule do almost anything;
- floats in `data` make results drift.

This package narrows JSONLogic to a **bounded profile** with a small operator whitelist, integers
only, no division and four collection aggregators. A conformance suite pins the exact outputs. The
full language is in [`doc/spec/item-properties.md`](../../../doc/spec/item-properties.md) §4.

The contract has two halves.

**Validation** (`validateRule` and `assertValidRule`) walks the rule and rejects anything outside
the profile:

- an operator off the whitelist;
- a literal that isn't a safe integer;
- a `var` path that is itself a rule;
- an `in` list that isn't an array literal;
- a rule over the depth cap or the node cap.

**Evaluation** (`evaluate` and the typed wrappers `evaluateFormula` and `evaluatePredicate`)
registers the four aggregators on the `json-logic-js` singleton and runs `apply`. Evaluation always
validates first, so the whitelist holds when a rule runs as well as when an author writes the rule.
The design notes below explain why.

## Exports

Rule and predicate shapes (`JsonLogicRule` and `AcceptPredicate`) come from
[`@beaconsgg/protocol-types`](../protocol-types).

| Purpose     | Export                             | Notes                                                                                                                                                                                                      |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation  | `validateRule(rule)`               | Checks the whole rule against the whitelist. Returns a `ValidationResult` with the first violation and its `path`.                                                                                        |
|             | `assertValidRule(rule)`            | The throwing variant, for code where a rule off the profile is a programming or policy error.                                                                                                             |
|             | `ValidationResult`                 | `{ ok; error?; path? }`                                                                                                                                                                                    |
|             | `ALLOWED_OPERATORS`                | The operator whitelist as a `ReadonlySet<string>`. The section on the whitelist below lists the operators.                                                                                                |
|             | `MAX_RULE_DEPTH`                   | The depth cap (`32`). A deeper rule fails validation.                                                                                                                                                     |
|             | `MAX_RULE_NODES`                   | The node cap (`1000`). A larger rule fails validation.                                                                                                                                                    |
| Evaluation  | `evaluate(rule, data)`             | Validates the rule and throws when the rule is off the profile. Then applies the rule and returns `unknown`.                                                                                              |
|             | `evaluateFormula(rule, data)`      | `evaluate`, then asserts a safe integer result. Returns a `number`.                                                                                                                                        |
|             | `evaluatePredicate(rule, data)`    | `evaluate`, coerced to a `boolean`.                                                                                                                                                                        |
| Aggregators | `aggregate(collection, key, kind)` | The underlying fold. Reads `levels[key]` or a flat field from each item and drops values that aren't safe integers.                                                                                       |
|             | `AggregatorKind`                   | `"sum" \| "min" \| "max" \| "count"`                                                                                                                                                                       |
| Acceptance  | `accepts(accept, item)`            | The room admission predicate. `class` matches any listed class. `tags` matches an item that shares a value under any listed key. An **empty value list is a wildcard** that matches any item with that key, as in `{ animal: [] }`. `minLevels` must all hold. |
|             | `withinCapacity(count, capacity)`  | Capacity is part of the room's **state** and not of the item. An `undefined` capacity has no bound.                                                                                                       |
|             | `AcceptCandidate`                  | The categorical shape an `accept` predicate matches: `class`, `tags` and `levels`.                                                                                                                        |
| Conformance | `CONFORMANCE_VECTORS`              | The `ConformanceVector[]` corpus every implementation must reproduce.                                                                                                                                     |
|             | `ConformanceVector`                | `{ name; rule; data; expected }`                                                                                                                                                                           |

## Design notes

**The whitelist.** `ALLOWED_OPERATORS` is the entire vocabulary:

- data access with `var`;
- integer arithmetic with `+`, `-` and `*`;
- scalar bounds with `min` and `max`;
- the four aggregators: `sum` and `count`, plus `min` and `max` by the shape of their arguments;
- the comparisons `==`, `!=`, `===`, `!==`, `<`, `<=`, `>` and `>=`;
- the boolean operators `and`, `or`, `!` and `!!`;
- `in`, for membership in an array literal and never for substrings;
- `some`.

Validation rejects every other operator and gives a hint for the common ones. The hint for `/` names
the rounding trap between implementations. Validation covers the _whole_ tree, including the `var`
**path**. The path must be a literal string or an integer index and never a rule, so nobody can hide
a forbidden operator in the path.

**Integers only, no division.** The profile has no `/`, no `%` and no `avg`. The integer guard holds
at **two** points. When an author writes a rule, `validateRule` rejects any literal that isn't a
safe integer. At run time the aggregators drop floats, `NaN`, numeric strings and any other input
that isn't a safe integer. `evaluateFormula` also **throws** if the final result isn't a safe
integer. A float that slips in through `data` therefore can't make a phone and the server disagree
on a formula's answer.

**The four aggregators, by key.** `sum`, `min`, `max` and `count` are the only ways to fold over a
collection. Each takes `(collection, key)` and reads `levels[key]` or a flat field from each item.
An empty collection gives `0` for all four, so a `min` over empty contents never produces
`±Infinity`. `min` and `max` dispatch two ways. Called as `(collection, key)` they aggregate. Called
with scalars they are variadic bounds, and `{ min: [9, 3, 7] }` gives `3`.

**The whitelist holds when a rule runs, as well as when an author writes the rule.** `evaluate` runs
`validateRule` through `assertValidRule` **first**, and `evaluateFormula` and `evaluatePredicate`
inherit that gate. The order matters because `json-logic-js` handles some operators in an inline
branch that runs _before_ the lookup in its operation table. These operators are `if`, `?:`, `and`,
`or`, `map`, `reduce`, `filter`, `all`, `none` and `some`. Removing them from the table
(`EXCLUDED_NATIVE_OPS`) therefore does **nothing** for them, and only
validation can stop them. `evaluate` validates first, so an excluded inline operator such as `if` or
`map` never runs. `json-logic-js` would still run such an operator if asked. The removal from the
table stays as extra hygiene for the operators the table _does_ reach such as `/`, `%`, `cat` and
`substr`.

**The conformance suite is the spec.** `CONFORMANCE_VECTORS` is the corpus that every implementation
must reproduce. Every server's JSONLogic evaluator and its four aggregators **must** produce these
exact outputs. The vectors cover these cases:

- integer arithmetic;
- scalar bounds and clamping;
- aggregation by key;
- the results for empty collections;
- a derived time window, with `startAt` and `endAt` shifted by the contents' stats;
- the predicate operators.

The stat keys (`alpha`, `beta` and `gamma`) and the class (`Widget`) are placeholders. The profile
gives no key a meaning, so the spec doesn't either. The test suite checks that each vector's rule is
inside the profile (`validateRule(rule).ok`) and that `evaluate` returns `expected`. A new
implementation conforms exactly when it passes this corpus.

## Scripts

```bash
pnpm --filter @beaconsgg/jsonlogic-profile build       # tsc -> dist
pnpm --filter @beaconsgg/jsonlogic-profile typecheck   # tsc --noEmit
pnpm --filter @beaconsgg/jsonlogic-profile test        # vitest (incl. conformance vectors)
```
