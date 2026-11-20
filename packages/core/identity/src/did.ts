import { DID_KEY_RE, type DidKey } from "@beaconsgg/protocol-types";
import { base58 } from "@scure/base";

// did:key codec for Ed25519 public keys (`doc/spec/identity.md` §2.1): multicodec-prefixed base58btc.

// The multicodec prefix for an ed25519 public key is 0xed, encoded as the
// unsigned varint [0xed, 0x01]. `did:key` = "did:key:z" + base58btc(prefix || pubkey).
const ED25519_PUB_MULTICODEC = Uint8Array.from([0xed, 0x01]);
const DID_KEY_PREFIX = "did:key:z"; // "z" = multibase base58btc

/**
 * Encode a 32-byte Ed25519 public key as a `did:key`, the form Beacon uses for every account and
 * device key: `did:key:z6Mk...`.
 *
 * @throws `Error` when `publicKey` is not 32 bytes.
 */
export function encodeDidKey(publicKey: Uint8Array): DidKey {
  if (publicKey.length !== 32) {
    throw new Error("encodeDidKey: ed25519 public key must be 32 bytes");
  }
  const bytes = new Uint8Array(ED25519_PUB_MULTICODEC.length + publicKey.length);
  bytes.set(ED25519_PUB_MULTICODEC, 0);
  bytes.set(publicKey, ED25519_PUB_MULTICODEC.length);
  return `${DID_KEY_PREFIX}${base58.encode(bytes)}`;
}

/**
 * Decode a `did:key` to its 32-byte Ed25519 public key.
 *
 * @throws `Error` when `did` is not a valid `did:key`, or is not an Ed25519 key.
 */
export function decodeDidKey(did: string): Uint8Array {
  // Enforce the canonical shape (length-bounded base58btc) before decoding, rather than
  // relying on base58 to throw on stray characters.
  if (!DID_KEY_RE.test(did)) {
    throw new Error(`decodeDidKey: not a valid did:key: ${did}`);
  }
  const bytes = base58.decode(did.slice(DID_KEY_PREFIX.length));
  if (bytes.length !== 2 + 32 || bytes[0] !== 0xed || bytes[1] !== 0x01) {
    throw new Error("decodeDidKey: unsupported did:key (expected ed25519-pub)");
  }
  return bytes.slice(2);
}
