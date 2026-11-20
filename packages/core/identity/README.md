# @beaconsgg/identity

**[C] client-bound (RN-safe).** Ed25519 keys and `did:key` identifiers. The package authorizes more
than one device per account and signs the profile that carries revocations. The package also signs
and verifies ops offline.

## Status

Stable. The server and the React Native or Expo client run the package unchanged.

The crypto is Ed25519 over [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) and
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes). Base encodings come from
[`@scure/base`](https://github.com/paulmillr/scure-base) and BIP39 from
[`@scure/bip39`](https://github.com/paulmillr/scure-bip39). The package uses **no `node:crypto` and
no Node built-ins** on purpose, so the same code runs in the React Native or Expo client and on the
server. The package wires the synchronous SHA-512 into `@noble/ed25519` at import. Signing and
verification then work without the async `subtle` API of WebCrypto.

## What the package does

The package is the identity layer of the protocol. The full model is in
[`doc/spec/identity.md`](../../../doc/spec/identity.md).

An **account** is a long-lived root keypair that can be derived from a BIP39 recovery phrase. The
root rarely comes online. Instead the root _authorizes_ a keypair for each **device** to sign on
the account's behalf, through a root-signed `DeviceAuthorization` with an optional `expires`. Day to
day a client carries a **wallet** that holds the account, the current device and the authorization.
The wallet signs ops with one call. Provenance verifies **offline**: an op envelope or a profile carries
the `auth` inline. Any party can therefore confirm that the account authorized the
device and that the device signed the bytes, with no network round trip.

Signatures here are for **attribution**. `verifyOp` establishes _who_ an op came from and never
whether the op's gameplay `params` are honest. This layer trusts those claims, and other code judges
them. The **profile** is the signed snapshot that an account publishes itself. The snapshot lists the
account's current devices and revocations and carries a `version` that only goes up. Revocation
works even offline because of the profile, as described below.

The package is pure TypeScript and works with any framework. The signing input is always
[JCS](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON (`canonicalJson` from
[`@beaconsgg/protocol-types`](../protocol-types)) over the object _without_ its `sig` or `proof`.
The signer and the verifier therefore canonicalize identical bytes.

## Exports

| Area | Exports |
| --- | --- |
| Raw crypto | `generateKeyPair`, `keyPairFromSeed`, `signUtf8` and `verifyUtf8`. The type is `KeyPair`. Every Beacon signature is over a UTF-8 string, so no byte form is exported. |
| `did:key` | `encodeDidKey` and `decodeDidKey`. `decodeDidKey` is gated by a regex and accepts only Ed25519 public keys. |
| Accounts and devices | `createAccount`, `createDevice`, `createRecoveryPhrase` and `accountFromMnemonic`. The types are `Account` and `Device`. |
| Authorization | `authorizeDevice(account, device, { issued?, expires? })` signs an optional `expires`. `verifyDeviceAuthorization` runs offline and honors `expires`. The type is `DeviceAuthorizationOptions`. |
| Wallet | `createWallet({ issued?, expires? })`, `walletFromMnemonic(phrase, { issued?, expires?, passphrase? })`, `walletIdentity` and `signOpWithWallet`. The types are `Wallet`, `MnemonicWalletOptions` and `OpIntent`. |
| Profile and revocation | `buildProfile`, `verifyProfile`, `acceptProfile`, `isDeviceRevoked` and `ProfileTooLargeError`. `acceptProfile` is the rollback guard. The types are `ProfileInput` and `ProfileAcceptance`. |
| Server descriptor | `signDescriptor(account, body)` signs the server's coverage advertisement with the server's own key. A client calls `verifyDescriptor(raw)` on the body as received before trusting the coverage. A `true` result narrows `raw` to a `ReceivedDescriptor`, and `readAccessLevel` reads its `accessLevel`. The type is `ServerDescriptorBody`. |
| Ops | `opSigningInput`, `signOp` and `verifyOp`. `verifyOp` returns an `OpVerification`. |
| Provenance (`mintedBy`) | `accountMinter` and `walletMinter` return a `Minter`. `signItemProvenance` and `verifyItemProvenance` take an `ItemBirth` for any game item. `signRoomProvenance` and `verifyRoomProvenance` take a `RoomBirth`. `signScoutProvenance` and `verifyScoutProvenance` take a `ScoutBirth`. |
| Signing vectors (from `@beaconsgg/identity/conformance` and not the barrel) | `SIGNING_VECTORS` (a `SigningVector[]`), `SIGNING_VECTOR_KEYS` and `SIGNING_VECTOR_NOW`: the canonical bytes and signatures every signed artifact must reproduce. |

## Signing vectors

**The signing vectors are the spec at the byte level.** Import them from
`@beaconsgg/identity/conformance` and not from the main barrel, so their fixed keys never reach app
or server code. `SIGNING_VECTORS` covers every kind of signed artifact:

- device authorizations;
- ops, including a `place` with float coordinates;
- the births of rooms, scouts and items;
- a server descriptor;
- a profile.

For each one the vectors pin the exact `signed` object, its `signingInput` and its `sig`.
`SIGNING_VECTOR_KEYS` gives each key as a phrase, a DID and raw `privateKey` and `publicKey` hex.
You can therefore check Ed25519 and JCS without BIP39.

An implementation or a consuming repository conforms when two things hold. The implementation's
canonical form of each `signed` equals `signingInput` byte for byte. The implementation's signature
over that string with the named key equals `sig`. Verify with `now` set to `SIGNING_VECTOR_NOW` and
never the current time, because one authorization expires. The suite also signs every `input` again
through the exported signer. **A vector that stops matching is a break in the wire format.** Never
update the vector to make the test pass.

## Design notes

- **The account root authorizes keys for each device.** The root is the durable identity that the
  player owns, and its `did:key` is the account id. The root exists mainly to mint
  `DeviceAuthorization`s. Device keys do the routine signing, so the root can stay offline.
- **Signatures are for attribution.** `verifyOp` proves provenance: the acting account, its
  authorized device and a valid device signature over the canonical envelope. `verifyOp` does
  **not** vouch for `params`. This layer trusts gameplay claims, and other code validates them.
- **Object provenance (`mintedBy`) is separate from op signing** (`provenance.ts`). A **minter**
  signs an object's **immutable birth fields** over JCS, with the minter's id bound in. A minter is
  a player's account root (`accountMinter` or `walletMinter`) or a server key. The signed fields
  differ by kind:
  - an item signs `{unique, ...birth}`, where the game defines `birth`;
  - a room signs `{unique, kind, policy}`;
  - a scout signs `{unique, config}`.

  The minter's id is part of the signed bytes, so an object stamped again under someone else's name
  won't verify. The identity spec treats provenance as a verified claim
  ([`doc/spec/identity.md`](../../../doc/spec/identity.md) §3). `verify*Provenance` runs offline
  with no lookup. The function returns `false` for an **absent** signature as well as an invalid
  one, so a gate that requires provenance decides on the one boolean. Provenance powers the trust
  and block lists a client keeps locally (identity spec §9).

- **Offline verification with inline `auth`.** The `DeviceAuthorization` travels inside the op
  envelope and inside each device entry of a profile. `verifyDeviceAuthorization`, `verifyOp` and
  `verifyProfile` therefore all run with no network and no key lookup. The `now` argument
  (milliseconds since the epoch) serves only the `expires` check.
- **JCS signing input.** Every signature covers `canonicalJson(value − sig/proof)`. An optional
  field such as `expires` is included only when present. An authorization with no expiry therefore
  signs the same way as the format before `expires` existed, and old and new artifacts verify each
  other.
- **A verifier never throws, and a signer does.** A verifier's input is untrusted, so every failure
  is the verifier's answer: `false` or an `OpVerification` reason. The answer covers values that
  canonical JSON has no form for. `JSON.parse` turns `1e400` into `Infinity`, and nesting can run
  deeper than the canonicalizer can walk. `verifyOp` answers `malformed` for those. A signer handed
  such a value throws, because a writer that produces the value has a bug to surface.
- **`verifyUtf8` is non-strict (ZIP215).** A signature is not a unique id for a pair of key and
  message. Never use a `sig` to deduplicate or as an idempotency key. The protocol keys on the ULID
  `nonce` instead.
- **Revocation needs the network and works on a best effort basis. Expiry is the offline
  mitigation.** `verifyOp` does **not** consult `revoked`, and the consumer sets that policy. The
  Beacon server checks every signed request against a revocation registry it keeps per server
  ([`doc/spec/identity.md`](../../../doc/spec/identity.md) §5.2). The signed device `expires` bounds
  how long a key works offline.

## Profile: devices and revocation that resist rollback

An account gets more than one device and revokes a device through its profile. The profile is the
account's signed snapshot of its current `devices` and a `revoked` list kept on a best effort basis,
with a `version` that only goes up. Each device entry holds a `did` and the root-signed `auth`, and
the entry carries the device's `expires` along.

### `buildProfile(account, input)`

`buildProfile` assembles the snapshot and signs the snapshot with the account root over the JCS of
the body. The caller sets the profile's `version` through `input.version` (default `1`). Raise the
version on every change so that readers can reject a rollback. Each device entry carries the device's signed `expires`.

On every republish pass the best published copy as `input.supersedes`. Each top-level field of that
copy that this build doesn't own (`buildProfile`'s doc lists the fields it owns) rides forward into the new signed
document, such as a field a newer app added. A profile is signed whole. A rebuild from the typed
fields alone would publish a higher version without those fields, and every reader would take the
rebuild as the profile. A copy that belongs to another account contributes nothing, and so does a
copy whose own signature fails.

`keyAgreement` is owned and dropped, since a key must not outlive a revocation on a build that
doesn't manage the key. For the same reason `revoked` overrides a key named anywhere else, and
readers must check `revoked`. Entries inside `devices` and `services` are rebuilt from what the
caller passes.

`buildProfile` throws `ProfileTooLargeError` instead of returning a document over
`MAX_PROFILE_BYTES`. The error carries the `bytes` that `buildProfile` measured. The cap is 64 KiB
of canonical JSON as `profileBytes` counts the bytes, and no server accepts a larger profile.
Carried fields count toward the cap and give way first. If they push the document over the cap,
`buildProfile` rebuilds the document without them. A copy already at the cap therefore can't stop
this build from publishing what it owns, and above all a revocation. An older server enforces no
cap, so such a copy can exist. A newer build must therefore never put a restriction in a field this
build doesn't own, or inside a `devices` or `services` entry. None of those is sure to survive a
republish.

### `verifyProfile(raw, now?)`

`verifyProfile` fails closed and checks three things in order:

1. the document's shape with `profileDocReadSchema`, so soundness never rests on the caller;
2. the root's signature over the document **as received**, without `proof`;
3. that **every** listed device holds a valid root authorization for this account that hasn't
   expired.

A `true` result narrows `raw` to a `ProfileDoc`. `verifyProfile` does **not** consult `revoked` or
`version`, and the caller sets that policy. Hand over the body exactly as it came off the wire. The
signature covers the raw body, so a field this build doesn't know still verifies. Parsing strictly
first would drop what was signed. The rule is written down in `protocol-types/src/read.ts`, and
`verifyDescriptor` follows the same rule.

### `acceptProfile(current, next, now?)`

`acceptProfile` is the check for anyone who holds profile state, such as the server's registry or a
cache of peers' profiles. Pass `next` as received. `acceptProfile` runs `verifyProfile` and then
**rejects** a `next` whose `version` doesn't advance past the last accepted `current` for that
account. The result is `{ ok: true; profile }` or `{ ok: false; reason: "invalid" | "stale" }`.

This check makes offline revocation **resist rollback**. A replayed profile from before a revocation
is `stale` and never accepted. An attacker therefore can't restore a revoked device by replaying an
older snapshot.

### `isDeviceRevoked(profile, deviceDid)`

`isDeviceRevoked` looks a device up in the `revoked` list of the accepted profile. This lookup is
the networked part of revocation and works on a best effort basis.

## Scripts

```bash
pnpm --filter @beaconsgg/identity build       # tsc -> dist
pnpm --filter @beaconsgg/identity typecheck   # tsc --noEmit
pnpm --filter @beaconsgg/identity test        # vitest
```
