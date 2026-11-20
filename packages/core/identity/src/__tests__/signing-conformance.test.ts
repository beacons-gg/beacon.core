import { canonicalJson } from "@beaconsgg/protocol-types";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import {
  accountFromMnemonic,
  accountMinter,
  authorizationFromProfileEntry,
  authorizeDevice,
  buildProfile,
  decodeDidKey,
  encodeDidKey,
  keyPairFromSeed,
  opSigningInput,
  signRoomProvenance,
  signDescriptor,
  signItemProvenance,
  signOp,
  signOpWithWallet,
  signScoutProvenance,
  signUtf8,
  verifyRoomProvenance,
  verifyDescriptor,
  verifyDeviceAuthorization,
  verifyItemProvenance,
  verifyOp,
  verifyProfile,
  verifyScoutProvenance,
  verifyUtf8,
} from "../index";
import {
  SIGNING_VECTOR_KEYS,
  SIGNING_VECTOR_NOW,
  SIGNING_VECTORS,
  type SigningVector,
} from "../signing-conformance";

const account = accountFromMnemonic(SIGNING_VECTOR_KEYS.account.mnemonic);
const device = accountFromMnemonic(SIGNING_VECTOR_KEYS.device.mnemonic);
const minter = accountMinter(account);
const NOW = Date.parse(SIGNING_VECTOR_NOW);

type VectorKey = (typeof SIGNING_VECTOR_KEYS)[keyof typeof SIGNING_VECTOR_KEYS];
const KEYS_BY_DID = new Map<string, VectorKey>(
  Object.values(SIGNING_VECTOR_KEYS).map((key) => [key.did, key]),
);

describe("signing vector keys", () => {
  for (const [role, key] of Object.entries(SIGNING_VECTOR_KEYS)) {
    it(`${role}: the raw hex is one Ed25519 keypair, named by the did`, () => {
      const pair = keyPairFromSeed(hexToBytes(key.privateKey));
      expect(bytesToHex(pair.publicKey)).toBe(key.publicKey);
      expect(encodeDidKey(pair.publicKey)).toBe(key.did);
    });
  }

  it("the phrases derive the same keys", () => {
    expect(bytesToHex(account.root.privateKey)).toBe(SIGNING_VECTOR_KEYS.account.privateKey);
    expect(bytesToHex(device.root.privateKey)).toBe(SIGNING_VECTOR_KEYS.device.privateKey);
  });
});

/** Every timestamp in a signed object, found by key at any depth. */
function timestamps(value: unknown, key = ""): [string, string][] {
  if (typeof value === "string") return key ? [[key, value]] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) =>
    Array.isArray(v) ? v.flatMap((el) => timestamps(el)) : timestamps(v, k),
  );
}

describe("signing vectors: the language-neutral check", () => {
  for (const vector of SIGNING_VECTORS) {
    it(vector.name, () => {
      // Written unsorted, so this fails for a canonicalizer that does not sort keys.
      expect(JSON.stringify(vector.signed)).not.toBe(vector.signingInput);
      expect(canonicalJson(vector.signed)).toBe(vector.signingInput);

      const key = KEYS_BY_DID.get(vector.signer);
      expect(key).toBeDefined();
      expect(signUtf8(vector.signingInput, hexToBytes(key!.privateKey))).toBe(vector.sig);
      expect(verifyUtf8(vector.signingInput, vector.sig, decodeDidKey(vector.signer))).toBe(true);
    });
  }

  it("SIGNING_VECTOR_NOW falls after every issue time and before every expiry", () => {
    const stamps = SIGNING_VECTORS.flatMap((v) => timestamps(v.signed));
    const issued = stamps.filter(([k]) =>
      ["issued", "issuedAt", "updated", "startedAt", "mintedAt"].includes(k),
    );
    const expires = stamps.filter(([k]) => k === "expires");
    expect(issued.length).toBeGreaterThan(0);
    expect(expires.length).toBeGreaterThan(0);
    for (const [, at] of issued) expect(Date.parse(at)).toBeLessThanOrEqual(NOW);
    for (const [, at] of expires) expect(Date.parse(at)).toBeGreaterThan(NOW);
  });
});

/**
 * Re-sign each input with the exported signer and verify the artifact it makes. An Ed25519 signature
 * verifies over exactly one message, so a matching `sig` proves the signer turned `input` into the
 * bytes of `signed`.
 */
function signAndVerify(vector: SigningVector): { sig: string; verified: boolean } {
  switch (vector.kind) {
    case "deviceAuthorization": {
      const { authorizes, issued, expires } = vector.input;
      const auth = authorizeDevice(account, authorizes, { issued, expires });
      expect(auth).toEqual({ ...vector.input, sig: auth.sig });
      return { sig: auth.sig, verified: verifyDeviceAuthorization(auth, NOW) };
    }
    case "op": {
      expect(opSigningInput(vector.input)).toBe(vector.signingInput);
      const env = signOp(vector.input, device.root.privateKey);
      // The wallet is how every app signs, so it must assemble the same envelope. The intent is
      // spelled out because a parsed envelope's optionals admit `undefined` and `OpIntent`'s do not.
      const { op, nonce, params, issuedAt, room, baseVersion, game } = vector.input;
      const wallet = {
        account,
        device: { key: device.root, did: device.did },
        auth: vector.input.auth,
      };
      const intent = {
        op,
        nonce,
        params,
        issuedAt,
        ...(room !== undefined ? { room } : {}),
        ...(baseVersion !== undefined ? { baseVersion } : {}),
        ...(game !== undefined ? { game } : {}),
      };
      expect(signOpWithWallet(wallet, intent)).toEqual(env);
      return { sig: env.sig, verified: verifyOp(env, NOW).ok };
    }
    case "room": {
      const mintedBy = signRoomProvenance(vector.input, minter);
      return { sig: mintedBy.sig, verified: verifyRoomProvenance(vector.input, mintedBy) };
    }
    case "scout": {
      const mintedBy = signScoutProvenance(vector.input, minter);
      return { sig: mintedBy.sig, verified: verifyScoutProvenance(vector.input, mintedBy) };
    }
    case "item": {
      const mintedBy = signItemProvenance(vector.input, minter);
      return { sig: mintedBy.sig, verified: verifyItemProvenance(vector.input, mintedBy) };
    }
    case "descriptor": {
      const descriptor = signDescriptor(account, vector.input);
      return { sig: descriptor.proof.sig, verified: verifyDescriptor(descriptor) };
    }
    case "profile": {
      // Spelled out for the same reason as the op intent: `ProfileInput`'s optionals exclude `undefined`.
      const { id, devices, version, handles, displayName, avatar, revoked, services, updated } =
        vector.input;
      const { proof, ...body } = buildProfile(account, {
        devices: devices.map((entry) => ({
          did: entry.key,
          auth: authorizationFromProfileEntry(id, entry),
        })),
        version,
        updated,
        ...(handles !== undefined ? { handles } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(avatar !== undefined ? { avatar } : {}),
        ...(revoked !== undefined ? { revoked } : {}),
        ...(services !== undefined ? { services } : {}),
      });
      expect(body).toEqual(vector.input);
      return { sig: proof.sig, verified: verifyProfile({ ...body, proof }, NOW) };
    }
  }
}

describe("signing vectors: the exported signers reproduce them", () => {
  for (const vector of SIGNING_VECTORS) {
    it(vector.name, () => {
      const { sig, verified } = signAndVerify(vector);
      expect(sig).toBe(vector.sig);
      expect(verified).toBe(true);
    });
  }
});
