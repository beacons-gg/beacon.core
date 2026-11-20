/**
 * Key custody: create and persist an account + device wallet with `@beaconsgg/identity`, keys in
 * the platform's secure storage (`doc/spec/identity.md` §10.1).
 *
 *   1. Keys live wherever the injected {@link SecureKeyStore} keeps them (Keychain / Keystore on a
 *      phone), never in plain storage. Every entry point takes the store and is `async`.
 *   2. The account is **recovery-phrase-first**: a new wallet starts from a BIP39 phrase, the
 *      account root is derived from it (`walletFromMnemonic`), and the phrase is what the player
 *      backs up; total root loss is the one unrecoverable case (`doc/spec/identity.md` §10). The
 *      device key is a separate per-device seed (a new device re-authorizes under the same
 *      account).
 *
 * Stored: the account mnemonic + the device seed (hex) + the device authorization. "Login" is
 * unlocking the local device key (reading it back from the store). A stored device that can no
 * longer sign is rebuilt from the phrase, never discarded with it: the phrase is the one thing
 * here that cannot be replaced.
 */
import {
  accountFromMnemonic,
  authorizeDevice,
  createDevice,
  createRecoveryPhrase,
  encodeDidKey,
  keyPairFromSeed,
  verifyDeviceAuthorization,
  walletFromMnemonic,
  type Account,
  type Wallet,
} from "@beaconsgg/identity";
import {
  deviceAuthorizationSchema,
  type DeviceAuthorization,
  type DidKey,
} from "@beaconsgg/protocol-types";
import { fromHex, toHex } from "./hex";

/**
 * The secret storage the wallet functions keep the player's keys in: an async key and value store
 * that your app supplies.
 *
 * On a phone, wrap the platform's secure storage: the iOS Keychain or the Android Keystore, for
 * example through `expo-secure-store`. The SDK stores one entry, a JSON string that holds the
 * recovery phrase in plain text, so never back the wallet functions' store with plain storage. In a
 * browser with no secure storage, use {@link passphraseVault} instead.
 */
export interface SecureKeyStore {
  /** Read the value stored under `key`, or `null` when there is none. */
  getItem(key: string): Promise<string | null>;
  /** Store `value` under `key`, replacing any value already there. */
  setItem(key: string, value: string): Promise<void>;
  /** Delete the value stored under `key`. Deleting a missing key is not an error. */
  deleteItem(key: string): Promise<void>;
}

/** An in-memory store for tests only. It keeps nothing secret. */
export function memorySecureStore(seed: Record<string, string> = {}): SecureKeyStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => Promise.resolve(map.get(key) ?? null),
    setItem: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    deleteItem: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

const WALLET_KEY = "beacon.wallet.v1";

/** What is persisted. The mnemonic is the account root's only backup. */
interface StoredWallet {
  /** BIP39 recovery phrase: derives the account root (`doc/spec/identity.md` §10.1). */
  mnemonic: string;
  /** Device private seed (hex): this device's signing key. */
  device: string;
  /** Root-signed authorization tying this device to the account. */
  auth: DeviceAuthorization;
}

/**
 * The stored blob and the account its phrase derives, or `null` when there is no phrase to derive
 * one from (not JSON, no phrase, or a phrase that does not parse): nothing in it can be recovered.
 */
function readStored(raw: string): { stored: StoredWallet; account: Account } | null {
  try {
    const stored = JSON.parse(raw) as StoredWallet;
    return { stored, account: accountFromMnemonic(stored.mnemonic) };
  } catch {
    return null; // not JSON, or no phrase that parses (`accountFromMnemonic` throws on either)
  }
}

/**
 * A device key from its stored seed. Throws unless the seed is exactly 32 bytes of hex:
 * `keyPairFromSeed` would quietly take the first 32 of a longer one and sign as someone else.
 */
function deviceFromSeedHex(seedHex: string): Wallet["device"] {
  const seed = fromHex(seedHex);
  if (seed.length !== 32) throw new Error("a device seed is 32 bytes");
  const key = keyPairFromSeed(seed);
  return { key, did: encodeDidKey(key.publicKey) };
}

/**
 * `account`'s wallet signing with the device this seed and authorization belong to (and the device
 * named `did`, when the record names one). Throws, saying why, unless the server would accept what
 * it signs: the authorization well-formed (an extra field leaves the signature valid, but the
 * server's strict parse refuses every op that carries it), the seed exactly 32 bytes of hex, and
 * the authorization naming that device under `account`, signed by its root and not expired. The one
 * rule for both device paths, the stored wallet's and a managed device's.
 */
function signingDevice(account: Account, seedHex: string, auth: unknown, did?: DidKey): Wallet {
  const parsed = deviceAuthorizationSchema.safeParse(auth);
  if (!parsed.success) throw new Error("its authorization is not well-formed");
  const device = deviceFromSeedHex(seedHex);
  if (did !== undefined && device.did !== did) throw new Error("its seed is another key");
  const valid = parsed.data;
  if (valid.authorizes !== device.did) throw new Error("its authorization names another device");
  if (valid.account !== account.did) throw new Error("its authorization is under another account");
  if (!verifyDeviceAuthorization(valid)) {
    // A signature that verifies at the moment it expired is out of date, not forged: renewable.
    const expired =
      valid.expires !== undefined && verifyDeviceAuthorization(valid, Date.parse(valid.expires));
    throw new Error(
      expired
        ? "its authorization has expired"
        : "its authorization is not the account's signature",
    );
  }
  return { account, device, auth: valid };
}

/** The stored device as a wallet for `account`, or `null` when it cannot sign for it. */
function storedDevice(stored: StoredWallet, account: Account): Wallet | null {
  try {
    return signingDevice(account, stored.device, stored.auth);
  } catch {
    return null;
  }
}

/** A wallet for `mnemonic` with a fresh device (`walletFromMnemonic`), persisted to `store`. */
async function persistNew(store: SecureKeyStore, mnemonic: string): Promise<Wallet> {
  const wallet = walletFromMnemonic(mnemonic);
  const stored: StoredWallet = {
    mnemonic: mnemonic.trim(),
    device: toHex(wallet.device.key.privateKey),
    auth: wallet.auth,
  };
  await store.setItem(WALLET_KEY, JSON.stringify(stored));
  return wallet;
}

/**
 * Load the player's wallet from `store`, or create and store a new account when there is none.
 *
 * A new account starts from a new 12-word recovery phrase. Show the phrase with
 * {@link revealRecoveryPhrase} so the player can back it up. Call {@link loadWallet} instead when
 * your app has its own first-run flow. A stored entry with no readable recovery phrase is replaced
 * by a new account.
 *
 * @example
 * ```ts
 * const wallet = await loadOrCreateWallet(store);
 * console.log(wallet.account.did); // did:key:z6Mk...
 * ```
 */
export async function loadOrCreateWallet(store: SecureKeyStore): Promise<Wallet> {
  return (await loadWallet(store)) ?? persistNew(store, createRecoveryPhrase());
}

/**
 * Load the player's wallet from `store`, without ever creating an account.
 *
 * When the phrase reads but the stored device key cannot sign, this rebuilds the wallet from the
 * phrase with a new device, stores it and returns it, as {@link importWalletFromPhrase} would. The
 * next profile the account publishes should list the new device.
 *
 * @returns The wallet, or `null` when nothing is stored or the stored recovery phrase cannot be
 * read. Start your first-run flow on `null`.
 * @throws The store's own error when storing a rebuilt wallet fails. The function throws instead of
 * returning `null`, so a caller that creates an account on `null` never writes over the recovery
 * phrase.
 */
export async function loadWallet(store: SecureKeyStore): Promise<Wallet | null> {
  const raw = await store.getItem(WALLET_KEY);
  if (!raw) return null;
  const read = readStored(raw);
  if (!read) return null;
  return storedDevice(read.stored, read.account) ?? persistNew(store, read.stored.mnemonic);
}

/**
 * Delete the stored wallet and create a new account in its place, for a "new identity" action.
 *
 * Warning: the old account is gone from this device. Only its recovery phrase can bring it back.
 */
export async function resetWallet(store: SecureKeyStore): Promise<Wallet> {
  await store.deleteItem(WALLET_KEY);
  return loadOrCreateWallet(store);
}

/**
 * Delete the stored wallet without creating a new one, for a "sign out" that starts your first-run
 * flow again.
 *
 * A later {@link loadWallet} returns `null`. Warning: only the recovery phrase can bring the
 * account back to this device.
 */
export async function deleteWallet(store: SecureKeyStore): Promise<void> {
  await store.deleteItem(WALLET_KEY);
}

/**
 * Restore an account on this device from its recovery phrase, with a new device key that the
 * account authorizes.
 *
 * The wallet replaces any wallet in `store`. The next profile the account publishes should list
 * this device (`doc/spec/identity.md` §10).
 *
 * @param mnemonic - A BIP39 recovery phrase from the English word list, such as the 12 words
 * `createRecoveryPhrase` makes. Spaces around the phrase are ignored. Inside it the words must be
 * lowercase and separated by single spaces, so normalize typed input first.
 * @throws `Error` when the phrase is not a valid BIP39 phrase, and the store's own error when
 * storing the wallet fails.
 */
export function importWalletFromPhrase(mnemonic: string, store: SecureKeyStore): Promise<Wallet> {
  return persistNew(store, mnemonic);
}

/**
 * Read the stored account's recovery phrase, to show the player for a backup.
 *
 * Warning: anyone with the phrase controls the account. Show the phrase only on the player's
 * request, and never send or log it (`doc/spec/identity.md` §10.1).
 *
 * @returns The phrase, or `null` when no wallet is stored.
 */
export async function revealRecoveryPhrase(store: SecureKeyStore): Promise<string | null> {
  const raw = await store.getItem(WALLET_KEY);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as StoredWallet).mnemonic;
  } catch {
    return null;
  }
}

/**
 * An extra device key for an account as {@link newDevice} makes it, with what the key needs to sign
 * after a reload.
 *
 * Turn the record into a wallet with {@link deviceWallet}. The record holds a private key, so keep
 * it in secret storage.
 */
export interface ManagedDevice {
  /** The device's public key as a `did:key`. */
  did: DidKey;
  /** The account root's signature that lets this device sign for the account. */
  auth: DeviceAuthorization;
  /** The device's 32-byte private seed, as 64 hex characters. */
  seedHex: string;
}

/**
 * Create a new device key and authorize it with the account root, for a second device or a key to
 * revoke later.
 *
 * The authorization does not expire. Store the returned record in secret storage, since the record
 * holds the device's private key.
 */
export function newDevice(account: Account): ManagedDevice {
  const device = createDevice();
  return {
    did: device.did,
    auth: authorizeDevice(account, device.did),
    seedHex: toHex(device.key.privateKey),
  };
}

/**
 * Build a wallet that signs as the device `dev` under `account`, to send ops from that device.
 *
 * The checks are the ones {@link loadWallet} applies to the stored device. A record that fails them
 * would sign ops the server refuses with no reason given. `keyPairFromSeed` would also take the
 * first 32 bytes of a longer seed and sign as another key.
 *
 * @throws `Error` naming the device and the reason when the record cannot sign: the seed is not
 * exactly 32 bytes of hex, the seed's key is not `dev.did`, or the authorization is malformed,
 * names another device or account, is not the account root's signature or has expired. An expired
 * authorization can be renewed with `authorizeDevice`.
 */
export function deviceWallet(account: Account, dev: ManagedDevice): Wallet {
  try {
    return signingDevice(account, dev.seedHex, dev.auth, dev.did);
  } catch (err) {
    throw new Error(`the record for ${dev.did} cannot sign: ${(err as Error).message}`);
  }
}
