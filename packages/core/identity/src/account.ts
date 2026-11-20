import type { DidKey } from "@beaconsgg/protocol-types";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { generateKeyPair, keyPairFromSeed, type KeyPair } from "./crypto";
import { encodeDidKey } from "./did";

// Account and device identities (`doc/spec/identity.md` §2): the durable account root (a did:key over
// an Ed25519 key pair) and the per-device signing keys it authorizes. The root is recoverable from a
// BIP39 phrase (§10.1); device keys are disposable and revocable.

/**
 * A player's account: the root key pair and the account's `did:key`, which is the player's lasting
 * identity.
 *
 * The root key authorizes device keys, and signs the profile and the provenance of what the player
 * mints. Ops are signed by a {@link Device}. An account made with {@link accountFromMnemonic} can
 * be recovered from its recovery phrase.
 */
export interface Account {
  /** The account's root key pair. */
  readonly root: KeyPair;
  /** The account's id: the root public key as a `did:key`. */
  readonly did: DidKey;
}

/**
 * A device key that signs ops for an account, once the account root authorizes it with
 * `authorizeDevice` (`doc/spec/identity.md` §2).
 */
export interface Device {
  /** The device's key pair. */
  readonly key: KeyPair;
  /** The device public key as a `did:key`. */
  readonly did: DidKey;
}

function accountFromKeyPair(root: KeyPair): Account {
  return { root, did: encodeDidKey(root.publicKey) };
}

/**
 * Create a new account from a random root key.
 *
 * An account made this way has no recovery phrase. Use {@link createRecoveryPhrase} and
 * {@link accountFromMnemonic} for an account the player can recover.
 */
export function createAccount(): Account {
  return accountFromKeyPair(generateKeyPair());
}

/** Create a new random device key. Authorize the key with `authorizeDevice` before it signs ops. */
export function createDevice(): Device {
  const key = generateKeyPair();
  return { key, did: encodeDidKey(key.publicKey) };
}

// ── BIP39 recovery phrase for the account root (`doc/spec/identity.md` §10.1) ──

/**
 * Generate a new BIP39 recovery phrase from the English word list: 12 words by default, or 24
 * words with `strengthBits` set to 256.
 */
export function createRecoveryPhrase(strengthBits: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strengthBits);
}

/**
 * Derive the account from its BIP39 recovery phrase. The same phrase always gives the same account.
 *
 * @param passphrase - The optional BIP39 passphrase. A different passphrase gives a different
 * account without any error, so a mistyped passphrase looks like a new, empty account. Leave it out
 * unless your onboarding asks for it clearly.
 * @throws `Error` when `mnemonic` is not a valid phrase from the English word list: lowercase words
 * separated by single spaces, with nothing around them.
 */
export function accountFromMnemonic(mnemonic: string, passphrase?: string): Account {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("accountFromMnemonic: invalid recovery phrase");
  }
  const seed = mnemonicToSeedSync(mnemonic, passphrase);
  return accountFromKeyPair(keyPairFromSeed(seed));
}
