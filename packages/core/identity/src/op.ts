import {
  canonicalJson,
  opEnvelopeSchema,
  type DidKey,
  type OpEnvelope,
  type UnsignedOpEnvelope,
} from "@beaconsgg/protocol-types";
import { verifyDeviceAuthorization } from "./authorization";
import { signUtf8, verifyUtf8 } from "./crypto";
import { decodeDidKey } from "./did";

// Op envelope signing and verifying (beacon.server `doc/spec/room-operation.md` §3,
// `doc/spec/identity.md` §5.2): the device signs an op and a verifier checks the attribution chain
// (root authorization and device signature) fully offline. The signature attests who acted. The
// gameplay params are trusted as sent.

/**
 * Return the exact text a device signs for an op: the envelope without `sig`, in JCS canonical JSON
 * (beacon.server `doc/spec/room-operation.md` §3).
 */
export function opSigningInput(unsigned: UnsignedOpEnvelope): string {
  return canonicalJson(unsigned);
}

/**
 * Sign an op envelope with a device's private key and return the envelope with `sig`.
 *
 * {@link signOpWithWallet} builds and signs the envelope from a wallet, and the client signs for
 * you. Use this when you build the envelope yourself.
 */
export function signOp(unsigned: UnsignedOpEnvelope, devicePrivateKey: Uint8Array): OpEnvelope {
  const sig = signUtf8(opSigningInput(unsigned), devicePrivateKey);
  return { ...unsigned, sig };
}

/**
 * The result of {@link verifyOp}: the acting account on success, or the reason the op fails.
 *
 * - `malformed`: the envelope does not match the schema or has no canonical form.
 * - `badauth`: the device authorization is not the account root's signature, or has expired.
 * - `actorMismatch`: `actor` is not the account in the authorization.
 * - `deviceMismatch`: `device` is not the device in the authorization.
 * - `baddevice`: `device` is not a valid `did:key`.
 * - `badsig`: the device's signature does not verify.
 */
export type OpVerification =
  | { ok: true; actor: DidKey }
  | {
      ok: false;
      reason: "malformed" | "badauth" | "actorMismatch" | "deviceMismatch" | "baddevice" | "badsig";
    };

/**
 * Check, offline, that a signed op was signed by a device its account authorized.
 *
 * The check covers who acted, and not what the op does: its params are trusted as sent. Revocation
 * is not checked, since it needs the account's profile. The function never throws, since the
 * envelope is untrusted input.
 *
 * The steps (`doc/spec/identity.md` §5.2):
 *   0. the envelope re-validates against the schema (so soundness doesn't rest on the caller) and
 *      has a canonical form, or it is `malformed`: a `1e400` from `JSON.parse` is `Infinity`, which
 *      has none, and nesting deeper than the canonicalizer can walk overflows its stack,
 *   1. the `auth` is a valid, unexpired root signature authorizing `device` for the account,
 *   2. `actor` is that account and `device` is the authorized device,
 *   3. `sig` is a valid device signature over JCS(envelope without sig).
 *
 * `now` is used only for the device-authorization expiry check (§10.3). The signing side does
 * throw.
 *
 * @param now - The time to check the authorization's expiry against, in milliseconds since the
 * epoch. Defaults to now.
 * @returns `{ ok: true, actor }`, or `{ ok: false, reason }` (see {@link OpVerification}).
 */
export function verifyOp(env: OpEnvelope, now: number = Date.now()): OpVerification {
  const parsed = opEnvelopeSchema.safeParse(env);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const { sig, ...unsigned } = parsed.data;
  let message: string;
  try {
    message = opSigningInput(unsigned);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const e = parsed.data;

  if (!verifyDeviceAuthorization(e.auth, now)) {
    return { ok: false, reason: "badauth" };
  }
  if (e.actor !== e.auth.account) {
    return { ok: false, reason: "actorMismatch" };
  }
  if (e.device !== e.auth.authorizes) {
    return { ok: false, reason: "deviceMismatch" };
  }

  let devicePublicKey: Uint8Array;
  try {
    devicePublicKey = decodeDidKey(e.device);
  } catch {
    return { ok: false, reason: "baddevice" };
  }

  if (!verifyUtf8(message, sig, devicePublicKey)) {
    return { ok: false, reason: "badsig" };
  }
  return { ok: true, actor: e.actor };
}
