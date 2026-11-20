import { describe, expect, it } from "vitest";
import {
  accountMinter,
  createAccount,
  signRoomProvenance,
  signItemProvenance,
  signScoutProvenance,
  verifyRoomProvenance,
  verifyItemProvenance,
  verifyScoutProvenance,
} from "../index";

const account = createAccount();
const other = createAccount();
const minter = accountMinter(account);

describe("room provenance — {unique, kind, policy} (the placed-room identity)", () => {
  const room = { unique: "box-abc", kind: "box", policy: { ops: {} } };
  const mintedBy = signRoomProvenance(room, minter);

  it("a room signed by its minter verifies against its {unique, kind, policy}", () => {
    expect(verifyRoomProvenance(room, mintedBy)).toBe(true);
  });

  it("fails when the unique or kind is swapped (per-instance binding — no replay)", () => {
    expect(verifyRoomProvenance({ ...room, unique: "box-xyz" }, mintedBy)).toBe(false);
    expect(verifyRoomProvenance({ ...room, kind: "bag" }, mintedBy)).toBe(false);
  });

  it("fails when the policy is altered (the placer can't wrap a trusted minter around a hostile policy)", () => {
    expect(verifyRoomProvenance({ ...room, policy: { ops: {}, claimTtl: "1d" } }, mintedBy)).toBe(
      false,
    );
  });

  it("cannot be forged: signing with one key but claiming another minter fails", () => {
    const forged = signRoomProvenance(room, {
      did: account.did,
      privateKey: other.root.privateKey,
    });
    expect(verifyRoomProvenance(room, forged)).toBe(false);
  });

  it("treats absent provenance as unverified", () => {
    expect(verifyRoomProvenance(room)).toBe(false);
  });
});

describe("scout provenance — {unique, config} (the deployed-scout identity)", () => {
  const config = {
    type: "survey",
    label: "Survey Scout",
    speedTier: 5,
    rangeMi: 1200,
    slots: 6,
  };
  const scout = { unique: "scout-1", config };
  const mintedBy = signScoutProvenance(scout, minter);

  it("a scout signed by its minter verifies against its {unique, config}", () => {
    expect(verifyScoutProvenance(scout, mintedBy)).toBe(true);
  });

  it("fails when the unique or a config cap is altered (no replay, no cap forgery)", () => {
    expect(verifyScoutProvenance({ ...scout, unique: "scout-2" }, mintedBy)).toBe(false);
    expect(verifyScoutProvenance({ ...scout, config: { ...config, speedTier: 0 } }, mintedBy)).toBe(
      false,
    );
  });

  it("cannot be forged and treats absent provenance as unverified", () => {
    const forged = signScoutProvenance(scout, {
      did: account.did,
      privateKey: other.root.privateKey,
    });
    expect(verifyScoutProvenance(scout, forged)).toBe(false);
    expect(verifyScoutProvenance(scout)).toBe(false);
  });
});

describe("generic item provenance, for any game's opaque items (doc/spec/item-properties.md §2.1)", () => {
  const item = { unique: "rw-1", birth: { class: "ColorSample", baseLevels: { hue: 200 } } };

  it("an item signed by its minter verifies", () => {
    expect(verifyItemProvenance(item, signItemProvenance(item, minter))).toBe(true);
  });

  it("names the minter by did:key (display handle is optional)", () => {
    const mintedBy = signItemProvenance(item, { ...minter, handle: "alice@beacon.example" });
    expect(mintedBy.id).toBe(account.did);
    expect(mintedBy.handle).toBe("alice@beacon.example");
    expect(verifyItemProvenance(item, mintedBy)).toBe(true);
  });

  it("fails when the claimed minter (mintedBy.id) is swapped to another key", () => {
    const mintedBy = signItemProvenance(item, minter);
    expect(verifyItemProvenance(item, { ...mintedBy, id: other.did })).toBe(false);
  });

  it("covers the whole birth: a nested value changed, or a field added after mint, fails", () => {
    const withMedia = {
      unique: "rw-1",
      birth: { ...item.birth, media: [{ type: "image", hash: "h", uris: ["h@a.example"] }] },
    };
    const mintedBy = signItemProvenance(withMedia, minter);
    const nested = {
      ...withMedia.birth,
      media: [{ type: "image", hash: "h", uris: ["h@evil.example"] }],
    };
    expect(verifyItemProvenance({ ...withMedia, birth: nested }, mintedBy)).toBe(false);
    const added = { ...withMedia.birth, description: "added later" };
    expect(verifyItemProvenance({ ...withMedia, birth: added }, mintedBy)).toBe(false);
  });

  it("verifies only the signed identity — a mutable state/owner/match projection is not signed", () => {
    // ItemBirth carries only { unique, birth }; state/owner/match never enter the signature.
    const mintedBy = signItemProvenance(item, minter);
    expect(verifyItemProvenance({ unique: item.unique, birth: item.birth }, mintedBy)).toBe(true);
  });

  it("fails when a birth field or the unique is tampered", () => {
    const mintedBy = signItemProvenance(item, minter);
    expect(verifyItemProvenance({ ...item, unique: "rw-2" }, mintedBy)).toBe(false);
    expect(
      verifyItemProvenance(
        { unique: "rw-1", birth: { class: "ColorSample", baseLevels: { hue: 201 } } },
        mintedBy,
      ),
    ).toBe(false);
    expect(
      verifyItemProvenance(
        { unique: "rw-1", birth: { class: "Contraband", baseLevels: { hue: 200 } } },
        mintedBy,
      ),
    ).toBe(false);
  });

  it("cannot be forged and treats absent provenance as unverified", () => {
    const forged = signItemProvenance(item, {
      did: account.did,
      privateKey: other.root.privateKey,
    });
    expect(verifyItemProvenance(item, forged)).toBe(false);
    expect(verifyItemProvenance(item)).toBe(false);
  });

  it("a birth.unique cannot shadow the top-level unique (no signature replay under a forged unique)", () => {
    // `unique` is spread LAST in the signed set, so a hostile `birth.unique` can't override it. Without
    // that, an attacker could replay a legit signature under an arbitrary engine-level `unique`.
    const legit = { unique: "u-legit", birth: { class: "X", baseLevels: { hue: 1 } } };
    const mintedBy = signItemProvenance(legit, minter);
    expect(verifyItemProvenance(legit, mintedBy)).toBe(true);
    const forged = { unique: "u-attacker", birth: { ...legit.birth, unique: "u-legit" } };
    expect(verifyItemProvenance(forged, mintedBy)).toBe(false);
  });
});

describe("a value canonical JSON has no form for", () => {
  // Only JSON.parse writes it: `1e400` parses to Infinity. What a peer or server sent is untrusted,
  // so each verifier answers `false` rather than throwing, e.g. during a client's render.
  const withInfinity = <T>(signed: T): T =>
    JSON.parse(JSON.stringify(signed).replace('"k":1', '"k":1e400')) as T;

  it("an item birth is unverified, not a throw", () => {
    const item = { unique: "i-1", birth: { k: 1 } };
    const mintedBy = signItemProvenance(item, minter);
    expect(verifyItemProvenance(withInfinity(item), mintedBy)).toBe(false);
  });

  it("a room policy is unverified, not a throw", () => {
    const room = { unique: "c-1", kind: "box", policy: { ops: {}, k: 1 } as never };
    const mintedBy = signRoomProvenance(room, minter);
    expect(verifyRoomProvenance(withInfinity(room), mintedBy)).toBe(false);
  });

  it("a scout config is unverified, not a throw", () => {
    const scout = { unique: "s-1", config: { k: 1 } };
    const mintedBy = signScoutProvenance(scout, minter);
    expect(verifyScoutProvenance(withInfinity(scout), mintedBy)).toBe(false);
  });

  it("the signing side keeps throwing: a writer producing Infinity is a bug to surface", () => {
    expect(() => signItemProvenance({ unique: "i-1", birth: { k: Infinity } }, minter)).toThrow();
  });
});
