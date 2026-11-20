/**
 * wallet.ts: the recovery-phrase-backed wallet, persisted to an in-memory store (no platform
 * storage).
 */
import {
  accountFromMnemonic,
  authorizeDevice,
  createAccount,
  encodeDidKey,
  keyPairFromSeed,
  signOpWithWallet,
  verifyOp,
  type Account,
} from "@beaconsgg/identity";
import { describe, expect, it } from "vitest";
import { fromHex } from "../hex";
import {
  deleteWallet,
  deviceWallet,
  importWalletFromPhrase,
  loadOrCreateWallet,
  loadWallet,
  memorySecureStore,
  newDevice,
  type ManagedDevice,
  resetWallet,
  revealRecoveryPhrase,
} from "../wallet";

describe("wallet: create / persist / reload", () => {
  it("creates a fresh wallet and reloads the SAME identity from the store", async () => {
    const store = memorySecureStore();
    const created = await loadOrCreateWallet(store);
    const reloaded = await loadOrCreateWallet(store);

    // Same account + device across a reload (a wrong seed encoding would misattribute ops).
    expect(reloaded.account.did).toBe(created.account.did);
    expect(reloaded.device.did).toBe(created.device.did);
    // The device authorization ties the device to the account.
    expect(created.auth.authorizes).toBe(created.device.did);
    expect(created.auth.account).toBe(created.account.did);
  });

  it("the stored recovery phrase re-derives the account root (doc/spec/identity.md §10)", async () => {
    const store = memorySecureStore();
    const created = await loadOrCreateWallet(store);
    const phrase = await revealRecoveryPhrase(store);
    expect(typeof phrase).toBe("string");
    // The phrase alone reconstructs the same account did: the one unrecoverable case is losing it.
    expect(accountFromMnemonic(phrase as string).did).toBe(created.account.did);
  });

  it("resetWallet discards the old identity and mints a new one", async () => {
    const store = memorySecureStore();
    const first = await loadOrCreateWallet(store);
    const second = await resetWallet(store);
    expect(second.account.did).not.toBe(first.account.did);
  });

  it("deleteWallet clears the store WITHOUT minting a new one (returns to first-run)", async () => {
    const store = memorySecureStore();
    await loadOrCreateWallet(store);
    await deleteWallet(store);
    // A later load-only restore must find nothing, so a first-run flow (with backup) runs again.
    expect(await loadWallet(store)).toBeNull();
  });

  it("importWalletFromPhrase recovers an account and registers THIS device under it", async () => {
    const source = memorySecureStore();
    const original = await loadOrCreateWallet(source);
    const phrase = (await revealRecoveryPhrase(source)) as string;

    const dest = memorySecureStore(); // a "new device"
    const imported = await importWalletFromPhrase(phrase, dest);
    expect(imported.account.did).toBe(original.account.did); // same account
    expect(imported.device.did).not.toBe(original.device.did); // different device key
    expect(imported.auth.account).toBe(original.account.did);
  });

  it("refuses an invalid phrase and leaves the stored wallet untouched", async () => {
    const store = memorySecureStore();
    const existing = await loadOrCreateWallet(store);
    await expect(importWalletFromPhrase("not a recovery phrase", store)).rejects.toThrow();
    // A mistyped restore must not land the player in a new account, or cost them the one they had.
    expect((await loadWallet(store))?.account.did).toBe(existing.account.did);
    expect((await loadWallet(store))?.device.did).toBe(existing.device.did);
  });

  it("stores a pasted phrase trimmed, so the backup it reveals is the phrase itself", async () => {
    const source = memorySecureStore();
    await loadOrCreateWallet(source);
    const phrase = (await revealRecoveryPhrase(source)) as string;
    const dest = memorySecureStore();
    await importWalletFromPhrase(`  ${phrase}\n`, dest);
    expect(await revealRecoveryPhrase(dest)).toBe(phrase);
  });

  it("regenerates on a corrupt stored blob instead of throwing", async () => {
    const store = memorySecureStore({ "beacon.wallet.v1": "not json" });
    const wallet = await loadOrCreateWallet(store);
    expect(wallet.account.did).toMatch(/^did:key:/);
    // It overwrote the blob: the regenerated wallet is the one that loads now.
    expect((await loadWallet(store))?.account.did).toBe(wallet.account.did);
  });

  describe("loadWallet: load-only, never creates", () => {
    it("returns null when nothing is stored (never creates one)", async () => {
      const store = memorySecureStore();
      expect(await loadWallet(store)).toBeNull();
      // Confirm it did NOT persist a fresh wallet as a side effect.
      expect(await loadWallet(store)).toBeNull();
    });

    it("restores the SAME identity a prior create persisted", async () => {
      const store = memorySecureStore();
      const created = await loadOrCreateWallet(store);
      const loaded = await loadWallet(store);
      expect(loaded).not.toBeNull();
      expect(loaded?.account.did).toBe(created.account.did);
      expect(loaded?.device.did).toBe(created.device.did);
    });

    it("returns null on a corrupt stored blob (no throw)", async () => {
      const store = memorySecureStore({ "beacon.wallet.v1": "not json" });
      expect(await loadWallet(store)).toBeNull();
    });
  });
});

describe("the stored device key", () => {
  it("reveals nothing when there is no wallet, or the blob is unreadable", async () => {
    expect(await revealRecoveryPhrase(memorySecureStore())).toBeNull();
    expect(await revealRecoveryPhrase(memorySecureStore({ "beacon.wallet.v1": "{" }))).toBeNull();
  });
});

/**
 * The recovery phrase is the account's only backup, so a stored wallet whose device can no
 * longer sign is rebuilt from it, not thrown away with it. Before, `loadWallet` answered `null` and
 * the next create wrote a new account over the phrase.
 */
describe("a damaged device with an intact phrase", () => {
  type Blob = { mnemonic: string; device: string; auth: Record<string, unknown> };
  /** A stored wallet, then its blob with `damage` applied: what a partial write or a re-encode leaves. */
  async function damaged(damage: (blob: Blob) => Blob) {
    const store = memorySecureStore();
    const original = await loadOrCreateWallet(store);
    const blob = JSON.parse((await store.getItem("beacon.wallet.v1")) ?? "") as Blob;
    await store.setItem("beacon.wallet.v1", JSON.stringify(damage(blob)));
    return { store, original, phrase: blob.mnemonic };
  }

  /** The did:key of a stored device seed. */
  const deviceDidOf = (seedHex: string) =>
    encodeDidKey(keyPairFromSeed(fromHex(seedHex)).publicKey);

  const damages: [string, (blob: Blob) => Blob][] = [
    ["a seed that is not hex", (b) => ({ ...b, device: "zz".repeat(32) })],
    // 33 bytes: `keyPairFromSeed` would quietly take the first 32 (the original key), so only the
    // wallet's own length check stops the truncated key signing.
    ["a seed one byte too long", (b) => ({ ...b, device: `${b.device}00` })],
    ["a seed one byte short", (b) => ({ ...b, device: b.device.slice(2) })],
    ["no seed at all", ({ device: _d, ...b }) => b as Blob],
    [
      "an authorization with a broken signature",
      (b) => ({ ...b, auth: { ...b.auth, sig: "AAAA" } }),
    ],
    [
      "an authorization edited to name another device",
      (b) => ({ ...b, auth: { ...b.auth, authorizes: createAccount().did } }),
    ],
    // Validly signed, so only the device and account comparisons can refuse them: the signature
    // verifies, the wallet would load, and the server would refuse every op it signs.
    [
      "a valid authorization for another device under this account",
      (b) => ({
        ...b,
        auth: authorizeDevice(accountFromMnemonic(b.mnemonic), createAccount().did),
      }),
    ],
    [
      "a valid authorization for this device under another account",
      (b) => ({ ...b, auth: authorizeDevice(createAccount(), deviceDidOf(b.device)) }),
    ],
    ["no authorization at all", ({ auth: _a, ...b }) => b as Blob],
    // Signed fields intact, so the signature still verifies, but the server's strict parse refuses it.
    ["an authorization with an unknown field", (b) => ({ ...b, auth: { ...b.auth, extra: 1 } })],
  ];

  it.each(damages)(
    "%s: rebuilds the same account with a new device that signs, and keeps the phrase",
    async (_label, damage) => {
      const { store, original, phrase } = await damaged(damage);
      const rebuilt = await loadWallet(store);
      expect(rebuilt?.account.did).toBe(original.account.did);
      expect(rebuilt?.device.did).not.toBe(original.device.did);
      expect(rebuilt?.auth).toMatchObject({
        account: original.account.did,
        authorizes: rebuilt?.device.did,
      });
      const env = signOpWithWallet(rebuilt!, {
        op: "list",
        nonce: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        params: {},
      });
      expect(verifyOp(env).ok).toBe(true);
      // Persisted: the next launch loads the rebuilt device, and the phrase is the one backed up.
      expect((await loadWallet(store))?.device.did).toBe(rebuilt?.device.did);
      expect(await revealRecoveryPhrase(store)).toBe(phrase);
    },
  );

  it("create keeps the account (the path that used to write a new one over the phrase)", async () => {
    const { store, original } = await damaged((b) => ({ ...b, device: "zz" }));
    expect((await loadOrCreateWallet(store)).account.did).toBe(original.account.did);
  });

  it("throws rather than answering null when the rebuilt wallet cannot be stored", async () => {
    const { store, original } = await damaged((b) => ({ ...b, device: "zz" }));
    const before = await store.getItem("beacon.wallet.v1");
    const readOnly = { ...store, setItem: () => Promise.reject(new Error("keystore locked")) };
    await expect(loadWallet(readOnly)).rejects.toThrow("keystore locked");
    // So a create on top cannot fall through to a new account either, and the blob is untouched.
    await expect(loadOrCreateWallet(readOnly)).rejects.toThrow("keystore locked");
    expect(await store.getItem("beacon.wallet.v1")).toBe(before);
    expect((await loadWallet(store))?.account.did).toBe(original.account.did);
  });

  it("a phrase that does not parse leaves nothing to rebuild from: null, as before", async () => {
    const { store } = await damaged((b) => ({ ...b, mnemonic: "not a recovery phrase" }));
    expect(await loadWallet(store)).toBeNull();
  });
});

describe("managed devices", () => {
  it("authorizes a new device, and it signs as itself once rebuilt from its seed", () => {
    const account = createAccount();
    const dev = newDevice(account);
    expect(dev.auth.account).toBe(account.did);
    expect(dev.auth.authorizes).toBe(dev.did);
    const wallet = deviceWallet(account, dev);
    expect(wallet.device.did).toBe(dev.did);
    const env = signOpWithWallet(wallet, {
      op: "list",
      nonce: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      params: {},
    });
    expect(verifyOp(env).ok).toBe(true);
  });

  /**
   * A record that cannot sign as the device it names is refused, not signed with. A seed one
   * byte long would otherwise sign as the key of its first 32 bytes, which is not the record's did.
   * The authorization is held to the rule a stored wallet loads by: each of these signs ops the
   * server refuses.
   */
  it.each<[string, (dev: ManagedDevice, account: Account) => ManagedDevice, RegExp]>([
    ["a seed one byte too long", (d) => ({ ...d, seedHex: `${d.seedHex}00` }), /32 bytes/],
    ["a seed one byte short", (d) => ({ ...d, seedHex: d.seedHex.slice(2) }), /32 bytes/],
    ["a seed that is not hex", (d) => ({ ...d, seedHex: "zz".repeat(32) }), /cannot sign/],
    ["another device's seed", (d, a) => ({ ...d, seedHex: newDevice(a).seedHex }), /another key/],
    [
      "an authorization for another device",
      (d, a) => ({ ...d, auth: newDevice(a).auth }),
      /names another device/,
    ],
    [
      "an authorization under another account",
      (d) => ({ ...d, auth: authorizeDevice(createAccount(), d.did) }),
      /under another account/,
    ],
    [
      "an authorization whose signature was changed",
      (d) => ({
        ...d,
        auth: { ...d.auth, sig: `${d.auth.sig[0] === "A" ? "B" : "A"}${d.auth.sig.slice(1)}` },
      }),
      /not the account's signature/,
    ],
    [
      "an authorization with a field the server refuses",
      (d) => ({ ...d, auth: { ...d.auth, note: "x" } as ManagedDevice["auth"] }),
      /not well-formed/,
    ],
    [
      "an authorization that has expired",
      (d, a) => ({
        ...d,
        auth: authorizeDevice(a, d.did, {
          issued: "2020-01-01T00:00:00.000Z",
          expires: "2020-01-02T00:00:00.000Z",
        }),
      }),
      /has expired/,
    ],
  ])("refuses to sign as a device whose record has %s", (_label, damage, reason) => {
    const account = createAccount();
    expect(() => deviceWallet(account, damage(newDevice(account), account))).toThrow(reason);
  });

  it("gives each added device a distinct identity", () => {
    const account = createAccount();
    const a = newDevice(account);
    const b = newDevice(account);
    expect(a.did).not.toBe(b.did);
    expect(a.seedHex).not.toBe(b.seedHex);
  });
});
