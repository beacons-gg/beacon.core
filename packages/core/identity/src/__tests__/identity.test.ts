import { opEnvelopeSchema, type UnsignedOpEnvelope } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import {
  accountFromMnemonic,
  authorizeDevice,
  createAccount,
  createDevice,
  createRecoveryPhrase,
  createWallet,
  decodeDidKey,
  encodeDidKey,
  generateKeyPair,
  signOp,
  signOpWithWallet,
  verifyDeviceAuthorization,
  verifyOp,
  walletFromMnemonic,
  walletIdentity,
} from "../index";

const NONCE = "01J8XR4M0NQ9Z6T2W3K4Y5B7CD";
const ISSUED = "2026-06-26T00:00:00Z";

describe("did:key", () => {
  it("round-trips a public key", () => {
    const { publicKey } = generateKeyPair();
    const did = encodeDidKey(publicKey);
    expect(did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(decodeDidKey(did)).toEqual(publicKey);
  });

  it("rejects a non-ed25519 did:key", () => {
    expect(() => decodeDidKey("did:key:zNotReal")).toThrow();
    expect(() => decodeDidKey("did:web:example.com")).toThrow();
  });
});

describe("device authorization", () => {
  it("a root authorizes a device, and it verifies", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    expect(auth.account).toBe(account.did);
    expect(auth.authorizes).toBe(device.did);
    expect(verifyDeviceAuthorization(auth)).toBe(true);
  });

  it("rejects a tampered authorization", () => {
    const account = createAccount();
    const device = createDevice();
    const other = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    expect(verifyDeviceAuthorization({ ...auth, authorizes: other.did })).toBe(false);
    expect(verifyDeviceAuthorization({ ...auth, issued: "2030-01-01T00:00:00Z" })).toBe(false);
  });

  it("rejects an authorization not actually signed by the named account", () => {
    const realAccount = createAccount();
    const impostor = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(impostor, device.did, { issued: ISSUED });
    // Claim it came from realAccount — signature no longer matches that key.
    expect(verifyDeviceAuthorization({ ...auth, account: realAccount.did })).toBe(false);
  });

  it("answers false for a field with no canonical form, never a throw", () => {
    // The schema keeps these strings on the wire; a caller handing over unparsed input gets an answer.
    const account = createAccount();
    const auth = authorizeDevice(account, createDevice().did, { issued: ISSUED });
    expect(verifyDeviceAuthorization({ ...auth, issued: Infinity as unknown as string })).toBe(
      false,
    );
  });

  it("honors an optional offline expiry", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, {
      issued: ISSUED,
      expires: "2026-07-01T00:00:00Z",
    });
    const before = Date.parse("2026-06-30T00:00:00Z");
    const after = Date.parse("2026-07-02T00:00:00Z");
    expect(verifyDeviceAuthorization(auth, before)).toBe(true);
    expect(verifyDeviceAuthorization(auth, after)).toBe(false); // expired
    // expiry is signed — tampering with it fails the signature, not just the time check
    expect(verifyDeviceAuthorization({ ...auth, expires: "2030-01-01T00:00:00Z" }, after)).toBe(
      false,
    );
  });
});

describe("signOp / verifyOp (M0)", () => {
  function unsigned(account: string, device: string, auth: ReturnType<typeof authorizeDevice>) {
    const env: UnsignedOpEnvelope = {
      op: "take",
      room: "u1@beacon.example",
      actor: account,
      device,
      auth,
      nonce: NONCE,
      issuedAt: ISSUED,
      params: { item: "itemUnique" },
    };
    return env;
  }

  it("generates an identity and signs + verifies an op", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });

    const env = signOp(unsigned(account.did, device.did, auth), device.key.privateKey);

    // The produced envelope is schema-valid wire data.
    expect(opEnvelopeSchema.safeParse(env).success).toBe(true);

    const result = verifyOp(env);
    expect(result).toEqual({ ok: true, actor: account.did });
  });

  it("rejects a tampered param (badsig)", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    const env = signOp(unsigned(account.did, device.did, auth), device.key.privateKey);

    const tampered = { ...env, params: { item: "somethingElse" } };
    expect(verifyOp(tampered)).toEqual({ ok: false, reason: "badsig" });
  });

  it("rejects when the op is signed by an unauthorized device", () => {
    const account = createAccount();
    const device = createDevice();
    const rogue = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });

    // Envelope claims the authorized device, but is signed by the rogue key.
    const env = signOp(unsigned(account.did, device.did, auth), rogue.key.privateKey);
    expect(verifyOp(env)).toEqual({ ok: false, reason: "badsig" });
  });

  it("rejects an actor that does not match the authorization", () => {
    const account = createAccount();
    const other = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    const env = signOp(unsigned(other.did, device.did, auth), device.key.privateKey);
    expect(verifyOp(env)).toEqual({ ok: false, reason: "actorMismatch" });
  });

  it("rejects a device that does not match the authorization", () => {
    const account = createAccount();
    const device = createDevice();
    const otherDevice = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    const env = signOp(unsigned(account.did, otherDevice.did, auth), otherDevice.key.privateKey);
    expect(verifyOp(env)).toEqual({ ok: false, reason: "deviceMismatch" });
  });

  it("rejects a malformed envelope (schema re-validation)", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    const env = signOp(unsigned(account.did, device.did, auth), device.key.privateKey);
    // an extra top-level key fails the strict schema before any crypto runs
    const malformed = { ...env, extra: 1 } as unknown as typeof env;
    expect(verifyOp(malformed)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a value canonical JSON has no form for as malformed, never a throw", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    const env = signOp(
      { ...unsigned(account.did, device.did, auth), params: { k: 1 } },
      device.key.privateKey,
    );
    // Only JSON.parse writes it: `1e400` parses to Infinity, which the schema's `unknown` params admit.
    const bad = JSON.parse(JSON.stringify(env).replace('"k":1', '"k":1e400')) as typeof env;
    expect(bad.params["k"]).toBe(Infinity);
    expect(verifyOp(bad)).toEqual({ ok: false, reason: "malformed" });
    // Decided before the auth checks, so a bad auth does not change the answer.
    expect(verifyOp({ ...bad, auth: { ...bad.auth, sig: "AAAA" } })).toEqual({
      ok: false,
      reason: "malformed",
    });
    // The signing side keeps throwing: a writer producing Infinity is a bug to surface.
    const { sig: _sig, ...unsignedBad } = bad;
    expect(() => signOp(unsignedBad, device.key.privateKey)).toThrow();
  });

  it("refuses params nested deeper than canonical JSON can walk as malformed", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, { issued: ISSUED });
    const env = signOp(
      { ...unsigned(account.did, device.did, auth), params: { k: 1 } },
      device.key.privateKey,
    );
    // 40 KB of JSON that `JSON.parse` reads and the schema's `unknown` params admit. The canonicalizer
    // recurses, and overflows its stack at a few thousand levels.
    const deep = "[".repeat(20_000) + "]".repeat(20_000);
    const bad = JSON.parse(JSON.stringify(env).replace('"k":1', `"k":${deep}`)) as typeof env;
    expect(verifyOp(bad)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an op signed by an expired device authorization", () => {
    const account = createAccount();
    const device = createDevice();
    const auth = authorizeDevice(account, device.did, {
      issued: ISSUED,
      expires: "2026-07-01T00:00:00Z",
    });
    const env = signOp(unsigned(account.did, device.did, auth), device.key.privateKey);
    const after = Date.parse("2026-07-02T00:00:00Z");
    expect(verifyOp(env, after)).toEqual({ ok: false, reason: "badauth" });
  });
});

describe("wallet", () => {
  it("signOpWithWallet produces a verifiable, schema-valid envelope", () => {
    const wallet = createWallet({ issued: ISSUED });
    const env = signOpWithWallet(wallet, {
      op: "add",
      room: "u1@beacon.example",
      nonce: NONCE,
      issuedAt: ISSUED,
      params: { item: { unique: "r1" } },
    });
    expect(opEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(verifyOp(env)).toEqual({ ok: true, actor: wallet.account.did });

    const identity = walletIdentity(wallet);
    expect(identity.account).toBe(wallet.account.did);
    expect(identity.device).toBe(wallet.device.did);
  });

  it("omits `room` for room-less ops (scout-report / spawn-claim)", () => {
    const wallet = createWallet({ issued: ISSUED });
    const env = signOpWithWallet(wallet, { op: "report", nonce: NONCE, params: {} });
    expect("room" in env).toBe(false);
    expect(verifyOp(env).ok).toBe(true);
  });

  // The conditional spread keeps the key absent rather than present-and-undefined, which keeps
  // `exactOptionalPropertyTypes` satisfiable and reads correctly to anything branching on key
  // presence. No slug is an operator console's envelope.
  it("omits `game` entirely when no slug is given", () => {
    const wallet = createWallet({ issued: ISSUED });
    const env = signOpWithWallet(wallet, { op: "add", nonce: NONCE, params: {} });
    expect("game" in env).toBe(false);
    expect(verifyOp(env).ok).toBe(true);
  });

  it("carries a `game` slug when one is given, covered by the same signature", () => {
    const wallet = createWallet({ issued: ISSUED });
    const env = signOpWithWallet(wallet, {
      op: "add",
      nonce: NONCE,
      params: {},
      game: "example",
    });
    expect(env.game).toBe("example");
    expect(verifyOp(env)).toEqual({ ok: true, actor: wallet.account.did });
  });

  // Tamper-evidence, made executable: no new key and no extra crypto, because the slug rides inside
  // the bytes the device already signs. This proves the value was not altered in flight. It does NOT
  // prove the value is true — the signer is the player's device, and a modified build holds one too.
  // That gap is the whole Tier 1 / Tier 2 boundary, and it is deliberate, not a defect.
  it("rejects an altered or stripped `game` slug (badsig)", () => {
    const wallet = createWallet({ issued: ISSUED });
    const env = signOpWithWallet(wallet, {
      op: "add",
      nonce: NONCE,
      params: {},
      game: "example",
    });
    expect(verifyOp({ ...env, game: "other-game" })).toEqual({ ok: false, reason: "badsig" });

    const { game: _game, ...stripped } = env;
    expect(verifyOp(stripped)).toEqual({ ok: false, reason: "badsig" });
  });
});

describe("BIP39 recovery", () => {
  it("recovers the same account root from its phrase", () => {
    const phrase = createRecoveryPhrase(128);
    expect(phrase.split(" ")).toHaveLength(12);
    const a = accountFromMnemonic(phrase);
    const b = accountFromMnemonic(phrase);
    expect(a.did).toBe(b.did);
  });

  it("rejects an invalid phrase", () => {
    expect(() => accountFromMnemonic("not a real recovery phrase at all")).toThrow();
  });

  it("builds a wallet whose device authorization expires when asked to", () => {
    const phrase = createRecoveryPhrase(128);
    const issued = "2026-11-01T00:00:00.000Z";
    const expires = "2026-11-08T00:00:00.000Z";
    const wallet = walletFromMnemonic(phrase, { issued, expires });
    expect(wallet.account.did).toBe(accountFromMnemonic(phrase).did);
    expect(wallet.auth).toMatchObject({ issued, expires });
    expect(verifyDeviceAuthorization(wallet.auth, Date.parse("2026-11-07T00:00:00Z"))).toBe(true);
    expect(verifyDeviceAuthorization(wallet.auth, Date.parse("2026-11-09T00:00:00Z"))).toBe(false);
    // Left out, the authorization has no expiry, as before.
    expect(walletFromMnemonic(phrase, { issued }).auth).not.toHaveProperty("expires");
  });
});

describe("the options forms", () => {
  const EXPIRES = "2026-07-01T00:00:00Z";

  it("authorizeDevice takes its timestamps in its options", () => {
    const account = createAccount();
    const device = createDevice();
    const options = authorizeDevice(account, device.did, { issued: ISSUED, expires: EXPIRES });
    expect(options).toMatchObject({ issued: ISSUED, expires: EXPIRES });
    expect(authorizeDevice(account, device.did, { expires: EXPIRES })).toMatchObject({
      expires: EXPIRES,
    });
    expect(authorizeDevice(account, device.did, {})).not.toHaveProperty("expires");
    expect(authorizeDevice(account, device.did).issued).toEqual(expect.any(String));
  });

  it("createWallet takes an expiry in its options", () => {
    const wallet = createWallet({ issued: ISSUED, expires: EXPIRES });
    expect(wallet.auth).toMatchObject({ issued: ISSUED, expires: EXPIRES });
    expect(createWallet({ issued: ISSUED }).auth).not.toHaveProperty("expires");
    expect(createWallet().auth.issued).toEqual(expect.any(String));
  });

  it("walletFromMnemonic takes the account's passphrase in its options", () => {
    const phrase = createRecoveryPhrase(128);
    const wallet = walletFromMnemonic(phrase, {
      issued: ISSUED,
      expires: EXPIRES,
      passphrase: "hunter2",
    });
    expect(wallet.account.did).toBe(accountFromMnemonic(phrase, "hunter2").did);
    expect(wallet.account.did).not.toBe(accountFromMnemonic(phrase).did);
    expect(wallet.auth).toMatchObject({ issued: ISSUED, expires: EXPIRES });
    expect(verifyDeviceAuthorization(wallet.auth, Date.parse("2026-06-27T00:00:00Z"))).toBe(true);
    expect(walletFromMnemonic(phrase, {}).account.did).toBe(accountFromMnemonic(phrase).did);
  });
});
