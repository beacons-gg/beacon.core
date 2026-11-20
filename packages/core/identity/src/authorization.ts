import {
  canonicalJson,
  type DeviceAuthorization,
  type DidKey,
  type IsoTimestamp,
} from "@beaconsgg/protocol-types";
import type { Account } from "./account";
import { signUtf8, verifyUtf8 } from "./crypto";
import { decodeDidKey } from "./did";

// Device-authorization signing and verifying (`doc/spec/identity.md` §5.1 to 5.2): a root-signed
// grant that lets a device key act for an account, verifiable offline. Revocation is a separate
// networked check (§2.1).

/**
 * The bytes the root signs = JCS of the authorization WITHOUT its `sig`.
 * Keeping this explicit (rather than `omit sig`) guarantees signer and verifier
 * canonicalize exactly the same fields. `expires` is included only when present, so an
 * authorization with no expiry signs identically to the pre-expiry format.
 */
function authorizationSigningInput(auth: Omit<DeviceAuthorization, "sig">): string {
  const fields: Record<string, unknown> = {
    authorizes: auth.authorizes,
    account: auth.account,
    issued: auth.issued,
  };
  if (auth.expires !== undefined) fields["expires"] = auth.expires;
  return canonicalJson(fields);
}

/** The options of {@link authorizeDevice}, `createWallet` and `walletFromMnemonic`. */
export interface DeviceAuthorizationOptions {
  /** When the authorization was issued, as an ISO 8601 timestamp. Defaults to now. */
  issued?: IsoTimestamp | undefined;
  /**
   * When the authorization stops being valid, as an ISO 8601 timestamp. Leave it out for no
   * expiry. An expiry limits how long a lost device can act while offline checks are all a server
   * can do (`doc/spec/identity.md` §10.3).
   */
  expires?: IsoTimestamp | undefined;
}

/**
 * Sign an authorization with the account root that lets the device `deviceDid` sign ops for
 * `account`.
 *
 * The wallet functions call this for you. Call it yourself to add a device or to renew an
 * authorization that expired.
 *
 * @param options - `issued` (defaults to now) and `expires` (leave it out for no expiry).
 */
export function authorizeDevice(
  account: Account,
  deviceDid: DidKey,
  options: DeviceAuthorizationOptions = {},
): DeviceAuthorization {
  const { issued = new Date().toISOString(), expires } = options;
  const unsigned: Omit<DeviceAuthorization, "sig"> = {
    authorizes: deviceDid,
    account: account.did,
    issued,
    ...(expires !== undefined ? { expires } : {}),
  };
  const sig = signUtf8(authorizationSigningInput(unsigned), account.root.privateKey);
  return { ...unsigned, sig };
}

/**
 * Return `true` when `auth` is signed by the root of `auth.account` and has not expired at `now`.
 *
 * The check runs offline (`doc/spec/identity.md` §5.2). A revoked device still passes: revocation
 * is in the account's profile, so check it with `isDeviceRevoked`.
 *
 * @param now - The time to check the expiry against, in milliseconds since the epoch. Defaults to
 * now.
 */
export function verifyDeviceAuthorization(
  auth: DeviceAuthorization,
  now: number = Date.now(),
): boolean {
  if (auth.expires !== undefined) {
    const expiresAt = Date.parse(auth.expires);
    if (Number.isNaN(expiresAt) || now > expiresAt) return false;
  }
  try {
    return verifyUtf8(authorizationSigningInput(auth), auth.sig, decodeDidKey(auth.account));
  } catch {
    return false; // a bad key, or a field with no canonical form
  }
}
