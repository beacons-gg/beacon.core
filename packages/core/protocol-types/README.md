# @beaconsgg/protocol-types

**[C] client-bound (RN-safe).** The wire contract: zod schemas, the TypeScript types inferred from
them and the JCS canonical serialization helper that signing uses.

## Status

Stable. The server and the React Native or Expo client use this wire contract unchanged. Every shape
that crosses the wire is defined here exactly once, so both sides agree byte for byte. The package
is pure TypeScript with zod and no Node built-ins, so the package is **RN-safe**.

## What the package does

The package is the single source of truth for the shapes that move between clients and servers:

- signed op envelopes;
- custodied rooms and the opaque items they hold;
- identity and profile documents;
- spatial discovery;
- scout reports;
- op results;
- the two live channels, with item changes per room and changes per live map cell.

Each shape exports both the zod validator (`*Schema`) and its inferred TypeScript type. The package
also exports some constants, regexes and helpers.

This package defines the **signed** bytes, so several schemas are `.strict()`. A strict schema
rejects unknown fields at parse time, and an unknown field can't ride into the signed payload
unseen. Every numeric field that lands in a signed artifact is held to a safe integer. The one
exception is `speedKmh`, which is held to a bounded finite float. `canonicalJson` is the one helper
here that isn't a schema. `canonicalJson` produces the deterministic serialization that all signing
covers, as the design notes below explain.

## Exports

The exports are grouped by module. Every entry exports a `*Schema` zod validator and an inferred
type unless the entry says otherwise.

### `read.ts`: tolerant read twins

| Export                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `readVariant(schema)`       | The same schema with every object at any depth set to **drop** unknown keys instead of rejecting them. Bounds, refinements and required fields still hold. Each strict shape a client reads off the wire exports its twin beside it as `*ReadSchema`. Examples are `serverDescriptorReadSchema`, `profileDocReadSchema`, `discoveryResponseReadSchema` and the `admin*` and `place*` response shapes.                                          |
| `conformsTo(schema, value)` | A type guard that asks whether `value` has the shape apart from unknown keys. The guard leaves the value as received. A signed document goes through `conformsTo` before its signature is checked over the raw body. The guard narrows to what the schema **accepts** (`z.input`) and not to what a parse returns. On a read twin a closed set that a newer peer may extend is typed `string`, and a field that degrades is typed `unknown`.              |
| `ReadsAs<T, Received>`      | The type a read mark gives its node. The read marks are `readAsOnRead`, `absentOnRead` and `rowsDroppedOnRead`. The type is `T` with the input type its read twin accepts, so `z.input` and `conformsTo` say what a received body can hold. The output type is unchanged. A mark is the outermost call on its node, so `.optional()` goes inside the mark. A method chained after a mark is typed `never`, because a wrapper would lose the mark from the type. A copy such as `.max()` or `.describe()` would lose the mark from the node. |

### `primitives.ts`: shared scalars and `GlobalId`

| Export                                             | What                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isoTimestampSchema` / `IsoTimestamp`              | An ISO 8601 timestamp in UTC, with offsets allowed.                                                                                                                                                                                                                                       |
| `didKeySchema` / `DidKey`, `DID_KEY_RE`            | A `did:key:z…` Ed25519 identifier (multibase base58btc). The length is bounded to `{6,64}`, which rejects inputs of several megabytes before decoding.                                                                                                                                     |
| `ulidSchema` / `Ulid`, `ULID_RE`                   | A ULID of 26 Crockford base32 characters, used for op nonces.                                                                                                                                                                                                                              |
| `latLngSchema` / `LatLng`                          | A geographic point with `lat ∈ [-90,90]` and `lng ∈ [-180,180]`.                                                                                                                                                                                                                         |
| `geohashCellSchema` / `GeohashCell`, `GEOHASH_RE`  | A geohash cell key of 1 to 12 base32 characters, without a, i, l and o. The key names the live map's `cell:<hash>` room and fills every `cells=` query parameter. The **regex is exported** for callers that need the matcher without zod. The regex is the one declaration of the alphabet and the cap, and `@beaconsgg/geo`'s `isGeohash` wraps the regex. |
| `signatureSchema` / `Signature`                    | An opaque signature string that isn't empty. On the wire the signature is base64url Ed25519.                                                                                                                                                                                              |
| `levelsSchema` / `Levels`                          | A numeric property map `record<string, int>` bounded to ±2^53 (`.safe()`). The values are exact in JavaScript, Go and C#.                                                                                                                                                                 |
| `tagsSchema` / `Tags`                              | Categorical tags as `record<string, string[]>`.                                                                                                                                                                                                                                           |
| `displayNameSchema` / `DisplayName`, `MAX_DISPLAY_NAME_LEN` | A display name the player sets, as a string of at most 64 characters. The name is **mutable** and travels on the wire. The name is part of no signed birth set.                                                                                                                |
| `globalIdSchema` / `GlobalId`, `GLOBAL_ID_RE`      | The live address `unique@host`. `unique` is the permanent key for deduplication, and `host` is the server that serves the object now.                                                                                                                                                      |
| `ParsedGlobalId`                                   | The `{ unique, host }` interface.                                                                                                                                                                                                                                                         |
| `parseGlobalId(id)`                                | Splits `unique@host` and **throws** on a malformed id.                                                                                                                                                                                                                                     |
| `formatGlobalId(parts)`                            | Builds `unique@host` from its parts.                                                                                                                                                                                                                                                      |
| `serverForHost(host, servers)`                     | The client's router. Returns the configured server URL that serves a `@host`. The match on the authority is exact to stop spoofing. The fallback is `originForHost(host)`: `https`, or `http` for a local or private host.                                                                                                                    |

### `identity.ts`: identity and profile

| Export                                              | What                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceAuthorizationSchema` / `DeviceAuthorization` | A `.strict()` grant signed by the root that lets a device key sign as the account. Each op carries the grant inline for offline verification. The optional `expires` is the offline expiry of [`doc/spec/identity.md`](../../../doc/spec/identity.md) §10.3.                                                                                                                     |
| `identitySchema` / `Identity` / `identityReadSchema`                       | The public bundle a client presents: `account`, `device` and `auth`. The schema refuses unknown keys. Read one a peer sent with the twin.                                                                                                                                                                                                                                                                                                              |
| `proofSchema` / `Proof`                             | A `.strict()` Ed25519 proof that a published document signs itself with (`type: "Ed25519"`).                                                                                                                                                                                                                                                                                      |
| `profileDeviceSchema` / `ProfileDevice`             | A `.strict()` device entry in the profile's log of authorizations. The inner `auth` is also `.strict()` with an optional `expires`.                                                                                                                                                                                                                                              |
| `serviceSchema` / `Service`                                   | A `{ type, endpoint }` service entry.                                                                                                                                                                                                                                                                                |
| `profileDocSchema` / `ProfileDoc`                   | A `.strict()` signed DID document and public profile. The required `version` is a nonnegative integer that only goes up, and a higher version supersedes a lower one as the rollback guard. The document also holds `devices`, `updated` and the self-signed `proof`. The optional fields are `handles`, `displayName`, `avatar`, `revoked`, `keyAgreement` and `services`. |
| `MAX_PROFILE_BYTES`, `profileBytes(doc)`            | The profile size cap of 64 KiB and what the cap counts: the UTF-8 bytes of the document's canonical JSON, `proof` included. `profileBytes` returns `Infinity` for a value too deep to canonicalize, so a check fails closed. A server keeps fields it doesn't know, so the cap is needed.                                                                                          |

### `mintedBy.ts`: object provenance

| Export                        | What                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mintedBySchema` / `MintedBy` | Optional signed provenance (`id`, an optional `handle` and `sig`) over an object's immutable birth fields. Items, rooms and scouts carry the provenance. The provenance powers the trust and block lists a client keeps.           |

### `mediaEntry.ts`: the `media[]` an object carries

| Export                              | What                                                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mediaSchema` / `Media`             | A content-addressed entry. The entry holds `type` and an optional `role` (`"full"` or `"thumb"`). `hash` is the sha256 that identifies the entry. `uris` holds `<hash>@host` hints for the location, and `credit` is optional. A read variant reads a `role` it doesn't know as absent. |
| `mediaCreditSchema` / `MediaCredit` | Attribution for media from a third party. The optional fields are `license`, `author`, `licenseUrl` and `sourceUrl`.                                                                                                                                         |
| `pickMedia(media, role)`            | The display image for a role. The function falls back to the other role and then to any image.                                                                                                                                                    |
| `mediaPairs(media)`                 | The images grouped into `[thumb, full]` photos. A `full` belongs to the `thumb` it directly follows.                                                                                                                                               |

The wire shapes for uploads (`media.put`) are in `media.ts`.

### `item.ts`: the opaque signed item

| Export                                       | What                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opaqueItemSchema` / `OpaqueItem`            | A game-defined item in a room's shared state, either in `contents` or in a reward pool. The item holds `unique` and the signed `birth` that only the game reads. `birth` must not carry `unique` or `minter`. The optional `mintedBy` signs `JCS({unique, ...birth, minter})`. The item also holds the opaque mutable `state`, the `owner` the engine manages and the `match` projection. The server verifies the provenance and never interprets `birth` or `state`. |
| `matchAttributesSchema` / `MatchAttributes`  | The `{class?, tags?, levels?}` that an item declares about itself for a room's `accept` gate and aggregates.                                                                                                                                                                                                                                                                         |

### `reaction.ts`: reactions

| Export                                            | What                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reactionSchema` / `Reaction`                     | One recorded reaction in `state.reactions`: `unique`, `by`, `at`, `target` and `kind`. `unique` is the op's nonce, and `at` is in server epoch seconds.                                                   |
| `reactionKindSchema`, `MAX_REACTION_KIND_LEN`     | A key from the game's vocabulary of 1 to 32 characters.                                                                                                                          |
| `reactionTargetSchema`, `MAX_REACTION_TARGET_LEN` | What a reaction points at, in 1 to 128 characters: an item's `unique` or the DID of a contributor the room holds.                                                                |

### `room.ts`: the custodied room and its policy

| Export                                        | What                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonLogicSchema` / `JsonLogicRule`           | An opaque JSONLogic rule (`z.unknown()`). `@beaconsgg/jsonlogic-profile` enforces the whitelist and the aggregators when the rule runs.                                                                                                                                                                                                                                                                                                                    |
| `roleSchema` / `Role`                         | Role gating: `"public"`, `"owner"`, `"contributor"` or an explicit `did:key[]`.                                                                                                                                                                                                                                                                                                                                                                            |
| `opRuleSchema` / `OpRule`                     | A permission entry for one op. The entry holds a `role` and an optional `phase`. The optional `max` is a positive cap on the entries of the op's own ledger in the room's state, and today only `react` has such a ledger. The optional `games` lists the other games that may run the op as slugs or `[ANY_GAME]`. The list holds at most `MAX_RULE_GAMES` entries. Without `games` only the room's own game may run the op. |
| `ANY_GAME`, `MAX_RULE_GAMES`                  | `ANY_GAME` is `"*"`, the `games` entry that opens an op to every game. `MAX_RULE_GAMES` caps one rule's list.                                                                                                                                                                                                                                                                                                                                             |
| `gameMayApply(room, op, game)`                | Whether `game` may run `op` on this room. The function decides the `games` half of an op's permission, and the engine decides `role` and `phase`.                                                                                                                                                                                                                                                                                                           |
| `acceptPredicateSchema` / `AcceptPredicate`   | The categorical admission predicate. `class` matches any listed class, and `tags` matches any listed key. Every `minLevels` entry must hold, and `capacity` caps the contents.                                                                                                                                                                                                                                                                             |
| `lifecycleSchema` / `Lifecycle`               | `{ phases, transitions }`, where each transition maps a phase to the derived key that starts the phase.                                                                                                                                                                                                                                                                                                                                                   |
| `TRANSITION_HORIZON_SEC`                      | `315_360_000`, which is 10 years of 365 days. A phase transition may fall at most this long after placement, and a later one is refused. See section 3.2 of [`doc/game-author.md`](../../../doc/game-author.md).                                                                                                                                                                                                                                               |
| `parseDuration(value)` / `durationSchema`     | A policy duration such as `"7d"`: a whole number followed by `s`, `m`, `h` or `d`. The duration is above zero and at most `TRANSITION_HORIZON_SEC`. `parseDuration` returns the seconds, or `undefined` for anything else. The schema refuses what `parseDuration` doesn't parse.                                                                                                                                                                          |
| `unlockRuleSchema` / `UnlockRule`             | One rule that upgrades an item on unlock. An optional `when` predicate and `set` formulas run over a claimed item, on the client at claim time.                                                                                                                                                                                                                                                                                                           |
| `grantRuleSchema` / `GrantRule`               | A rule that hands out rewards: `{op, from, count, when?}`. A successful `op` hands the actor `count` items from the state pool `from` when the optional state condition passes.                                                                                                                                                                                                                                                                             |
| `policySchema` / `Policy`                     | The declarative room policy. The policy requires `ops`. The optional fields are `type`, `lifecycle`, `derived`, `accept`, `maxContributors` and `onEmpty: "close"`. `unlockTransform` is an `UnlockRule[]` that only the client runs. `grant` is one `GrantRule` or an array of them. `claimTtl` is a `durationSchema` duration.                                                                                                                         |
| `roomSchema` / `Room` / `roomReadSchema`                         | A custodied room. The room holds `id`, `type`, `version`, `location`, `state` and `policy`. The `version` only goes up, and the `state` depends on the room's kind. `placedBy` is the actor of the place op and holds the "owner" role. The optional fields are `game`, `mintedBy`, `name`, `media` and `live`. The server stamps `game` with the placing game's slug. `mintedBy` is the room's signed provenance and `name` its display name. `media` is the preview header set at placement, and `live` is the URL of the live channel. The schema refuses unknown keys. Read a room a server sent with the twin. |

### `op.ts`: the signed op envelope

| Export                                            | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `opEnvelopeSchema` / `OpEnvelope`                 | A `.strict()` signed op. The envelope holds the `op` name and the acting account `actor`. The signing `device` and its `auth` follow. The optional `room` names the room of a room op, and `place`, the scout ops and the capability routes leave it out. The optional `game` slug is signed and self-attested. `nonce` is a ULID that protects against replay, and `issuedAt` says when the op was made. The optional `baseVersion` gives optimistic concurrency. The envelope ends with the op's own `params` and the `sig`. The schema covers `place`, the room ops and the scout ops `report` and `cancel`. The schema also covers the op name of each signed capability route. The room ops are `add`, `take`, `list`, `contribute`, `claim`, `collect` and `react`. |
| `unsignedOpEnvelopeSchema` / `UnsignedOpEnvelope` | The envelope without `sig`, which is exactly the value that is canonicalized and signed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `placeParamsSchema` / `PlaceParams`               | The params of a `place` op. `type` names the room type, and `unique` is a ULID the client mints that becomes the room's `unique`. The room's `mintedBy` is required and signs `{unique, kind, policy}`. The params also hold `location` and the declarative `policy`, which a game's builders compose. The optional fields are `name`, `initialContents`, `media`, `initialRewards` and `initialPools`. Every item is an `OpaqueItem` whose provenance the server verifies. |
| `reactParamsSchema` / `ReactParams`               | The params of a `react` op. `target` is an item's `unique` or the DID of a contributor the room holds. `kind` is a key from the game's vocabulary.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### `scoutConfig.ts`: the scout's signed type config

| Export                                              | What                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scoutConfigSchema` / `ScoutConfig`                 | Any JSON object: the config a game mints a scout with. The config is frozen and signed at mint, with `mintedBy` over `{unique, config}`. Every report and summary carries the config so a peer can verify the minter. No server reads a field of the config, and each game parses its own on the client.                                                                  |
| `MAX_SCOUT_CONFIG_BYTES`, `scoutConfigFits(config)` | The cap on a reported config of 2 KiB and what the cap counts: the UTF-8 bytes of the config's canonical JSON. `scoutConfigFits` returns `false` for a value that canonical JSON can't express (`1e400`), so a report is refused instead of failing. The cap applies to `report` params only, and reads are not capped.                                             |
| `MAX_SCOUT_SPEED_KMH`                               | `16_100`, the ceiling on a reported speed in kilometers per hour. The bound on `movement.speedKmh` blocks `Infinity` and `1e12` in a signed envelope that servers relay.                                                                                                                                                                                                |

### `discovery.ts`: spatial discovery and movement

| Export                                          | What                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverDescriptorSchema` / `ServerDescriptor`   | A `.strict()` advertisement that the server signs itself. The descriptor holds `host`, `key`, `coverage`, `version`, `startedAt`, `accessLevel`, `updated` and `proof`. `coverage` lists geohash prefixes, and `startedAt` is the boot time. `serverAccessLevelSchema` defines `accessLevel`. The optional fields are `name`, `description`, `contact` and `capabilities`. The fields are described in [`doc/spec/discovery.md`](../../../doc/spec/discovery.md) §3.2. |
| `ReceivedDescriptor`                            | A `ServerDescriptor` as `verifyDescriptor` narrows it: the signed body as received, with `accessLevel: string`. A newer server may send a level this build doesn't know, so act on the level through `readAccessLevel`.                                                                                                                                                        |
| `serverAccessLevelSchema` / `ServerAccessLevel` | `z.enum(["open","request","private"])`, the access policy a server advertises. A server that lists `access:members` takes writes only from members at `request` and `private` (see `access.ts`). Reads are open at every level.                                                                                                                                                                                                                       |
| `gamesFilterSchema`                             | A read's game filter of one or more slugs.                                                                                                                                                                                                                                                                                                                                    |
| `discoveryQuerySchema` / `DiscoveryQuery`       | An anonymous spatial query with no signature. The schema applies a server's bounds: 1 to 256 geohash `cells`, up to 16 `types` of 1 to 32 characters and 1 to 16 `games`. `types` and `games` are optional. A query returns the whole set, with no paging.                                                                                                                                                                                                                  |
| `movementSchema` / `Movement`                   | A `.strict()` descriptor of a scout's movement. `speedKmh` is in kilometers per hour, finite, nonnegative and at most `MAX_SCOUT_SPEED_KMH`. The descriptor rides inside a signed report.                                                                                                                                                                                    |
| `roomSummarySchema` / `RoomSummary`             | A room in a discovery response: `id`, `type` and `location`. The optional fields are `game`, `mintedBy`, `live` and `summary`.                                                                                                                                                                                                                                                |
| `scoutSummarySchema` / `ScoutSummary`           | A scout report in a response. The summary holds `id`, `owner`, `config`, `mintedBy`, `movement` and `expiresAt`. `id` is the key for deduplication, and `owner` is `{id, handle}`. `config` and `mintedBy` are signed. The optional fields are `name` and the `game` slug.                                                                                                                                             |
| `discoveryResponseSchema` / `DiscoveryResponse` | The response: `coveredBy`, `rooms[]` and `scouts[]`.                                                                                                                                                                                                                                                                                                    |

### `access.ts`: server membership

| Export | What |
| ------ | ---- |
| `ACCESS_MARKER`, `enforcesAccess` | The `access:members` marker a server lists when it enforces its `accessLevel` and takes the `access.*` ops, and the check for it. Without the marker a level is for display only. |
| `accessStatusSchema` / `AccessStatus` | Where a player stands on a server: `member`, `pending`, `declined` or `none`. |
| `accessRequestParamsSchema` / `AccessRequestParams`, `accessNoteSchema` | The params of `access.request`: an optional `note` of 1 to 280 characters, which `accessNoteSchema` checks. Only a `request` server takes one. |
| `accessStatusParamsSchema` / `AccessStatusParams` | The params of `access.status`: always empty. |
| `accessResultSchema` / `AccessResult` | The reply to both player ops: `accessLevel` and the player's `status`. On read an unknown level becomes `private` and an unknown status becomes `none`. |
| `accessEntrySchema` / `AccessEntry` | One entry on a server's member list: `did` and `status`. The optional fields are `note`, `requestedAt`, `decidedBy` and `decidedAt`. |
| `adminAccessFetchParamsSchema`, `adminAccessFetchResultSchema` | `admin.access.fetch`: an optional `status` filter, and the `entries`. |
| `adminAccessDidParamsSchema`, `adminAccessEntryResultSchema` | `admin.access.add`, `admin.access.decline` and `admin.access.remove`: a `did` and an optional `reason`. Add and decline reply with the `entry`. |
| `adminAccessAdmitAllParamsSchema`, `adminAccessAdmitAllResultSchema` | `admin.access.admitAll`: makes a member of every account with a profile on the server, and replies with the count `added`. |

### `scout.ts`: the signed scout report

| Export                                          | What                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scoutReportSchema` / `ScoutReport`             | A `.strict()` movement advertisement that the owner signs. A server caches and relays the report and never takes custody of it, and `unique` deduplicates reports. The report holds `owner`, `config`, `mintedBy`, `movement`, `reportedAt` and `expiresAt`. The `config` is frozen, and `mintedBy` signs `{unique, config}`. `expiresAt` is the TTL. The optional `name` is a display name. The optional `game` is the signed slug of the report's envelope, relayed so a reader can tell whose scout it is. |
| `scoutReportParamsSchema` / `ScoutReportParams` | The `.strict()` params of a `report` op. The server fills in `owner` and `reportedAt`. The params are the one place where a `config` is capped (`scoutConfigFits`).                                                                                                                                                                                                                                          |
| `scoutCancelParamsSchema` / `ScoutCancelParams` | The params of a `cancel` op, which leaves a tombstone by `unique`.                                                                                                                                                                                                                                                                                                                                           |

### `understands.ts`: capability markers

Capability markers let the protocol grow while its two sides release separately. **Markers name
additions**, and a peer that says nothing understands the whole baseline.

- A **server** advertises what it accepts in the `capabilities` of its signed descriptor, as
  `op:<name>`, `policy:<feature>` and `rule:<name>`. The `game:<slug>` admission list sits beside
  them.
- A **client** declares what it reads as `code:<name>` markers. The client sends them in the
  `beacon-understands` request header or in a socket's `handshake.auth.understands`. The
  `result:<field>` namespace is reserved for fields added to op results.

There is no `live:` namespace. A client re-reads the room when a live change is one it doesn't know.

| Export                                                 | What                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNDERSTANDS_HEADER`                                   | `"beacon-understands"`, the request header a client declares its markers in.                                                                                                             |
| `formatUnderstands(markers)` | The header value a client sends. A server reads it with `parseUnderstands` from the `server` subpath. |

### `markers.ts`: `op:`, `policy:` and `rule:` markers

The markers say what a server accepts beyond the baseline. The baseline is implied, so a server that
predates these markers and a server that has added nothing say the same thing: nothing. A server
derives its markers from what it runs and never from a list kept by hand:

- `op:` from the engine's table of handlers;
- `policy:` from `policySchema`;
- `rule:` from `ALLOWED_OPERATORS` in `@beaconsgg/jsonlogic-profile`.

A policy feature is the dotted path of a field from the policy root, as in `ops.max`. A value of a
closed set is one more segment, as in `onEmpty.close` and `ops.role.owner`. Records and arrays add
no segment. A rule operator that is a word names itself (`rule:if`). A symbol takes the word that
`RULE_OPERATOR_NAMES` gives it, so `%` becomes `rule:mod`.

**The op vocabulary belongs to the platform, and a game can't add a verb.** A new op ships in a
platform release with its `op:` marker. A new rule operator ships the same way with its `rule:`
marker. The doc comment of `markers.ts` gives the reasoning.

| Export                                                                            | What                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BASELINE_OPS` / `BASELINE_POLICY_FEATURES` / `BASELINE_RULE_OPERATORS`           | Frozen lists of the room ops, policy features and rule operators that every server accepts. The lists hold what existed when the markers started.                                                                                              |
| `RULE_OPERATOR_NAMES`                                                             | The frozen marker name of each symbolic operator: `div` for `/`, `mod` for `%` and `ternary` for `?:`.                                                                                                                              |
| `policyFeaturesOf(policy)` / `ruleOperatorsOf(policy)`                            | The features a concrete policy uses and the operators in its rule bodies.                                                                                                                                                           |
| `acceptsOp(capabilities, op)` / `unsupportedPolicyFeatures(capabilities, policy)` | The questions a client asks before it offers a verb or places a policy. The answer is yes for the baseline and for an advertised addition. A missing feature is reported in `policy:` spelling without the prefix. A missing operator is reported as its whole `rule:` marker. |

### `result.ts`: op results and error codes

| Export                                        | What                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERROR_CODES`, `errorCodeSchema` / `ErrorCode` | The enum of rejections by outcome. The frozen baseline is `badsig`, `invalid`, `unknownRoom`, `expired`, `denied`, `gameNotAdmitted`, `phase`, `full`, `gone`, `empty`, `locked`, `rateLimited` and `stale`. The codes added after the baseline are `deviceRevoked`, `clockSkew`, `gameNotAccepted` and `notMember`. `gameNotAccepted` means the room doesn't open the op to the caller's game. `notMember` means the server takes writes from members only. `unknownRoute` counts as baseline too: the 404 of a route that doesn't exist or is turned off. The 404s `unknownPlace`, `unknownMedia`, `unknownProposal`, `unknownRun` and `noAbout` name what is missing and reach only a client that declares them. Any other client gets `unknownRoute`. |
| `grantReceiptSchema` / `GrantReceipt`         | A `.strict()` optional proof of acquisition signed by the server. The receipt is **reserved**. No server issues one yet, so clients must not depend on receiving one.                                                                                                                                                                                                      |
| `okResultSchema` / `OkResult`                 | `{ ok: true, version, result?, receipt? }`                                                                                                                                                                                                                                                                                                                                  |
| `errorResultSchema` / `ErrorResult`           | `{ ok: false, error, message? }`                                                                                                                                                                                                                                                                                                                                            |
| `opResultSchema` / `OpResult`                 | The union of the two above, discriminated on `ok`.                                                                                                                                                                                                                                                                                                                          |

### `liveEvent.ts`: the live channel per room

`roomChangeSchema` / `RoomChange` is a change discriminated on `type`. The four item changes carry
`by`, the DID of the acting account.

| `type`           | What the change carries                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `itemAdded`      | The `OpaqueItem` and `by`.                                                                                               |
| `itemRemoved`    | The item's `unique` and `by`. The item left custody, as after a `take`.                                                 |
| `itemClaimed`    | The item's `unique` and `by`. The item changed custody and stays in the frozen contents, as after a `claim`.            |
| `itemGranted`    | The item's `unique` and `by`. A grant pool handed out the item, and the item stays in its pool marked as owned.         |
| `phaseChanged`   | The new phase.                                                                                                           |
| `derivedUpdated` | The new `Levels`.                                                                                                        |
| `reactionAdded`  | The whole `Reaction`.                                                                                                    |
| `closed`         | Nothing more. The change is a tombstone.                                                                                 |

`liveEventSchema` / `LiveEvent` is `{ room, version, change }`. The server sends live events to the
client only, ordered by `version`. All ops go over REST.

### `mapEvent.ts`: the live map cell channel

| Export                                | What                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapDeltaSchema` / `MapDelta`         | The live **map** change, discriminated on `kind`. Every variant is `.strict()`. `room` inserts or updates with a fresh `RoomSummary`, and `roomGone` carries an `id`. `scout` inserts or updates a `ScoutSummary`, and `scoutGone` carries an `id`. The changes are keyed by `cell` and are separate from the changes per room. The volume is lower, and a client can patch markers without querying discovery again. The channel is described in [`doc/spec/discovery.md`](../../../doc/spec/discovery.md) §6. |
| `cellsSubscribeSchema` / `CellsSubscribe` | The WebSocket message a client sends to subscribe to a bounded set of `cells` or to unsubscribe. The message is `.strict()` with at most 256 cells.                                                                                                                                                                      |

### `geocode.ts`: the reverse geocoding capability

| Export                                | What                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geocodeResultSchema` / `GeocodeResult` | The `.strict()` response of `GET /geocode?geohash=`, which the server produces. The response holds the normalized cell, `source`, `attribution` and `cachedAt`. The optional fields are `city`, `state`, `country`, `countryCode` and `displayName`.                                    |

### `places.ts`: the places wire for the owned dataset

The `places` capability serves a server's **own curated dataset of places**, and the server always
serves the dataset from its own store. Operator import runs fill the dataset. Reads are public and
unsigned, and the admin surface uses signed `OpEnvelope`s. The server's places spec describes the
model (beacon.server `doc/spec/places.md`).

| Export                                                | What                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placeCategorySchema` / `PlaceCategory`               | The neutral taxonomy of places, from `park` to `surveillance` (see the enum). The taxonomy is the vocabulary games query with, and games never see raw tags from a source.                                                                                                                                                         |
| `geoPositionSchema` / `GeoPosition`                   | A GeoJSON position `[lng, lat]`. The order is **GeoJSON order**, the reverse of `{lat,lng}`. The bounds come from `latLngSchema`.                                                                                                                                                                                                  |
| `placeGeometrySchema` / `PlaceGeometry`               | A GeoJSON **geometry value** and never a Feature envelope: a `Polygon` or a `MultiPolygon`. Rings are closed, and `MAX_RING_POSITIONS`, `MAX_POLYGON_RINGS` and `MAX_MULTIPOLYGON_POLYGONS` cap the size. `containsPoint` in `@beaconsgg/geo` tests containment.                                                                    |
| `placeSummarySchema` / `PlaceSummary`                 | One place in a list response. The summary holds `unique` (a ULID that survives export and import), the category, `point`, `media?` and `updatedAt`. `hasGeometry` says whether a polygon exists, and only the detail route carries the polygon.                                                                                   |
| `placeDetailSchema` / `PlaceDetail`                   | The summary with the full `geometry?` and a `sources` summary of provenance, which lists the source names and their attribution lines.                                                                                                                                                                                            |
| `placesQueryResultSchema` / `PlacesQueryResult`       | The response of `GET /places?cells=&categories=`. The response holds the summaries, an `attribution[]` derived from the sources present and an explicit `truncated` flag.                                                                                                                                                  |
| `geoBBoxSchema` / `GeoBBox`                           | A bounding box in latitude and longitude. A box across the antimeridian has `minLng > maxLng`.                                                                                                                                                                                                                                     |
| `placeSnapshotParamsSchema` / `PlaceSnapshotParams`   | What one import run was asked to do: the `source` and the `boundary`, which is a box or a polygon. An optional `categories` filter narrows the run, and an Atlas run also records its `options`. The server stores the params verbatim, so the run's record says what the run was asked to do.                                                         |
| `placeSnapshotStatsSchema` / `PlaceSnapshotStats`     | The counters of one run, persisted after every chunk. The counters are `chunksDone` and `chunksTotal`, then `fetched`, `created`, `updated`, `unchanged`, `skipped`, `retired`, `conflicts` and `imagesIngested`. The optional counters are `filtered`, `retiredFiltered` and `retiredUnselected`. `imagesStorageFull` is set when the run left photos out for lack of room.                                                                                                              |
| `placeSnapshotSchema` / `PlaceSnapshot`               | The durable record of an ingestion run: the id, the params, `requestedBy`, the status and the stats. `requestedBy` is the admin's DID. The record is the run's audit trail.                                                                                                                                                    |
| `placeSnapshotsFetchParamsSchema`                     | The params of `op:"places.snapshots.fetch"`, which fetches one run by id or the list of recent runs.                                                                                                                                                                                                                              |

### `jcs.ts`: canonical serialization

| Export                 | What                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `canonicalJson(value)` | JCS-style canonical form, the exact bytes that signing covers. The function **throws** on `undefined`. |

### `@beaconsgg/protocol-types/server`: the helpers only a server needs

These helpers serve the server's side of the protocol. A server reads the markers a client
declares and picks the code to send that client. A server also derives the markers it advertises
and builds the refusal for params it cannot parse. The helpers sit in their own subpath, so the root
that every game imports does not carry them. They stay public for anyone who writes a server.

| Export                                                                 | What                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseUnderstands(raw)`                                                | The markers a caller declared, from the header or a socket's handshake. Parsing is bounded. A malformed value reads as declaring nothing, which is always safe.                                                                                                                   |
| `codeFor(code, understands, options?)`                                 | The code to send a caller. The code itself goes out when the code is in the baseline or declared, and otherwise its `CODE_FALLBACKS` entry. The server applies `codeFor` to every HTTP refusal in the response.                                                                  |
| `CODE_FALLBACKS`                                                       | For each code added after the baseline, the baseline code an older client gets instead at the same HTTP status. `clockSkew` falls back to `invalid`. `deviceRevoked`, `gameNotAccepted` and `notMember` fall back to `denied`. The type makes a new code without a fallback fail to compile. |
| `NOT_FOUND_FALLBACKS`                                                  | The code an older client gets instead of each 404 code that names what is missing: `unknownRoute`. Only at 404: `codeFor` applies it when given `{ status: 404 }`. |
| `policyFeatures()`                                                     | Every feature `policySchema` accepts, in marker spelling.                                                                                                                                                                                |
| `opMarkers(ops)` / `policyMarkers()` / `ruleMarkers(operators)`        | The markers for a set of handlers, a policy schema and a set of operators. Each entry beyond the baseline gets one marker. `ruleMarkers` throws for a symbol with no name.                                                                                                       |
| `roomGames(room)` / `roomOpenToGame(room, game)` | The games a room is open to for routing its updates, and the filter a read by game applies. A game asks `gameMayApply` instead. |
| `unknownFields(error)` / `paramsRefusal(error, prefix?, message?)`     | The unknown fields a strict parse refused, and the `invalid` result that names them in `fields`.                                                                                                                                                                                 |

## Design notes: the invariants everything rests on

**Canonical signing input.** `canonicalJson` produces a deterministic serialization, so a signature
made on a client verifies on the server. The output is that of the `canonicalize` library, which
**follows JCS without conforming strictly to RFC 8785**. Numbers go through `JSON.stringify`, so
`1e21` becomes `"1e+21"` and `-0` becomes `0`. Both would differ from a verifier that follows the
RFC. Keys whose value is `undefined` are dropped. Two rules follow, and the schemas enforce them
where the value is signed:

- Every party **must** use this exact helper to agree on the bytes.
- Keep signed payloads to **safe integers and strings**. `levelsSchema` and the version fields of
  rooms, results and ops use `z.number().int()`. `levels` adds `.safe()`. `movement.speedKmh` is the
  one float, held to finite values from zero to `MAX_SCOUT_SPEED_KMH`. **Leave out** an optional
  field instead of setting it to `undefined`. The wallet builds envelopes with conditional spreads
  for this reason.

[`@beaconsgg/identity`](../identity) builds the signing flow on this helper.

**`.strict()` on signed shapes.** These schemas reject unknown keys at parse time:

- `opEnvelopeSchema`;
- `deviceAuthorizationSchema` and `proofSchema`;
- `profileDeviceSchema` and `profileDocSchema`;
- `serverDescriptorSchema`;
- `scoutReportSchema`, `scoutReportParamsSchema` and `movementSchema`;
- every `mapDelta` variant and `cellsSubscribeSchema`;
- the whole signed policy tree: `policySchema` with `opRuleSchema`, `lifecycleSchema`,
  `acceptPredicateSchema`, `grantRuleSchema` and `unlockRuleSchema`;
- `placeParamsSchema`.

Otherwise an unknown field would be canonicalized and signed or broadcast without notice. A field
stripped on the way in would also make a valid signature look forged. Rule bodies stay opaque
(`jsonLogicSchema` is `z.unknown()`), so a new operator inside a formula is no new field.

Every request shape is strict at every depth. The shared pieces are strict too: `latLngSchema`,
`mintedBySchema`, `mediaSchema` and `opaqueItemSchema`. A newer client's field is therefore refused
and never dropped. `strict-requests.test.ts` holds that rule for every exported `*ParamsSchema`.
`unknownFields(error)` from the `server` subpath names what was refused. A server sends that list as
`fields` on the 400 or in the op's `ErrorResult`.

**Strict schemas are for what a server accepts, and a client reads the twin.** A client meets
servers newer than itself. Every field such a server adds would fail a strict parse of the whole
response. A client therefore parses server output with the shape's `*ReadSchema` twin (`read.ts`),
which drops what the client doesn't know. A signed document is verified over the raw body first and
then checked against its twin. Request params and envelopes stay strict, and additions there go
through capability markers.

A twin drops unknown **keys** by itself. A new **value** in a closed set is up to each field, and
the strict schema declares the choice where the field is (`read.ts`):

- the places list and the taxonomy leave out a row they can't read (`rowsDroppedOnRead`);
- a place's optional `geometry` reads as absent (`absentOnRead`);
- a descriptor's `accessLevel` reads as `private` (`readAsOnRead`).

`readAccessLevel` gives the same answer for the raw signed body that a verifier narrows. That body
is typed `ReceivedDescriptor`, so nothing can read the level as the enum without `readAccessLevel`.

Every other unknown value still fails the read. The failure is on purpose where an operator acts on
the value or writes the value back. A review queue that loses a proposal without a word is worse
than a queue that says it can't read the proposal. An operator's reads therefore use
`readVariant(schema, { degrade: false })`. A new value that a client _sends_ ships behind a
`policy:` marker, so ask `unsupportedPolicyFeatures` before placing.

**Versions only go up.** `profileDoc.version`, `room.version` and the result's `version` are
nonnegative integers that only increase. A higher version supersedes a lower one. For a profile the
version is the rollback guard. For a room the version gives optimistic concurrency through the
envelope's `baseVersion`.

## Scripts

```bash
pnpm --filter @beaconsgg/protocol-types build       # tsc -> dist
pnpm --filter @beaconsgg/protocol-types typecheck   # tsc --noEmit
pnpm --filter @beaconsgg/protocol-types test        # vitest
```
