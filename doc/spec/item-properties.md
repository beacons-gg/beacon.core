# Item properties and formulas

How a game's items carry properties and how those properties change rooms, scouts and other items.
This spec defines the property model and the bounded JSONLogic profile that formulas use. The spec
also covers the three places a formula runs and the `accept` predicate a room checks. `@beaconsgg/jsonlogic-profile`
implements the profile and `@beaconsgg/protocol-types` holds the wire shapes.

Checked against Beacon 0.3.

The examples use a placeholder game whose items carry three levels: `alpha`, `beta` and `gamma`.
Beacon gives level names no meaning. Each game picks its own.

## 1. Goals

The property model is built to these goals:

1. **One contract for client and server.** The same property model and formula language run on the
   client for gameplay and display, and on the server for contended room state. Where both sides
   evaluate the same formula they agree.
2. **Bounded and safe.** The server evaluates formulas. The language is therefore small and total, and not
   Turing-complete. A formula has no loops and runs no arbitrary code (§4).
3. **The same answer on every server.** Servers can be written in different languages. The same
   formula JSON must evaluate to the same number in each. Integers only, no division and a shared
   set of conformance vectors make that hold (§4.4).
4. **Game-agnostic.** The model defines structure: keyed levels, formulas and predicates. What a
   level or a tag means is game content that the platform never reads.

## 2. The item property model

An item carries three kinds of property, each with its own job:

| Kind                    | Shape                              | Used for                                    | Evaluated by                |
| ----------------------- | ---------------------------------- | ------------------------------------------- | --------------------------- |
| Levels                  | `key → integer`                    | numeric math: how objects change each other | formulas (§4)               |
| Classification and tags | `class` and `tags: key → values[]` | categorical matching: what a room accepts   | the `accept` predicate (§6) |
| Descriptive             | media, names and labels            | display only                                | nothing                     |

Levels are safe integers (`levelsSchema`): whole numbers within ±2^53.

### 2.1 Item anatomy

An item that enters a room's shared state is an opaque item (`opaqueItemSchema`). The server stores
the item and never reads the game's part of it:

```jsonc
{
  // immutable and signed by the minter
  "unique": "01J…", // the dedupe key
  "birth": { "kind": "stone", "alpha": 4, "beta": 3, "gamma": 2 }, // the game's own fields
  "mintedBy": { "id": "did:key:…", "sig": "…" }, // over { ...birth, unique, minter }

  // mutable and trusted
  "owner": "did:key:…", // custody, managed by the room engine
  "state": { "alpha": 5 }, // the game's mutable fields

  // what the server reads to match and to aggregate
  "match": { "class": "Stone", "tags": { "color": ["gray"] }, "levels": { "alpha": 5, "beta": 3 } },
}
```

- **`birth`** is the game's private, immutable object. The minter signs it with `unique`
  ([identity §5.1](identity.md#51-what-gets-signed)). `birth` must not carry the reserved keys
  `unique` or `minter`.
- **`state`** is mutable game data that the room trusts.
- **`match`** is a projection the game declares for the server: a `class`, `tags` and `levels`. The
  `accept` predicate reads `match` (§6), and the aggregators read `match.levels` (§4.3). The
  projection is unsigned and self-declared. A room's checks keep shared state consistent and are no
  defense against a dishonest client.
- The engine reads `unique` for dedupe, `owner` for custody and `match`. The engine also checks
  `mintedBy` against `birth` and `unique`. The engine never interprets `birth` or `state`.

**Effects belong to the host.** An item stores what it is and never what it does to a particular
room or scout. A room or scout that holds the item computes the effect from the item's levels with
its own formula or code. Balance therefore stays with the host. One room can weigh `alpha` heavily
and another can ignore it, and the signed item stays a plain description.

A game may need math the profile can't express, such as a curve. The client then computes the value
and ships it as an extra key in `match.levels`. The server sums that integer like any other level
and never interprets it.

## 3. Immutable and mutable

- **Immutable and signed:** `unique`, `birth` and `mintedBy`. These are set when the item is minted
  and anyone can verify them.
- **Mutable and trusted:** `owner`, `state` and `match`. These change through ops. Beacon doesn't
  defend them against cheating ([identity §3](identity.md#3-trust-model-two-axes)).

Math that reads `birth` can be reproduced from the signed item. Math that reads `state` or `match`
trusts whoever holds the item.

## 4. The formula language

Formulas and predicates are [JSONLogic](https://jsonlogic.com): rules written as a JSON syntax tree,
made to share logic as data between a client and a server. JSONLogic already has mature libraries
in the common server languages, so every Beacon server can reuse a library and add the four
aggregators. A language of Beacon's own would need a new evaluator for each server language, each verified
again.

Beacon uses a small whitelisted profile of JSONLogic.

### 4.1 What a formula is

A formula computes one integer from room state: base values, aggregates of a level across a
collection and constants. A formula is total and has no side effects.

### 4.2 Expression model

```jsonc
// endAt = placedAt + sum(contents.beta), kept between placedAt and placedAt + 14 days
{
  "min": [
    {
      "max": [
        { "+": [{ "var": "placedAt" }, { "sum": [{ "var": "contents" }, "beta"] }] },
        { "var": "placedAt" },
      ],
    },
    { "+": [{ "var": "placedAt" }, 1209600] },
  ],
}
```

### 4.3 The profile

`validateRule` accepts only these operators:

| Group         | Operators                                                                               | Notes                                                              |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Data access   | `var`                                                                                   | the path is a literal string or an integer index, never a sub-rule |
| Arithmetic    | `+`, `-` and `*`                                                                        | integers only (§4.4)                                               |
| Scalar bounds | `min` and `max`                                                                         | variadic; a clamp is `min([max([x, lo]), hi])`                     |
| Aggregators   | `sum`, `count`, `min` and `max` over a collection by key                                | the four custom operations                                         |
| Predicates    | `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`, `and`, `or`, `!`, `!!`, `in` and `some` | for `when` conditions and matching                                 |

**The aggregators.** `sum`, `min` and `max` take a collection and a level key:
`{ "sum": [{ "var": "contents" }, "alpha"] }`. A level is read from the item's `levels`, then from
`match.levels` and then from a key of the same name on the item. Values that aren't safe integers
are skipped. `count` with a key counts the items whose level for that key is a safe integer. Without a key
`count` counts every item. `min` and `max` act as aggregators only when called with a collection and a key. Called any
other way they are scalar bounds.

**Empty input gives 0.** Every aggregator returns 0 for an empty collection. Scalar `min` and `max`
skip any argument that isn't a safe integer, and with none left they return 0.

**Excluded.** Division `/`, `%` and `avg` are out. Rounding is where implementations differ.
`if` and `?:` are out, because formulas stay arithmetic and branching lives in predicates. String
operators, `map`, `reduce`, `filter`, `all`, `none`, `merge`, `method` and `log` are out too.

**Shape limits.** A rule may nest at most 32 levels deep (`MAX_RULE_DEPTH`) and hold at most 1000
nodes (`MAX_RULE_NODES`). Each operator object has exactly one key. The haystack of `in` must be an
array literal. A string haystack would turn `in` into a substring test in some libraries.

`evaluate` runs `validateRule` before every evaluation, so no caller can reach an operator outside
the profile. A placement whose rules use an operator outside the profile is refused. An operator
added to the profile later is one an older server refuses, so a server lists each operator beyond
the baseline as a `rule:` capability marker
([discovery §3.2](discovery.md#32-server-descriptor)).

`+` and `*` coerce their operands to numbers, so a boolean inside arithmetic turns into `NaN`. A
condition therefore belongs in a separate predicate, such as an unlock rule's `when` (§5.2).

### 4.4 Integers only

Every value is an integer. Beacon never uses floating point in a formula:

- Integers stay within ±2^53. Implementations that compute in 64-bit floating point stay exact for
  `+`, `-` and `*`.
- The profile has no division, which removes the one place such implementations differ. A game that needs a fraction scales its data into thousandths or another unit and multiplies.
- `validateRule` refuses a literal that isn't a safe integer. `evaluateFormula` throws when a result
  isn't a safe integer, which catches a float that arrives through data.
- The conformance vectors (`CONFORMANCE_VECTORS` in `@beaconsgg/jsonlogic-profile`) are
  the interoperability contract. Every server's evaluator must produce their exact outputs.

Two implementations in different languages rarely compute the same value. Each room is recomputed
only by its own host. Clients agree with each other on client-side transforms, and those clients run
the same JavaScript library. The vectors protect interoperability rather than a hot path.

## 5. Three application points

The same language drives every case where one object changes another. Only who evaluates and when
differ:

| Interaction    | Where the rule lives                | Reads                             | Evaluated by                                  | When                             |
| -------------- | ----------------------------------- | --------------------------------- | --------------------------------------------- | -------------------------------- |
| Items to room  | the room policy's `derived`         | the room state and its `contents` | the server, since writers contend             | after each op that changes state |
| Room to items  | the room policy's `unlockTransform` | each frozen item                  | the client, since nothing contends            | at claim                         |
| Items to scout | the game's own code                 | the equipped items' levels        | the client, since the owner is the one writer | on equip or deploy               |

### 5.1 Items to room

A room policy's `derived` block holds named formulas. The server recomputes the whole block from the
full room state at placement and after every op. Ops that only append to a ledger skip the recompute. `react` is one. The formulas run in declaration order, so a
later formula can read an earlier result. A full recompute makes concurrent contributions
independent of their order, with no lost update. Clients send intent and never a computed value.

A formula reads the room state by name. The names include `contents`, `phase` and every value an
earlier formula derived. In a room whose policy has a `lifecycle`, `placedAt` is the placement time in epoch
seconds. The lifecycle names a derived key for each phase
transition, and the server fires the transition at that time. A derived key can't take the name of a key the engine owns,
such as `contents` or `phase`. The server refuses a placement that tries. A room whose
window shrinks as items arrive looks like this:

```jsonc
"derived": {
  // each unit of alpha starts the window 1800 s sooner, never before placement
  "lockAt": { "max": [ { "var": "placedAt" },
                       { "+": [ { "var": "placedAt" }, 86400,
                                { "*": [ { "sum": [ { "var": "contents" }, "alpha" ] }, -1800 ] } ] } ] },
  // each unit of beta ends the window 3600 s sooner, never before lockAt
  "unlockAt": { "max": [ { "var": "lockAt" },
                         { "+": [ { "var": "lockAt" }, 604800,
                                  { "*": [ { "sum": [ { "var": "contents" }, "beta" ] }, -3600 ] } ] } ] }
}
```

The `max` clamps keep the window from inverting. Scalar `max` drops an operand that isn't a safe
integer, so an absurd level collapses the window rather than crashing. An unclamped sum that
overflows makes the op fail as `invalid`, and the room is left unchanged.

A grant rule's `when` is a formula too. The rule applies when the result is 1 or more. The profile
has no booleans, so a condition is clamped arithmetic: `max(0, 1 - deficit)` is 1 exactly when the
deficit is 0.

### 5.2 Room to items: the unlock transform

A room may carry an `unlockTransform`: an ordered list of rules that a client applies to each item
it claims. The server validates and stores the list and never evaluates it.

```jsonc
"unlockTransform": [
  // every claimed item gains 1 gamma
  { "set": { "gamma": { "+": [ { "var": "gamma" }, 1 ] } } },
  // an item with alpha 5 or more also gains 1 beta
  { "when": { ">=": [ { "var": "alpha" }, 5 ] },
    "set": { "beta": { "+": [ { "var": "beta" }, 1 ] } } }
]
```

For each rule whose `when` predicate matches the item, each formula in `set` is evaluated over the
item and replaces that level. A rule with no `when` applies to every item. Rules compose, so a
later rule sees the levels an earlier rule produced. The game decides what data a rule reads. A
typical scope is the item's levels plus its `class` and `tags`.

The transform is a rule list rather than one formula per level so that a bonus can depend on a
category. Arithmetic can't take a boolean operand (§4.3), so the condition lives in a predicate of
its own. The contents are frozen at claim, so nothing races and each client computes the same result.
A game clamps each result to its own level cap.

### 5.3 Items to scout

A scout computes its movement from the items it carries, on the same principle: the scout reads the
items' levels and owns the scaling. A scout has one writer, its owner, so nothing contends and no
formula crosses the wire. The game computes speed and range in its own code. The game is free of the
profile's limits there and may use curves or division.

The result rides in the scout's movement descriptor
([discovery §5](discovery.md#5-moving-scouts-in-a-view)). `speedKmh` is capped at 16100 km/h.

## 6. Categorical matching

Numbers use formulas and categories use predicates. A room policy carries an `accept` predicate that
the server checks before an item enters the room:

```jsonc
"accept": {
  "class": ["Stone"], // the item's class is one of these; omitted means any class
  "tags": { "color": ["gray", "white"] }, // the item matches any listed value of any listed key
  "minLevels": { "alpha": 1 }, // the item meets every listed minimum
  "capacity": 10 // the room holds fewer than this many items before the add
}
```

`accepts` reads the item's `match` projection:

| Check       | Passes when                                                                 |
| ----------- | --------------------------------------------------------------------------- |
| `class`     | the item's `class` is in the list, or the list is absent or empty           |
| `tags`      | the item has at least one listed value for at least one listed key          |
| `minLevels` | every listed level is at least its minimum, and a missing level counts as 0 |
| `capacity`  | the room's item count is below `capacity` (`withinCapacity`)                |

A key mapped to an empty list in `tags` is a wildcard: the item needs at least one value for that
key. These
are cheap set and threshold tests, so the server enforces them. They protect the integrity of shared
rooms and are no defense against a dishonest client.

## 7. Worked example

A room in the placeholder game has a base window that starts 1 day after placement and lasts 7 days.
The room accepts gray stones. The room's `derived` block is the one in §5.1, and its `unlockTransform` is the one in §5.2.

1. Player A contributes a stone whose `match.levels` are `{ alpha: 2, beta: 24, gamma: 3 }`. The
   server checks `accept` and adds the stone. The server then moves `lockAt` 1 hour sooner (2 × 1800 s) and shortens the window
   between `lockAt` and `unlockAt` by 1 day (24 × 3600 s).
2. Player B contributes `{ alpha: 5, beta: 24, gamma: 1 }`. `lockAt` moves 2.5 hours sooner and the
   window shrinks by another day. The sums don't depend on which contribution arrived first.
3. The server clock passes `lockAt` and the room locks. At `unlockAt` the room unlocks and the
   contents are frozen.
4. Each player claims, and the client applies `unlockTransform` to the claimed items. Every item
   gains 1 `gamma`. Player B's stone also gains 1 `beta`, because its `alpha` is 5.
5. The room's policy sets `onEmpty: "close"`, so the room closes once every contributor has
   claimed or its claim window ends. A room without that setting stays open.

Every number is an integer. Every client computes the same `lockAt` and `unlockAt` as the server,
and every client applies the same frozen transform.

## 8. Who evaluates what

| Evaluated on the server                            | Evaluated on the client                     |
| -------------------------------------------------- | ------------------------------------------- |
| a room's `derived` block, after each change (§5.1) | a room's `unlockTransform`, at claim (§5.2) |
| `accept` predicates, before an item enters (§6)    | a scout's movement math (§5.3)              |
| grant `when` conditions (§5.1)                     | all display and preview math                |
| phase transitions at the derived times             |                                             |

The rule of thumb is that contended state the server is authoritative for runs on the server.
Everything else runs on the client. Both sides use the same schema, so their results match.
