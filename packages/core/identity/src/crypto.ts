import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { utf8ToBytes } from "@noble/hashes/utils";
import { base64urlnopad } from "@scure/base";

// Ed25519 primitives (`doc/spec/identity.md` §5.3): keypair generation and derivation, raw and UTF-8
// sign and verify with base64url signatures without padding, and sha256 content ids. Pure-JS @noble
// (no node:crypto) to stay safe for React Native.

// Wire the *synchronous* SHA-512 so getPublicKey/sign/verify work without WebCrypto's
// async subtle API. @noble/hashes is pure JS, so this keeps the package RN-safe
// (no node:crypto, `doc/spec/identity.md` §5.3).
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/** An Ed25519 key pair: a 32-byte private key and its 32-byte public key. */
export interface KeyPair {
  /** The 32-byte Ed25519 seed, which is the private key. Keep the private key on its device. */
  readonly privateKey: Uint8Array;
  /** The 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array;
}

/**
 * Generate a new random Ed25519 key pair, from the platform's secure random source
 * (`crypto.getRandomValues`).
 */
export function generateKeyPair(): KeyPair {
  const privateKey = ed.utils.randomPrivateKey();
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

/**
 * Derive an Ed25519 key pair from a seed of at least 32 bytes, such as a BIP39 seed. The same seed
 * always gives the same key pair.
 *
 * The first 32 bytes of the seed become the private key, and the rest is ignored.
 *
 * Taking the first 32 bytes is Beacon's own rule, not SLIP-0010. Another implementation must use
 * the same rule to recover the same account from a recovery phrase.
 *
 * @throws `Error` when `seed` is shorter than 32 bytes.
 */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length < 32) {
    throw new Error("keyPairFromSeed: seed must be at least 32 bytes");
  }
  const privateKey = seed.slice(0, 32);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
}

// The one byte-level verifier. Only the UTF-8 forms below are exported: every Beacon signature is
// over a UTF-8 string, and a raw verifier whose three parameters are all bytes would compile with
// its arguments swapped.
function verifyBytes(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed.verify(signature, message, publicKey);
  } catch {
    // Malformed signature/key bytes -> not valid, never throw.
    return false;
  }
}

/** Sign the UTF-8 bytes of `message`, and return the signature as base64url without padding. */
export function signUtf8(message: string, privateKey: Uint8Array): string {
  return base64urlnopad.encode(ed.sign(utf8ToBytes(message), privateKey));
}

/**
 * Return `true` when `signature`, as base64url, is a valid signature of the UTF-8 bytes of
 * `message` by `publicKey`. The function never throws.
 *
 * Verification follows ZIP215, which accepts more than one signature for the same key and message.
 * Never use a signature as a unique id, for example to drop duplicates: Beacon uses the op's ULID
 * nonce for that.
 */
export function verifyUtf8(message: string, signature: string, publicKey: Uint8Array): boolean {
  let raw: Uint8Array;
  try {
    raw = base64urlnopad.decode(signature);
  } catch {
    return false;
  }
  return verifyBytes(raw, utf8ToBytes(message), publicKey);
}

/**
 * Compute the content id of a file: the sha256 of `bytes`, as base64url without padding.
 *
 * Pass the result as the `hash` of `client.putMedia`. The server hashes the bytes it receives in
 * the same way and refuses the upload when the two differ (beacon.server
 * `doc/spec/mailbox-and-media.md` §5.2). The id contains only `[A-Za-z0-9_-]`, so the file's
 * address `<hash>@host` is a valid GlobalId.
 */
export function sha256Base64url(bytes: Uint8Array): string {
  return base64urlnopad.encode(sha256(bytes));
}
