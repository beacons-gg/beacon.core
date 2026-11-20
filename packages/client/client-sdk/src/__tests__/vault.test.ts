/**
 * vault.ts: custody without secure storage. The passphrase envelope (AES-GCM under PBKDF2) and the
 * vault over a store: only the encrypted phrase at rest, a fresh device per unlock.
 */
import { signOpWithWallet, verifyOp, walletFromMnemonic } from "@beaconsgg/identity";
import { describe, expect, it, vi } from "vitest";
import {
  decryptWithPassphrase,
  encryptWithPassphrase,
  isWrongPassphrase,
  WrongPassphraseError,
  passphraseVault,
  VAULT_SESSION_TTL_SEC,
  type VaultCrypto,
} from "../vault";
import { memorySecureStore } from "../wallet";

const PHRASE = "test test test test test test test test test test test junk";
const KEY = "test.vault";

describe("the passphrase envelope (AES-GCM)", () => {
  it("round-trips a mnemonic and rejects a wrong passphrase", async () => {
    const envelope = await encryptWithPassphrase(PHRASE, "correct horse");
    expect(envelope.data).not.toContain("test"); // ciphertext, not plaintext

    expect(await decryptWithPassphrase(envelope, "correct horse")).toBe(PHRASE);
    await expect(decryptWithPassphrase(envelope, "wrong")).rejects.toThrow();
  });

  it("uses a fresh salt + IV per encryption (no envelope reuse)", async () => {
    const a = await encryptWithPassphrase(PHRASE, "pw");
    const b = await encryptWithPassphrase(PHRASE, "pw");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });
});

describe("session assembly", () => {
  it("derives a stable account DID and a fresh authorized device per unlock", async () => {
    const store = memorySecureStore();
    const vault = passphraseVault({ store, key: KEY });
    await vault.importPhrase(PHRASE, "pw");
    const first = await vault.unlock("pw");
    const second = await vault.unlock("pw");
    expect(first.account.did).toBe(second.account.did); // the DID on BEACON_ADMINS is stable
    expect(first.device.did).not.toBe(second.device.did); // device rotates per session

    // The session wallet signs envelopes that verify offline: the whole point.
    const env = signOpWithWallet(first, {
      op: "admin.status",
      nonce: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      params: {},
    });
    expect(verifyOp(env, Date.now()).ok).toBe(true);
    expect(env.actor).toBe(walletFromMnemonic(PHRASE).account.did);
  });
});

describe("session expiry", () => {
  const T0 = Date.parse("2026-11-12T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const listAt = (wallet: Awaited<ReturnType<ReturnType<typeof passphraseVault>["unlock"]>>) =>
    signOpWithWallet(wallet, {
      op: "admin.status",
      nonce: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      params: {},
    });

  it("authorizes each session device for 7 days by default", async () => {
    const vault = passphraseVault({ store: memorySecureStore(), key: KEY, now: () => T0 });
    const created = await vault.create("pw");
    const unlocked = await vault.unlock("pw");
    expect(VAULT_SESSION_TTL_SEC).toBe(7 * 24 * 60 * 60);
    for (const wallet of [created.wallet, unlocked]) {
      expect(wallet.auth.issued).toBe(new Date(T0).toISOString());
      expect(wallet.auth.expires).toBe(new Date(T0 + 7 * DAY).toISOString());
    }
    // A server checks the expiry: inside the week the session signs, after it the op is refused.
    expect(verifyOp(listAt(unlocked), T0 + 6 * DAY).ok).toBe(true);
    expect(verifyOp(listAt(unlocked), T0 + 8 * DAY).ok).toBe(false);
  });

  it("takes another length, or none", async () => {
    const hour = passphraseVault({
      store: memorySecureStore(),
      key: KEY,
      now: () => T0,
      sessionTtlSec: 3600,
    });
    expect((await hour.importPhrase(PHRASE, "pw")).auth.expires).toBe(
      new Date(T0 + 3600 * 1000).toISOString(),
    );
    const forever = passphraseVault({ store: memorySecureStore(), key: KEY, sessionTtlSec: null });
    expect((await forever.importPhrase(PHRASE, "pw")).auth).not.toHaveProperty("expires");
  });

  it("refuses a length that is not a positive number of seconds", () => {
    for (const sessionTtlSec of [0, -1, Number.NaN, Infinity])
      expect(() =>
        passphraseVault({ store: memorySecureStore(), key: KEY, sessionTtlSec }),
      ).toThrow(TypeError);
  });
});

describe("the vault over a store", () => {
  it("rejects an invalid recovery phrase before anything persists", async () => {
    const store = memorySecureStore();
    const vault = passphraseVault({ store, key: KEY });
    await expect(vault.importPhrase("not a real phrase", "pw")).rejects.toThrow(/invalid/);
    expect(await store.getItem(KEY)).toBeNull();
  });

  it("keeps only the encrypted phrase at rest, trimmed", async () => {
    const store = memorySecureStore();
    const vault = passphraseVault({ store, key: KEY });
    await vault.importPhrase(`  ${PHRASE}\n`, "pw");
    const raw = (await store.getItem(KEY)) ?? "";
    expect(raw).not.toContain("test"); // no phrase, no key material
    expect(await decryptWithPassphrase(JSON.parse(raw), "pw")).toBe(PHRASE);
  });

  it("creates a fresh identity and returns its phrase", async () => {
    const vault = passphraseVault({ store: memorySecureStore(), key: KEY });
    const { mnemonic, wallet } = await vault.create("pw");
    expect(mnemonic.split(" ")).toHaveLength(12);
    expect((await vault.unlock("pw")).account.did).toBe(wallet.account.did);
  });

  it("refuses to unlock with the wrong passphrase, or with nothing saved", async () => {
    const vault = passphraseVault({ store: memorySecureStore(), key: KEY });
    await expect(vault.unlock("pw")).rejects.toThrow("no saved wallet");
    await vault.importPhrase(PHRASE, "pw");
    await expect(vault.unlock("wrong")).rejects.toThrow();
  });

  it("throws a WrongPassphraseError for a wrong passphrase, with the crypto's error as its cause", async () => {
    const vault = passphraseVault({ store: memorySecureStore(), key: KEY });
    const nothingSaved = await vault.unlock("pw").catch((err: unknown) => err);
    expect(isWrongPassphrase(nothingSaved)).toBe(false);
    await vault.importPhrase(PHRASE, "pw");
    const wrong = await vault.unlock("wrong").catch((err: unknown) => err);
    expect(isWrongPassphrase(wrong)).toBe(true);
    expect(wrong).toBeInstanceOf(WrongPassphraseError);
    expect((wrong as Error).name).toBe("WrongPassphraseError");
    expect(((wrong as Error).cause as Error).name).toBe("OperationError");
    expect(isWrongPassphrase(new Error("operation failed"))).toBe(false);
    expect(isWrongPassphrase(undefined)).toBe(false);
  });

  it("does not call a crypto failure before the decryption a wrong passphrase", async () => {
    const store = memorySecureStore();
    await passphraseVault({ store, key: KEY }).importPhrase(PHRASE, "pw");
    const broken = {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
      subtle: { importKey: () => Promise.reject(new TypeError("no WebCrypto here")) },
    } as unknown as VaultCrypto;
    const err = await passphraseVault({ store, key: KEY, crypto: broken })
      .unlock("pw")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isWrongPassphrase(err)).toBe(false);
  });

  it("unlocks at the iteration count the envelope was saved with, not the current one", async () => {
    // The count is stored so the work factor can rise without stranding saved wallets. This one was
    // made at 1,000 rounds (the same algorithm, run standalone), so it only unlocks if decryption
    // derives with the stored count.
    const at1000 =
      '{"v":1,"salt":"JaG9S/iiQuYbhvl8Tn5bsQ==","iv":"Lb2nGmpKghHfn/rW","data":"1HU1rId9a9r+09Fws+UBkRXgl5ND1osyYlHz+YWJXEpiw/uGvdSOQLa3VUvU8g+L0Stnt726VgGGIi8lPa0QGgUtlXRnX7yKxWAL","iterations":1000}';
    const vault = passphraseVault({ store: memorySecureStore({ [KEY]: at1000 }), key: KEY });
    const wallet = await vault.unlock("pw");
    expect(wallet.account.did).toBe(walletFromMnemonic(PHRASE).account.did);
  });

  it("forgets the saved envelope", async () => {
    const vault = passphraseVault({ store: memorySecureStore(), key: KEY });
    await vault.importPhrase(PHRASE, "pw");
    await vault.forget();
    expect(await vault.hasSaved()).toBe(false);
  });

  it("reads JSON garbage or any other shape as nothing saved", async () => {
    const good = await encryptWithPassphrase(PHRASE, "pw");
    const read = (raw: string) =>
      passphraseVault({ store: memorySecureStore({ [KEY]: raw }), key: KEY }).hasSaved();
    expect(await read("{")).toBe(false);
    expect(await read("[]")).toBe(false);
    expect(await read(JSON.stringify({ ...good, extra: 1 }))).toBe(false);
    expect(await read(JSON.stringify({ ...good, v: 2 }))).toBe(false);
    expect(await read(JSON.stringify({ ...good, salt: "" }))).toBe(false);
    expect(await read(JSON.stringify({ ...good, iv: "" }))).toBe(false);
    expect(await read(JSON.stringify({ ...good, data: "" }))).toBe(false);
    expect(await read(JSON.stringify({ ...good, iterations: 1.5 }))).toBe(false);
    expect(await read(JSON.stringify({ ...good, iterations: 0 }))).toBe(false);
    expect(await read(JSON.stringify(good))).toBe(true);
  });

  it("uses the WebCrypto it was given", async () => {
    const getRandomValues = vi.fn((a: Uint8Array) => globalThis.crypto.getRandomValues(a));
    const crypto = {
      getRandomValues,
      subtle: globalThis.crypto.subtle,
    } as unknown as VaultCrypto;
    const vault = passphraseVault({ store: memorySecureStore(), key: KEY, crypto });
    await vault.importPhrase(PHRASE, "pw");
    expect(getRandomValues).toHaveBeenCalledTimes(2); // the salt and the IV
  });
});
