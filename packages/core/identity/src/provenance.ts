import {
  canonicalJson,
  type DidKey,
  type MintedBy,
  type Policy,
  type ScoutConfig,
} from "@beaconsgg/protocol-types";
import type { Account } from "./account";
import { signUtf8, verifyUtf8 } from "./crypto";
import { decodeDidKey } from "./did";
import type { Wallet } from "./wallet";

// Object provenance signing (`doc/spec/identity.md` §5.1 "provenance",
// `doc/spec/item-properties.md` §2.1, §3): the minter's signature over an object's immutable birth
// fields, which powers client-local trust and block lists (`doc/spec/identity.md` §9). Ed25519 over
// JCS canonical JSON (`doc/spec/identity.md` §5.3), mirroring op.ts.
//
// A module-private generic core (`signProvenance` and `verifyProvenance` over a birth-fields object)
// with per-type wrappers that name each object's birth fields: rooms (minted at grant, then placed),
// scouts, and generic items, which is how a game signs its own items. Only the typed wrappers are
// exported, so a caller can't sign one field shape and verify another. The signed object is
// `{ ...birthFields, minter }`, so the minter is bound in and re-stamping under someone else's name
// won't verify (§3). A minter is a player account root or a server key (`doc/spec/identity.md` §4.3).

/**
 * The key that signs an object's provenance, its `mintedBy`: a player's account root or a server's
 * key, with an optional display handle.
 *
 * Get one from {@link walletMinter} or {@link accountMinter}.
 */
export interface Minter {
  /** The signing key's `did:key`, which becomes `mintedBy.id`. */
  did: DidKey;
  /** The signing key's 32-byte private key. */
  privateKey: Uint8Array;
  /** A name to show for the minter (`doc/spec/identity.md` §4.3). The name is never the identity. */
  handle?: string;
}

/**
 * Make a {@link Minter} that signs with the account root, for something the player mints.
 */
// The single path from an account to its minter key, so a change to how the root key is reached
// lands in one place.
export function accountMinter(account: Account): Minter {
  return { did: account.did, privateKey: account.root.privateKey };
}

/**
 * Make a {@link Minter} that signs with the wallet's account root. The result is
 * `accountMinter(wallet.account)`.
 */
export function walletMinter(wallet: Wallet): Minter {
  return accountMinter(wallet.account);
}

/** The exact bytes a `mintedBy` signature covers: JCS of the birth fields with the minter bound in. */
function provenanceInput(birthFields: Record<string, unknown>, minterId: DidKey): string {
  return canonicalJson({ ...birthFields, minter: minterId });
}

/** Sign an object's birth fields as `minter`, returning the `mintedBy` block to stamp onto it. */
function signProvenance(birthFields: Record<string, unknown>, minter: Minter): MintedBy {
  const sig = signUtf8(provenanceInput(birthFields, minter.did), minter.privateKey);
  return { id: minter.did, ...(minter.handle ? { handle: minter.handle } : {}), sig };
}

/**
 * Verify a `mintedBy` signature against the birth fields + the minter key it names, offline, with no
 * lookup. Returns `false` when provenance is **absent** as well as present-but-invalid, so a
 * required-provenance gate can decide on the single boolean. Never throws: birth fields a peer sent
 * are untrusted, and fields with no canonical form (a `1e400` from `JSON.parse` is `Infinity`, or
 * nesting too deep to walk) are `false` too.
 */
function verifyProvenance(
  mintedBy: MintedBy | undefined,
  birthFields: Record<string, unknown>,
): boolean {
  if (!mintedBy) return false;
  try {
    const message = provenanceInput(birthFields, mintedBy.id);
    return verifyUtf8(message, mintedBy.sig, decodeDidKey(mintedBy.id));
  } catch {
    return false; // a bad key, or fields with no canonical form
  }
}

// ── Rooms (minted at grant, then placed) ──

/**
 * The fields a room's provenance signs: the room's `unique`, its type as `kind` and its full
 * `policy`. None of them can change after the room is minted.
 *
 * Because the policy is signed, a placer cannot put a trusted `mintedBy` on a room with another
 * policy (`doc/spec/identity.md` §5.1). A discovery summary has no policy, so verify `mintedBy`
 * after you fetch the full room with `client.resolveRoom`, before the player acts on the room.
 */
export interface RoomBirth {
  /** The room's ULID, chosen at mint. The placed room's id is `unique@host`. */
  unique: string;
  /** The room's type: the same value as the placed room's `type`. */
  kind: string;
  /** The policy the room is placed with, exactly as placed. */
  policy: Policy;
}

function roomBirthFields(room: RoomBirth): Record<string, unknown> {
  return { unique: room.unique, kind: room.kind, policy: room.policy };
}

/**
 * Sign a room's provenance as `minter`, and return the `mintedBy` to put in the room's place
 * params.
 */
export function signRoomProvenance(room: RoomBirth, minter: Minter): MintedBy {
  return signProvenance(roomBirthFields(room), minter);
}

/**
 * Return `true` when `mintedBy` is a valid signature of the room's `unique`, `kind` and `policy` by
 * the key it names.
 *
 * A missing `mintedBy` returns `false`. The check runs offline, and the function never throws. Who
 * to trust as a minter is your game's choice: compare `mintedBy.id` with the keys you trust.
 */
export function verifyRoomProvenance(room: RoomBirth, mintedBy?: MintedBy | undefined): boolean {
  return verifyProvenance(mintedBy, roomBirthFields(room));
}

// ── Scouts (a deployed/reported scout) ──

/**
 * The fields a scout's provenance signs: the scout's `unique` and your game's `config` for it.
 *
 * Both travel in every scout report and discovery summary, so any player can verify the scout
 * offline. No server enforces the config. The server relays movement as reported, so a game that
 * cares whether a scout kept to its limits checks that on the client.
 */
export interface ScoutBirth {
  /** The scout's id, chosen at mint. */
  unique: string;
  /** Your game's configuration for the scout. */
  config: ScoutConfig;
}

function scoutBirthFields(scout: ScoutBirth): Record<string, unknown> {
  return { unique: scout.unique, config: scout.config };
}

/** Sign a scout's provenance as `minter`, and return the `mintedBy` to send in each scout report. */
export function signScoutProvenance(scout: ScoutBirth, minter: Minter): MintedBy {
  return signProvenance(scoutBirthFields(scout), minter);
}

/**
 * Return `true` when `mintedBy` is a valid signature of the scout's `unique` and `config` by the
 * key it names. A missing `mintedBy` returns `false`, and the function never throws.
 */
export function verifyScoutProvenance(scout: ScoutBirth, mintedBy?: MintedBy | undefined): boolean {
  return verifyProvenance(mintedBy, scoutBirthFields(scout));
}

// ── Generic items (an opaque, game-defined item crossing into shared room state) ──

/**
 * The fields an item's provenance signs: the item's `unique`, and the fields of your game's item
 * that never change, in `birth`.
 *
 * You choose which fields go in `birth`. The server never needs to know their shape. `birth` must
 * not use the keys `unique` or `minter`.
 *
 * The signed input is `{ ...birth, unique, minter }` in JCS canonical JSON. The game-specific
 * signer this replaced produced the same bytes, so items it minted still verify, and the layout
 * must not change. `opaqueItemSchema` refuses the reserved keys, and {@link itemBirthFields}
 * spreads `unique` last as the guard that matters.
 */
export interface ItemBirth {
  /** The item's id, chosen at mint. */
  unique: string;
  /** Your game's fields that never change after the item is minted. */
  birth: Record<string, unknown>;
}

function itemBirthFields(item: ItemBirth): Record<string, unknown> {
  // `unique` is spread LAST so a hostile `birth.unique` can't shadow the real top-level `unique` in the
  // signed JCS input (that would let a valid signature be replayed under an arbitrary engine-level
  // `unique` — the `opaqueItemSchema` refinement also rejects the reserved key, but this is the
  // load-bearing guard, since `verifyItemProvenance` is also called on un-schema-parsed inputs).
  return { ...item.birth, unique: item.unique };
}

/** Sign an item's provenance as `minter`, and return the `mintedBy` to put on the item. */
export function signItemProvenance(item: ItemBirth, minter: Minter): MintedBy {
  return signProvenance(itemBirthFields(item), minter);
}

/**
 * Return `true` when `mintedBy` is a valid signature of the item's `unique` and `birth` by the key
 * it names. A missing `mintedBy` returns `false`, and the function never throws.
 */
export function verifyItemProvenance(item: ItemBirth, mintedBy?: MintedBy | undefined): boolean {
  return verifyProvenance(mintedBy, itemBirthFields(item));
}
