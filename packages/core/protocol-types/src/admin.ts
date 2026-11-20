import { z } from "zod";
import { absentOnRead, readVariant } from "./read";
import { accessNoteSchema, accessStatusSchema } from "./access";
import { serverAccessLevelSchema, serverDescriptorSchema } from "./discovery";
import { mediaHashSchema } from "./media";
import { didKeySchema, globalIdSchema, isoTimestampSchema } from "./primitives";

// Admin wire shapes (the server's admin API spec, beacon.server `doc/spec/admin-api.md`), for
// operator console authors. Each admin request is a signed `OpEnvelope` (beacon.server
// `doc/spec/mailbox-and-media.md` §3.2), accepted only from a DID on the server's `BEACON_ADMINS`
// allowlist. The admin surface is never advertised as a descriptor capability, and its routes answer
// 404 when no admins are configured.

/** Validates {@link AdminStatusParams}: an empty object. */
export const adminStatusParamsSchema = z.object({}).strict();
/**
 * The params of an `admin.status` op: always empty, because the signed envelope is the whole
 * request.
 */
export type AdminStatusParams = z.infer<typeof adminStatusParamsSchema>;

/**
 * Validates {@link AdminStatusCounts}: every count a whole number of zero or more.
 *
 * Every table exists whichever capabilities are on (migrations are unconditional), so every count
 * is always present.
 */
export const adminStatusCountsSchema = z
  .object({
    /** Rooms the server holds, of every `type`. */
    rooms: z.number().int().nonnegative(),
    /** Published profiles the server keeps, which it also uses to check device revocation. */
    profiles: z.number().int().nonnegative(),
    /** Active places in the server's own places dataset. */
    places: z.number().int().nonnegative(),
    /** Retired places, kept so their history stays traceable. */
    placesRetired: z.number().int().nonnegative(),
    /** Place conflicts waiting for an admin to resolve: the curation to-do count. */
    conflictsPending: z.number().int().nonnegative(),
    /** Recorded places snapshot runs, which `places.snapshots.fetch` lists. */
    snapshots: z.number().int().nonnegative(),
    /** Stored media objects. */
    mediaObjects: z.number().int().nonnegative(),
    /** Total size of the stored media, in bytes. */
    mediaBytes: z.number().int().nonnegative(),
    /**
     * The most media the server will hold, in bytes, across every uploader and import. Absent when
     * there is no limit. Whoever hosts the server sets it; no admin op changes it.
     */
    mediaLimitBytes: z.number().int().nonnegative().optional(),
    /** Media objects no admin has reviewed yet: the review-queue to-do count. */
    mediaUnreviewed: z.number().int().nonnegative(),
    /**
     * Requests to join the server that no admin has answered yet (`admin.access.fetch`). Absent
     * from a server too old to take requests.
     */
    accessPending: z.number().int().nonnegative().optional(),
  })
  .strict();
/**
 * The dataset sizes in an {@link AdminStatus}: counts of rows and bytes, never the rows themselves.
 *
 * Every count is present. A capability that is turned off reports 0.
 */
export type AdminStatusCounts = z.infer<typeof adminStatusCountsSchema>;

/**
 * Validates an {@link AdminStatus}.
 *
 * The descriptor facts are picked from {@link serverDescriptorSchema}, so the two never drift. The
 * reply is authenticated and fresh, so no signed proof rides along. `name` and `capabilities` are
 * optional on the descriptor and required here: a status read reports the empty list rather than
 * omitting it. No duration is frozen into the reply, the same rule as the descriptor.
 */
export const adminStatusSchema = serverDescriptorSchema
  .pick({
    host: true,
    name: true,
    version: true,
    startedAt: true,
    accessLevel: true,
    coverage: true,
    capabilities: true,
  })
  .required({ name: true, capabilities: true })
  // The operator's own server: its level as sent, never the player's fallback, so an older console
  // fails to read one it does not know rather than misstate it.
  .extend({
    accessLevel: serverAccessLevelSchema,
    counts: adminStatusCountsSchema,
    // Whether an admin has locked the server read-only (the `writeLocked` setting). Absent from a
    // server too old to have a lock, which is the same as unlocked.
    writeLocked: z.boolean().optional(),
  })
  .strict();
/**
 * The reply to an `admin.status` op: the server's descriptor facts, its dataset counts and whether
 * it is locked read-only.
 *
 * Work out uptime from `startedAt`. `writeLocked` is absent on a server too old to have a lock,
 * which means unlocked.
 */
export type AdminStatus = z.infer<typeof adminStatusSchema>;
/**
 * {@link AdminStatus} as a client reads it: the checks of `adminStatusSchema`, with unknown fields
 * dropped instead of refused.
 */
export const adminStatusReadSchema = readVariant(adminStatusSchema);

// ── Moderation (beacon.server `doc/spec/admin-api.md` §3) ──────────────────────
// Every op is a signed, allowlisted admin action; `reason` is a bounded operator note that lands in
// the structured audit log (and, for blocks, the durable row), never shown to players.

/** A bounded operator note for the audit trail: 1 to 500 characters. */
const reasonSchema = z.string().min(1).max(500);

/** Validates {@link AdminRoomRemoveParams}. `reason` is 1 to 500 characters. */
export const adminRoomRemoveParamsSchema = z
  .object({ id: globalIdSchema, reason: reasonSchema.optional() })
  .strict();
/**
 * The params of an `admin.room.remove` op: the id of a room to remove from this server, and an
 * optional reason.
 *
 * Players watching the room get the usual events for a room that is gone. The reason goes to the
 * audit log and is never shown to players.
 */
export type AdminRoomRemoveParams = z.infer<typeof adminRoomRemoveParamsSchema>;

/** Validates {@link AdminMediaRemoveParams}. `reason` is 1 to 500 characters. */
export const adminMediaRemoveParamsSchema = z
  .object({ hash: mediaHashSchema, reason: reasonSchema.optional() })
  .strict();
/**
 * The params of an `admin.media.remove` op: the content hash of a media object to delete and an
 * optional reason for the audit log.
 *
 * The server deletes both the stored bytes and the metadata.
 */
export type AdminMediaRemoveParams = z.infer<typeof adminMediaRemoveParamsSchema>;

/** Validates {@link AdminBlocklistAddParams}. `reason` is 1 to 500 characters. */
export const adminBlocklistAddParamsSchema = z
  .object({ did: didKeySchema, reason: reasonSchema.optional() })
  .strict();
/**
 * The params of an `admin.blocklist.add` op: a DID to block, and an optional reason.
 *
 * The server then refuses every signed request from that DID, room ops and profile publishes
 * included, until an admin lifts the block. The block survives a restart, and the reason is stored
 * with it.
 */
export type AdminBlocklistAddParams = z.infer<typeof adminBlocklistAddParamsSchema>;

/** Validates {@link AdminBlocklistRemoveParams}. `reason` is 1 to 500 characters. */
export const adminBlocklistRemoveParamsSchema = z
  .object({ did: didKeySchema, reason: reasonSchema.optional() })
  .strict();
/**
 * The params of an `admin.blocklist.remove` op: a blocked DID to unblock, and an optional reason
 * for the audit log.
 */
export type AdminBlocklistRemoveParams = z.infer<typeof adminBlocklistRemoveParamsSchema>;

/** Validates {@link AdminBlocklistFetchParams}: an empty object. */
export const adminBlocklistFetchParamsSchema = z.object({}).strict();
/**
 * The params of an `admin.blocklist.fetch` op: always empty.
 *
 * The reply is an {@link AdminBlocklistFetchResult}.
 */
export type AdminBlocklistFetchParams = z.infer<typeof adminBlocklistFetchParamsSchema>;

/** Validates a {@link BlockEntry}. */
export const blockEntrySchema = z
  .object({
    did: didKeySchema,
    reason: reasonSchema.optional(),
    /** The operator DID that added the block, or `"env"` for one seeded from `BEACON_BLOCKLIST`. */
    addedBy: z.string().min(1),
    addedAt: isoTimestampSchema,
  })
  .strict();
/** One blocked DID: who is blocked, why, and which operator blocked them when. */
export type BlockEntry = z.infer<typeof blockEntrySchema>;
/**
 * {@link BlockEntry} as a client reads it: the checks of `blockEntrySchema`, with unknown fields
 * dropped instead of refused.
 */
export const blockEntryReadSchema = readVariant(blockEntrySchema);

/** Validates an {@link AdminBlocklistFetchResult}, refusing unknown fields. */
export const adminBlocklistFetchResultSchema = z
  .object({ ok: z.literal(true), entries: z.array(blockEntrySchema) })
  .strict();
/** The reply to `admin.blocklist.fetch`: `ok: true` and every blocked DID as a {@link BlockEntry}. */
export type AdminBlocklistFetchResult = z.infer<typeof adminBlocklistFetchResultSchema>;
/**
 * {@link AdminBlocklistFetchResult} as a client reads it: the checks of
 * `adminBlocklistFetchResultSchema`, with unknown fields dropped instead of refused.
 */
export const adminBlocklistFetchResultReadSchema = readVariant(adminBlocklistFetchResultSchema);

// ── Members (beacon.server `doc/spec/admin-api.md` §6) ─────────────────────────
// The member list a server at `request` or `private` takes writes from (`access.ts`).

/** The statuses an entry on the member list can have: every `AccessStatus` but `none`. */
const entryStatusSchema = accessStatusSchema.exclude(["none"]);

/** Validates an {@link AccessEntry}. */
export const accessEntrySchema = z
  .object({
    did: didKeySchema,
    status: entryStatusSchema,
    /** The player's note from their request, if they left one. */
    note: accessNoteSchema.optional(),
    /** When the player last asked. Absent for a member an admin added without a request. */
    requestedAt: isoTimestampSchema.optional(),
    /** The admin DID that approved, declined or added the player. Absent while pending. */
    decidedBy: didKeySchema.optional(),
    /** When an admin approved, declined or added the player. Absent while pending. */
    decidedAt: isoTimestampSchema.optional(),
  })
  .strict();
/**
 * One account on a server's member list: a member, a pending request or a declined one.
 *
 * Admins are members without an entry.
 */
export type AccessEntry = z.infer<typeof accessEntrySchema>;
/** Validates {@link AdminAccessFetchParams}. */
export const adminAccessFetchParamsSchema = z
  .object({ status: entryStatusSchema.optional() })
  .strict();
/**
 * The params of an `admin.access.fetch` op: an optional `status` to list only members, pending
 * requests or declined ones. Without it, every entry.
 */
export type AdminAccessFetchParams = z.infer<typeof adminAccessFetchParamsSchema>;

/** Validates an {@link AdminAccessFetchResult}, refusing unknown fields. */
export const adminAccessFetchResultSchema = z
  .object({ ok: z.literal(true), entries: z.array(accessEntrySchema) })
  .strict();
/**
 * The reply to `admin.access.fetch`: `ok: true` and the entries, pending requests oldest first and
 * then the rest by DID.
 */
export type AdminAccessFetchResult = z.infer<typeof adminAccessFetchResultSchema>;
/** {@link AdminAccessFetchResult} as a client reads it, with unknown fields dropped. */
export const adminAccessFetchResultReadSchema = readVariant(adminAccessFetchResultSchema);

/** Validates {@link AdminAccessDidParams}. `reason` is 1 to 500 characters. */
export const adminAccessDidParamsSchema = z
  .object({ did: didKeySchema, reason: reasonSchema.optional() })
  .strict();
/**
 * The params of `admin.access.add`, `admin.access.decline` and `admin.access.remove`: the account
 * to act on, and an optional reason for the audit log, never shown to the player.
 *
 * - `admin.access.add` makes the account a member, approving its request if it has one. The reply
 *   is an {@link AdminAccessEntryResult}.
 * - `admin.access.decline` declines a pending request, and is refused `invalid` when the account
 *   has none. The reply is an {@link AdminAccessEntryResult}.
 * - `admin.access.remove` deletes the entry, so a member loses write access and a declined player
 *   may ask again. The reply is `{ ok: true, removed }`, with `removed` `false` when there was no
 *   entry.
 */
export type AdminAccessDidParams = z.infer<typeof adminAccessDidParamsSchema>;

/** Validates an {@link AdminAccessEntryResult}, refusing unknown fields. */
export const adminAccessEntryResultSchema = z
  .object({ ok: z.literal(true), entry: accessEntrySchema })
  .strict();
/** The reply to `admin.access.add` and `admin.access.decline`: the entry as it now stands. */
export type AdminAccessEntryResult = z.infer<typeof adminAccessEntryResultSchema>;
/** {@link AdminAccessEntryResult} as a client reads it, with unknown fields dropped. */
export const adminAccessEntryResultReadSchema = readVariant(adminAccessEntryResultSchema);

/** Validates {@link AdminAccessAdmitAllParams}: an empty object. */
export const adminAccessAdmitAllParamsSchema = z.object({}).strict();
/**
 * The params of an `admin.access.admitAll` op: always empty. The server makes a member of every
 * account with a published profile on it, for an operator moving a server off `open` without
 * shutting out its players.
 */
export type AdminAccessAdmitAllParams = z.infer<typeof adminAccessAdmitAllParamsSchema>;

/** Validates an {@link AdminAccessAdmitAllResult}, refusing unknown fields. */
export const adminAccessAdmitAllResultSchema = z
  .object({ ok: z.literal(true), added: z.number().int().nonnegative() })
  .strict();
/** The reply to `admin.access.admitAll`: how many accounts became members. */
export type AdminAccessAdmitAllResult = z.infer<typeof adminAccessAdmitAllResultSchema>;
/** {@link AdminAccessAdmitAllResult} as a client reads it, with unknown fields dropped. */
export const adminAccessAdmitAllResultReadSchema = readVariant(adminAccessAdmitAllResultSchema);

// ── Media management (beacon.server `doc/spec/admin-api.md` §3) ────────────────
// The admin browse/curate surface over the content-addressed media store: a paginated, filtered list
// (a signed READ) plus a per-object review toggle (a signed WRITE). Enumerating hashes/owners is
// admin-only: individual bytes were already public by content address, so the list adds only
// enumerability, gated behind the `BEACON_ADMINS` allowlist.

/**
 * Validates {@link AdminMediaListParams}: `limit` is 1 to 100 and `type` at most 128 characters.
 */
export const adminMediaListParamsSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    owner: didKeySchema.optional(),
    type: z.string().min(1).max(128).optional(),
    reviewed: z.enum(["reviewed", "unreviewed"]).optional(),
    sort: z.enum(["recent", "size"]).optional(),
  })
  .strict();
/**
 * The params of an `admin.media.list` op: which page of the server's media to list, how to sort it
 * and optional filters.
 *
 * - `cursor`: the `nextCursor` of the previous page. Leave it out for the first page.
 * - `limit`: rows per page, 1 to 100. The server picks a default when it is absent.
 * - `owner`, `type`: exact matches on the uploader's DID and the media type.
 * - `reviewed`: `"reviewed"` or `"unreviewed"`. Absent lists both.
 * - `sort`: `"recent"` (newest first, the default) or `"size"` (largest first).
 *
 * A cursor works only with the `sort` that produced it, so keep `sort` the same while you page.
 */
export type AdminMediaListParams = z.infer<typeof adminMediaListParamsSchema>;

/** Validates a {@link MediaListItem}. */
export const mediaListItemSchema = z
  .object({
    /** The bare content hash, without `@host`. */
    hash: mediaHashSchema,
    /** The media type, such as `image/webp`. */
    type: z.string(),
    /** The size in bytes. */
    size: z.number().int().nonnegative(),
    /** The DID that uploaded it. */
    owner: didKeySchema,
    uploadedAt: isoTimestampSchema,
    /** When the server last served the bytes, or `null` when it never has. */
    lastAccessAt: isoTimestampSchema.nullable(),
    /** When an admin reviewed it, or `null` when no admin has. */
    reviewedAt: isoTimestampSchema.nullable(),
    /** The admin who reviewed it, or `null` when no admin has. */
    reviewedBy: didKeySchema.nullable(),
  })
  .strict();
/**
 * One media object in an `admin.media.list` page: its metadata without the bytes.
 *
 * Anyone can fetch the bytes at `GET /media/:hash`. The `hash` is bare because every console use
 * (a thumbnail, `admin.media.remove`, `admin.media.review`) takes it bare.
 */
export type MediaListItem = z.infer<typeof mediaListItemSchema>;

/** Validates an {@link AdminMediaList}. */
export const adminMediaListSchema = z
  .object({
    items: z.array(mediaListItemSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
/**
 * The reply to an `admin.media.list` op: one page of media objects, and `nextCursor` when another
 * page follows.
 */
export type AdminMediaList = z.infer<typeof adminMediaListSchema>;
/**
 * {@link AdminMediaList} as a client reads it: the checks of `adminMediaListSchema`, with unknown
 * fields dropped instead of refused.
 */
export const adminMediaListReadSchema = readVariant(adminMediaListSchema);

/** Validates {@link AdminMediaReviewParams}. `reason` is 1 to 500 characters. */
export const adminMediaReviewParamsSchema = z
  .object({
    hash: mediaHashSchema,
    reviewed: z.boolean(),
    reason: reasonSchema.optional(),
  })
  .strict();
/**
 * The params of an `admin.media.review` op: mark one media object reviewed with `reviewed: true`,
 * or clear its review stamp with `reviewed: false`.
 */
export type AdminMediaReviewParams = z.infer<typeof adminMediaReviewParamsSchema>;

/** Validates an {@link AdminMediaReview}. */
export const adminMediaReviewSchema = z
  .object({
    reviewedAt: isoTimestampSchema.nullable(),
    reviewedBy: didKeySchema.nullable(),
  })
  .strict();
/**
 * The reply to an `admin.media.review` op: the object's review stamp after the change, with both
 * fields `null` when the stamp was cleared.
 */
export type AdminMediaReview = z.infer<typeof adminMediaReviewSchema>;
/**
 * {@link AdminMediaReview} as a client reads it: the checks of `adminMediaReviewSchema`, with
 * unknown fields dropped instead of refused.
 */
export const adminMediaReviewReadSchema = readVariant(adminMediaReviewSchema);

// ── Runtime settings (beacon.server `doc/spec/runtime-settings.md` §5) ─────────
// The operator's configuration surface: read the whole thing, override some of it, hand parts of it
// back to the environment. Editable settings live in the `settings` table; the rest is read from the
// environment at boot and reported read-only, so one screen shows the whole configuration and says
// which half needs a restart.

/** Validates a {@link SettingValue}. */
export const settingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
/**
 * A server setting's value on the wire: a string, a number, a boolean or a list of strings.
 *
 * A write sends `null` for "no value", because JSON has no `undefined` and several settings are
 * optional (`contact`, `mediaCdnUrl`). A read never carries `null`: a setting with no value is left
 * out, the same as every other optional field on this wire.
 *
 * `trustProxy` is why the union has both `boolean` and `number` (`true`, or a hop count).
 */
export type SettingValue = z.infer<typeof settingValueSchema>;

/**
 * Validates an {@link AdminSetting}.
 *
 * Two facts are kept separate on purpose. `editable` says whether `admin.settings.set` will take
 * the setting: false for the deploy-shape fields, which are read from the environment and nowhere
 * else (beacon.server `doc/spec/runtime-settings.md` §3.1). `provenance` says where the value in
 * force came from, and a read-only field is always `env` because nothing else could have supplied
 * it. Collapsing the two into one enum would make "not editable" and "not overridden" the same
 * word, and they answer different questions.
 */
export const adminSettingSchema = z
  .object({
    /** The `ServerConfig` field name, which is also the key `admin.settings.set` takes. */
    key: z.string().min(1),
    /** The environment variable that supplies it, so a read-only row still says what to edit. */
    env: z.string().min(1),
    /** Whether a signed `admin.settings.set` can change it, or a restart is the only way. */
    editable: z.boolean(),
    /** Where the value in force came from. Always `env` for a field that is not editable. */
    provenance: z.enum(["env", "admin"]),
    /** The value in force. Absent when the setting has no value, and always absent for a secret. */
    value: settingValueSchema.optional(),
    /**
     * Whether {@link env} is actually set in the server's environment. `false` means the field is
     * on its built-in default, which is the answer to "I set that variable and nothing changed".
     *
     * For a secret it is the whole of what a read learns; for everything else it sits beside the
     * value. One meaning either way: **the environment supplies this field.** Keeping the two as
     * one word is deliberate, because a console asking "did the operator set this?" should not
     * have to ask it differently depending on whether it may see the answer.
     */
    configured: z.boolean(),
    /**
     * Present, and `true`, only for a field that is never reported by value: key material, the S3
     * credentials, and the database URL, whose DSN carries its own password.
     */
    secret: z.literal(true).optional(),
    /** The operator DID that set it, absent while the environment still drives it. */
    updatedBy: z.string().min(1).optional(),
    updatedAt: isoTimestampSchema.optional(),
    /**
     * What a reset would restore. Absent for a read-only field, where it is already {@link value}.
     */
    envValue: settingValueSchema.optional(),
    /**
     * What the admin actually stored, present only when it is not what {@link value} reports: a
     * capability forced off while its prerequisite is off, or a ceiling clamped to its boot bound.
     * The stored choice takes effect again when it can be honored, so a console shows both rather
     * than telling an operator their write did not land.
     */
    storedValue: settingValueSchema.optional(),
    /**
     * Which rule held {@link storedValue} back, present exactly when it is.
     *
     * The two cases leave an identical shape and want opposite things: `prerequisite` is fixed by
     * turning the capability it depends on back on, `ceiling` by raising the environment variable
     * and restarting. A console that had only `storedValue` could render nothing better than a
     * generic "not in force" badge over both, which tells an operator nothing they can act on.
     */
    storedReason: absentOnRead(z.enum(["prerequisite", "ceiling"]).optional()),
  })
  .strict();
/**
 * One server setting as an operator console shows it: its key and value, where the value came from
 * and whether an admin may change it.
 *
 * A setting that is not `editable` changes only through its environment variable and a restart. A
 * secret never reports its value; `configured` says whether the environment sets it.
 */
export type AdminSetting = z.infer<typeof adminSettingSchema>;
/**
 * {@link AdminSetting} as a client reads it: the checks of `adminSettingSchema`, with unknown
 * fields dropped instead of refused. A `storedReason` this version does not know reads as absent.
 */
export const adminSettingReadSchema = readVariant(adminSettingSchema);

/** Validates {@link AdminSettings}. */
export const adminSettingsSchema = z.object({ settings: z.array(adminSettingSchema) }).strict();
/**
 * The reply to `admin.settings.get`, `admin.settings.set` and `admin.settings.reset`: every
 * setting in the server's grouped order, editable ones first.
 *
 * A write returns the same shape as a read, and the whole of it rather than the fields it touched,
 * because a write can move a field it did not name: turning `placesEnabled` off forces the
 * contributions flags off with it. Redraw every row from the reply, or the dependent settings will
 * still show as on.
 */
export type AdminSettings = z.infer<typeof adminSettingsSchema>;
/**
 * {@link AdminSettings} as a client reads it: the checks of `adminSettingsSchema`, with unknown
 * fields dropped instead of refused. A `storedReason` this version does not know reads as absent.
 */
export const adminSettingsReadSchema = readVariant(adminSettingsSchema);

/**
 * The most keys either write op will look at.
 *
 * There are 41 editable settings, so a write naming more keys than that is a mistake or an attempt
 * to make the server do work proportional to the body: every unwritable key produces a refusal,
 * and those refusals are assembled into one response. The exact count lives on the server, so this
 * is a generous bound rather than the real one, and it is on the wire because that is the cheapest
 * place to stop it.
 */
const MAX_KEYS_PER_OP = 100;

/** Validates {@link AdminSettingsGetParams}: an empty object. */
export const adminSettingsGetParamsSchema = z.object({}).strict();
/**
 * The params of an `admin.settings.get` op: always empty, because the signed envelope is the whole
 * request.
 */
export type AdminSettingsGetParams = z.infer<typeof adminSettingsGetParamsSchema>;

/**
 * Validates {@link AdminSettingsSetParams}: 1 to 100 keys, and a `reason` of 1 to 500 characters.
 *
 * Several keys in one write is the point of the shape. Some settings constrain each other, so an
 * operator turning `placesEnabled` off has to turn its dependents off in the same write: one key at
 * a time forces them through a state the validator refuses, in whichever order they pick.
 */
export const adminSettingsSetParamsSchema = z
  .object({
    settings: z
      .record(z.string().min(1), settingValueSchema.nullable())
      .refine((v) => Object.keys(v).length > 0, { message: "no settings to set" })
      .refine((v) => Object.keys(v).length <= MAX_KEYS_PER_OP, {
        message: `at most ${MAX_KEYS_PER_OP} settings in one write`,
      }),
    reason: reasonSchema.optional(),
  })
  .strict();
/**
 * The params of an `admin.settings.set` op: new values for one or more settings, keyed by setting
 * name, written together.
 *
 * The server checks the whole patch against the configuration it would produce and stores none of
 * it when any part is refused. Send settings that depend on each other in the same write. A `null`
 * value sets a setting to no value, which differs from `admin.settings.reset`: a reset drops the
 * override and lets the environment supply the setting again.
 */
export type AdminSettingsSetParams = z.infer<typeof adminSettingsSetParamsSchema>;

/**
 * Validates {@link AdminSettingsResetParams}: 1 to 100 keys, and a `reason` of 1 to 500 characters.
 *
 * A reset is never refused for the combination it produces: an admin who could not reset a
 * prerequisite while a dependent override stood could undo their own change only in one order.
 */
export const adminSettingsResetParamsSchema = z
  .object({
    keys: z.array(z.string().min(1)).min(1).max(MAX_KEYS_PER_OP),
    reason: reasonSchema.optional(),
  })
  .strict();
/**
 * The params of an `admin.settings.reset` op: the settings whose admin overrides to drop, so the
 * environment supplies them again.
 *
 * A setting that depends on a reset one keeps its override but stops applying, and applies again
 * once its prerequisite is back.
 */
export type AdminSettingsResetParams = z.infer<typeof adminSettingsResetParamsSchema>;
