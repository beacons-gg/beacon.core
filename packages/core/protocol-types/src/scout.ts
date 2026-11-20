import { z } from "zod";
import { movementSchema } from "./discovery";
import { didKeySchema, displayNameSchema, gameSlugSchema, isoTimestampSchema } from "./primitives";
import { mintedBySchema } from "./mintedBy";
import { MAX_SCOUT_CONFIG_BYTES, scoutConfigFits, scoutConfigSchema } from "./scoutConfig";

/**
 * Validates a {@link ScoutReport}, refusing unknown fields.
 *
 * The scout advertisement of `doc/spec/discovery.md` §5. A scout has a single writer, its owner.
 */
export const scoutReportSchema = z
  .object({
    unique: z.string().min(1), // dedupe key across servers
    owner: didKeySchema,
    config: scoutConfigSchema, // the game's baked, signed type config; opaque to the server
    mintedBy: mintedBySchema, // scout provenance over {unique, config}
    name: displayNameSchema.optional(), // owner's custom display name — mutable, travels; distinct from the signed config.label
    // The game slug the report's envelope was signed with, relayed so a reader can tell whose scout
    // this is without guessing from the config's shape. Absent when the envelope had none.
    game: gameSlugSchema.optional(),
    movement: movementSchema,
    reportedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema, // TTL — owner heartbeats before this or the report ages out
  })
  .strict();
/**
 * A scout report as a server stores and relays it. The report holds the owner and the scout's
 * config, provenance and movement, and it says when the report expires.
 *
 * A server caches and relays a report and never takes custody of the scout. Several servers can
 * hold the same scout, so readers drop duplicates by `unique`. The config is signed into the
 * scout's provenance (`mintedBy` over `{ unique, config }`), so anyone can verify the minter
 * offline.
 *
 * The server reads none of the config. The server relays `movement` as reported and bounds only its
 * own store: the report's lifetime, the number of scouts and the {@link MAX_SCOUT_CONFIG_BYTES}
 * cap.
 *
 * To send a report, use the client SDK's `reportScout`. The client SDK names that method's input
 * type `ScoutReport` too.
 */
export type ScoutReport = z.infer<typeof scoutReportSchema>;

/** Validates {@link ScoutReportParams}, including the config size limit. */
export const scoutReportParamsSchema = z
  .object({
    unique: z.string().min(1),
    // Bounded here, where a scout enters a server, and nowhere a client reads one.
    config: scoutConfigSchema.refine(scoutConfigFits, {
      message: `config must be at most ${MAX_SCOUT_CONFIG_BYTES} bytes of canonical JSON`,
    }),
    mintedBy: mintedBySchema,
    name: displayNameSchema.optional(), // owner's custom display name (mutable) — carried onto the stored report
    movement: movementSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();
/**
 * The params of a scout `report` op: the scout's `unique`, config, provenance, movement and expiry.
 *
 * The server fills in `owner` and `reportedAt` from the signed op. The config must fit in {@link
 * MAX_SCOUT_CONFIG_BYTES} bytes of canonical JSON. The client's `reportScout` sends this op to
 * `POST /scouts`.
 */
export type ScoutReportParams = z.infer<typeof scoutReportParamsSchema>;

/** Validates {@link ScoutCancelParams}. */
export const scoutCancelParamsSchema = z.object({ unique: z.string().min(1) }).strict();
/**
 * The params of a scout `cancel` op: the `unique` of the scout to remove. The client's
 * `cancelScout` sends this op.
 */
export type ScoutCancelParams = z.infer<typeof scoutCancelParamsSchema>;
