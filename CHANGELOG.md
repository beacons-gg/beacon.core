# Changelog

The release notes on each GitHub Release list the pull requests in it. This file adds what a consumer has to do: the migration for a major, each deprecation with its replacement, and any other release that asks a consumer to act (`doc/core-compatibility.md` §9).

## 1.0.0

Release 1.0.0 is the first stable release. From here the promises of `doc/core-compatibility.md`
hold: a break waits for the next planned major, and a name leaves only after a deprecation in a
stable minor. The release comes as candidates first, starting with `1.0.0-rc.1` under the `next`
dist-tag. Candidates may break each other until `1.0.0`.

No wire form changes. 1.0.0 keeps the skew window of 0.4: a client on 1.x works with servers from
0.3.0 on, and a server on 1.x works with clients from 0.3.0 on (`doc/core-compatibility.md` §6).

The release removes every form 0.4.3 deprecated, and makes the few breaks that had no additive
form. A consumer that moved off the deprecated forms on 0.4.3 has only the rows marked "(break)"
below left to check.

### What changed

Removed, each deprecated in 0.4.3:

| Removed                                                                                                                                                 | Use instead                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `authorizeDevice(account, device, issued?, expires?)`                                                                                                   | `authorizeDevice(account, device, { issued, expires })`                                             |
| `walletFromMnemonic(phrase, issued?, expires?)`                                                                                                         | `walletFromMnemonic(phrase, { issued, expires, passphrase })`                                       |
| `createWallet(issued?)`                                                                                                                                 | `createWallet({ issued, expires })`                                                                 |
| `sign`, `verify`, `encodeSignature`, `decodeSignature` (`@beaconsgg/identity`)                                                                          | `signUtf8` and `verifyUtf8`                                                                         |
| `PROFILE_OWNED_FIELDS`                                                                                                                                  | none; `buildProfile`'s doc states the rule                                                          |
| `coarsestFitCover(bbox, startPrecision, maxCells, estimateSlack?)`                                                                                      | `coarsestFitCover(bbox, { maxCells, precision, estimateSlack })`                                    |
| `liveCellsForView(bbox, maxCells?)`                                                                                                                     | `liveCellsForView(bbox, { maxCells })`                                                              |
| `precisionForZoom`, `queryCells`                                                                                                                        | `cellsForView(bbox, zoom)`, or `withNeighbors(coveringCells(bbox, precision))` at a fixed precision |
| `ensureOperations`, `sumOp`, `countOp`, `minOp`, `maxOp`                                                                                                | none; `evaluate` registers them, and `aggregate` computes an aggregate directly                     |
| The `schema` parameter of `unsupportedPolicyFeatures`, `policyFeaturesOf`, `ruleOperatorsOf`, and of `policyFeatures` and `policyMarkers` in `./server` | the same call without `schema`                                                                      |
| `PLACE_WEBP_QUALITY`                                                                                                                                    | none; an encoder keeps its own quality setting                                                      |
| `BACKUP_FORMAT`                                                                                                                                         | none; a server keeps its own format number, and a console reads each manifest's `format`            |
| `roomGames`, `roomOpenToGame` from the root                                                                                                             | the same names from `@beaconsgg/protocol-types/server`; a game asks `gameMayApply`                  |

The breaks that had no additive form, all announced in 0.4.3 or found by the API review:

- (break) `@beaconsgg/client-sdk`: `mediaUrl` returns `null` for an address that is not
  `unique@host`, as it already did for a bad host. The wire allows any string there, so a server's
  malformed address no longer throws inside a render. A `try` around the call becomes dead code.
- (break) `@beaconsgg/client-sdk`: a vault's `unlock` throws the new `WrongPassphraseError` for a
  wrong passphrase, with WebCrypto's own error as its `cause`. 0.4 threw WebCrypto's
  `OperationError`. `isWrongPassphrase(err)` is `true` for the new error, as it was for the old one,
  and now narrows `err` to `WrongPassphraseError`. A failure before the decryption, such as a
  browser without WebCrypto, still throws the crypto's own error.
- (break) `@beaconsgg/protocol-types`: `discoveryQuerySchema` applies the bounds every server
  already applies: 1 to 256 geohash `cells`, up to 16 `types` of 1 to 32 characters each, and 1 to
  16 `games`. A query whose values a server accepted still parses.
- (break) `SIGNING_VECTORS`, `CONTAINMENT_VECTORS` and `CONFORMANCE_VECTORS` are typed as readonly
  arrays. Code that only reads them compiles as before. Code that changes one copies it first.
- (break) Every published package declares `"engines": { "node": ">=22" }`, the seven and the
  tooling presets alike. The supported minimum in an app is React Native 0.86 on Expo SDK 57.
  `doc/core-compatibility.md` §7 says why, and raising either minimum is a later major.

Additions:

- `WrongPassphraseError`, above.
- `httpUrlSchema(null)`: an `http` or `https` URL with no length cap. An Atlas
  preview's `versionUrl` uses that form, so `z.toJSONSchema` no longer writes `"maxLength": null`
  for the field. The field accepts the same values as in 0.4.3.

Kept as they are, though the API review named them:

- `paramsRefusal(error, prefix?, message?)` in `./server` keeps its positional form. 0.4.3 shipped
  no options form beside it, and §5 removes a form only after a stable release deprecated it. An
  options form can arrive in a 1.x minor.
- `relaysScoutsTo` keeps its name.
- `ValidationResult` keeps its shape (`{ ok; error?; path? }`).

### Migration

Raise every `@beaconsgg/*` range to `^1.0.0` (to `1.0.0-rc.1` while testing a candidate), all
seven together, and build on Node 22 or later. Each table lists the calls 1.0.0 removes or changes.

#### A game

| Where                                                       | Old                                                                   | New                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A wallet built from a phrase or created for a test or a bot | `walletFromMnemonic(phrase, issued, expires)`, `createWallet(issued)` | `walletFromMnemonic(phrase, { issued, expires })`, `createWallet({ issued })`          |
| A device added or renewed by hand                           | `authorizeDevice(account, device, issued, expires)`                   | `authorizeDevice(account, device, { issued, expires })`                                |
| Raw signatures                                              | `sign`, `verify`, `encodeSignature`, `decodeSignature`                | `signUtf8` and `verifyUtf8`                                                            |
| The live map's cells                                        | `liveCellsForView(bbox, maxCells)`                                    | `liveCellsForView(bbox, { maxCells })`                                                 |
| A discovery read's cells                                    | `queryCells(bbox, precisionForZoom(zoom))`                            | `cellsForView(bbox, zoom)`, which also limits the count                                |
| A check before placing a policy                             | `unsupportedPolicyFeatures(capabilities, policy, schema)`             | `unsupportedPolicyFeatures(capabilities, policy)`                                      |
| A room's games                                              | `roomOpenToGame(room, game)` from the root                            | `gameMayApply(room, op, game)` for the op you are about to send                        |
| (break) A media URL                                         | a `try` around `mediaUrl` for a malformed address                     | check for `null`, which now covers a malformed address; drop the `catch`               |
| (break) A browser game's vault unlock                       | `err.name === "OperationError"` for a wrong passphrase                | `isWrongPassphrase(err)`, or `err instanceof WrongPassphraseError`                     |
| (break) A discovery query checked with the schema           | `discoveryQuerySchema` with any strings and no limits                 | geohash cells within the limits above, which `cellsForView` keeps at its default limit |
| (break) The conformance vectors                             | changing one of the exported arrays in place                          | copy it first, as in `[...SIGNING_VECTORS]`                                            |
| (break) The build                                           | any Node                                                              | Node 22 or later, and React Native 0.86 (Expo SDK 57) or later in the app              |

#### The console

| Where                                         | Old                                                                   | New                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Test fixtures that build sessions and wallets | `walletFromMnemonic(phrase, issued, expires)`, `createWallet(issued)` | `walletFromMnemonic(phrase, { issued, expires })`, `createWallet({ issued })`                         |
| (break) The wallet dialog's unlock            | the error's `message`, which was WebCrypto's `operation failed`       | `isWrongPassphrase(err)` to word a wrong passphrase; the message is no longer WebCrypto's             |
| Backup screens                                | `BACKUP_FORMAT`, if read                                              | each manifest's own `format`                                                                          |
| The plugin contract                           | peer dependencies on the seven at `^0.4.0`                            | a major of the contract with peers at `^1.0.0`, since a major of the seven moves under its types (§8) |

#### A console plugin

A plugin uses the client SDK and the protocol types as a game does, so the rows under "A game"
apply where a plugin makes the same call. Raise the contract's range to its 1.0.0 together with the
seven: the contract's 1.0.0 takes the seven at `^1.0.0`.

#### The server

| Where                                                                  | Old                                                                    | New                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `places/admin.service.ts`, `places/snapshot.service.ts`                | `coarsestFitCover(bbox, precision, maxCells, slack)`                   | `coarsestFitCover(bbox, { precision, maxCells, estimateSlack: slack })`                                       |
| `profiles.test.ts`, `rooms-service.test.ts`                            | `authorizeDevice(account, device, issued, expires)`                    | `authorizeDevice(account, device, { issued, expires })`                                                       |
| `rooms/rooms.service.ts`                                               | `roomGames`, `roomOpenToGame` from the root                            | from `@beaconsgg/protocol-types/server`                                                                       |
| `backup/backup-job.ts`, `backup/restore-job.ts`                        | `BACKUP_FORMAT` from core                                              | the server's own constant                                                                                     |
| `apps/atlas/cartographer/src/media.ts`, `packages/server/image-encode` | `PLACE_WEBP_QUALITY` from core                                         | a constant in `image-encode`                                                                                  |
| `packages/server/policy-engine/src/markers.ts`                         | `policyMarkers(schema)` or `policyFeatures(schema)`, if passed         | the same calls without `schema`                                                                               |
| The OpenAPI generator                                                  | dropping a non-finite bound such as the Atlas preview's `versionUrl`'s | nothing to drop for that field: `versionUrl` has no `maxLength`. Keep the guard for other schemas if you like |
| `discovery/discovery.controller.ts` (optional)                         | its own bounds on `cells`, `types` and `games`                         | the same bounds, now also in `discoveryQuerySchema`; the controller may parse with the schema                 |

The server's images and CI already run Node 22, so `engines` asks nothing of them.

## 0.4.3

Release 0.4.3 prepares the move to 1.0.0. Every form that 1.0.0 removes or replaces gets its
replacement here, and the old form is marked `@deprecated` with the name of the new one. Nothing is
removed and no existing call changes what it does, so every consumer can move while on 0.4.x and
then raise its ranges to `^1.0.0`. No wire form is deprecated, so the earliest release that may
remove each deprecated name is 1.0.0 (`doc/core-compatibility.md` §5).

Two changes read or refuse more than before, and neither changes an answer a conforming peer gets:

- A media entry's `role` that a reader doesn't know now reads as absent in every read variant (a
  room, a place summary, a place detail, a places query). A third role from a newer server would
  have failed the whole read. The entry now shows as a standalone image, which `pickMedia` and
  `mediaPairs` handle. The strict `mediaSchema`, which a server accepts, is unchanged.
- An Atlas volume target's `url` and a preview's `versionUrl` take only an `http` or `https` URL of
  at most 2048 characters. A `javascript:` or `data:` URL names no volume a server can read, so a
  request with one could never import anything. Under §3 this is a patch: a fix that refuses input
  no conforming implementation can produce.

### What changed

`@beaconsgg/identity`:

- `authorizeDevice(account, device, { issued?, expires? })`, `createWallet({ issued?, expires? })`
  and `walletFromMnemonic(phrase, { issued?, expires?, passphrase? })` take an options object. The
  types are `DeviceAuthorizationOptions` and `MnemonicWalletOptions`. `createWallet` gains
  `expires`, and `walletFromMnemonic` gains the BIP39 `passphrase`, so an account made with
  `accountFromMnemonic(phrase, passphrase)` now has a wallet path.
- `buildProfile`'s doc states which top-level fields it owns, the rule `PROFILE_OWNED_FIELDS` held.

`@beaconsgg/geo`:

- `coarsestFitCover(bbox, { maxCells, precision?, estimateSlack? })` takes an options object, with
  the option names `cellsWithinRadius` uses. `precision` defaults to `DEFAULT_PRECISION`. The type
  is `FitCoverOptions`.
- `liveCellsForView(bbox, { maxCells? })` takes an options object, as `cellsForView` does. The type
  is `LiveCellOptions`.

`@beaconsgg/protocol-types`:

- New error codes: `unknownPlace`, `unknownMedia`, `unknownProposal`, `unknownRun` and `noAbout`, the
  404s that name what is missing on a route that exists. A client gets one only when it declares
  `code:<name>` in `beacon-understands`. Any other client gets `unknownRoute` at the same 404.
  `unknownPlace` and `unknownMedia` are also 400 codes of `places.propose`, which every client has
  always received, so they fall back at 404 only.
- `unknownRoute` is in `ERROR_CODES` and counts as baseline: every server has sent it and every
  client has read it since before capability markers. Making it baseline lets the new codes fall
  back to it the same way every other code falls back: one lookup, to a code every client reads.
  Letting a fallback name a code outside `ERROR_CODES` instead would have widened what
  `CODE_FALLBACKS` may name and what `codeFor` returns, for one code that was already universal.
- `@beaconsgg/protocol-types/server`: `NOT_FOUND_FALLBACKS` maps each of the five codes to
  `unknownRoute`, and `codeFor(code, understands, { status })` applies it when the status is 404.
  Without `status`, `codeFor` answers as before. The new type is `CodeForOptions`.
- `mailboxFetchParamsSchema` and `MailboxFetchParams`: the params of `mailbox.fetch`, an empty object
  that refuses any key.
- `roomGames` and `roomOpenToGame` are exported from `@beaconsgg/protocol-types/server` too. The
  root exports are the same functions, deprecated.

`@beaconsgg/client-sdk`:

- `isWrongPassphrase(err)` is `true` for the error a vault's `unlock` throws when the passphrase
  doesn't decrypt the saved phrase. `unlock` still throws WebCrypto's own `OperationError` in 0.4.
  1.0.0 throws a named error in its place, and `isWrongPassphrase` is `true` for both.
- `subscribeRoom` and `subscribeMailbox` document their return value as a handle for that one
  subscription. Only `connected` and `disconnect()` are promised on it, and `disconnect()` ends only
  that subscription. The value is the same socket as before. A later release may share one socket
  between the subscriptions to a server, and code that uses only those two members keeps working.
- `mediaUrl`'s doc says that 1.0.0 returns `null` for a malformed address instead of throwing.

### Deprecations

Each name keeps working in every 0.4 release and is removed no earlier than 1.0.0.

| Deprecated                                                                                                                                              | Replacement                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `authorizeDevice(account, device, issued?, expires?)`                                                                                                   | `authorizeDevice(account, device, { issued, expires })`                                             |
| `walletFromMnemonic(phrase, issued?, expires?)`                                                                                                         | `walletFromMnemonic(phrase, { issued, expires, passphrase })`                                       |
| `createWallet(issued?)`                                                                                                                                 | `createWallet({ issued, expires })`                                                                 |
| `sign`, `verify`, `encodeSignature`, `decodeSignature` (`@beaconsgg/identity`)                                                                          | `signUtf8` and `verifyUtf8`; every Beacon signature is over a UTF-8 string                          |
| `PROFILE_OWNED_FIELDS`                                                                                                                                  | none; the rule is in `buildProfile`'s doc, and the set becomes internal                             |
| `coarsestFitCover(bbox, startPrecision, maxCells, estimateSlack?)`                                                                                      | `coarsestFitCover(bbox, { maxCells, precision, estimateSlack })`                                    |
| `liveCellsForView(bbox, maxCells?)`                                                                                                                     | `liveCellsForView(bbox, { maxCells })`                                                              |
| `precisionForZoom`, `queryCells`                                                                                                                        | `cellsForView(bbox, zoom)`, or `withNeighbors(coveringCells(bbox, precision))` at a fixed precision |
| `ensureOperations`, `sumOp`, `countOp`, `minOp`, `maxOp`                                                                                                | none; `evaluate` registers them, and `aggregate` computes an aggregate directly                     |
| The `schema` parameter of `unsupportedPolicyFeatures`, `policyFeaturesOf`, `ruleOperatorsOf`, and of `policyFeatures` and `policyMarkers` in `./server` | the same call without `schema`, which reads this version's `policySchema`                           |
| `PLACE_WEBP_QUALITY`                                                                                                                                    | none; an encoder keeps its own quality setting                                                      |
| `BACKUP_FORMAT`                                                                                                                                         | none; a server keeps its own format number, and a console reads each manifest's `format`            |
| `roomGames`, `roomOpenToGame` from the root                                                                                                             | the same names from `@beaconsgg/protocol-types/server`; a game asks `gameMayApply`                  |

### Migration

Raise every `@beaconsgg/*` range to `^0.4.3`. Nothing breaks without the changes below. Each one
moves a call off a deprecated form, or onto a rule that holds on 0.4 and on 1.0.0, before 1.0.0
removes the old form.

#### A game

| Where                                                       | Old                                                                   | New                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A wallet built from a phrase or created for a test or a bot | `walletFromMnemonic(phrase, issued, expires)`, `createWallet(issued)` | `walletFromMnemonic(phrase, { issued, expires })`, `createWallet({ issued })`  |
| A device added or renewed by hand                           | `authorizeDevice(account, device, issued, expires)`                   | `authorizeDevice(account, device, { issued, expires })`                        |
| Raw signatures                                              | `sign`, `verify`, `encodeSignature`, `decodeSignature`                | `signUtf8` and `verifyUtf8`                                                    |
| The live map's cells                                        | `liveCellsForView(bbox, maxCells)`                                    | `liveCellsForView(bbox, { maxCells })`                                         |
| A discovery read's cells                                    | `queryCells(bbox, precisionForZoom(zoom))`                            | `cellsForView(bbox, zoom)`, which also limits the count                        |
| A check before placing a policy                             | `unsupportedPolicyFeatures(capabilities, policy, schema)`             | `unsupportedPolicyFeatures(capabilities, policy)`                              |
| A room's games                                              | `roomOpenToGame(room, game)` from the root                            | `gameMayApply(room, op, game)` for the op you are about to send                |
| A room or mailbox subscription                              | any member of the returned socket                                     | only `connected` and `disconnect()`                                            |
| A media URL                                                 | a `try` around `mediaUrl` for a malformed address                     | handle `null` and a throw alike: from 1.0.0 a malformed address returns `null` |
| A browser game's vault unlock                               | `err.name === "OperationError"` for a wrong passphrase                | `isWrongPassphrase(err)`                                                       |

A game reads a third media role as a standalone image with no change.

#### The console

| Where                                         | Old                                                                   | New                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Test fixtures that build sessions and wallets | `walletFromMnemonic(phrase, issued, expires)`, `createWallet(issued)` | `walletFromMnemonic(phrase, { issued, expires })`, `createWallet({ issued })` |
| The wallet dialog's unlock                    | WebCrypto's `operation failed` shown to the operator                  | `isWrongPassphrase(err)` to word a wrong passphrase                           |
| Backup screens                                | `BACKUP_FORMAT`, if read                                              | each manifest's own `format`                                                  |

#### A console plugin

A plugin uses the client SDK and the protocol types as a game does, so the rows under "A game"
apply where a plugin makes the same call. A plugin that subscribes to rooms keeps to `connected`
and `disconnect()` on the handle.

#### The server

| Where                                                                  | Old                                                                                            | New                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/common/understands.filter.ts`                         | `MISSING_CODES` and its own 404 fallback to `unknownRoute`, then `codeFor(error, understands)` | `codeFor(error, understands, { status })`, which applies `NOT_FOUND_FALLBACKS` at 404. Type the five codes from `ErrorCode`. The local test that waits for `CODE_FALLBACKS` to list them should check `NOT_FOUND_FALLBACKS` instead |
| `apps/server/src/common/signed-routes.ts`                              | a local `mailboxFetchParamsSchema`                                                             | `mailboxFetchParamsSchema` from `@beaconsgg/protocol-types`                                                                                                                                                                         |
| `places/admin.service.ts`, `places/snapshot.service.ts`                | `coarsestFitCover(bbox, precision, maxCells, slack)`                                           | `coarsestFitCover(bbox, { precision, maxCells, estimateSlack: slack })`                                                                                                                                                             |
| `profiles.test.ts`, `rooms-service.test.ts`                            | `authorizeDevice(account, device, issued, expires)`                                            | `authorizeDevice(account, device, { issued, expires })`                                                                                                                                                                             |
| `rooms/rooms.service.ts`, `rooms/rooms.gateway.ts`                     | `roomGames`, `roomOpenToGame` from the root                                                    | from `@beaconsgg/protocol-types/server`                                                                                                                                                                                             |
| `backup/backup-job.ts`, `backup/restore-job.ts`                        | `BACKUP_FORMAT` from core                                                                      | the server's own constant                                                                                                                                                                                                           |
| `apps/atlas/cartographer/src/media.ts`, `packages/server/image-encode` | `PLACE_WEBP_QUALITY` from core                                                                 | a constant in `image-encode`                                                                                                                                                                                                        |
| `packages/server/policy-engine/src/markers.ts`                         | `policyMarkers(schema)` or `policyFeatures(schema)`, if passed                                 | the same calls without `schema`                                                                                                                                                                                                     |

The Atlas routes now refuse a `javascript:` or `data:` volume URL with `400 invalid` when they parse
the params, before any fetch.

## 0.4.2

`@beaconsgg/eslint-config`: `beacon-check-internal-refs` carries no private names of its own. The
`org-names`, `private-docs` and `people` rules match only the names a repository lists. The lists
are `orgNames`, `privateDocs` and `people` under `beacon.internalRefs.privatePatterns` in the root
manifest. A JSON file of the same shape passed with `--patterns <file>` adds to them. The `allow` list in the same
object holds exact phrases inside which no match is a finding, such as a copyright holder's legal
name. An unknown field is an error. The check doesn't scan the manifest's own `privatePatterns`
value, or a tracked `--patterns` file. Issue references, phase wording and `§` sections of docs a
repository doesn't ship are still found with no configuration.

A repository that relied on the names built into 0.4.1 has to list them in its root manifest when
it moves to 0.4.2. Without that list the three rules find nothing. The package's README shows the
shape.

## 0.4.1

`@beaconsgg/eslint-config`: `beacon-check-internal-refs` takes `--allow <rule>` with `--strict`.
The strict check then lists the named rule's findings and fails only on the other rules. A
repository whose organization names change only when the repository moves runs
`beacon-check-internal-refs --strict --allow org-names` in its gate, so new issue references,
private docs, phase wording and people's names fail the gate. The root manifest's
`beacon.internalRefs.publicOrg` names the public GitHub organization, and a doc linked by its URL
there no longer counts as private. No consumer has to change code.

## 0.4.0

Release 0.4 is the planned breaking release before 1.0. The release
changes the TypeScript API and some of the client SDK's behavior. No existing field, op or error
code changes meaning. 0.4 therefore keeps the skew window: a 0.3 client works with a 0.4 server and
the other way round (`doc/core-compatibility.md` §6). The servers and the apps move to 0.4 at their own pace.

0.4.0-rc.2 adds three changes found while writing the docs against rc.1: one routing rule, a
refusal you can tell from a fault, and one rule for what throws. The items marked "(rc.2)" below are
new since rc.1. The server, the console and the site moved to rc.1 already, so their tables list the
rc.2 rows separately.

0.4.0 adds three fixes found while writing the docs against rc.2, marked "(0.4.0)" below. A location
read's 2xx reply of the wrong shape is a fault, `DeviceProbe`'s `unknown` always has a `code`, and
the routing rule is stated as the code applies it. No consumer has to change code for them (see
"From rc.2 to 0.4.0" under each consumer).

0.4 includes the 0.3.4 rule for a 404. A 404 is an answer only when its body is the Beacon server's
own `{ ok: false, error }` refusal. Any other 404, such as a reverse proxy's page while the server
restarts, throws a `ServerError` with `status` 404. `discoverCells` and `resolveRoom` follow the
rule too, so a proxy's 404 throws a `ServerError` rather than an `ApiError` with no `code`.

### What changed

`@beaconsgg/client-sdk`:

- `discoverCells(server, cells, options)` takes `{ rooms, scouts, games? }`. `scouts` is required,
  and `rooms: null` asks for rooms of every type. A refused query (a 4xx) throws an `ApiError` with
  the refusal `code` instead of returning the refusal body as a `DiscoveryResponse`.
- `resolveRoom` throws an `ApiError` with the `code` for a 4xx other than 404, and a `ServerError`
  for a 5xx. A 404 keeps the 0.3.4 rule: `null` only for the server's `unknownRoom`, and a
  `ServerError` with `status` 404 for any other 404.
- `probeDevice` returns a `DeviceProbe`: `{ status: "allowed" | "revoked" | "blocked" }`, or
  `{ status: "unknown", code }` with the server's refusal code. The probe declares
  `code:deviceRevoked` on its own request, so `denied` now means a blocked account rather than a
  revoked device. (rc.2) A fault throws instead of giving `unknown`. (0.4.0) `code` is required on
  `unknown`, since every `unknown` is a refusal with its code. A 2xx reply that is neither `ok: true`
  nor a refusal throws a `ServerError`.
- `verifyServer` saves a server under its own host name by default, as `addServer` does.
  `verifyServer(address, { keepAddress: true })` keeps the typed address.
- (rc.2) One routing rule. Every routing function takes the registry's state
  (`ServerRegistryState`) and skips a server refused for a changed key, with no list form left to
  fill from `approvedServers`. A function that chooses among the servers also skips a server that
  never verified. (0.4.0) The rule is now stated so: routing a `unique@host` id chooses nothing,
  since the id names its server, so `resolveServerForId` and `mediaUrl` use the listed entry for
  that host whether or not it verified, as rc.2 already did. rc.2's docs said every routing function
  skipped an unverified server. The functions are `serversForCells`,
  `serversCovering`, `selectCoveringServer`, `serversWithCapability`,
  `serversForCellsWithCapability`, `selectMailboxHost`, `selectMediaHost`, `resolveServerForId` and
  `mediaUrl`. `registryOf(entries)` makes a state for a caller with no player list, such as a
  console with one server or a test driver. The `ServerList` type is gone.
- (rc.2) `selectMailboxHost(state)` and `selectMediaHost(state)` read the player's choice from
  `state.mailboxOrigin` and `state.mediaOrigin`, so the `preferred` parameter is gone.
- (rc.2) `scoutReportServers(state, points)` picks the servers for a scout report: the servers
  covering either end of the trip that the player reports scouts to. The function replaces
  `serversCovering(scoutRelayServers(state), points)`.
- `resolveServerForId` and `mediaUrl` take the registry's state, not origin strings. Both return
  `null` for a server the registry refused for a changed key, unless you pass
  `{ allowKeyRefused: true }` for a read. A bare id (a scout's) goes to the first verified server,
  or `null` when there is none.
- A host that is not on the player's list is reached over `https`. Before
  0.4 such a host always got `http`. A local or private host keeps `http`: `localhost`, a `.local`
  name or a private address.
- `passphraseVault` authorizes each session device for 7 days by default (`sessionTtlSec`,
  `VAULT_SESSION_TTL_SEC`). A server refuses an op that arrives after the expiry with `badsig`,
  a retry of an earlier op included.
- `sendOpWithRetry`'s last parameter also takes `{ attempts, delayMs }`. (rc.2) The method retries
  only a fault, so a refusal or a bug in the caller throws at once.
- (rc.2) A refusal or a fault. `isRefusal(err)` is `true` for the server's own `{ ok: false, error }`
  thrown as an `ApiError` with its `code`. `isFault(err)` is `true` for a `ServerError`, a
  `RequestTimeoutError` and the new `NetworkError`. A `ServerError` is always a fault, and every
  error a request throws is exactly one of the two, except the platform's own error when your
  `signal` aborts the request. The guards take the `unknown` a `catch` gives
  and cover a timeout and a lost connection, which a `kind` field on `ApiError` could not.
- (rc.2) One throw rule: every call except a best-effort one throws a fault and never returns it.
  The best-effort calls are `fetchProfile`, `fetchBestProfile`, `pingServer` and `addServer`. These
  calls change to follow it:
  - `publishProfile` throws a fault, where it returned `{ ok: false, error: "http <status>" }`.
    `error` is now always the server's refusal code.
  - `probeDevice` throws a fault, where it returned `{ status: "unknown" }` with no code.
  - The location reads (`getGeocode`, `getPlaces`, `getPlaceTaxonomy`, `getPlaceDetail`) return
    `null` only for the server's 404 `unknownRoute`, as `resolveRoom` does for `unknownRoom`. Any
    other refusal, such as `invalid` or `rateLimited`, throws an `ApiError`. They returned `null` for
    any 4xx before. (0.4.0) A 2xx body of the wrong shape throws a `ServerError` too, where rc.2
    returned `null`, so a game that deletes or forgets something on `null` never does so for a
    reply the server did not mean.
  - (0.4.0) `resolveRoom` throws a `ServerError` for a 2xx body that is not a JSON object. A JSON
    `null` returned `null`, which read as `unknownRoom`. The room is still handed back as received
    otherwise, so a field a newer server adds still reads.
  - `getDescriptor` throws a refusal, where it returned the refusal body as the descriptor.
  - The `...OrThrow` calls, `verifyServer` and `parseOrThrow` throw a `ServerError` for a fault,
    where they threw a plain `ApiError` with the body's message.
- (rc.2) A locked server's `writeLocked` is a refusal from every call: an `ApiError` with the code
  and `retryAfterSec`, which moves from `ServerError` to `ApiError`. The game-facing calls threw a
  `ServerError` and `publishProfile` returned the code before. `sendOpWithRetry` still throws it at
  once.
- (rc.2) The 0.3.4 rule for a 404 now covers every status. A reply outside 2xx without the server's
  `{ ok: false, error }` body is a fault from every call, such as a CDN's own 403 page or the 413 of
  the server's body parser. A write returned such a reply as a result with no `ok`, or threw a
  `SyntaxError` for an HTML page. A 404 with a code other than the one a read treats as "not there"
  is that refusal, where it was a `ServerError`. A 2xx body that is not JSON, such as a captive
  portal's page, is a fault too, and so `sendOpWithRetry` retries it. The body of every reply
  outside 2xx is read under a time limit and a size limit: 4 KiB for a 5xx or 404 and 64 KiB for any
  other 4xx.
- (rc.2) A request that fails with no reply, such as on a lost connection, throws a `NetworkError`
  with the platform's error as `cause`. A request your own `signal` aborted still throws the
  platform's error.
- `ScoutReport` (the input of `reportScout`) is renamed `ScoutReportInput`.
- New names: `DiscoverOptions`, `DeviceProbe`, `RetryOptions`, `VerifyServerOptions`,
  `RouteOptions` and `VAULT_SESSION_TTL_SEC`. (rc.2) `registryOf`, `scoutReportServers`,
  `isRefusal`, `isFault` and `NetworkError`.

`@beaconsgg/protocol-types`:

- `parseUnderstands`, `codeFor`, `CODE_FALLBACKS`, `policyFeatures`, `opMarkers`, `policyMarkers`,
  `ruleMarkers`, `unknownFields` and `paramsRefusal` move from the root to
  `@beaconsgg/protocol-types/server`.
- `roomSchema` and `identitySchema` refuse unknown keys. Read a room or an identity someone else
  sent with `roomReadSchema` or `identityReadSchema`, and verify a signed part over the raw value.
- `MAX_MAILBOX_BODY` counts 4096 bytes of UTF-8, not characters, and `mailboxSendParamsSchema`
  checks bytes. `mailboxBodyBytes(body)` measures a body.
- `serverForHost` falls back to `originForHost(host)`: `https` for a public host.
- `DiscoveryQuery.limit`, `DiscoveryQuery.cursor` and `DiscoveryResponse.cursor` are gone. They were
  deprecated in 0.3.3, and no server read or sent them.

`@beaconsgg/identity`:

- `walletFromMnemonic(mnemonic, issued?, expires?)` takes an expiry. Leaving it out keeps the old
  behavior.

### Migration

Raise every `@beaconsgg/*` range to `^0.4.0` (or the release candidate), all seven together.

#### Server (beacon.server)

| Where                                                                                                                                       | Old                                                                                            | New                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/common/understands.filter.ts`, `apps/server/src/mailbox/mailbox.gateway.ts`                                                | `codeFor` and `parseUnderstands` from `@beaconsgg/protocol-types`                              | from `@beaconsgg/protocol-types/server`; `UNDERSTANDS_HEADER` stays in the root                                                                                                                                |
| `apps/server/src/common/capability-http.ts`, `apps/server/src/common/signed-request.ts` and `packages/server/policy-engine/src/handlers.ts` | `paramsRefusal` from the root                                                                  | from `@beaconsgg/protocol-types/server`                                                                                                                                                                        |
| `packages/server/policy-engine/src/markers.ts`                                                                                              | `opMarkers`, `policyMarkers` and `ruleMarkers` from the root                                   | from `@beaconsgg/protocol-types/server`                                                                                                                                                                        |
| `apps/server/src/__tests__/understands-filter.test.ts`                                                                                      | `CODE_FALLBACKS` from the root                                                                 | from `@beaconsgg/protocol-types/server`                                                                                                                                                                        |
| `packages/server/policy-engine/src/__tests__/stored-rooms.test.ts`                                                                          | `roomSchema` accepted unknown top-level keys                                                   | strict: every stored room fixture must parse, or the store has a key the schema lacks                                                                                                                          |
| `apps/server/src/docs/openapi.ts`                                                                                                           | `Room` from `roomSchema`; discovery's `limit` and `cursor` written by hand                     | the generated `Room` gains `additionalProperties: false`; delete the hand-written `limit` and `cursor` lines                                                                                                   |
| The `BEACON_MAILBOX_MAX_BODY` setting (`settings/registry.ts`)                                                                              | `positiveInt` with no upper bound                                                              | bound it at `MAX_MAILBOX_BODY` (4096 bytes) in the setting's schema, so neither the environment nor the console can raise it past the wire cap                                                                 |
| `mailbox.controller.ts` `POST /mailbox`                                                                                                     | `mailboxSendParamsSchema` (4096 characters), then the server's own byte limit (`413 tooLarge`) | the schema now counts bytes, so a body of 4097 to 16384 bytes gets `400 invalid` before the byte check. Check the server's limit first, or answer `tooLarge` for a body the schema refused only for its length |
| `packages/server/server-runtime/src/scout-relay.ts`                                                                                         | `ScoutReport` from `@beaconsgg/protocol-types`                                                 | unchanged: the stored report keeps the name                                                                                                                                                                    |
| A new engine test                                                                                                                           | none                                                                                           | a blocked account's op on a room that does not exist answers `denied` and not `unknownRoom`; `probeDevice` relies on it                                                                                        |

**The flows driver** (`apps/flows`) needs no change. The driver calls `verifyServer(server)` and then
uses the address it was given. The new default only adds one descriptor request when the server's
own host differs from that address. The driver calls `sendOpWithRetry` without the last parameter
and `resolveRoom` only on rooms it placed. A driver test that injects a 500 can pass
`{ delayMs: 0 }` once the driver no longer has to run over a 0.3 SDK.

From rc.1 to rc.2 neither the server nor the driver has to change. The server uses no routing
function. The driver checks `published.ok` after `publishProfile`, which now throws a fault, so a
500 on the publish reports `threw ServerError: server error 500` instead of
`publish refused: http 500`. The e2e test for it matches `/500/`, so it passes either way. A lost
connection now throws a `NetworkError`, and the driver's own `attempt` reports it like any other
throw.

From rc.2 to 0.4.0 neither has to change. The driver calls `resolveRoom` only on rooms a Beacon
server placed, and calls no location read, `probeDevice` or routing function.

#### Console (beacon.admin)

| Where                                     | Old                            | New                                                                                                                                                 |
| ----------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin/features/servers/registry.ts` | `client.verifyServer(address)` | `client.verifyServer(address, { keepAddress: true })`, so a server reached by an internal address keeps that address                                |
| `apps/admin/features/wallet/vault.ts`     | sessions never expired         | sessions last 7 days; pass `sessionTtlSec` to choose, and ask for the passphrase again when a write is refused `badsig` after `wallet.auth.expires` |
| `apps/admin/features/places/logic.ts`     | its own `mediaUrl(uri)`        | unchanged; it does not use the SDK's                                                                                                                |

From rc.1 to rc.2 the console needs no code change, since it calls no routing function and
`describeApiError` reads the refusal code first. These change under it:

| Where                                                                            | Old (rc.1)                                                                                          | New (rc.2)                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/api.ts` `describeApiError`                                                  | a lock was a `ServerError` from a plugin's `postSigned` and an `ApiError` from an `...OrThrow` call | an `ApiError` from both, which `describeRefusal` already words. A `ServerError` is any fault: a 5xx, and a 4xx or 404 without the server's body. Its 404 and 403 sentences still match by `status` |
| `lib/__tests__/api.test.ts`, `features/backup/__tests__/useRunFollower.test.tsx` | `new ServerError(503, "writeLocked", 60)` as "a game-facing call"                                   | `new ApiError(503, "locked", "writeLocked", 60)`, as every call now throws it                                                                                                                      |
| `features/wallet/profileApi.ts` `publishOperatorProfile`                         | a fault came back as `{ ok: false, error: "http <status>" }`                                        | the fault and a lock land in the existing `catch`, so a row reads `Server error <status>.` or the lock sentence                                                                                    |
| The `...OrThrow` calls                                                           | a 5xx threw an `ApiError` with the body's `message`                                                 | a `ServerError` with the message `server error <status>`; `isFault(err)` is `true`                                                                                                                 |

From rc.2 to 0.4.0 the console needs no change. The console calls no location read, no
`probeDevice` and no routing function, and its own `mediaUrl` in `features/places/logic.ts` stays.

#### A game

These notes cover a game's app, its shared packages and any bot that plays it through them. A bot
that reaches the SDK only through the game's packages raises its core ranges together with those
packages, and passes a registry state into them once they take one.

Discovery:

| Where                                                   | Old                                             | New                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A discovery call by room type                           | `client.discoverCells(server, cells, types)`    | `client.discoverCells(server, cells, { rooms, scouts })`: pass `scouts: true` where `types` held `scout`, and leave `scout` out of `rooms` |
| A discovery call for every room type                    | `client.discoverCells(server, cells, [], null)` | `client.discoverCells(server, cells, { rooms: null, scouts: false, games: null })`                                                         |
| A game's own discovery wrapper with a `types` parameter | the wrapper passed `types` to the SDK           | the wrapper can keep its `types` parameter and map it to the options object as above, so its own callers don't change                      |
| Tests that call the SDK or assert its arguments         | the positional call                             | the options object                                                                                                                         |
| Tests that assert the query string                      | `types=jar,capsule,scout,challenge`             | the SDK puts `scout` last: `types=jar,capsule,challenge,scout`                                                                             |
| Every discovery caller                                  | a refusal came back as a body with no `rooms`   | a refusal throws an `ApiError`, so catch per server                                                                                        |

Routing by id and media URLs. A game can read and show a room or a file on a server refused for a
changed key, and skip that server only for its writes and settlements. Keep that with
`{ allowKeyRefused: true }` at the read-only sites.

| Where                                       | Old                                                                                     | New                                                                                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing a room by id to read or show it     | `resolveServerForId(id, origins)`                                                       | `resolveServerForId(id, registry, { allowKeyRefused: true })`; the result is `string \| null`, so every caller that receives it handles `null`                                                      |
| Routing a room by id to settle a membership | `resolveServerForId(roomId, origins)`, then skip a server in `origins` but not approved | `resolveServerForId(roomId, registry)` and skip on `null`. Keep the check that the server is on the approved list before settling: a 404 from a server not on the list must not settle a membership |
| Building a media URL                        | `mediaUrl(address, origins)`                                                            | `mediaUrl(address, registry, { allowKeyRefused: true })`; the result is `string \| null`, `null` only for an address whose host is not a host name                                                  |
| Tests and fakes built on origin strings     | origin strings, and the `http://<host>` fallback                                        | the registry, and the `https` fallback                                                                                                                                                              |
| Tests of `serverForHost`                    | `serverForHost("unknown.example", [])` is `http://unknown.example`                      | `https://unknown.example`; a local or private host stays `http`                                                                                                                                     |
| Comments that describe the fallback         | the `http://<host>` fallback                                                            | the `https` fallback                                                                                                                                                                                |

Routing over the registry (rc.2). Every routing function takes the registry's state, so pass the
state (`ServerRegistryState`) where the code passes the approved list today. The SDK skips an
unverified or refused server itself. Keep the list for what the game shows or counts. A game or a
bot that keeps its servers as a plain list makes a state with `registryOf(entries)` and passes that.

| Where                                                  | Old                                                                                                                     | New                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A game's own helpers that take the servers for routing | `servers: readonly ServerEntry[]`, the approved list                                                                    | `ServerRegistryState`; read the descriptors from `state.servers`                                             |
| The routing calls                                      | `serversForCells(servers, …)`, `serversForCellsWithCapability(servers, …)`, `serversWithCapability(servers, "mailbox")` | the same calls over the state                                                                                |
| The mailbox and media hosts                            | `selectMailboxHost(servers, mailboxOrigin)`, `selectMediaHost(servers, mediaOrigin)`                                    | `selectMailboxHost(registry)` and `selectMediaHost(registry)`, which read the player's choice from the state |
| A scout report                                         | `serversCovering(scoutRelayServers, relayPoints(movement))`                                                             | `scoutReportServers(registry, relayPoints(movement))`; keep the relay list for what the game shows and signs |
| A list of origins kept only for routing by id          | the origins passed to `resolveServerForId` and `mediaUrl`                                                               | delete it: the routing-by-id rows above pass the state                                                       |
| Mocks and fakes that take a list                       | a list of servers                                                                                                       | a state: `registryOf(list)` or `{ servers: list }`                                                           |

Errors (rc.2):

| Where                               | Old                                                          | New                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `publishProfile(…).catch(…)`        | a fault came back as `{ ok: false, error: "http <status>" }` | unchanged: a fault and a lock land in the `catch`. A test mock that resolved `http 503` now rejects      |
| The location reads and their caches | `null` for any 4xx                                           | `null` only for `unknownRoute`; a `400` or `429` throws, which each caller handles as it handles a fault |
| A check for a fault                 | a fault is a `ServerError`, which is an `ApiError`           | unchanged; `isFault(err)` reads better than the classes                                                  |
| Any check for a network failure     | the platform's `TypeError`                                   | a `NetworkError` with the platform's error as `cause`                                                    |

Other:

| Where                         | Old                                                 | New                                                     |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Tests that read `understands` | `parseUnderstands` from `@beaconsgg/protocol-types` | from `@beaconsgg/protocol-types/server`                 |
| A wrapper of `probeDevice`    | `Promise<string>`                                   | `Promise<DeviceProbe>`. (rc.2) The probe throws a fault |

From rc.2 to 0.4.0 a game needs no code change:

| Where                               | Old (rc.2)                                                          | New (0.4.0)                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The location reads and their caches | a 2xx body of the wrong shape gave `null`, which a cache could keep | a `ServerError`, which each caller already handles as a fault: a cache asks again after its cool-down rather than keep `null` |
| `resolveRoom` callers               | a 2xx JSON `null` gave `null`, the answer for a room that is gone   | a `ServerError`; never delete a saved room on a throw                                                                         |
| A wrapper of `probeDevice`          | `{ status: "unknown", code?: string }`                              | `code` is required                                                                                                            |
| Routing by id and media URLs        | a listed server that never verified got the request                 | unchanged; only the docs now say so                                                                                           |

#### A console plugin

| Where                                           | Old                                                  | New                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A discovery call for one room type              | `client.discoverCells(origin, cells, ["challenge"])` | `client.discoverCells(origin, cells, { rooms: ["challenge"], scouts: false })`                 |
| Tests that call the SDK or assert its arguments | the positional call                                  | the options object                                                                             |
| A check for a fault                             | a fault is a `ServerError`, which is an `ApiError`   | unchanged; `isFault(err)` reads better than the classes                                        |
| (rc.2) A lock from `postSigned`                 | a `ServerError`                                      | an `ApiError` with the code `writeLocked` and `retryAfterSec`, which the console already words |

#### The documentation and its examples

| Where                                       | Old                                                                             | New                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| The live updates example                    | `discoverCells(SERVER, cells, ["jar", "scout"])` (2 calls)                      | `discoverCells(SERVER, cells, { rooms: ["jar"], scouts: true })`                                                                          |
| The scouts example                          | `discoverCells(origin, [cell], ["scout"])`                                      | `discoverCells(origin, [cell], { rooms: [], scouts: true })`                                                                              |
| The many-servers example                    | `discoverCells(origin, cells, ["guide-jar"])` (2 calls)                         | `discoverCells(origin, cells, { rooms: ["guide-jar"], scouts: false })`                                                                   |
| The many-servers example                    | `resolveServerForId(id, all)` over origin strings                               | `resolveServerForId(id, entries)` over `ServerEntry` objects; the result can be `null`                                                    |
| The slugs example                           | `discoverCells(target, cells, ["tidewalk-jar"])`                                | `discoverCells(target, cells, { rooms: ["tidewalk-jar"], scouts: false })`                                                                |
| The player services example                 | `mediaUrl(put.id, origins)`                                                     | `mediaUrl(put.id, entries)`                                                                                                               |
| The wallet example                          | logs `probeDevice`'s string                                                     | log `(await client.probeDevice(server, w)).status`; mention the vault's 7-day sessions                                                    |
| The many-servers page                       | the `http://<host>` warning, positional discovery                               | the `https` fallback, the options form and `ApiError` for a refused query                                                                 |
| The server list and server descriptor pages | `verifyServer` keeps the typed address                                          | `verifyServer` saves the server's own host, with `keepAddress` for a console                                                              |
| The wallets page                            | `probeDevice` reads `denied` as revoked; vault sessions never expire            | the four statuses; sessions expire after 7 days                                                                                           |
| The error codes page and the errors guide   | `resolveRoom` throws `ServerError` for anything but 2xx and a 404 `unknownRoom` | `ApiError` for a 4xx other than 404, `ServerError` for a 5xx or a 404 other than `unknownRoom`; discovery throws `ApiError` for a refusal |
| The player services page                    | `mediaUrl(id, origins)`                                                         | `mediaUrl(id, entries)`, `null` for a refused server                                                                                      |
| The scouts page                             | "include `scout` in `types`"                                                    | pass `scouts: true`                                                                                                                       |
| The limits page                             | the mailbox body is 4096 characters; the `limit` and `cursor` sentence          | 4096 bytes of UTF-8, measured with `mailboxBodyBytes`; no paging                                                                          |
| The games page                              | "pass `null` as the games filter" positionally                                  | `games: null` in the options                                                                                                              |
| The SDK reference                           | 0.3 names                                                                       | regenerate once against 0.4                                                                                                               |

From rc.1 to rc.2:

| Where                                            | Old (rc.1)                                                                                                                                                 | New (rc.2)                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The many-servers example                         | `selectCoveringServer(servers, dam)`, `selectCoveringServer([b], dam)`, `serversForCells(servers, cells)` and `resolveServerForId(id, servers)` over lists | the same calls over a state: `registryOf(servers)` and `registryOf([b])`, or a registry built with `serverRegistryReducer`. The two scout reports (`serversCovering(servers, …)`) become `scoutReportServers(registry, …)` |
| The many-servers example                         | `answer.reason instanceof ApiError && !(answer.reason instanceof ServerError)`                                                                             | `isRefusal(answer.reason)`                                                                                                                                                                                                 |
| The scouts example                               | `serversCovering(servers, [amsterdam, utrecht])`, `serversCovering(servers, [point])`                                                                      | `scoutReportServers(registry, [amsterdam, utrecht])` for the report, `serversCovering(registry, [point])` for the read                                                                                                     |
| The slugs example                                | `selectCoveringServer` over a list                                                                                                                         | over a state                                                                                                                                                                                                               |
| The player services example                      | `selectMailboxHost(servers, a.origin)`, `selectMediaHost(servers, a.origin)`                                                                               | `selectMailboxHost(registry)` and `selectMediaHost(registry)` after `setMailbox` and `setMedia` actions, or `{ ...registryOf(servers), mailboxOrigin: a.origin }`                                                          |
| The player services example                      | `mediaUrl(put.id, servers)`, `serversForCellsWithCapability(servers, …)`                                                                                   | the same calls over the state                                                                                                                                                                                              |
| The errors example                               | `err instanceof ServerError && err.code === "writeLocked"`, then `err instanceof ServerError` for a fault                                                  | `isRefusal(err) && err.code === "writeLocked"`, then `isFault(err)`, which covers the timeout branch too                                                                                                                   |
| The wallet example                               | `probeDevice` never threw                                                                                                                                  | the probe throws a fault; the guide's server is up, so the logs are unchanged                                                                                                                                              |
| The many-servers and server list pages           | `approvedServers(state)` for the routing calls, and routing by id as the exception                                                                         | one rule: every routing call takes the state; `approvedServers` is for showing the list; `registryOf` for a list with no registry                                                                                          |
| The scouts and many-servers pages                | `serversCovering` picks a scout report's servers                                                                                                           | `scoutReportServers(state, points)`, which also applies the player's scout reporting choice                                                                                                                                |
| The player services page                         | `selectMailboxHost(entries, preferred)` and `selectMediaHost(entries, preferred)`                                                                          | `selectMailboxHost(state)` and `selectMediaHost(state)`, which read the player's choice from the state                                                                                                                     |
| The errors, error codes and client methods pages | `writeLocked` as a `ServerError`, `publishProfile`'s `http <status>`, "the network's own error", `ServerError` only for a 5xx or a 404                     | quote the rule in `doc/game-author.md` §5.3: a fault always throws; `isRefusal` and `isFault`; `writeLocked` an `ApiError` from every call; a `NetworkError` for a lost connection                                         |
| The places page                                  | the location reads give `null` for any 4xx                                                                                                                 | `null` only for `unknownRoute`; another refusal throws an `ApiError`                                                                                                                                                       |
| The wallets page                                 | "The probe never throws"                                                                                                                                   | the probe throws a fault, so catch per server                                                                                                                                                                              |
| The SDK reference                                | rc.1                                                                                                                                                       | regenerate against rc.2                                                                                                                                                                                                    |

From rc.2 to 0.4.0 no example changes. The pages that describe the changed behavior:

| Where                 | Old (rc.2)                                                                        | New (0.4.0)                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The places page       | the location reads return `null` for `unknownRoute` or a reply of the wrong shape | `null` only for `unknownRoute`; a reply of the wrong shape is a fault                                                                           |
| The wallets page      | "`unknown` always carries the refusal code"                                       | unchanged, and now in the type: `code` is required on `unknown`                                                                                 |
| The many-servers page | routing by id goes to a listed server that has not verified                       | unchanged; quote the rule as stated now: the refusal check applies to every routing call, the verified check where a call chooses among servers |
| The SDK reference     | rc.2                                                                              | regenerate against 0.4.0                                                                                                                        |
