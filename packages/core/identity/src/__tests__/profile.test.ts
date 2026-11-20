import {
  canonicalJson,
  MAX_PROFILE_BYTES,
  opEnvelopeSchema,
  profileBytes,
  profileDocSchema,
  type DidKey,
  type ProfileDoc,
} from "@beaconsgg/protocol-types";
import { signUtf8 } from "../crypto";
import { PROFILE_OWNED_FIELDS } from "../profile-fields";
import { describe, expect, it } from "vitest";
import {
  acceptProfile,
  authorizeDevice,
  bestVerifiedProfile,
  buildProfile,
  createAccount,
  createDevice,
  isDeviceRevoked,
  ProfileTooLargeError,
  signOp,
  verifyOp,
  verifyProfile,
} from "../index";

const ISSUED = "2026-06-29T00:00:00Z";

/** `body` signed by `account`'s root: how a newer app's doc, with fields this build lacks, arrives. */
function resign(
  account: ReturnType<typeof createAccount>,
  body: Record<string, unknown>,
): ProfileDoc {
  const sig = signUtf8(canonicalJson(body), account.root.privateKey);
  return { ...body, proof: { type: "Ed25519", key: account.did, sig } } as ProfileDoc;
}
const NONCE = "01J8XR4M0NQ9Z6T2W3K4Y5B7CD";

describe("multi-device", () => {
  it("a root authorizes two devices; ops from each verify and attribute to the account", () => {
    const account = createAccount();
    const phone = createDevice();
    const laptop = createDevice();
    const phoneAuth = authorizeDevice(account, phone.did, { issued: ISSUED });
    const laptopAuth = authorizeDevice(account, laptop.did, { issued: ISSUED });

    for (const [device, auth] of [
      [phone, phoneAuth],
      [laptop, laptopAuth],
    ] as const) {
      const env = signOp(
        {
          op: "take",
          room: "u1@beacon.example",
          actor: account.did,
          device: device.did,
          auth,
          nonce: NONCE,
          issuedAt: ISSUED,
          params: {},
        },
        device.key.privateKey,
      );
      expect(opEnvelopeSchema.safeParse(env).success).toBe(true);
      expect(verifyOp(env)).toEqual({ ok: true, actor: account.did });
    }
  });

  it("builds a verifiable profile listing both devices", () => {
    const account = createAccount();
    const phone = createDevice();
    const laptop = createDevice();
    const profile = buildProfile(account, {
      displayName: "Alice",
      devices: [
        { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
        { did: laptop.did, auth: authorizeDevice(account, laptop.did, { issued: ISSUED }) },
      ],
    });
    expect(profile.id).toBe(account.did);
    expect(profile.devices).toHaveLength(2);
    expect(verifyProfile(profile)).toBe(true);
  });

  it("rejects a profile with a tampered body or device", () => {
    const account = createAccount();
    const phone = createDevice();
    const profile = buildProfile(account, {
      devices: [{ did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) }],
    });
    // tamper the signed body
    expect(verifyProfile({ ...profile, displayName: "Mallory" })).toBe(false);
    // swap in a device the root never authorized
    const rogue = createDevice();
    const tampered = {
      ...profile,
      devices: [{ key: rogue.did, auth: profile.devices[0]!.auth }],
    };
    expect(verifyProfile(tampered)).toBe(false);
  });

  it("accepts a field this build does not know when the account signed it", () => {
    // A doc published by a newer app. Signed over the whole body, so the signature still checks;
    // the unknown field rides along unread, and a fan-out over raw JSON narrows to the doc.
    const account = createAccount();
    const phone = createDevice();
    const { proof: _old, ...body } = buildProfile(account, {
      devices: [{ did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) }],
    });
    const raw: unknown = JSON.parse(
      JSON.stringify(resign(account, { ...body, pronouns: "they/them" })),
    );
    expect(verifyProfile(raw)).toBe(true);
    expect(bestVerifiedProfile(account.did, [null, {}, "junk", raw])).toBe(raw);
    expect(acceptProfile(undefined, raw).ok).toBe(true);
    // The same field added after signing is a tamper.
    expect(verifyProfile({ ...body, proof: _old, pronouns: "she/her" })).toBe(false);
  });

  describe("a rebuild carries forward what it does not own", () => {
    /** A v1 a newer build published: `pronouns` is a field this build has never heard of. */
    function newerDoc() {
      const account = createAccount();
      const phone = createDevice();
      const laptop = createDevice();
      const devices = [
        { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
        { did: laptop.did, auth: authorizeDevice(account, laptop.did, { issued: ISSUED }) },
      ];
      const { proof: _p, ...body } = buildProfile(account, { devices, displayName: "Wren" });
      const v1 = resign(account, { ...body, pronouns: "they/them", keyAgreement: phone.did });
      return { account, phone, laptop, devices, v1 };
    }

    it("an older build revoking a device keeps the newer build's field, signed", () => {
      const { account, phone, laptop, devices, v1 } = newerDoc();
      const v2 = buildProfile(account, {
        version: 2,
        devices: devices.filter((d) => d.did === laptop.did),
        revoked: [phone.did],
        displayName: "Wren",
        supersedes: v1,
      });
      expect(v2).toMatchObject({ pronouns: "they/them", revoked: [phone.did] });
      expect(verifyProfile(JSON.parse(JSON.stringify(v2)))).toBe(true);
      expect(acceptProfile(v1, v2).ok).toBe(true);
    });

    it("drops `keyAgreement` rather than carry a key past a revocation it cannot judge", () => {
      const { account, phone, laptop, devices, v1 } = newerDoc();
      const v2 = buildProfile(account, {
        version: 2,
        devices: devices.filter((d) => d.did === laptop.did),
        revoked: [phone.did],
        supersedes: v1,
      });
      expect(v2).not.toHaveProperty("keyAgreement");
    });

    it("never carries a field it writes: a cleared name stays cleared", () => {
      const { account, devices, v1 } = newerDoc();
      const v2 = buildProfile(account, { version: 2, devices, supersedes: v1 });
      expect(v2.displayName).toBeUndefined();
    });

    it("carries nothing from another account's doc, or from a copy whose signature fails", () => {
      const { account, devices, v1 } = newerDoc();
      const stranger = buildProfile(createAccount(), { devices: [], supersedes: v1 });
      expect(stranger).not.toHaveProperty("pronouns");
      // A server slipped a field into its copy: the root must not sign it on the way out.
      const injected = { ...v1, mood: "sly" } as ProfileDoc;
      const next = buildProfile(account, { version: 2, devices, supersedes: injected });
      expect(next).not.toHaveProperty("mood");
      expect(next).not.toHaveProperty("pronouns");
    });

    it("owns exactly what it writes, plus `keyAgreement`, all of them known profile fields", () => {
      const account = createAccount();
      const phone = createDevice();
      const full = buildProfile(account, {
        version: 3,
        devices: [
          { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
        ],
        revoked: [createDevice().did],
        handles: ["wren@beacon.example"],
        displayName: "Wren",
        avatar: "emoji:🐦",
        services: [{ type: "mailbox", endpoint: "beacon.example" }],
      });
      expect(PROFILE_OWNED_FIELDS).toEqual(new Set([...Object.keys(full), "keyAgreement"]));
      const known = new Set(Object.keys(profileDocSchema.shape));
      for (const field of PROFILE_OWNED_FIELDS) expect(known.has(field)).toBe(true);
    });
  });

  it("revocation is reflected in the profile (best-effort check)", () => {
    const account = createAccount();
    const phone = createDevice();
    const laptop = createDevice();
    const profile = buildProfile(account, {
      devices: [
        { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
        { did: laptop.did, auth: authorizeDevice(account, laptop.did, { issued: ISSUED }) },
      ],
      revoked: [phone.did], // lost phone
    });
    expect(verifyProfile(profile)).toBe(true); // still a valid signed document
    expect(isDeviceRevoked(profile, phone.did)).toBe(true);
    expect(isDeviceRevoked(profile, laptop.did)).toBe(false);
  });

  it("acceptProfile rejects a rollback: a stale (pre-revocation) profile can't replace a newer one", () => {
    const account = createAccount();
    const phone = createDevice();
    const laptop = createDevice();
    const devices = [
      { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
      { did: laptop.did, auth: authorizeDevice(account, laptop.did, { issued: ISSUED }) },
    ];
    // v1 trusts the phone; v2 revokes it.
    const v1 = buildProfile(account, { version: 1, devices });
    const v2 = buildProfile(account, { version: 2, devices, revoked: [phone.did] });

    // Bootstrapping accepts v1, then advances to v2.
    const first = acceptProfile(undefined, v1);
    expect(first.ok).toBe(true);
    expect(acceptProfile(v1, v2).ok).toBe(true);

    // The attacker replays the pre-revocation v1 — rejected as stale, so revocation can't roll back.
    const rolled = acceptProfile(v2, v1);
    expect(rolled).toEqual({ ok: false, reason: "stale" });
    // A same-version re-publish is also stale (no forward progress).
    expect(acceptProfile(v2, v2).ok).toBe(false);
    // A tampered document is rejected as invalid, not stale.
    expect(acceptProfile(undefined, { ...v2, version: 9 })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("carries device `expires` into the profile, and an expired device fails verification", () => {
    const account = createAccount();
    const phone = createDevice();
    const expires = "2026-07-01T00:00:00Z";
    const profile = buildProfile(account, {
      devices: [
        {
          did: phone.did,
          auth: authorizeDevice(account, phone.did, { issued: ISSUED, expires: expires }),
        },
      ],
    });
    expect(profile.devices[0]!.auth.expires).toBe(expires);
    expect(verifyProfile(profile, Date.parse("2026-06-30T00:00:00Z"))).toBe(true); // before expiry
    expect(verifyProfile(profile, Date.parse("2026-07-02T00:00:00Z"))).toBe(false); // past expiry
  });
});

describe("buildProfile refuses a doc over the size cap", () => {
  const account = createAccount();
  const phone = createDevice();
  const lost = createDevice();
  const devices = [
    { did: phone.did, auth: authorizeDevice(account, phone.did, { issued: ISSUED }) },
  ];
  const build = (displayName: string, supersedes: ProfileDoc | null = null, revoked?: DidKey[]) =>
    buildProfile(account, {
      version: 2,
      devices,
      displayName,
      updated: ISSUED,
      supersedes,
      ...(revoked ? { revoked } : {}),
    });
  /** The name length that makes the doc exactly `bytes` (the signature's length is fixed). */
  const nameFor = (bytes: number) => "x".repeat(bytes - profileBytes(build("")));
  /** A v1 this account signed, carrying `notes`, a field this build does not own, of `size` chars. */
  const withNotes = (size: number) => {
    const { proof: _p, ...body } = build("");
    return resign(account, { ...body, version: 1, notes: "n".repeat(size) });
  };

  it("builds a doc of exactly the cap, and refuses one byte more, saying how big it was", () => {
    const atCap = build(nameFor(MAX_PROFILE_BYTES));
    expect(profileBytes(atCap)).toBe(MAX_PROFILE_BYTES);
    expect(verifyProfile(atCap)).toBe(true);
    expect(() => build(nameFor(MAX_PROFILE_BYTES + 1))).toThrow(
      expect.objectContaining({ name: "ProfileTooLargeError", bytes: MAX_PROFILE_BYTES + 1 }),
    );
  });

  it("carries a field forward while it fits, and drops it rather than refuse what this build owns", () => {
    const bulky = withNotes(MAX_PROFILE_BYTES - 1_000);
    expect(build("", bulky)).toMatchObject({ notes: "n".repeat(MAX_PROFILE_BYTES - 1_000) });

    // One copy already over the cap (an older server enforces none): the revocation still goes out.
    const overCap = withNotes(MAX_PROFILE_BYTES);
    expect(profileBytes(overCap)).toBeGreaterThan(MAX_PROFILE_BYTES);
    const revoking = build("Wren", overCap, [lost.did]);
    expect(revoking).not.toHaveProperty("notes");
    expect(revoking).toMatchObject({ displayName: "Wren", revoked: [lost.did] });
    expect(verifyProfile(revoking)).toBe(true);

    // What this build owns still has to fit on its own.
    expect(() => build(nameFor(MAX_PROFILE_BYTES + 1), bulky)).toThrow(ProfileTooLargeError);
  });
});

describe("bestVerifiedProfile — the fan-out selection rule (the fold of acceptProfile)", () => {
  it("picks the highest-version verified doc for the did; wrong-id and tampered docs never win", () => {
    const account = createAccount();
    const v1 = buildProfile(account, { version: 1, devices: [], displayName: "Old" });
    const v2 = buildProfile(account, { version: 2, devices: [], displayName: "New" });
    const other = buildProfile(createAccount(), { version: 9, devices: [] });
    const tampered = { ...v2, version: 5 }; // signature no longer covers it
    expect(bestVerifiedProfile(account.did, [v1, other, v2, null])?.displayName).toBe("New");
    expect(bestVerifiedProfile(account.did, [v1, tampered])?.displayName).toBe("Old");
    expect(bestVerifiedProfile(account.did, [null, other])).toBeNull();
  });
});
