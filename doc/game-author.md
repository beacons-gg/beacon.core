# Building a game on Beacon

This page says what the platform guarantees and what your game has to supply. The page is for
someone building a game against a Beacon server and the `@beaconsgg/*` core packages without reading
another game's source. Nothing below depends on any one game.

The core packages are published under the `@beaconsgg` scope.
[Section 9](#9-versioning-and-compatibility) says what the packages promise from `1.0.0`, and
[section 11](#11-your-repository) says how a game installs them.

## 1. The model

A Beacon server does three things for a game:

- **The server custodies rooms.** A room is a place on the map that holds signed items under a
  declarative **policy** your game writes. The server enforces the policy's bookkeeping: who may do
  what and when, capacity, atomic handoff and idempotency. The server never decides what anything
  _means_.
- **The server relays scouts.** Scouts are signed movement reports the server stores and hands to
  anyone looking at the map.
- **The server verifies identity.** Every write is signed by a device key an account has authorized.

Everything game-shaped lives in your client and in the data your client signs. The server holds your
items as **opaque payloads**. The server checks their signatures and their shape and reads only the
small projection you give it for admission (`match`). The server has no branch on your room types or
item classes.

This model rests on **radical trust**. The server enforces consistency and leaves gameplay to your
client. The server does not check that a player stands where they place a room. The server also
doesn't check that a stat was earned or that a picture shows what it claims. Your client is the game.
Players can run a modified client, so anything that must hold between players has to be expressible
as policy the server evaluates (section 3). Everything else is a matter of your client's own rules.

## 2. Rooms and the op vocabulary

### 2.1 The ops

A room answers exactly these ops. **The vocabulary is the platform's, and a game cannot add an op.**
You compose rooms from these ops and say what they mean through policy. A new op is a platform
release, advertised by the servers that have it (section 5.5). The table is `HANDLERS` in
`@beaconsgg/policy-engine`, which is the definition.

| Op           | Params             | What it does                                                                                                                                                         | Live change     |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `add`        | `{ item }`         | Put a signed item into `contents` with no owner (up for grabs). Checks capacity, provenance and `accept`.                                                            | `itemAdded`     |
| `take`       | `{ item: unique }` | Remove an item from `contents` and make the actor its owner, atomically. `gone` if someone got there first, `empty` if there is nothing.                             | `itemRemoved`   |
| `list`       | `{}`               | Return `contents`. Read-only: no version bump, no broadcast.                                                                                                         | none            |
| `contribute` | `{ item }`         | Put a signed item into `contents` that stays owned by the actor, and record the actor as a contributor. Checks capacity, `maxContributors`, provenance and `accept`. | `itemAdded`     |
| `claim`      | `{}`               | Once per contributor: return the items that actor contributed. They stay in `contents`, so every claimant sees the same frozen set.                                  | `itemClaimed`   |
| `collect`    | `{}`               | Does nothing itself. Exists to trigger `grant` rules (section 3.4), repeatably.                                                                                      | none            |
| `react`      | `{ target, kind }` | Append a small gesture to the room's `reactions` ledger. One per player per target; `target` must be an item in the room or a contributor's DID.                     | `reactionAdded` |

**Every item op names its param `item`**, whatever your game calls the thing. `add` and
`contribute` carry the whole signed item, while `take`'s `item` is the item's `unique`.

Every op also passes through the policy's gate for it (`ops.<name>`: role and phase, section 3.1)
before its handler runs. An op the policy does not name is refused `denied` ("op not permitted").

**A policy may name an op the server does not handle yet.** Placement accepts any key under `ops`.
The op is refused `denied` ("unsupported op") until a server that handles it hosts the room, and
then the op works. Rooms you place today can therefore gain a verb later. Ask before offering the
verb to a player (`acceptsOp`, section 5.5).

### 2.2 Room state

A room's `state` is one JSON object. The engine owns these keys, and your policy may not use them as
a `derived` key or a reward pool name:

| Key            | Written by                     | Holds                                                                           |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `contents`     | `add`, `take` and `contribute` | the items in the room                                                           |
| `contributors` | `contribute`                   | `{ did: [unique, ...] }`: who contributed what                                  |
| `claimed`      | `claim`                        | the DIDs that have claimed                                                      |
| `granted`      | grant rules                    | per actor, per pool: what each actor has drawn                                  |
| `reactions`    | `react`                        | the reaction ledger. Append-only; an entry outlives its target leaving the room |
| `phase`        | the lifecycle tick             | the stored phase (the clock decides the effective one, section 3.2)             |
| `placedAt`     | placement (lifecycle rooms)    | epoch seconds                                                                   |
| `settledAt`    | the tick, on the last phase    | epoch seconds; the claim window is measured from it                             |

Everything else in `state` is yours: the keys your `derived` formulas write, and the reward pools you
seed at placement.

### 2.3 Closing

A room with `onEmpty: "close"` closes by itself; any other room lives until an operator removes it.

- **Without a lifecycle** the room closes when `contents` becomes empty.
- **With a lifecycle** the room closes once the room is in its last phase and one of these holds:
  - every contributor has claimed;
  - nobody contributed;
  - nobody is still owed a grant, when the room has grant rules;
  - the claim window (`claimTtl` after `settledAt`) has ended. Whatever was not drawn is dropped.

Closing deletes the room and broadcasts `closed`. A racing op then gets `expired`.

## 3. Policy

The policy is the declarative program a room runs. The policy is signed into the room's provenance
(section 4.2), so **the policy is frozen at placement**. A later build of your game changes the rooms
that build places next and leaves rooms already on the map alone.

The policy schema is strict. A field this server does not know is refused by name ("this server does
not understand: policy.x") instead of being dropped. A value the server does not know on a closed
set (such as a new role) is refused too. Additions of either kind are advertised as `policy:` markers
(section 5.5).

The table follows `policySchema` in `@beaconsgg/protocol-types`, which is the definition.

| Field             | The server                     | Meaning                                                                                                                                                                             |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`            | carries                        | an informational tag; the engine never branches on it                                                                                                                               |
| `ops`             | **evaluates**                  | `{ opName: { role, phase?, max?, games? } }`: who may run each op, in which phase and from which other games                                                                        |
| `lifecycle`       | **evaluates**                  | `{ phases: [...], transitions: { phase: derivedKey } }`: ordered phases and what fires each                                                                                         |
| `derived`         | **evaluates**                  | `{ key: formula }`: integer values recomputed after every op, written into `state`                                                                                                  |
| `accept`          | **evaluates**                  | admission for `add` and `contribute`: `class`, `tags`, `minLevels` and `capacity`                                                                                                   |
| `maxContributors` | **evaluates**                  | how many distinct contributors `contribute` admits                                                                                                                                  |
| `grant`           | **evaluates**                  | reward handoff: one rule or a list                                                                                                                                                  |
| `onEmpty`         | **evaluates**                  | `"close"`: the room closes itself (section 2.3)                                                                                                                                     |
| `claimTtl`        | **evaluates**                  | the claim window after settling: a whole number above zero followed by `s`, `m`, `h` or `d` (`"30m"` or `"7d"`). The window is at most 10 years. Anything else is refused `invalid` |
| `unlockTransform` | validates, **never evaluates** | rules your client applies to items at claim time. The server checks them against the formula profile so a bad one cannot be placed and fanned out                                   |

### 3.1 Roles and phases

`role` is one of:

- `"public"`: anyone;
- `"owner"`: the account that placed the room;
- `"contributor"`: anyone recorded in `contributors`;
- an explicit list of account DIDs.

When `phase` is present the room must be in that phase for the op. `max` bounds an op's own ledger
(today only `react`'s), at most 500. `games` opens the op to other games (section 5.6): a list of
slugs, or `["*"]` for every game. Without `games` only your own game may run the op.

### 3.2 Lifecycle and derived values

A lifecycle room starts in `phases[0]` with `placedAt` stamped. The room is in phase _n_ once the
`derived` key named by `transitions[phases[n]]` holds a time (epoch seconds) that has passed. Phases
are checked in order. **Phases are clock-authoritative**: the op gate reads the clock and ignores the
stored phase. An op therefore cannot slip in after a boundary even if the tick that broadcasts the
boundary is late.

`derived` formulas are recomputed in declaration order after every op (so one may read an earlier
one) and at placement. The formulas are how a room's timing responds to what is in the room. **A
formula cannot see the clock.** That has two consequences:

- A deadline is a **literal epoch time** baked into the policy when you build it, or an offset from
  `placedAt`.
- To settle early when a goal is met, derive the settle time from what is still missing:
  `settleAt = min(deadline, placedAt + deficit × BIG)`. When the deficit reaches zero `settleAt`
  collapses to `placedAt`, which has already passed. The room then settles on the next tick.

**The transition horizon.** A transition may be at most 10 years after placement
(`TRANSITION_HORIZON_SEC`). A placement that schedules one later is refused `invalid`, and so is an
op that would push a transition later and past the horizon.

### 3.3 Formulas

Every rule in a policy is JSONLogic restricted to a bounded profile, `@beaconsgg/jsonlogic-profile`.
The rules are `derived`, `grant[].when` and `unlockTransform`. Client and server evaluate a rule
identically.

- **Operators**: `var`; `+ - *`; `min` and `max`; `sum` and `count`; the comparisons
  `== != === !== < <= > >=`; `and or ! !!`; `in` against an array literal; `some`. Nothing else: no
  `/`, `%`, `if`, string operations or iteration. This is the baseline, `BASELINE_RULE_OPERATORS` in
  `@beaconsgg/protocol-types`. The operator set is platform vocabulary like the ops: a new operator is
  a platform release, advertised as a `rule:` marker (section 5.5).
- **Integers only.** Literals must be safe integers, and a formula whose result is not one is an
  error. At placement that refuses the room; during an op it refuses the op `invalid`.
- **Aggregators fold over items by key**: `{"sum": [{"var": "contents"}, "weight"]}` adds up
  `match.levels.weight` across the room's contents. `count`, `min` and `max` work the same way. All
  four return `0` over an empty collection.
- **Booleans are not numbers.** `+` and `*` turn a boolean into `NaN`. A condition that pays out
  belongs in a `when` predicate and stays out of the arithmetic.

`CONFORMANCE_VECTORS` in `@beaconsgg/jsonlogic-profile` is the executable definition: an
implementation in another language is conformant when it produces every vector's expected output.

### 3.4 Grants: rewards the room hands out

A grant rule is `{ op, from, count, when? }`. When op `op` succeeds the acting player receives
`count` unowned items from the state pool named `from`. If the rule has a `when` formula, the formula
must evaluate to at least 1 over the room's state after the op. Each player draws from each pool
once. A grant never fails the op: if the condition does not pass or the pool is empty, the op
succeeds and grants nothing. Granted items come back in the op result under `granted`.

Pools are seeded at placement: `initialRewards` fills the first rule's pool, and `initialPools` fills
pools by name. Every seeded item must carry valid provenance. Several rules behind cumulative `when`
conditions make a ladder that pays each rung as it is reached, which is what `collect` is for.

## 4. Items and provenance

### 4.1 Items

Everything that enters a room is an **`OpaqueItem`**:

```ts
{
  unique: string,               // your id for it; the room's dedupe key. A ULID is the convention.
  birth: Record<string, unknown>, // your item's immutable identity, any shape. Signed.
  mintedBy: { id, sig, handle? }, // the minter's signature over it
  state?: Record<string, unknown>, // mutable, unsigned, yours
  owner?: did | null,           // custody; the engine sets it
  match?: { class?, tags?, levels? }, // what `accept` and the aggregators read
}
```

The server reads `unique`, `owner` and `match` and verifies `mintedBy` over `birth`. The server never
reads `birth` or `state`. **`match` is self-attested and unsigned.** The field is a structural gate
that keeps honest clients' items where they belong, and a modified client can set it to anything. If
a value in `match` is derived from `birth`, your client has to check that the two agree when it reads
a peer's item (section 7).

`birth` may not use the keys `unique` or `minter`.

### 4.2 Signing

Provenance is an Ed25519 signature over canonical JSON (JCS) of an object's birth fields with the
minter bound in. `@beaconsgg/identity` has the signing and verifying halves; use them rather than
reproducing the bytes.

- **An item**: `signItemProvenance({ unique, birth }, minter)` signs
  `JCS({ ...birth, unique, minter })`.
- **A room**: `signRoomProvenance({ unique, kind, policy }, minter)`, where `kind` is the room's
  `type`. This is the signature that freezes the policy: change one byte of it and the placement is
  refused.

A minter is an account's root key (`accountMinter(account)` / `walletMinter(wallet)`) or a server
key. The minter need not be the player who places the room.

`@beaconsgg/identity/conformance` exports `SIGNING_VECTORS`: fixed keys with the exact bytes and
signatures core produces. The vectors cover device authorizations, ops, items, rooms, scouts,
descriptors and profiles. An implementation in another language is compatible when it reproduces
them.

## 5. Talking to a server

`@beaconsgg/client-sdk` makes these calls for you:

- signed writes with the same-nonce retry;
- the reads;
- the live channel with its reconnects;
- descriptor verification and server choice;
- key custody.

You hand the SDK the platform pieces: the socket.io `io`, a key store and `fetch` if you want your
own. The SDK therefore runs in React Native and the browser alike. The SDK's README shows the calls.
The rest of this section describes the wire the SDK speaks, for a game that makes the calls itself
or wants to know what the SDK does. Either way the other core packages give you:

- the schemas (`@beaconsgg/protocol-types`);
- signing and verification (`@beaconsgg/identity`);
- the formula engine (`@beaconsgg/jsonlogic-profile`);
- geohash coverage (`@beaconsgg/geo`).

### 5.1 Identity and the op envelope

A player is an **account** (a root key and its `did:key`) with one or more **devices**, each
authorized by the root. Every write is an envelope signed by a device:

```ts
signOpWithWallet(wallet, { op, room?, nonce, params, baseVersion?, game? }) // → OpEnvelope
```

- `nonce` is a fresh ULID per op. **Retry with the same nonce**: the server records each op's result
  under its nonce, so a retry after a lost reply returns the original result rather than applying the
  op twice. A stable refusal is recorded too, so a corrected op needs a new nonce.
- `issuedAt` must be within 5 minutes of the server's clock in either direction.
- The optional `baseVersion` refuses the op `stale` if the room has changed since that version.
- `game` is your game's slug, and **every write must carry it** (section 5.6). The client SDK
  attaches it to everything it signs when you pass `game` to `createClient`.

### 5.2 Routes

| Route                                    | Body / query                                         | Returns                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /rooms`                            | an envelope with `op: "place"`, params below         | `{ ok, id, version, room }`. Idempotent by nonce and by id; `conflict` (409) if another account placed that id |
| `POST /rooms/:id/ops`                    | an envelope naming the op and `room: id`             | `{ ok: true, version, result? }` or an error                                                                   |
| `GET /rooms/:id?games=…`                 | optional games filter                                | the `Room`, or `unknownRoom` (404) when no listed game owns it or may act on it                                |
| `GET /discovery?cells=…&types=…&games=…` | geohash cells in view; optional room types and games | `{ coveredBy, rooms, scouts }`                                                                                 |
| `POST /scouts`                           | an envelope with `op: "report"` or `"cancel"`        | `{ ok: true, id? }` or an error (section 6.2)                                                                  |
| `GET /server/descriptor`                 |                                                      | the signed `ServerDescriptor`                                                                                  |

**Place params** (`placeParamsSchema`) are `type`, `unique`, `mintedBy`, `location` and `policy`. The
optional ones are `name`, `media`, `initialContents`, `initialRewards` and `initialPools`. `unique`
is a ULID, and the room id becomes `unique@host`. `mintedBy` is the room's signature.

`cells` is a comma-separated list of geohashes. `types` keeps only rooms whose `type` is listed and
keeps scouts only when the list includes `scout` or `types` is absent. `games` keeps only rooms those
games own or may act on, and only their scouts (section 5.6). The SDK's
`discoverCells(server, cells, { rooms, scouts, games })` builds `types` from your room types and a
required `scouts`, so you always choose whether scouts come back. The reply holds the whole set at
once.

**A room in a discovery response** is `{ id, type, location, game, summary, mintedBy?, live? }`. The
`summary` holds:

- `count`;
- `capacity` when the policy sets one;
- `phase` for a lifecycle room;
- one thumbnail from the room's `media`.

Nothing else about a room is public without resolving the room.

### 5.3 Results

A refused op answers `{ ok: false, error, message? }` with a status:

| Status | Codes                                                                           |
| ------ | ------------------------------------------------------------------------------- |
| 400    | `invalid` and `clockSkew`                                                       |
| 401    | `badsig`                                                                        |
| 403    | `denied`, `gameNotAdmitted`, `gameNotAccepted`, `deviceRevoked` and `notMember` |
| 404    | `unknownRoom` and `expired`                                                     |
| 409    | `phase`, `full`, `gone`, `empty`, `locked` and `stale`                          |
| 429    | `rateLimited`                                                                   |

`notMember` comes from a server whose `accessLevel` is `request` or `private`, to a player who is not
a member. Stop offering that server for writes. On a `request` server, offer the player a way to ask to join
with `client.requestAccess`. Publish their profile there first so the operator can see who is
asking. `client.fetchAccess` reads where the player stands. Reads stay open at every level.

Every request shape is strict at every depth. On these requests an `invalid` whose only problem is
unknown keys carries those keys as `fields`, each with its path (`["item.tint"]`):

- a room op;
- a placement;
- a scout report or cancel;
- a place proposal;
- the signed envelope of any route.

A `fields` answer means your build is newer than the server. That answer differs from the one for a
malformed request. A value the server does not know on a closed set gets no `fields`, because the
server cannot tell such a value from a bug.

Codes added after the baseline are sent only to a client that declares in the
`beacon-understands` request header that it reads them (`code:deviceRevoked`). Those codes are `deviceRevoked`,
`clockSkew`, `gameNotAccepted` and `notMember`. Any other client gets the baseline code it already handles, at
the same status. The 404s that name what is missing work the same way: `unknownPlace`,
`unknownMedia`, `unknownProposal`, `unknownRun` and `noAbout` reach a client that declares them. Any
other client gets `unknownRoute` at the same 404.

The client SDK follows one rule for errors. Every call except a best-effort one throws a fault and
never returns it, so whatever such a call returns is the server's own answer. The best-effort calls
are `fetchProfile`, `fetchBestProfile`, `pingServer` and `addServer`.

- A fault is any of these: a `5xx`, a timeout, a lost connection or a reply the server did not
  send. `isFault(err)` is `true` for its error: a `ServerError`, `RequestTimeoutError` or
  `NetworkError`. A fault says nothing about the room or the player. Try again later or ask another
  server, and never delete anything on a fault.
- A refusal is the server's own `{ ok: false, error }` body. A call returns the refusal where its
  result has a place for one: `ok: false` in a result that has `ok`, the probe's `unknown` or `null`
  from a read for something that is not there. Every other call throws the refusal as an `ApiError`
  with the `code`, and `isRefusal(err)` is `true`.
- A lock is the one refusal every call throws. An operator can lock a server read-only for a
  while, such as for a restore. Every write then answers `503` with
  `{ ok: false, error: "writeLocked" }` and a `Retry-After` header in seconds. The SDK throws an
  `ApiError` with the code `writeLocked` and `retryAfterSec` set from the header. Tell the player the
  server is read-only and try again later.

`sendOpWithRetry` retries only a fault. The waits are about 0.5 seconds and then 1.5 seconds, and a
lock throws at once. Pass `{ attempts, delayMs }` as its last argument to change the retries, such as
`{ delayMs: 0 }` in a test.

A Beacon route that answers 404 sends an `{ ok: false, error }` body such as `unknownRoom` or
`unknownRoute`. Only that 404 says something is absent. A reverse proxy in front of a server sends a
404 of its own for a few seconds while the server restarts, such as Traefik's plain-text
`404 page not found`. That reply says nothing about the room, so the SDK throws it as a fault: a
`ServerError` whose `status` is 404. `resolveRoom` returns `null` only for the server's
`unknownRoom`, and the location reads only for its `unknownRoute`. Each throws any other refusal,
such as `rateLimited`. A 2xx reply they cannot read is a fault too, so `null` is always the
server's own answer. A captive portal's page is one such reply, and so are a location read's JSON of
the wrong shape and a room that is not a JSON object. `discoverCells` throws a refused query, such
as too many cells or an unknown game. Delete a saved room only on `null`, and never on a throw.

### 5.4 Live updates

A socket.io connection carries **server-to-client events only**; every write goes over REST. Name
your game in the handshake with `auth: { game }`, which the SDK sends for you. The map channel then
carries only your game's scouts and the rooms your game owns or may act on. A room subscription is
by an id you already chose, so the server does not filter it.

- **A room**: emit `subscribe` with `{ room: id }` and receive ordered `delta` events,
  `{ room, version, change }`. Fold a change at or above your view's version. A version jump or a
  change type you do not know means you missed something: re-read the room over REST.
- **The map**: emit `setCells` with `{ cells: [...] }` to watch up to 256 cells. Each call replaces
  the previous set. You receive `map` events tagged with their cell: `room`, `roomGone`, `scout` and
  `scoutGone`.

The SDK's `subscribeRoom` and `subscribeMailbox` return a handle for that one subscription. Call its
`disconnect()` to end the subscription, and read `connected` to see whether its socket is up. Rely on
only those two members: a later release may share one socket between the subscriptions to a server,
and `disconnect()` then still ends only the one subscription.

### 5.5 What a server supports

`GET /server/descriptor` returns a document the server signs with its own key. Verify it with
`verifyDescriptor` over the raw body before trusting anything in it, then read it with
`serverDescriptorReadSchema`. The descriptor's `capabilities` list carries two kinds of entry:

- **Services** an operator turned on: `mailbox`, `media`, `geocode`, `places` and
  `places-proposals`. `serviceCapabilities` returns only these.
- **Protocol markers** stating what this build accepts:
  - `game:<slug>`: the only games this server admits; none means it admits every game. A server
    that does not list yours refuses your writes `gameNotAdmitted`.
  - Additions **beyond the baseline**: `op:<name>` for an op, `policy:<feature>` for a policy
    feature and `rule:<name>` for a rule operator. The baseline is implied and never listed, so a
    server that says nothing accepts all of the baseline. The baseline is the ops in section 2.1,
    every policy field and value in section 3 and the operators in section 3.3. A rule operator
    that is a word names itself (`rule:if`); a symbol takes a word from `RULE_OPERATOR_NAMES`
    (`rule:mod` for `%`).

Ask before you rely on an addition:

- `acceptsOp(capabilities, "someOp")` before offering a verb a later build added;
- `unsupportedPolicyFeatures(capabilities, policy)` before placing a policy. The function names every
  addition the policy uses that the server has not advertised. A feature is named by its path
  (`onEmpty.archive`) and a rule operator by its marker (`rule:if`). The function returns `[]` when
  the server takes all of the policy. A `rule:` marker speaks for the server only. Your client
  evaluates every `unlockTransform` and any `derived` or `grant.when` it computes itself. An operator
  in such a rule also needs every build of your game that may evaluate the rule to know the
  operator.

**Reading what a server sends.** Parse a shape with its read twin where `@beaconsgg/protocol-types`
has one. The twins are `serverDescriptorReadSchema`, `discoveryResponseReadSchema`,
`profileDocReadSchema` and the places reads. A twin ignores fields your build does not know. The
strict schema is what a server _accepts_, and reading with it would break your app the day a server
adds a field. The twins also read some new **values**: a place under a category your build does not
know is left out of the list, and an access level your build does not know reads as `private`. Read
a verified descriptor's level through `readAccessLevel`. A room and its live changes have no twin:
read the fields you use, and treat a change you do not know as a gap (section 5.4).

### 5.6 Games

Several games can share a server, and the slug is how each finds its own content.

- **Every write names its game.** Rooms, room ops, scouts, place proposals, mail and media all carry
  `game`. A write without one is refused `gameNotAdmitted`.
- **A room belongs to the game that placed it.** The server stamps the `place` envelope's slug on the
  room as `game` and never changes it. Only that game may run the room's ops unless the policy opens
  an op to others with `games` (section 3.1). The value is `["*"]` for every game or a list of slugs.
  An op from a game the room does not open to is refused `gameNotAccepted`. The policy is signed, so
  who may play is your choice at mint and nobody can widen it later.
- **Every read can filter by game.** Discovery and room fetch take `games`; the map channel takes
  `game` in its handshake; the mailbox only returns mail sent from your game. The SDK applies your
  configured game by default. A room's `game` tells your own rooms from rooms another game opened to
  you.
- **Check what you get back.** The slug is self-attested: another app can place a room that claims to
  be your game. The signatures on that room can be as valid as yours, because they are made with
  players' keys. Before you show a room check that its type, policy and items are ones your game
  makes. Drop the rest (section 7).

## 6. Scouts

A scout is something a player sends across the map: a marker other players see moving between two
points. Scouts are separate from rooms, and no op or policy touches a scout. The server **relays**
scouts. The owner reports where the scout is headed. The server keeps the latest report for a while
and hands it to anyone looking at the map. The server never holds or changes the scout itself.

### 6.1 Minting a scout

A scout is a `unique` id and a **config**. The config is any JSON object your game defines. A type, a
label and the caps that make a rule (how fast and how far) are typical fields. The platform reads no
field of the config.

- Sign the scout once at mint: `signScoutProvenance({ unique, config }, minter)` signs
  `JCS({ unique, config, minter })`. The config is frozen from then on; a different config is a
  different scout.
- Keep the config within `MAX_SCOUT_CONFIG_BYTES` (2 KiB of canonical JSON, the bytes the signature
  covers). A report carrying a larger config is refused.
- A display `name` is separate from the config. The name is optional and unsigned, and any report may
  change it.

### 6.2 Reporting and canceling

`POST /scouts` takes an envelope (section 5.1) with no `room` and one of two ops:

- **`report`** publishes the scout or refreshes it. The params are
  `{ unique, config, mintedBy, name?, movement, expiresAt }`. `movement` is
  `{ lastKnownLocation, locationTimestamp, destination?, speedKmh }`. `speedKmh` is a finite speed in
  kilometers per hour of at most 16,100. A scout with no `destination` or a `speedKmh` of 0 stands
  still. `lastKnownLocation` is the last point you reported. Never report the point where the scout set
  out. The report has no field for the scout's origin, so a watcher cannot trace a scout back to its
  owner.
- **`cancel`** takes the scout off the map at once. The params are `{ unique }`.

What the server holds you to:

- `expiresAt` may be at most **one hour** after the server's clock. Report again before it passes (a
  heartbeat), or the scout drops off the map. The server keeps scouts in memory, so after a restart
  every scout is gone until its next report. A server that holds 10,000 scouts drops the oldest
  first.
- Only the account that first reported a `unique` may refresh or cancel it; anyone else is refused
  `denied` (403).
- Each report replaces the one before it, timed by the server's clock rather than yours.
- The server checks:
  - the envelope;
  - the `mintedBy` over `{ unique, config }`;
  - whether the server admits your game (`gameNotAdmitted`, section 5.5);
  - a relay budget kept apart from room writes (`rateLimited` with status 429).

  A malformed report or an oversized config is `invalid` (400). So is a bad signature or an
  `expiresAt` too far out.

- The server does **not** check movement against the config. A scout faster than its type allows is
  relayed as reported. Enforcing your caps is your client's job (radical trust, section 1).

A refused `cancel` leaves the scout advertised until its `expiresAt`. A revoked device or a game the
server has stopped admitting cannot take a scout down there. The one-hour limit bounds how long the
scout stays.

A scout is not tied to one server: you may report it to several, and each keeps its own copy.

### 6.3 Seeing other players' scouts

Scouts arrive in discovery's `scouts` list and as live `scout` and `scoutGone` map events (section
5.4), each a summary: `{ id, owner: { id }, config, mintedBy, name?, game?, movement, expiresAt }`.
`id` is the scout's `unique`: the same scout from two servers is one scout, so dedupe by `id`.

- **Positions are not streamed.** Compute where a scout is now with `interpolateScout(movement, now)`
  from `@beaconsgg/scout-interp`, which follows the great circle toward `destination` at `speedKmh`
  and stops there. Discovery uses the same function, so a query finds a scout in the cell it has
  reached by now. A live `scout` event goes only to the cell the scout was in when reported. A scout
  that moves into your view between reports appears at your next discovery query and sends no event.
- **Ask for scouts**: pass `scouts: true` to `discoverCells`. On the wire, a `types` list without
  `scout` returns none.
- **Every game's scouts come back.** `game` is the slug the report's envelope was signed with. Skip a
  scout whose `game` is another game's. A scout may have no `game` because the reporter sent no slug
  or the server is older. Then fall back to parsing the config with your own schema and skip what
  does not parse. Two games can have configs of the same shape, so the slug is the reliable test.
- **Verify before you parse**: `verifyScoutProvenance({ unique: id, config }, mintedBy)` over the
  config as received. A read schema that drops unknown keys loses the fields a newer build of your
  game added, and the signature covers those fields. Verifying the parsed copy would fail that scout.

## 7. What your game supplies

- **Your item model.** The shape of `birth` and `state`, and a validator for it. Validate every item
  a peer hands you (a take, a claim or a grant) before your client uses it: `birth` arrives as
  whatever another client signed. Refuse the whole item or keep it verbatim; never repair a signed
  field, or its signature stops verifying and every server will refuse it afterward.
- **Your `match` projection**, consistent with `birth`.
- **Your policies**: builders that produce the policy for each kind of room you place.
- **Unlock transforms**, if you use `unlockTransform`. The server carries and validates them but
  never applies them. Your client applies them to the claimed items. The platform has no
  implementation of its own yet.
- **Your scout config**, if you have scouts. That means its schema and a parser that tells your
  scouts from other games' scouts. The config's caps apply only in your client (section 6).
- **Every rule the server does not enforce**: how close a player must be to place or open a room,
  what a player may carry and how stats grow. These are your client's rules.
- **Which rooms are yours.** Ask for your own game's rooms (section 5.6) and check each room before
  you show it. Look for a type you place, a policy your builders produce and items your validator
  accepts. The slug narrows the list; it does not prove where a room came from.

## 8. Constraints and limits

- **No third-party calls on a game's behalf.** A server calls out only for an operator's opt-in
  service (the `geocode` proxy). Anything your game needs from a third party belongs in your client
  or your own service.
- **The core packages run in React Native.** `@beaconsgg/protocol-types`, `@beaconsgg/identity`,
  `@beaconsgg/jsonlogic-profile`, `@beaconsgg/geo`, `@beaconsgg/scout-interp`,
  `@beaconsgg/client-sdk` and `@beaconsgg/event-bus` are pure TypeScript with no Node built-ins. A
  lint gate keeps them that way, so they run in React Native as well as in Node. The one thing a
  React Native app must supply is `crypto.getRandomValues`: `@beaconsgg/identity` draws key
  randomness from it, and Hermes does not provide it. Install a native-backed polyfill such as
  `react-native-get-random-values` in your entry file before anything imports `@beaconsgg/identity`.
  Never substitute `Math.random`: these are private keys.
- **Minimum runtimes.** The packages need Node 22 or later for your build and tests. An app needs
  React Native 0.86 (Expo SDK 57) or later ([`core-compatibility.md`](core-compatibility.md) section
  7).
- **Rate limits.** Every write is budgeted per account, and reactions more tightly; the operator sets
  the budgets. An over-budget write is refused `rateLimited` (429) and succeeds later.
- **Fixed limits**:
  - an op's ledger holds at most 500 entries (section 3.1);
  - a transition may be at most 10 years out (section 3.2);
  - a scout's config is at most 2 KiB, and a report lives at most an hour (section 6.2);
  - a socket may subscribe to 256 rooms and watch 256 map cells.

## 9. Versioning and compatibility

The full policy is [`core-compatibility.md`](core-compatibility.md). What the policy means for a
game:

- **Use the public API only.** Import from a core package's root or from a subpath the package
  declares, such as `@beaconsgg/identity/conformance`. Never import a file under `dist`. Each package
  lists its public names in `public-api.txt` in its source repository.
- **One version for all seven.** All seven core packages are versioned in lockstep, the client SDK
  and the event bus included. Depend on the same version of each. The packages follow semantic
  versioning from `1.0.0`. A break of the public API or of the wire is a major: removing or renaming
  a public name is one, and so is changing the bytes a signer produces. An addition is a minor and a
  fix is a patch, so a `^1.0.0` range keeps working until `2.0.0`. Majors are rare and planned. A
  breaking change to any package waits for the next planned major, the client SDK included. Until
  then the change ships beside what it replaces.
- **A protocol addition is a minor with a marker.** Ask a server whether it understands an addition
  before you use it (section 5.5). Nothing already on the wire changes meaning inside the skew
  window.
- **Deprecation comes first.** A name is marked `@deprecated` in a minor with the name of its
  replacement, and `CHANGELOG.md` says so too. The name keeps working for at least one minor and is
  removed no earlier than the next major. `1.0.0` removed what `0.4.3` deprecated, and the
  changelog's 1.0.0 entry lists each name with its replacement.
- **The skew window is one major in both directions.** A client on core `N` works with a server on
  `N` or `N-1`, and a server on `N` works with a client on `N` or `N-1`. The `0.x` line from `0.3.0`
  counts as the major before `1`, so a `1.x` client works with servers from `0.3.0` on. Players
  update slowly and servers are run by different operators, so expect to meet the older side of
  that window.

The rules that make this hold are in these sections:

- section 3: strict acceptance and frozen policies;
- section 5.3: new error codes only to a client that declares them;
- section 5.5: markers and read twins.

One gap remains: a value this build has never heard of in a closed set. A placement refuses such a
value as malformed instead of naming it. A read fails on such a value unless the field declares what
an older reader does with it. A place's category and a server's access level are two fields that make
that declaration (section 5.5).

## 10. A worked example

This example is the smallest game that places a room, admits items and settles. The game is a
**pot** that anyone may add a stone to for an hour. The pot then opens for each contributor to claim
their stones back. Heavier stones make the pot open sooner, though never sooner than ten minutes in.
The pot closes once everyone has claimed or a week after it opens.

The same policy is exported as `POT_POLICY` from `@beaconsgg/protocol-types/examples`, and the
engine's test suite places and plays it exactly as below.

<!-- example: packages/core/protocol-types/src/examples/pot-policy.json -->

```json
{
  "type": "pot",
  "ops": {
    "list": { "role": "public" },
    "contribute": { "role": "public", "phase": "open" },
    "claim": { "role": "contributor", "phase": "settled" }
  },
  "lifecycle": {
    "phases": ["open", "settled"],
    "transitions": { "settled": "settleAt" }
  },
  "derived": {
    "settleAt": {
      "max": [
        { "+": [{ "var": "placedAt" }, 600] },
        {
          "-": [
            { "+": [{ "var": "placedAt" }, 3600] },
            { "*": [{ "sum": [{ "var": "contents" }, "weight"] }, 60] }
          ]
        }
      ]
    }
  },
  "accept": { "class": ["stone"], "capacity": 10 },
  "onEmpty": "close",
  "claimTtl": "7d"
}
```

What happens, in order:

1. **Mint a room and place it.** Generate a ULID `unique`, sign
   `signRoomProvenance({ unique, kind: "pot", policy }, minter)` and send a `place` envelope with
   `{ type: "pot", unique, mintedBy, location, policy }`. The room starts in `open`, with `placedAt`
   stamped and `settleAt = placedAt + 3600`.
2. **Contribute a stone.** Mint an item with `match: { class: "stone", levels: { weight: 10 } }`. The
   `birth` is yours, say `{ class: "stone", found: "..." }`. Sign the item with `signItemProvenance`
   and send `contribute` with `{ item }`. The room recomputes `settleAt` to
   `placedAt + 3600 - 10 × 60`, and watchers get `itemAdded` then `derivedUpdated`.
3. **Anything that is not a stone is refused** `denied` by `accept`, and an eleventh item `full`.
4. **At `settleAt` the room settles.** The tick moves the room to `settled` (`phaseChanged`), and
   `contribute` is now refused `phase`.
5. **Each contributor claims.** `claim` returns that player's own stones. When the last contributor
   has claimed, the room closes (`closed`).

From here a `grant` rule and a pool seeded with `initialRewards` would pay each contributor a reward
on `claim`. A `react` entry under `ops` would let contributors react to each other's stones.

## 11. Your repository

Your game lives in its own repository with its own CI and release steps. The repository also has its
own config for building, testing, linting and formatting. The game takes Beacon's published packages
and nothing else of Beacon's. That rules out shared config, shared workflows and anything from a
repository you cannot read.

**What you install.** Install the seven core packages (section 9) at one version by range, as in
`"@beaconsgg/client-sdk": "^1.0.0"`. If you build operator screens for the Beacon console, install
`@beaconsgg/admin-plugin` too (below). Install nothing else of Beacon's. The server packages are not
published, so a game cannot depend on them even by accident.

**The registry.** The packages are on the public npm registry under the `@beaconsgg` scope. An
install needs no token and no registry line in your `.npmrc`.

**Metro and pnpm.** Metro cannot follow pnpm's symlinked layout, so your workspace keeps
`node-linker=hoisted` in `.npmrc`. Your own packages stay symlinked; the Beacon packages are plain
copies under `node_modules`, which Metro bundles as it bundles any dependency. Your app resolves the
packages' `dist`, which is CommonJS with type declarations (section 9). You have nothing to build on
your side for them, so a pulled branch never runs stale package code.

**Operator screens for the console** are a package you publish named
`@<your-scope>/beacon-admin-plugin`. The package is built against `@beaconsgg/admin-plugin`, the
console's plugin contract. The contract defines what a plugin is and what the console hands it. A
console deployment installs and lists the plugin, and the console reads the plugin by that name. The
contract requires three things of the package:

- The package is an ES module (`"type": "module"`) with `.js` extensions on its relative imports.
  Node can then load it as an installed copy, and the `"use client"` directives stay first in their
  modules. Compile the build under `moduleResolution: NodeNext` so an extensionless import fails your
  build instead of someone's install.
- `@beaconsgg/admin-plugin`, React and the core packages its screens are typed against are **peer
  dependencies**. `useAdminHost` reads a React context the console provides, so the plugin must
  share the console's copy of the contract.
- The console's operator must be able to install whatever else the package depends on. If the
  package depends on your game model, publish the model too at the same version. Keep the two moving
  together.

Publish under a scope you own, to a registry the console deployment installs from. A registry other
than npmjs needs `@<scope>:registry=` in `.npmrc`. An unmapped scope is fetched from npmjs, where
someone else may own the name. If that registry proxies npmjs, ask its operators for a
no-proxy rule for your scope. Pre-release versions can go up under the default dist-tag while
nothing stable exists; a bare install then gets your newest candidate.

**Lint bans worth keeping.** Keep these two:

- No Node built-in in a package the phone bundles. The ES library does not name `fetch`, `URL` or
  `console`. Type them with `lib: ["ES2022", "DOM"]` instead of `@types/node`.
- Nothing of the console in the phone bundle, since the contract and your plugin are React DOM.

Flat ESLint config replaces a rule's options when a later block names the rule again, so a check
that asks ESLint what each directory resolves to is what keeps a ban in place.
