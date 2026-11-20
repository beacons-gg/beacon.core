import {
  canonicalJson,
  conformsTo,
  MAX_PROFILE_BYTES,
  profileBytes,
  profileDocReadSchema,
  type DeviceAuthorization,
  type DidKey,
  type IsoTimestamp,
  type ProfileDoc,
} from "@beaconsgg/protocol-types";
import type { Account } from "./account";
import { verifyDeviceAuthorization } from "./authorization";
import { signUtf8, verifyUtf8 } from "./crypto";
import { decodeDidKey } from "./did";
import { PROFILE_OWNED_FIELDS } from "./profile-fields";

// Profile document support (`doc/spec/identity.md` §6): the signed snapshot of an account's current
// device key set (`devices`) and revocations (`revoked`). The account root authorizes per-device
// keys, and the profile is the published, self-signed record of them.
//
// The signed `version` is the rollback guard. Revocation is online and best-effort (§2.1), so a
// consumer must reject a profile whose `version` is at or below the highest it has accepted, or an
// attacker replays the profile from before a revocation. `acceptProfile` folds the verify and that
// check together. Device `expires` (offline expiry, §10.3) also rides in each profile entry, so the
// offline-expiry mitigation applies to profile-listed devices too.

/**
 * What {@link buildProfile} builds a profile from: the account's devices, revocations, public name
 * and services.
 */
export interface ProfileInput {
  /** The account's current devices, each with its `did:key` and its authorization from the root. */
  devices: { did: DidKey; auth: DeviceAuthorization }[];
  /**
   * The profile's version. Defaults to 1. Raise the version by at least one on every change, since
   * a server or player keeps the highest version it has seen and refuses a lower or equal one.
   */
  version?: number;
  /**
   * The `did:key`s of devices the account revoked. A server refuses ops from a revoked device once
   * the server holds this profile.
   */
  revoked?: DidKey[];
  /** Handles the player claims, such as `zoe@beacon.example`. */
  handles?: string[];
  /** The name other players see. */
  displayName?: string;
  /**
   * The account's avatar, with a scheme: `"emoji:🦊"`, or `"image:<hash>@host"` for an uploaded
   * image (`doc/spec/identity.md` §6).
   */
  avatar?: string;
  /**
   * The services the account publishes, such as `{ type: "mailbox", endpoint: "beacon.example" }`
   * for the host other players send mail to (`doc/spec/mailbox-client.md` §6).
   */
  services?: { type: string; endpoint: string }[];
  /** When the profile was last changed, as an ISO 8601 timestamp. Defaults to now. */
  updated?: IsoTimestamp;
  /**
   * The profile this one replaces: the best published copy, such as `client.fetchBestProfile`
   * returns. Fields this version of the SDK does not manage are copied forward from it (see
   * {@link buildProfile}).
   *
   * The profile is ignored unless it belongs to this account and its signature verifies, so the
   * root never signs a field a server added to a copy.
   */
  supersedes?: ProfileDoc | null;
}

/** Whether `doc`'s root self-signature covers its body (not its devices: see {@link verifyProfile}). */
function selfSigned(doc: ProfileDoc): boolean {
  const { proof, ...body } = doc;
  if (proof.key !== doc.id) return false;
  try {
    return verifyUtf8(canonicalJson(body), proof.sig, decodeDidKey(doc.id));
  } catch {
    return false;
  }
}

/** The fields of `supersedes` a rebuild for `account` carries forward: see {@link buildProfile}. */
function carriedFields(account: Account, supersedes: ProfileDoc | null | undefined) {
  if (!supersedes || supersedes.id !== account.did || !selfSigned(supersedes)) return {};
  return Object.fromEntries(
    Object.entries(supersedes).filter(([key]) => !PROFILE_OWNED_FIELDS.has(key)),
  );
}

/**
 * The error {@link buildProfile} throws for a profile larger than `MAX_PROFILE_BYTES`, which no
 * server accepts. `bytes` holds the profile's size.
 */
export class ProfileTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`profile is ${bytes} bytes; the cap is ${MAX_PROFILE_BYTES}`);
    this.name = "ProfileTooLargeError";
  }
}

/**
 * Build the account's profile and sign it with the account root, ready for `client.publishProfile`.
 *
 * The function owns these top-level fields: `id`, `version`, `handles`, `displayName`, `avatar`,
 * `devices`, `revoked`, `services`, `updated`, `proof` and `keyAgreement`. The function writes
 * each of them, from the account, from `input` or by signing, except `keyAgreement`, which it
 * drops, so a key never outlives a revocation on a build that does not manage keys. Every other top-level field of `input.supersedes` belongs to a
 * newer build and is copied forward, since a profile is signed whole and a rebuild without the
 * field would publish a higher version without it. The copied fields are dropped when keeping them
 * would push the profile over `MAX_PROFILE_BYTES`, so they never block what you publish, such as a
 * revocation. Only top-level fields are copied: what sits inside a device or service entry is
 * rebuilt from `input`.
 *
 * @throws {@link ProfileTooLargeError} when the profile is still over `MAX_PROFILE_BYTES`, so you
 * learn it here and not from every server refusing it.
 */
export function buildProfile(account: Account, input: ProfileInput): ProfileDoc {
  const carried = carriedFields(account, input.supersedes);
  const withCarry = signedProfile(account, input, carried);
  const doc =
    profileBytes(withCarry) > MAX_PROFILE_BYTES && Object.keys(carried).length > 0
      ? signedProfile(account, input, {})
      : withCarry;
  const bytes = profileBytes(doc);
  if (bytes > MAX_PROFILE_BYTES) throw new ProfileTooLargeError(bytes);
  return doc;
}

/** {@link buildProfile}'s doc with `carried` under the fields it owns, signed. */
function signedProfile(
  account: Account,
  input: ProfileInput,
  carried: ReturnType<typeof carriedFields>,
): ProfileDoc {
  const updated = input.updated ?? new Date().toISOString();
  const body = {
    ...carried,
    id: account.did,
    version: input.version ?? 1,
    ...(input.handles ? { handles: input.handles } : {}),
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
    devices: input.devices.map((d) => ({
      key: d.did,
      auth: {
        issued: d.auth.issued,
        ...(d.auth.expires !== undefined ? { expires: d.auth.expires } : {}),
        sig: d.auth.sig,
      },
    })),
    ...(input.revoked && input.revoked.length > 0 ? { revoked: input.revoked } : {}),
    ...(input.services && input.services.length > 0 ? { services: input.services } : {}),
    updated,
  };
  const sig = signUtf8(canonicalJson(body), account.root.privateKey);
  return { ...body, proof: { type: "Ed25519", key: account.did, sig } };
}

/**
 * Return `true` when a received profile is well formed and signed by its own account root, and
 * every device it lists has a valid and unexpired authorization from that root.
 *
 * Pass the body exactly as it came from the server, without parsing it first: a profile from a
 * newer app, with fields this version does not know, still verifies. `true` narrows `profile` to
 * `ProfileDoc`. The check does not read `revoked` or `version`: use {@link isDeviceRevoked} and
 * {@link acceptProfile} for those.
 *
 * The rule matches `verifyDescriptor`: the shape check uses the read schema, and the signature is
 * checked over the raw body.
 *
 * @param now - The time to check device expiry against, in milliseconds since the epoch. Defaults
 * to now.
 */
export function verifyProfile(profile: unknown, now: number = Date.now()): profile is ProfileDoc {
  if (!conformsTo(profileDocReadSchema, profile) || !selfSigned(profile)) return false;

  for (const device of profile.devices) {
    if (!verifyDeviceAuthorization(authorizationFromProfileEntry(profile.id, device), now)) {
      return false;
    }
  }
  return true;
}

/**
 * Rebuild a device's full `DeviceAuthorization` from its entry in a profile's `devices`.
 *
 * A profile leaves out each authorization's `authorizes` and `account`, since they are the entry's
 * `key` and the profile's `id`. Use this when recovering an account, to keep the devices its
 * published profile lists.
 *
 * {@link buildProfile} strips the two fields, and this is the exact inverse. {@link verifyProfile}
 * uses it too. If the two ever disagreed, a recovered device's republished authorization would stop
 * verifying.
 *
 * @param accountDid - The profile's `id`.
 */
export function authorizationFromProfileEntry(
  accountDid: DidKey,
  entry: ProfileDoc["devices"][number],
): DeviceAuthorization {
  return {
    authorizes: entry.key,
    account: accountDid,
    issued: entry.auth.issued,
    ...(entry.auth.expires !== undefined ? { expires: entry.auth.expires } : {}),
    sig: entry.auth.sig,
  };
}

/**
 * Pick the profile to believe among copies of one account's profile fetched from several servers:
 * the copy with the highest `version` that is for `did` and verifies.
 *
 * Pass the copies as fetched. Anything that is not a profile is skipped. On a tie the earlier copy
 * wins, so pass copies in the order of the player's server list. `client.fetchBestProfile` fetches
 * and calls this for you.
 *
 * The version check runs before the costly {@link verifyProfile}, so a copy that cannot win is
 * never verified. Every client uses this one rule, since a rule about trust must not have two
 * spellings.
 *
 * @returns The profile, or `null` when no copy verifies.
 */
export function bestVerifiedProfile(
  did: DidKey | string,
  docs: readonly unknown[],
): ProfileDoc | null {
  let best: ProfileDoc | null = null;
  for (const doc of docs) {
    if (
      conformsTo(profileDocReadSchema, doc) &&
      doc.id === did &&
      (best === null || doc.version > best.version) &&
      verifyProfile(doc)
    ) {
      best = doc;
    }
  }
  return best;
}

/**
 * The result of {@link acceptProfile}: the accepted profile, or `invalid` when the profile does not
 * verify, or `stale` when its version is not higher than the profile already held.
 */
export type ProfileAcceptance =
  { ok: true; profile: ProfileDoc } | { ok: false; reason: "invalid" | "stale" };

/**
 * Decide whether to replace a stored profile with `next`: accept `next` only when it verifies and
 * its `version` is higher than that of `current` for the same account.
 *
 * Use this wherever you keep profiles, such as a cache of other players. An old profile from before
 * a revocation is then refused as `stale` and never replaces a newer one. The version is compared
 * only when `next.id` equals `current.id`, so check that `next` is for the account you asked about.
 *
 * @param current - The profile you hold for this account, or `undefined` for none.
 * @param now - The time to check device expiry against, in milliseconds since the epoch.
 * Defaults to now.
 */
export function acceptProfile(
  current: ProfileDoc | undefined,
  next: unknown,
  now: number = Date.now(),
): ProfileAcceptance {
  if (!verifyProfile(next, now)) return { ok: false, reason: "invalid" };
  if (current && current.id === next.id && next.version <= current.version) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, profile: next };
}

/**
 * Return `true` when the profile lists `deviceDid` in `revoked`.
 *
 * Revocation reaches only those who read the newest profile, so the check is only as fresh as the
 * profile you pass.
 */
export function isDeviceRevoked(profile: ProfileDoc, deviceDid: DidKey): boolean {
  return (profile.revoked ?? []).includes(deviceDid);
}
