# Identity

How Beacon identifies players and servers. This spec says how ops, provenance and profiles are
signed and verified. This spec also covers profiles, revocation and the key lifecycle. The
`@beaconsgg/identity` package implements it, with the wire shapes in `@beaconsgg/protocol-types` and
key custody in `@beaconsgg/client-sdk`.

Checked against Beacon 0.3.

## 1. Goals

Identity in Beacon is built to these goals:

1. **The player owns the identity.** No server issues or holds a player's identity, and the
   identity survives the loss of any server. Rooms and items work the other way: they live on a
   server and are lost with it.
2. **Ops are attributable.** Every state-changing op is tied by signature to the account that sent
   it. Roles and custody depend on that. Signatures attribute actions and are no defense against
   cheating (§3).
3. **Provenance is verifiable.** A `mintedBy` block can be checked by anyone, so a block list can't
   be dodged by forging a name.
4. **Privacy comes first.** A player can play, own items and contribute while revealing nothing but
   a bare key. Whether a profile is published is the player's choice.
5. **Identity is recoverable and portable.** Several devices and key rotation are routine. Moving
   between servers doesn't touch the identity. Losing the account root with no backup is the one
   case Beacon can't recover from.
6. **The server stays simple.** Servers host copies of profiles and record who acted. A server is
   never the root of anyone's identity.

## 2. What an identity is

An identity is an Ed25519 account root keypair. The account is the durable identity, and no single
signing key is. Each device signs day-to-day ops with a device key that the account root has
authorized.

Beacon deliberately doesn't use the simpler model in which one key is the whole identity. With one
key a player can't rotate keys or use a second device, since a second device would need the same
secret or would be a different person. A Beacon account lasts a lifetime, so Beacon splits the keys:

- **Account root.** The durable identifier is the `did:key` of the root key. A recovery phrase backs
  up the root (§10.1). The root exists to authorize device keys and to sign the profile. The root
  doesn't sign everyday ops.
- **Device keys.** Each device generates its own Ed25519 key, and the root signs an authorization
  for that key. Ops are signed by the device key and attributed to the account.
- **Private keys stay on their device.** On a phone they live in the platform's secure storage. The
  SDK takes that storage as an injected `SecureKeyStore` and never names one.
- **Logging in means unlocking the local device key.** Beacon has no server-side passwords.

The split gives a player several devices and lets a player revoke one device without losing the
account. The split can also keep the root off everyday devices, though the phone wallet in the SDK
keeps the recovery phrase on the device today (§10.3).

### 2.1 Self-certifying at the account level

The account DID is a `did:key` that contains the root public key:

```text
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
        └──────── multibase-encoded Ed25519 root public key ────────┘
```

The encoding is the multicodec prefix `0xed 0x01` followed by the 32-byte public key, in base58btc
with the multibase prefix `z`. `encodeDidKey` and `decodeDidKey` implement it.

The root key sits inside the account identifier, so authorization is self-certifying and needs no
network. An op carries its device key's authorization signed by the root. A verifier checks the
device signature and the root's authorization, and the account DID supplies the root's public key
(§5.2). A server that is down can stop a client from finding someone. A server that is down can
never stop a client from verifying a signed op.

**Revocation is the one networked part.** Whether a device key was revoked after it was authorized
can't be known offline. That check reads the account's current key set from the latest profile
(§6). The Beacon server enforces revocation on every signed request (§5.2) against a registry it
keeps per server. Revocation doesn't spread from one server to another: a player publishes the new
profile to each server that should honor it.

### 2.2 The key is the identity and a handle is an alias

A profile may list human-readable handles such as `alice@beacon.example`, and a `mintedBy` block
may carry a display handle. Both are display data. The key is the identity, and a handle never
replaces the key anywhere a signature is checked.

The split mirrors the GlobalId `unique@host`. In a GlobalId `unique` never changes and `host` names
the server that serves the thing today. In an identity the key never changes and a handle names a
server that can be replaced. Losing a handle's server loses the handle and never the identity.

## 3. Trust model: two axes

Beacon treats two kinds of claim differently, and the difference decides what gets signed.

- **Identity and provenance are verified.** "This op came from Bob" and "this server minted this
  item" are claims whose forgery harms someone else. Beacon checks them with signatures. The checks
  are cheap because identifiers are self-certifying (§2.1).
- **Gameplay and position are trusted.** "I'm here", "my scout moved" and "my item's levels are X"
  are claims whose forgery helps only the player who makes them. Beacon doesn't verify them.

Signatures cover the first axis only. A signature proves who acted and never proves what is true
about the world.

## 4. Identifiers and addressing

### 4.1 Canonical identity

The canonical identity is `did:key:<multibase Ed25519 public key>`. The identifier certifies
itself, depends on no server and never changes.

### 4.2 Handles

Beacon 0.3 doesn't resolve handles. No route maps a handle to an account, and no client looks one
up. A handle in a profile is a name the player chose to show.

A resolver added later must bind a handle in both directions. The handle's server must say the
handle belongs to a DID, and that DID's signed profile must list the handle in `handles`. One
direction alone lets a server operator list someone else's DID under a handle the DID's owner never
claimed.

### 4.3 How `owner` and `mintedBy` reference identities

Both reference an identity by its canonical key, which verifies with no lookup. `mintedBy` may add a
handle for display:

```jsonc
"owner": "did:key:z6Mk…",                                      // who holds the item now
"mintedBy": { "id": "did:key:z6Mk…", "handle": "…", "sig": "…" } // signed provenance
```

A minter is addressed by key so that verifying provenance needs no network. The handle is never
checked. A minter is either a server with its own keypair (§11) or a player who mints with their
account root. Both are keys.

## 5. Signing and verification

### 5.1 What gets signed

| Artifact                                         | Signed by                 | Purpose                                          |
| ------------------------------------------------ | ------------------------- | ------------------------------------------------ |
| Device authorization (the root authorizes a key) | the account root          | lets a device sign for the account               |
| Op envelope (a placement or a mailbox send)      | an authorized device key  | attribution, roles and replay protection         |
| Provenance (`mintedBy` over birth fields)        | the minter's key          | trust and block lists (§9)                       |
| Profile document (§6)                            | the account root          | proves the published profile is the player's     |
| Server descriptor                                | the server's account root | proves a server's advertisement (discovery §3.2) |

An op is attributed to the account (`actor` is the account DID) and signed by a device key. The op
carries the root-signed authorization for that device inline:

```jsonc
{
  "op": "contribute",
  "actor": "did:key:ROOT", // the account, the stable identity
  "device": "did:key:DEVICE", // the signing device key
  "auth": {
    "authorizes": "did:key:DEVICE",
    "account": "did:key:ROOT",
    "issued": "2026-11-01T12:00:00Z",
    "expires": "2027-11-01T12:00:00Z", // optional
    "sig": "<root signature>",
  },
  "nonce": "01J…", // a ULID, the idempotency key
  "issuedAt": "2026-11-11T09:30:00Z",
  "game": "example-game", // the declaring game's slug, absent on an operator console's envelope
  "room": "01J…@beacon.example", // absent on a request that targets no room
  "params": {},
  "sig": "<device signature over the envelope without sig>",
}
```

Carrying `auth` inline costs one extra signature per op and keeps verification fully offline.

Provenance signs an object's immutable birth fields with the minter's DID bound in, so a signature
can't be moved to another minter. Each object type names its own birth fields, and one function pair
signs and verifies each type:

| Object | Signed fields                      | Functions                                         |
| ------ | ---------------------------------- | ------------------------------------------------- |
| Room   | `{ unique, kind, policy, minter }` | `signRoomProvenance` and `verifyRoomProvenance`   |
| Scout  | `{ unique, config, minter }`       | `signScoutProvenance` and `verifyScoutProvenance` |
| Item   | `{ ...birth, unique, minter }`     | `signItemProvenance` and `verifyItemProvenance`   |

A room's whole policy is part of what its minter signs. A placer therefore can't wrap a trusted
`mintedBy` around a policy the minter never vouched for. An item's `birth` is the game's private
object. `unique` is spread after `birth`, so a `birth.unique` can never shadow the real `unique` in
the signed bytes.

### 5.2 Verification

`verifyOp` checks an envelope entirely offline, in this order:

1. The envelope parses against the op envelope schema and has a canonical form. Otherwise the result
   is `malformed`. A number such as `1e400` parses to `Infinity`, which has no canonical form.
2. `auth` is a valid root signature that hasn't passed its `expires` time. Otherwise `badauth`.
3. `actor` equals `auth.account`. Otherwise `actorMismatch`.
4. `device` equals `auth.authorizes`. Otherwise `deviceMismatch`.
5. `device` decodes as a `did:key`. Otherwise `baddevice`.
6. `sig` is a valid device signature over the canonical JSON of the envelope without `sig`.
   Otherwise `badsig`.

`verifyOp` never throws, since the envelope is untrusted input. The signing functions do throw.

**Revocation** is checked against the account's current key set. The Beacon server checks every
signed request against its revocation registry, whether the request writes or reads. The room engine
checks room ops while it applies them. A shared gate checks everything else:

- placement and the scout relay;
- the mailbox routes and the mailbox live channel;
- media, place proposals and admin requests.

A device revoked on a server stays revoked there after a restart. A pre-revocation profile can't be
replayed to undo a revocation, because a profile's `version` must advance (§6).

The shared gate takes each request through these steps:

1. The op name matches the route.
2. `verifyOp` passes.
3. `issuedAt` is within five minutes of the server clock. Otherwise `400` `clockSkew`.
4. The actor isn't blocked. Otherwise `403` `denied`.
5. The device isn't revoked. Otherwise `403` `deviceRevoked`.

`clockSkew` and `deviceRevoked` came after the first error codes. The server sends either one only to
a client that declares `code:clockSkew` or `code:deviceRevoked` in the `beacon-understands` request
header, or in a socket's handshake `auth.understands`. Any other client gets the older code at the
same status: `invalid` in place of `clockSkew` and `denied` in place of `deviceRevoked`.

### 5.3 Crypto choices

| Concern                 | Choice                                                     | Reason                                                                                                    |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Signature scheme        | Ed25519 through `@noble/ed25519`                           | small keys and signatures native to `did:key`; pure JavaScript runs in React Native with no `node:crypto` |
| Signature encoding      | base64url with no padding                                  | URL-safe and compact                                                                                      |
| Canonical serialization | JCS canonical JSON (RFC 8785), `canonicalJson`             | signer and verifier must hash the same bytes                                                              |
| Identifier method       | `did:key` for the account root                             | self-certifying, with nothing to host                                                                     |
| Content ids             | SHA-256, base64url with no padding (`sha256Base64url`)     | a media hash is also a valid GlobalId `unique`                                                            |
| Encryption              | none today, with `keyAgreement` reserved for an X25519 key | an Ed25519 signing key must not be converted for encryption, so encryption would need a separate key      |

Verification uses the ZIP215 rules that `@noble/ed25519` defaults to. A signature is therefore not
a unique id for a key and message pair. Beacon keys idempotency on the op's ULID `nonce` and never on
`sig`.

## 6. Profiles and privacy tiers

A profile is a document the account root signs, published wherever the player chooses. A profile is
a DID document plus public profile fields:

```jsonc
{
  "id": "did:key:ROOT", // the account
  "version": 7, // monotonic: a consumer rejects a version that doesn't advance
  "handles": ["alice@beacon.example"], // display only (§4.2)
  "displayName": "Alice",
  "avatar": "emoji:🦊", // or "image:<hash>@host", a media content address
  "devices": [
    {
      "key": "did:key:DEVICE1",
      "auth": { "issued": "…", "expires": "…", "sig": "<root signature>" },
    },
  ],
  "revoked": ["did:key:OLDPHONE"],
  "services": [{ "type": "mailbox", "endpoint": "beacon.example" }],
  "updated": "2026-11-11T09:30:00Z",
  "proof": { "type": "Ed25519", "key": "did:key:ROOT", "sig": "…" },
}
```

`buildProfile` writes a profile and `verifyProfile` checks one. These rules hold:

- **`devices` is the current authorization log.** Each entry is a root-signed authorization with the
  redundant `authorizes` and `account` fields dropped. `authorizationFromProfileEntry` rebuilds the
  full authorization from an entry. Adding a device adds an entry.
- **`revoked` lists revoked device keys.** A key in `revoked` is revoked even when the document names
  it anywhere else, so every reader checks `revoked`.
- **`version` is a high-water mark.** `acceptProfile` verifies a profile and answers `stale` when its
  version doesn't pass the one already accepted for the account. That check stops the replay of a
  pre-revocation profile. `bestVerifiedProfile` picks the highest verified version from several
  fetched copies, and the earlier copy wins a tie.
- **`services` advertises endpoints.** A `mailbox` entry names the server that holds the player's
  mailbox (see the [mailbox client spec](mailbox-client.md) §6).
- **The root signs the whole document,** so any host can serve a copy that a reader verifies.
- **`keyAgreement` is reserved** for an X25519 key if Beacon ever encrypts. No build writes it.

**Fields a build doesn't know survive in both directions.** A reader checks the shape with the read
schema and the signature over the body as received. A field from a newer app therefore still
verifies. A server stores and serves such a document verbatim, so a revocation in it takes effect.
When a build republishes, `buildProfile` carries forward every top-level field it doesn't own from
the copy passed as `supersedes`. A caller should pass the best verified copy
(`bestVerifiedProfile`). `buildProfile` ignores a `supersedes` that isn't self-signed by this
account. The doc of `buildProfile` names the fields a build owns. An older app that revokes a device
therefore doesn't delete what a newer app published. Two rules keep this safe:

- `keyAgreement` is dropped on a republish and never carried, because a key must not outlive a
  revocation on a build that doesn't manage it.
- Entries inside `devices` and `services` are rebuilt from what the writer passes. A carried field
  can also be dropped at the size cap. A newer build must therefore never put a restriction in an
  entry or in a top-level field of its own.

A client that republishes must take `revoked` as the union of its own list and the lists of every
copy it reads while publishing, and drop those keys from `devices`. `buildProfile` writes the list it
is given, so this rule is the app's. A device that never saw another device's revocation then can't
publish the revoked key back at a higher version. A client must never authorize a revoked key again.
A device that returns gets a fresh key.

**A profile is capped at 64 KiB.** `MAX_PROFILE_BYTES` (65536) counts the UTF-8 bytes of the
document's canonical JSON with `proof` included. Every writer and server therefore measures the same
number. The cap holds hundreds of devices or about a thousand revocations. `buildProfile` throws
`ProfileTooLargeError` rather than return a document over the cap. Fields a build only carries
forward give way first: a revocation must go out even when an older copy is already at the cap.

The Beacon server publishes and serves profiles on two routes:

| Route               | Does                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /profiles`    | verifies and records the document; errors are `400` `invalid` (bad shape or signature), `409` `stale`, `403` `denied` (blocked) and `413` `tooLarge` |
| `GET /profiles/:id` | returns this server's copy of the profile for a `did:key`, or `404` `unknownProfile`                                                                 |

A client verifies every profile it fetches before it shows a name or an avatar. A server can't
forge a signed profile, though a server can serve a stale one.

### 6.1 Privacy tiers

Where a profile lives is the player's choice:

| Tier      | Where the profile lives      | Who sees a name and avatar          | Can still play, own and contribute    |
| --------- | ---------------------------- | ----------------------------------- | ------------------------------------- |
| private   | the device only              | nobody, so the player is a bare key | yes, since ops verify against the key |
| published | the servers the player picks | whoever queries those servers       | yes                                   |

Gameplay never depends on profile visibility. A private player still owns items, contributes to
rooms and deploys scouts with no published name. A server enforces revocation only for accounts
that published a profile to it.

### 6.2 Hosting is best effort and identity is not

A profile copy on a server is at risk like any other server-held state. When a server goes away its
copy goes too. The player holds the account root and can publish again elsewhere. Profile
availability is at risk, and the identity isn't. The server keeps its revocation registry in its
database, so enforcement survives a restart.

## 7. Authentication

### 7.1 No accounts and no passwords

A Beacon server has no user accounts. The server learns of a player when a signed request arrives.
The envelope's `actor` is the identity, carried by a device signature and its authorization (§5).
First contact needs no sign-up.

### 7.2 Reading is anonymous and writing is attributable

- **Public reads need no identity.** Discovery, resolving a room and fetching a profile are anonymous.
- **Every write is signed,** so the action is attributable. A player reveals their identity when an
  action needs it and not before.
- **Private reads are signed too.** Reading a mailbox is a signed `POST`, so only the recipient can
  read it (see the [mailbox client spec](mailbox-client.md) §2).

### 7.3 No sessions

Beacon 0.3 issues no session tokens. Every signed request carries its own signature, and the server
verifies each one. The `issuedAt` freshness window and the nonce log protect against replay.

## 9. Trust filtering

Provenance (§4.3) lets players curate what they see:

- A client keeps local allow and block lists of keys and of servers.
- When it draws discovered objects the client hides block-listed minters and servers. A client may
  instead show only allow-listed ones.
- `mintedBy` is a key, so a block holds up. A bad actor can't evade a block by stamping a trusted
  name, since the signature wouldn't verify.
- The same mechanism blocks a player by identity and a whole server by its key or host.

Beacon supplies the verification functions. The lists themselves belong to the game's client.

## 10. Key lifecycle: recovery, devices, rotation and migration

The account root and device key model (§2) makes most of the lifecycle routine. Total loss of the
root is the case that remains hard.

### 10.1 The account root and the recovery phrase

The account root is derived from a BIP39 recovery phrase shown at creation. `createRecoveryPhrase`
makes 12 words by default, or 24 with 256 bits. The phrase backs up the account itself.

`accountFromMnemonic` derives the root from the phrase's BIP39 seed and takes the first 32 bytes of
the seed as the Ed25519 private key. That rule is Beacon's own and isn't SLIP-0010. Any other
implementation must apply the same rule to recover the same account. A BIP39 passphrase derives a
different valid account with no error. A recovery flow should leave it out or show it clearly.

`walletFromMnemonic` assembles a wallet from a phrase: the recovered root and a fresh device that
the root authorizes. The account DID stays the same, and the device key is new each time.

The SDK has two custody policies:

- **Phone** (`loadOrCreateWallet` and its siblings): the phrase, the device seed and the device's
  authorization are stored in the injected `SecureKeyStore`. A stored device that can no longer sign
  is rebuilt from the phrase, which is never discarded.
- **Browser** (the vault): only the phrase is kept, encrypted with a passphrase through PBKDF2-SHA-256
  and AES-256-GCM. Each unlock builds a session wallet with a fresh device, and nothing key-shaped
  is stored. A session device never appears in the profile, so nothing could revoke it. The vault therefore
  gives its authorization an `expires` 7 days after the unlock by default. A server refuses the
  device's ops after that (§10.3). The client then asks for the passphrase again.

### 10.2 More than one device

Adding a device is a normal operation. The new device generates its own key, and the root authorizes
it with an entry in `devices` (§6). The authorization travels inline on the device's ops (§5). Each
device signs as itself and is attributed to the account. No secret is shared and no second identity
appears.

### 10.3 Rotation and revocation

- **Revoke a device** that was lost or stolen: the root moves its key from `devices` to `revoked`
  and signs a new profile version. The account and its history survive, and only that device key is
  cut off.
- **Rotate a device key:** authorize a new key and revoke the old one. Past ops stay valid, since
  their inline authorizations prove the device was authorized when it signed.
- **Bound a key in time:** an authorization may carry `expires`. Verification refuses an expired
  authorization offline, in an op and in a profile entry alike. The vault's session devices always
  carry one (§10.1).
- **Ask whether a device still signs:** the SDK's `probeDevice` sends a signed `list` for a room
  that does not exist and declares `code:deviceRevoked`. The server checks the block on the account and then the device before it looks for the room. `denied` therefore means the account is blocked,
  `deviceRevoked` that the device is revoked and `unknownRoom` that the device is allowed. A server
  that fails gives no verdict, so the probe throws a fault as every SDK call does.
- **A stolen root is the one fatal case.** The design keeps the root in cold backup and off everyday
  devices to make that rare.

> **Warning:** the SDK's phone wallet keeps the recovery phrase on the device. Whoever holds the
> unlocked phone can read the phrase and do anything the root can: authorize a new device, publish a
> profile and revoke the owner's other devices. Revocation protects against a leaked device key used
> without the phone. Revocation doesn't protect against the phone itself.

### 10.4 Migration between servers

The account DID doesn't depend on any host, so moving servers never breaks identity. The player
publishes the signed profile on the new server and points the mailbox `services` entry there. Signed
history and ownership stay valid, because the account root never changed.

### 10.5 Total root loss

A player who loses the root and its recovery phrase loses the identity. Only the root can authorize
device keys, so nothing can bring the account back. Systems with hosted rotation keys fail the same
way when the user loses those keys. A client should push the player to back up the phrase at
onboarding.

## 11. The server's part in identity

A server's identity duties are few:

| A server does                                        | A server doesn't                   |
| ---------------------------------------------------- | ---------------------------------- |
| host copies of published profiles                    | own or issue identities            |
| enforce revocation from the profiles published to it | hold players' private keys         |
| record the account (`actor`) on each op it applies   | gate gameplay on sign-up or log-in |
| sign its own descriptor with its own key             | verify gameplay claims (§3)        |

A server has an identity of its own, built on the same account root model. The server's `did:key`
signs its descriptor (discovery §3.2), and a descriptor is self-signed by the key it advertises. The
advertised identity is therefore the server's account root, which must stay the same across
restarts. A key provider loads the root at boot. The Beacon server ships four providers:

- a recovery phrase in `BEACON_MNEMONIC`;
- a key file at `BEACON_KEY_FILE`, whose permissions the server checks;
- an encrypted key file unlocked with `BEACON_KEY_PASSPHRASE` (`BEACON_KEY_PROVIDER=encrypted-file`);
- the key restored from a backup.

With no phrase and no key file the server makes a temporary identity that changes on every start.
That suits development only, since clients that added the server can no longer verify it after a
restart. A provider whose configured material is unusable stops the server rather than make a new
identity. Beacon 0.3 has no provider for a cloud secret manager. Rotating the server's device
key keeps its identity. Replacing the account root gives the server a new identity, and clients
must add the server again.
