# @beaconsgg/client-sdk

**`[C]` client-bound (RN-safe).** The SDK holds everything a game's client needs to talk to a Beacon
server. The caller hands in the platform pieces, and the SDK imports none of them. Every game and the operator
console share this one client instead of keeping copies.

## What the package gives you

```ts
import { io } from "socket.io-client";
import {
  createClient,
  emptyRegistry,
  selectCoveringServer,
  serverRegistryReducer,
} from "@beaconsgg/client-sdk";

const client = createClient({
  connect: io, // socket.io-client's `io`: the live channel's socket
  understands: ["code:deviceRevoked"], // the error codes this build has something to say about
  game: "my-game", // signed into every write, and the default filter on every read
});

const entry = await client.addServer("https://beacon.example"); // fetch + verify the descriptor
const registry = serverRegistryReducer(emptyRegistry, { type: "add", entry }); // the player's list

const target = selectCoveringServer(registry, { lat: 37.77, lng: -122.42 });
if (target) await client.placeRoom(target, wallet, placeParams);
```

### The client

`createClient` returns the client. The client's methods close over the config, so an app can
destructure them and export them again under its own names. The client covers these calls:

- signed writes: `sendOp`, `sendOpWithRetry`, `postSigned`, `placeRoom`, `reportScout`,
  `cancelScout`, `putMedia` and `proposePlace` (`sendOpWithRetry` retries with the same nonce);
- the platform reads: `getDescriptor`, `discoverCells`, `resolveRoom`, geocoding and places;
- the mailbox operations and the handshake envelope;
- publishing and fetching a profile;
- `requestAccess` and `fetchAccess`, to ask to join a server at the `request` level and to read
  where the player stands;
- `probeDevice` and `addServer`. `probeDevice` answers `allowed`, `revoked`, `blocked` or `unknown`
  for the player's device.

`discoverCells(server, cells, { rooms, scouts, games })` takes the room types and a required
`scouts`, so a game always chooses whether scouts come back. `rooms: null` asks for rooms of every
type.

### Errors

Every call except a best-effort one throws a fault and never returns it, so whatever such a call
returns is the server's own answer. The best-effort calls are `fetchProfile`, `fetchBestProfile`,
`pingServer` and `addServer`.

- A fault is any of these: a 5xx, a timeout, a lost connection or a reply the server did not send.
  `isFault(err)` is `true` for its error: a `ServerError`, `RequestTimeoutError` or `NetworkError`.
  Try again later, and never delete anything on a fault.
- A refusal is the server's own `{ok:false,error}` body. A call returns the refusal where its result
  has a place for one: `ok: false` in a result that has `ok`, the probe's `unknown` or `null` from a
  read for something that is not there. Every other call throws the refusal as an `ApiError` with
  the `code`, and `isRefusal(err)` is `true`.
- A locked server's `writeLocked` is the one refusal every call throws. The `ApiError` carries
  `retryAfterSec` from the reply's `Retry-After`.

A 404 says something is absent only when its body is the server's refusal, such as `unknownRoom`. A
reverse proxy answers a 404 of its own while the server behind the proxy restarts, and every call
throws that reply as a fault: a `ServerError` with `status` 404. `resolveRoom` gives `null` only for
`unknownRoom`, and the location reads only for `unknownRoute`. A 2xx reply they cannot read is a
fault too, so `null` is always the server's own answer. A captive portal's page is one such reply,
and so are a location read's JSON of the wrong shape and a room that is not a JSON object. Discovery
throws a refused query.

```ts
try {
  await client.sendOpWithRetry(server, wallet, roomId, "take", params);
} catch (err) {
  if (isFault(err)) showOffline(); // retried already: try later or another server
  else if (isRefusal(err) && err.code === "writeLocked") showLocked(err.retryAfterSec);
  else throw err;
}
```

### The throwing calls

Some callers treat every refusal as an error to show, as an operator console does. The client has
throwing calls for them:

- `getOrThrow`, `postSignedOrThrow` and `uploadSignedOrThrow` (the `{env, data}` shape) throw for
  any status outside 2xx: an `ApiError` for a refusal and a `ServerError` for a fault.
- The refusal's `ApiError` carries the HTTP `status`, the wire `message` and the server's `code`. That
  code is the `error` of an `{ok:false,error}` body such as `gameNotAdmitted`. A caller switches on
  `err.code` once `isRefusal(err)` is `true`.
- `verifyServer` is the strict twin of `addServer` and saves a server the same way. `verifyServer`
  throws the same errors, or a plain `Error` for a descriptor that fails its check. A console that
  reaches a server by an internal address passes `{ keepAddress: true }` to keep that address.
- `sign` returns an envelope without sending the envelope, for a route whose body the client doesn't
  carry.

The package also exports the decoders behind these calls. `parseOrThrow` decodes a body, `on404`
turns a 404 into a fallback and `fieldIssues` splits a 400 into refusals per field. `on404` turns
every 404 `ApiError` into its fallback, including a proxy's `ServerError`.

### The live channel

The client opens three subscriptions: `subscribeRoom`, `subscribeMap` and `subscribeMailbox`. Each
subscription declares again what it is for on every reconnect and tells the caller, so the caller
can catch up. `subscribeRoom` and `subscribeMailbox` return a handle for that one subscription:
`disconnect()` ends it and `connected` says whether its socket is up. Rely on only those two
members, since a later release may share one socket between the subscriptions to a server. The package also exports these helpers:

- `applyMapDelta`, the pure rule a map applies to what arrives;
- `pushCells`, which declares the watched cells again after a pan or a zoom;
- `pollDiscovery`, the fallback when a view has too many cells for live updates;
- `scoutPosition`.

### The transport

The transport is a timed `fetch` (`REQUEST_TIMEOUT_MS` and `RequestTimeoutError`) that sorts each
reply outside 2xx into a refusal or a fault. A failed request with no reply throws a `NetworkError`
with the platform's error as `cause`. `ServerError` extends `ApiError`, so a catch for `ApiError`
catches both. Use `isRefusal` and `isFault` to tell them apart.

A `ServerError` carries the `code` of a 5xx body too, and `retryAfterSec` from the reply's
`Retry-After`. The transport reads a 5xx or 404 body only when it is JSON of at most 4 KiB that
arrives within 2 seconds. A custom `fetch` whose replies have no `headers` or `text` has every body
read with `json()`. `sendOpWithRetry` retries only a fault. The waits are about 0.5 seconds and then
1.5 seconds, and a lock throws at once. The last parameter of `sendOpWithRetry` takes
`{ attempts, delayMs }`. A test passes `{ delayMs: 0 }` to retry at once.

### Servers

The server functions are pure. A descriptor fetch produces a `ServerEntry`, and the package routes
over the registry's state:

- the fan-out for reads;
- the single server that covers a write;
- capability lookups;
- the designated mailbox and media hosts;
- `unique@host` resolution and media URLs.

`normalizeServerUrl` turns a typed address into an origin through `originForHost`, so
`beacon.example` becomes `https://beacon.example`. `client.addServer` and `client.verifyServer`
apply that rule. A player can reach a verified server by another name, such as a domain in front of
a hosted server. Once the name in the server's descriptor answers with the same key, both save the
server under that name. The ids the server mints then route to the saved entry. When the player
adds the server again under its own name, the registry folds that entry into the one saved by the
alias.

Every routing function takes the registry's state and applies one rule itself. Nothing goes to a
server the registry refused for a changed key. A function that chooses among the servers also
chooses only a server whose descriptor verified. Routing a `unique@host` id chooses nothing because
the id names its server. `resolveServerForId` and `mediaUrl` use the listed entry for that host
whether or not it verified, and reach a host not on the list too. A bare id such as a scout's names
no server and goes to the first verified one. The functions are `serversForCells`,
`serversCovering`, `scoutReportServers`, `selectCoveringServer`, `serversWithCapability`,
`serversForCellsWithCapability`, `selectMailboxHost`, `selectMediaHost`, `resolveServerForId` and
`mediaUrl`. `resolveServerForId` and `mediaUrl` take `{ allowKeyRefused: true }` for a read-only
use, such as showing a room the player already has. A caller with no player list passes
`registryOf(entries)`, as a console with one server does. `approvedServers(state)` is for showing or
counting servers and never for routing.

A host the list does not hold gets the same scheme rule as a typed address: `https`, and `http` for
a local or private host.

### The registry

The registry is a pure reducer for the list of approved servers, and the registry answers the
questions asked of that list. The reducer covers these changes:

- add, remove and reorder;
- the designated hosts;
- the servers that scouts are reported to.

`null` means off in every setter. `setMailbox` and `setMedia` with `null` clear the host, and
`setScoutRelay` with `null` reports scouts nowhere. While no list is set scouts go to every server,
including servers added later. `resetScoutRelay` returns to that default.

A saved server is pinned to the key it verified with. A refresh checks `serverIdentityChanged`
before adopting a descriptor fetched again. A different key at a familiar address is refused and
never absorbed, and a failed add never replaces a verified entry. A player accepts a genuine key
rotation by adding the address again on purpose. The registry records a refused refresh as the
`identityChanged` action, and the reducer marks the server's entry `keyRefused`. Every routing
function reads both, so coverage, capability and the mailbox and media hosts leave the server out.
`resolveServerForId` and `mediaUrl` route by the host in an id, and return `null` for a refused
server rather than reach the same host another way. A screen that shows what the server holds passes
`{ allowKeyRefused: true }`, as does a screen that asks the player about the new key. The mark stays
until an entry for the server is written again. Either the player adds the server again, or a
refresh finds the pinned key.

### Key custody

The SDK has two policies for keeping keys.

**With secure storage, as on a phone.** The wallet puts the recovery phrase first. Each function
takes a `SecureKeyStore` that the caller passes in:

- `loadOrCreateWallet`;
- `loadWallet`;
- `importWalletFromPhrase`;
- `revealRecoveryPhrase`;
- `resetWallet`;
- `deleteWallet`.

`newDevice` adds a device that an account manages, and `deviceWallet` signs as one of those devices.
`deviceWallet` throws for a record that couldn't sign as the device it names, instead of signing
operations the server would refuse. Such a record has one of these faults:

- a seed that isn't exactly 32 bytes;
- a key for another device;
- an authorization that isn't a well-formed and valid root signature for the device.

`deviceWallet` holds a managed device to the same rule that `loadWallet` holds the stored device to,
and says so when the authorization has only expired. `loadWallet` rebuilds a stored device that
can't sign from the recovery phrase. The device key persists.

**Without secure storage, as in a browser.** `passphraseVault({ store, key })` keeps only the
recovery phrase, encrypted with a passphrase (PBKDF2-SHA-256 and then AES-256-GCM through
WebCrypto). Each `unlock` assembles a session wallet with a fresh device, and nothing shaped like a
key persists. The session device's authorization expires after `sessionTtlSec`, 7 days by default
(`VAULT_SESSION_TTL_SEC`). A session device never appears in the profile, so nothing else could
revoke a leaked session key. A server refuses an op that arrives after the expiry with `badsig`, a
retry of an earlier op included. Read `wallet.auth.expires` and ask for the passphrase again. The
vault has five methods: `create`, `importPhrase`, `unlock`, `hasSaved` and `forget`. A wrong
passphrase makes `unlock` throw a `WrongPassphraseError`. Check with `isWrongPassphrase(err)` and
ask again.

## What you inject

| Option        | Default                           | Why it is injected                                               |
| ------------- | --------------------------------- | ---------------------------------------------------------------- |
| `fetch`       | the global `fetch`, read per call | a test double, or a platform without one                         |
| `now`         | `Date.now`                        | scout-report expiry and ping timing, deterministic in tests      |
| `timeoutMs`   | `REQUEST_TIMEOUT_MS` (15 s)       | React Native's `fetch` has no timeout of its own; `null` is none |
| `understands` | none sent                         | only the app knows which codes it has a sentence for             |
| `game`        | none sent                         | only a game has a slug; an operator console configures none      |
| `connect`     | none: a live subscription throws  | the SDK names no socket library; the app passes socket.io's `io` |

Key custody takes its storage separately. Every wallet function's last argument is a
`SecureKeyStore` with `getItem`, `setItem` and `deleteItem`. A vault takes a store in its config,
with the key its envelope lives under. A vault can also take a WebCrypto implementation, and uses
the global one by default. On a phone the store is the platform's secure storage, such as
`expo-secure-store`. A browser has no secure storage, and the vault exists for that case. The
operator console hands the vault `localStorage`.

## What stays in the game

The operation builders and their vocabulary stay in the game:

- the game's room types;
- the game's scout config type;
- the types the game asks discovery for;
- any copy a player reads.

`discoverCells` takes the room types with no default, so one game's list never becomes another's.
