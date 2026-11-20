import { z } from "zod";
import { readVariant } from "./read";
import { didKeySchema, httpUrlSchema, isoTimestampSchema, ulidSchema } from "./primitives";

// Backup and restore (beacon.server `doc/spec/admin-api.md` §3): an admin-only job that writes a
// server's whole state to an S3 prefix, and the same job in reverse on another server. Like the
// rest of the admin surface these ride a signed envelope, gated on `BEACON_ADMINS`, and are never
// advertised.
//
// A backup is a folder rather than an archive, because it runs to tens of GB, mostly photos:
// `manifest.json`, `db/<timestamp>/*`, `identity.key`, `media/<aa>/<hash>`. Re-running to the same
// prefix uploads only new photos, and the manifest is written last, so a run that dies leaves the
// previous good backup in place.

const countSchema = z.number().int().nonnegative();

/** A Postgres name a restore puts in a `COPY` statement, so nothing else can pass for one. */
const sqlNameSchema = z.string().regex(/^[a-z_][a-z0-9_]*$/, "a lower-case SQL name");

/** Relative path segments, never empty and never climbing out: a prefix, or a file under one. */
const relativePathSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "letters, digits, . _ - separated by /")
  .refine((path) => !path.split("/").some((segment) => /^\.+$/.test(segment)), {
    message: "a path has no . or .. segment",
  });

/**
 * Validates a {@link BackupS3Target}.
 *
 * `endpoint` is an `http` or `https` URL of at most 2,048 characters with no login, query or
 * fragment. `prefix` is a relative path of at most 512 characters with no `.` or `..` segment.
 */
export const backupS3TargetSchema = z
  .object({
    // Reported on every run, so it may not carry a credential of its own.
    endpoint: httpUrlSchema(2048)
      .refine((url) => !/[@?#]/.test(url), { message: "an endpoint has no login or query" })
      .optional(),
    region: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a region name"),
    bucket: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/, "a bucket name"),
    prefix: relativePathSchema,
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(1024),
    forcePathStyle: z.boolean(),
  })
  .strict();
/**
 * The S3 bucket and prefix a backup is written to or restored from, with the credentials to reach
 * it.
 *
 * Leave `endpoint` out for AWS, or set it for another S3-compatible store. The server uses the
 * credentials for that one run and never stores them. A run reports its target as a
 * {@link BackupRunTarget}, which leaves them out.
 */
export type BackupS3Target = z.infer<typeof backupS3TargetSchema>;

/** Validates a {@link BackupRunTarget}. */
export const backupRunTargetSchema = backupS3TargetSchema.pick({
  endpoint: true,
  region: true,
  bucket: true,
  prefix: true,
});
/** A run's S3 target as the server reports it: a {@link BackupS3Target} without the credentials. */
export type BackupRunTarget = z.infer<typeof backupRunTargetSchema>;

/** Validates {@link AdminBackupStartParams}. */
export const adminBackupStartParamsSchema = z
  .object({ target: backupS3TargetSchema, includeIdentity: z.boolean() })
  .strict();
/**
 * The params of an `admin.backup.start` op: where to write the backup, and whether to include the
 * server's identity.
 *
 * With `includeIdentity` the backup holds `identity.key`, the server's recovery phrase. Anyone with
 * that file can act as your server, so restrict who can read the bucket.
 */
export type AdminBackupStartParams = z.infer<typeof adminBackupStartParamsSchema>;

/** Validates {@link AdminRestoreInspectParams}. */
export const adminRestoreInspectParamsSchema = z.object({ target: backupS3TargetSchema }).strict();
/**
 * The params of an `admin.restore.inspect` op: the backup to look at.
 *
 * The server reads the backup's manifest and says whether the backup would restore on this server,
 * without changing anything.
 */
export type AdminRestoreInspectParams = z.infer<typeof adminRestoreInspectParamsSchema>;

/** Validates {@link AdminRestoreStartParams}: the same schema as `admin.restore.inspect` uses. */
export const adminRestoreStartParamsSchema = adminRestoreInspectParamsSchema;
/**
 * The params of an `admin.restore.start` op: the backup to restore onto this server.
 *
 * Run `admin.restore.inspect` first: it reports a `refusal` when this server would not restore the
 * backup. The most common refusal is a server that already holds player data. A backup in another
 * format or at a newer schema version is refused too, and so is a backup from a server with another
 * key when the backup has no `identity.key` or `BEACON_KEY_PASSPHRASE` is not set.
 */
export type AdminRestoreStartParams = z.infer<typeof adminRestoreStartParamsSchema>;

/** Validates {@link AdminBackupRunsParams}. */
export const adminBackupRunsParamsSchema = z.object({ id: ulidSchema.optional() }).strict();
/**
 * The params of an `admin.backup.runs` op: the `id` of one run, or nothing for the recent backups
 * and restores.
 */
export type AdminBackupRunsParams = z.infer<typeof adminBackupRunsParamsSchema>;

/** Validates {@link BackupRunStats}. */
export const backupRunStatsSchema = z
  .object({
    tablesDone: countSchema,
    tablesTotal: countSchema,
    rows: countSchema,
    mediaDone: countSchema,
    mediaTotal: countSchema,
    mediaBytes: countSchema,
    /** Of `mediaDone`: already at the destination, so not copied again. */
    mediaSkipped: countSchema,
    /** Rows whose file was missing or did not match its hash. */
    mediaMissing: countSchema,
  })
  .strict();
/** How far a backup or restore run has got: tables and rows, and media objects and bytes. */
export type BackupRunStats = z.infer<typeof backupRunStatsSchema>;

/**
 * Validates a {@link BackupRun}: at most 100 warnings of 500 characters, and an `error` of 2,000.
 */
export const backupRunSchema = z
  .object({
    id: ulidSchema,
    kind: z.enum(["backup", "restore"]),
    status: z.enum(["queued", "running", "done", "failed"]),
    requestedBy: didKeySchema,
    target: backupRunTargetSchema,
    /** A backup: whether the server was locked for it, which is what a move needs. */
    locked: z.boolean().optional(),
    stats: backupRunStatsSchema.optional(),
    warnings: z.array(z.string().max(500)).max(100).optional(),
    error: z.string().max(2000).optional(),
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.optional(),
    finishedAt: isoTimestampSchema.optional(),
  })
  .strict();
/**
 * One backup or restore run as the server records it: its kind, its status, who asked for it and
 * how far it has got.
 *
 * Poll it with `admin.backup.runs` until `status` is `done` or `failed`. The record never holds a
 * credential.
 */
export type BackupRun = z.infer<typeof backupRunSchema>;
/**
 * {@link BackupRun} as a client reads it: the checks of `backupRunSchema`, with unknown fields
 * dropped instead of refused.
 */
export const backupRunReadSchema = readVariant(backupRunSchema);

/** Validates {@link AdminBackupRuns}: at most 50 runs. */
export const adminBackupRunsSchema = z.object({ runs: z.array(backupRunSchema).max(50) }).strict();
/**
 * The reply to an `admin.backup.runs` op: the run asked for by id, or the recent runs, at most 50.
 */
export type AdminBackupRuns = z.infer<typeof adminBackupRunsSchema>;
/**
 * {@link AdminBackupRuns} as a client reads it: the checks of `adminBackupRunsSchema`, with unknown
 * fields dropped instead of refused.
 */
export const adminBackupRunsReadSchema = readVariant(adminBackupRunsSchema);

/** Validates a {@link BackupTable}. Table and column names are lowercase SQL names. */
export const backupTableSchema = z
  .object({
    name: sqlNameSchema,
    columns: z.array(sqlNameSchema).min(1),
    rows: countSchema,
    bytes: countSchema,
    /** Relative to the prefix. `bytes` is the size of this file. */
    file: relativePathSchema,
  })
  .strict();
/** One table's data in a backup manifest: the table, its columns in order, and its `COPY` file. */
export type BackupTable = z.infer<typeof backupTableSchema>;

/**
 * Validates a {@link BackupManifest}.
 *
 * A manifest outlives any one release, so a field is only ever added.
 */
export const backupManifestSchema = z
  .object({
    format: z.number().int().positive(),
    createdAt: isoTimestampSchema,
    host: z.string().min(1).max(261),
    did: didKeySchema,
    /** The last migration applied when the backup was taken. */
    schemaVersion: z.number().int().positive(),
    serverVersion: z.string().min(1).max(32),
    /** Whether the server was locked, so nothing changed after this copy. A move needs this. */
    locked: z.boolean(),
    /** Whether `identity.key` is in this backup. */
    identity: z.boolean(),
    tables: z.array(backupTableSchema).min(1),
    media: z
      .object({
        count: countSchema,
        bytes: countSchema,
        /** Of `count`: rows whose file was already missing or corrupt on the server backed up. */
        missing: countSchema,
      })
      .strict(),
  })
  .strict();
/**
 * A backup's `manifest.json`: what the backup holds and which server it came from.
 *
 * A restore moves the server: the restored server takes the backup's `host` and, when `did`
 * differs from its own, the backup's key. Every id and photo address holds the host, and players
 * have pinned the server's key, so the restored server answers as the server that was backed up. A
 * backup with a different `did` restores only when it carries `identity.key` and the server has
 * `BEACON_KEY_PASSPHRASE` set to keep that key.
 */
export type BackupManifest = z.infer<typeof backupManifestSchema>;
/**
 * {@link BackupManifest} as a client reads it: the checks of `backupManifestSchema`, with unknown
 * fields dropped instead of refused.
 */
export const backupManifestReadSchema = readVariant(backupManifestSchema);

/** Validates an {@link AdminRestoreInspection}. */
export const adminRestoreInspectionSchema = z
  .object({ manifest: backupManifestSchema, refusal: z.string().optional() })
  .strict();
/**
 * The reply to an `admin.restore.inspect` op: the backup's manifest, with a `refusal` when this
 * server would not restore the backup.
 *
 * The `refusal` says why. No `refusal` means `admin.restore.start` may go ahead.
 */
export type AdminRestoreInspection = z.infer<typeof adminRestoreInspectionSchema>;
/**
 * {@link AdminRestoreInspection} as a client reads it: the checks of
 * `adminRestoreInspectionSchema`, with unknown fields dropped instead of refused.
 */
export const adminRestoreInspectionReadSchema = readVariant(adminRestoreInspectionSchema);
