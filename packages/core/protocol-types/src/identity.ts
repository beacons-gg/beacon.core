import { z } from "zod";
import { canonicalJson } from "./jcs";
import { readVariant } from "./read";
import { didKeySchema, isoTimestampSchema, signatureSchema } from "./primitives";

/**
 * Validates a {@link DeviceAuthorization}: the five fields and no others.
 *
 * Spec: `doc/spec/identity.md` §5.1.
 */
export const deviceAuthorizationSchema = z
  .object({
    /** The device key being authorized. */
    authorizes: didKeySchema,
    /** The account root that authorizes it. */
    account: didKeySchema,
    /** When the account root signed the authorization. */
    issued: isoTimestampSchema,
    /** When the authorization stops verifying. Absent means it never expires offline. */
    expires: isoTimestampSchema.optional(), // offline expiry: `doc/spec/identity.md` §10.3
    /** The account root's signature over the canonical JSON of the other fields. */
    sig: signatureSchema,
  })
  .strict();
/**
 * The account root's signed permission for one device key to sign ops as the account.
 *
 * Every op carries one, so a server can check the signer offline. Create one with
 * `authorizeDevice` in `@beaconsgg/identity`, which a wallet does for you.
 */
export type DeviceAuthorization = z.infer<typeof deviceAuthorizationSchema>;

/**
 * Validates an {@link Identity}, refusing unknown fields at every depth.
 *
 * Check an identity a peer sent with {@link identityReadSchema}, which ignores unknown keys, so a
 * field a newer peer adds does not fail the read.
 */
export const identitySchema = z
  .object({
    account: didKeySchema,
    device: didKeySchema,
    auth: deviceAuthorizationSchema,
  })
  .strict();
/**
 * The public identity a client presents: the account, the device that signs and the device's
 * authorization.
 */
export type Identity = z.infer<typeof identitySchema>;
/**
 * {@link Identity} as a client reads it: the checks of `identitySchema`, with unknown fields
 * dropped instead of refused at every depth.
 *
 * The `auth` is signed by the account root, and a parse drops a field a newer peer signed. Check
 * the raw identity with `conformsTo(identityReadSchema, raw)`, which keeps it as it is, and verify
 * `auth` over that.
 */
export const identityReadSchema = readVariant(identitySchema);

/** Validates a {@link Proof}: `type` is always `"Ed25519"`. */
export const proofSchema = z
  .object({
    type: z.literal("Ed25519"),
    key: didKeySchema,
    sig: signatureSchema,
  })
  .strict();
/**
 * A self-signature on a published document, such as a profile or a server descriptor: the signing
 * key and its Ed25519 signature.
 */
export type Proof = z.infer<typeof proofSchema>;

/**
 * Validates a {@link ProfileDevice}.
 *
 * Spec: `doc/spec/identity.md` §6.
 */
export const profileDeviceSchema = z
  .object({
    key: didKeySchema,
    auth: z
      .object({
        issued: isoTimestampSchema,
        expires: isoTimestampSchema.optional(), // carries the §10.3 offline expiry into the profile
        sig: signatureSchema,
      })
      .strict(),
  })
  .strict();
/**
 * One device in a profile's device list: the device key and its authorization.
 *
 * The authorization leaves out `authorizes` and `account`, which are the entry's `key` and the
 * profile's `id`. `authorizationFromProfileEntry` in `@beaconsgg/identity` rebuilds the full
 * {@link DeviceAuthorization}.
 */
export type ProfileDevice = z.infer<typeof profileDeviceSchema>;

/**
 * Validates a {@link Service}: a `type` and an `endpoint`, both strings.
 *
 * The object is not strict, so a key it does not know is dropped.
 */
export const serviceSchema = z.object({
  type: z.string(),
  endpoint: z.string(),
});
/**
 * One service a profile advertises: a `type` and an `endpoint`.
 *
 * A player's mailbox host is advertised as `{ type: "mailbox", endpoint: "<host[:port]>" }`.
 */
export type Service = z.infer<typeof serviceSchema>;

/**
 * Validates a {@link ProfileDoc}: every field typed, and no field this build does not know.
 *
 * A client reads a profile through {@link profileDocReadSchema} instead, so a field a newer app
 * signed does not fail the read.
 */
export const profileDocSchema = z
  .object({
    /** The account root: the player's durable identity. */
    id: didKeySchema,
    /** Raise it on every change. A server refuses a version no higher than the one it holds. */
    version: z.number().int().nonnegative(), // the rollback guard, `doc/spec/identity.md` §5.2
    /** Handles the player claims, such as `zoe@beacon.example`. */
    handles: z.array(z.string()).optional(), // bidirectional binding, §4.2
    displayName: z.string().optional(),
    avatar: z.string().optional(),
    /** The device keys authorized to sign for the account now. */
    devices: z.array(profileDeviceSchema),
    /** Device keys the account has revoked. */
    revoked: z.array(didKeySchema).optional(), // revocation state, §5.2
    /** Reserved for encryption; nothing reads it yet. */
    keyAgreement: didKeySchema.optional(), // §5.3
    /** Services the player advertises, such as their mailbox host. */
    services: z.array(serviceSchema).optional(),
    /** When the profile was built. */
    updated: isoTimestampSchema,
    /** The account root's self-signature over the rest of the document. */
    proof: proofSchema,
  })
  .strict();
/**
 * A player's signed profile: the account's current devices and revocations, with public fields such
 * as a display name and an avatar.
 *
 * Build one with `buildProfile` in `@beaconsgg/identity` and check one with `verifyProfile` before
 * you trust any field. The player holds the source and the signing key, so the profile survives the
 * loss of any server. A server accepts at most {@link MAX_PROFILE_BYTES}.
 *
 * Spec: `doc/spec/identity.md` §6.
 */
export type ProfileDoc = z.infer<typeof profileDocSchema>;
/**
 * {@link ProfileDoc} as a client reads it: the checks of `profileDocSchema`, with unknown fields
 * dropped instead of refused.
 */
export const profileDocReadSchema = readVariant(profileDocSchema);

/**
 * The largest profile a server accepts: 65,536 bytes (64 KiB) of canonical JSON, as
 * {@link profileBytes} counts them.
 *
 * Room for hundreds of devices or about a thousand revocations.
 *
 * Why a byte cap: a server keeps a field it does not know, so the schema no longer bounds a
 * profile's size, and a server holds every account's latest profile in memory. The headroom is also
 * the space a newer build has for fields of its own. Spec: `doc/spec/identity.md` §6.
 */
export const MAX_PROFILE_BYTES = 65_536;

/**
 * Measure a profile the way a server applies {@link MAX_PROFILE_BYTES}: the UTF-8 length of its
 * canonical JSON, `proof` included.
 *
 * Whitespace and key order on the wire do not change the result, so every writer and every server
 * gets the same number.
 *
 * @returns The size in bytes, or `Infinity` when `doc` is nested too deep to serialize, so a size
 *   check fails closed instead of throwing.
 * @throws Error when `doc` is `undefined` or otherwise cannot be serialized.
 */
export function profileBytes(doc: unknown): number {
  try {
    return new TextEncoder().encode(canonicalJson(doc)).length;
  } catch (err) {
    // Thousands of nesting levels fit in a small body, and the canonicalizer recurses.
    if (err instanceof RangeError) return Infinity; // the call stack, not the doc, ran out
    throw err;
  }
}
