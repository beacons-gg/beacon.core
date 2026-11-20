/**
 * Key custody for a client without secure storage, such as a browser: only the recovery phrase is
 * kept, encrypted with a passphrase, and each unlock assembles a session wallet with a **fresh**
 * device (`walletFromMnemonic`) whose authorization expires. Nothing key-shaped is ever persisted,
 * and dropping the session wallet (closing the tab) is a lock. A session device never appears in
 * the account's profile, so nothing could revoke it: the expiry is what bounds a leaked session key. The phone's policy is ./wallet.ts, which keeps the device key
 * in secure storage.
 *
 * The passphrase layer is PBKDF2-SHA-256 → AES-256-GCM through WebCrypto, with a random salt and IV
 * per encryption. The mnemonic only ever exists decrypted in memory during an unlocked session.
 *
 * Injected: the {@link SecureKeyStore} the envelope lives in, the key it lives under, and WebCrypto
 * (the global one by default; React Native has none, one reason the phone uses ./wallet.ts).
 */
import { createRecoveryPhrase, walletFromMnemonic, type Wallet } from "@beaconsgg/identity";
import type { SecureKeyStore } from "./wallet";

/** OWASP-recommended PBKDF2-SHA-256 work factor (2023+). */
const PBKDF2_ITERATIONS = 210_000;

/** The encrypted phrase at rest. Every byte string is standard base64. */
interface EncryptedEnvelope {
  v: 1;
  salt: string;
  iv: string;
  /** AES-GCM ciphertext, auth tag included. */
  data: string;
  iterations: number;
}

/**
 * The parts of WebCrypto a vault uses: `getRandomValues` for the salt and IV, and `subtle` for the
 * key derivation and encryption. The global `crypto` of a browser or of Node.js fits.
 */
export type VaultCrypto = Pick<typeof globalThis.crypto, "getRandomValues" | "subtle">;

/** The derived AES key, named without the DOM's `CryptoKey`: the SDK compiles without the DOM lib. */
type AesKey = Awaited<ReturnType<VaultCrypto["subtle"]["deriveKey"]>>;

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Exactly the envelope's fields, well-typed, and nothing else; anything else reads as absent. */
function readEnvelope(raw: unknown): EncryptedEnvelope | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(",");
  const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
  const ok =
    keys === "data,iterations,iv,salt,v" &&
    e["v"] === 1 &&
    nonEmpty(e["salt"]) &&
    nonEmpty(e["iv"]) &&
    nonEmpty(e["data"]) &&
    Number.isInteger(e["iterations"]) &&
    (e["iterations"] as number) > 0;
  return ok ? (e as unknown as EncryptedEnvelope) : undefined;
}

async function deriveKey(
  crypto: VaultCrypto,
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<AesKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `plaintext` under `passphrase`: a fresh salt and IV every time. */
export async function encryptWithPassphrase(
  plaintext: string,
  passphrase: string,
  crypto: VaultCrypto = globalThis.crypto,
): Promise<EncryptedEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(crypto, passphrase, salt, PBKDF2_ITERATIONS);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    v: 1,
    salt: toB64(salt),
    iv: toB64(iv),
    data: toB64(new Uint8Array(data)),
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * The error a vault's `unlock` throws when the passphrase does not decrypt the saved phrase. The
 * crypto's own error is the `cause`.
 *
 * AES-GCM can't tell a wrong passphrase from a damaged saved phrase, so both throw this error. Ask
 * for the passphrase again. Any other failure, such as a browser without WebCrypto, throws the
 * crypto's own error instead.
 */
export class WrongPassphraseError extends Error {
  constructor(cause: unknown) {
    super("the passphrase does not unlock the saved recovery phrase", { cause });
    this.name = "WrongPassphraseError";
  }
}

/**
 * Return `true` when `err` is what a vault's `unlock` threw because the passphrase did not decrypt
 * the saved phrase: a {@link WrongPassphraseError}.
 *
 * Use it to ask for the passphrase again.
 */
export function isWrongPassphrase(err: unknown): err is WrongPassphraseError {
  return err instanceof WrongPassphraseError;
}

/**
 * Throws a {@link WrongPassphraseError} on a wrong passphrase or a corrupted envelope (AES-GCM
 * authentication fails), and the crypto's own error for any failure before the decryption.
 */
export async function decryptWithPassphrase(
  envelope: EncryptedEnvelope,
  passphrase: string,
  crypto: VaultCrypto = globalThis.crypto,
): Promise<string> {
  const key = await deriveKey(crypto, passphrase, fromB64(envelope.salt), envelope.iterations);
  const iv = fromB64(envelope.iv);
  const data = fromB64(envelope.data);
  // Only AES-GCM's own refusal means the passphrase did not open the envelope.
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data).catch((err) => {
    throw new WrongPassphraseError(err);
  });
  return new TextDecoder().decode(plain);
}

/**
 * How long a vault's session device stays authorized by default, in seconds: 604800 (7 days).
 */
export const VAULT_SESSION_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * The settings of {@link passphraseVault}: where the vault stores the encrypted phrase, and how long
 * a session lasts.
 */
export interface VaultConfig {
  /**
   * The storage the encrypted phrase is saved to. The phrase is encrypted, so a browser's
   * `localStorage` wrapped in this interface is enough.
   */
  store: SecureKeyStore;
  /** The storage key the encrypted phrase is saved under. */
  key: string;
  /** The WebCrypto to use. Defaults to `globalThis.crypto`. */
  crypto?: VaultCrypto;
  /**
   * How long each session wallet's device authorization lasts, in seconds. Defaults to
   * {@link VAULT_SESSION_TTL_SEC} (7 days). Pass `null` for no expiry.
   *
   * A server checks the expiry when an op arrives, and refuses an op that arrives after it as it
   * refuses a bad signature, with `badsig`. A retry of an op signed earlier is refused too. Read
   * `wallet.auth.expires`, and ask for the passphrase again before then or when a write is refused
   * after it.
   */
  sessionTtlSec?: number | null;
  /** The clock, in milliseconds since the epoch, that stamps each session. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Create a vault that keeps the player's recovery phrase encrypted with a passphrase, for a client
 * with no secure storage such as a browser.
 *
 * Only the encrypted phrase is stored. Each `create`, `importPhrase` or `unlock` returns a session
 * wallet with a new device key, authorized for `sessionTtlSec` (7 days by default), and nothing
 * key-shaped is stored, so dropping the wallet (closing the tab) locks the vault. Unlock again for
 * a new session once `wallet.auth.expires` has passed. On a phone, use {@link loadOrCreateWallet}
 * with the platform's secure storage instead.
 *
 * The phrase is encrypted with AES-256-GCM, under a key derived from the passphrase with
 * PBKDF2-SHA-256 at 210000 iterations, with a new random salt and IV each time.
 *
 * @example
 * ```ts
 * const vault = passphraseVault({ store, key: "my-game.vault" });
 * const wallet = (await vault.hasSaved())
 *   ? await vault.unlock(passphrase)
 *   : (await vault.create(passphrase)).wallet;
 * ```
 */
export function passphraseVault(config: VaultConfig) {
  const ttlSec = config.sessionTtlSec === undefined ? VAULT_SESSION_TTL_SEC : config.sessionTtlSec;
  if (ttlSec !== null && !(Number.isFinite(ttlSec) && ttlSec > 0)) {
    throw new TypeError("passphraseVault: sessionTtlSec must be a positive number of seconds");
  }
  const now = config.now ?? (() => Date.now());

  /** A session wallet for `mnemonic`: a new device, authorized from now for the session's length. */
  function session(mnemonic: string): Wallet {
    const issuedAt = now();
    const expires = ttlSec === null ? undefined : new Date(issuedAt + ttlSec * 1000).toISOString();
    return walletFromMnemonic(mnemonic, { issued: new Date(issuedAt).toISOString(), expires });
  }

  /** The saved envelope, or `undefined` for none, JSON garbage or a shape mismatch. */
  async function saved(): Promise<EncryptedEnvelope | undefined> {
    const raw = await config.store.getItem(config.key);
    if (raw === null) return undefined;
    try {
      return readEnvelope(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async function importPhrase(mnemonic: string, passphrase: string): Promise<Wallet> {
    const wallet = session(mnemonic); // validates the phrase before anything persists
    const envelope = await encryptWithPassphrase(mnemonic.trim(), passphrase, config.crypto);
    await config.store.setItem(config.key, JSON.stringify(envelope));
    return wallet;
  }

  return {
    /**
     * Save an existing recovery phrase, encrypted with `passphrase`, and return a session wallet
     * for its account.
     *
     * The phrase replaces any phrase already saved under the vault's key.
     *
     * @throws `Error` when `mnemonic` is not a valid BIP39 phrase. Nothing is saved in that case.
     */
    importPhrase,

    /**
     * Return `true` when the vault holds a saved phrase it can read. Use the answer to offer either
     * "set up" or "unlock".
     */
    async hasSaved(): Promise<boolean> {
      return (await saved()) !== undefined;
    },

    /**
     * Create a new account: generate a 12-word recovery phrase, save it encrypted with `passphrase`
     * and return the phrase with a session wallet.
     *
     * Show `mnemonic` to the player once so they can back it up. The phrase replaces any phrase
     * already saved under the vault's key.
     */
    async create(passphrase: string): Promise<{ mnemonic: string; wallet: Wallet }> {
      const mnemonic = createRecoveryPhrase();
      return { mnemonic, wallet: await importPhrase(mnemonic, passphrase) };
    },

    /**
     * Decrypt the saved phrase with `passphrase` and return a session wallet with a new device key.
     *
     * The session lasts `sessionTtlSec` from now. Call `unlock` again for a new one.
     *
     * @throws {@link WrongPassphraseError} when the passphrase is wrong, `Error` when no readable
     * phrase is saved, and the crypto's own error for a failure before the decryption.
     */
    async unlock(passphrase: string): Promise<Wallet> {
      const envelope = await saved();
      if (!envelope) throw new Error("no saved wallet");
      return session(await decryptWithPassphrase(envelope, passphrase, config.crypto));
    },

    /**
     * Delete the saved encrypted phrase.
     *
     * Warning: after this only the player's own backup of the recovery phrase can restore the
     * account.
     */
    forget(): Promise<void> {
      return config.store.deleteItem(config.key);
    },
  };
}

/**
 * A vault from {@link passphraseVault} that keeps the player's recovery phrase encrypted under a
 * passphrase and unlocks a session wallet from it.
 *
 * The methods are `hasSaved`, `create`, `importPhrase`, `unlock` and `forget`.
 */
export type PassphraseVault = ReturnType<typeof passphraseVault>;
