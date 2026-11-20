import { z } from "zod";
import { readAsOnRead, readVariant } from "./read";
import { proofSchema } from "./identity";
import {
  didKeySchema,
  displayNameSchema,
  gameSlugSchema,
  geohashCellSchema,
  globalIdSchema,
  isoTimestampSchema,
  latLngSchema,
} from "./primitives";
import { mintedBySchema } from "./mintedBy";
import { MAX_SCOUT_SPEED_KMH, scoutConfigSchema } from "./scoutConfig";

/**
 * Validates a {@link ServerAccessLevel}: `open`, `request` or `private`.
 *
 * The access policy of `doc/spec/discovery.md` §3.2.
 */
export const serverAccessLevelSchema = z.enum(["open", "request", "private"]);
/**
 * Who may use a server, as its operator advertises it: `open` for anyone, `request` for players who
 * ask the operator, or `private` for invited players only.
 *
 * A server that lists the `access:members` marker (`enforcesAccess`) takes writes only from
 * members at `request` and `private`, and refuses anyone else with `notMember`. Reads are open at
 * every level. A server without the marker shows the level for display only. Read a received
 * descriptor's level with {@link readAccessLevel}.
 */
export type ServerAccessLevel = z.infer<typeof serverAccessLevelSchema>;

/**
 * The descriptor's access level as a client reads it: a level this build has never heard of reads
 * as `private`, the most restrictive.
 */
const accessLevelOnRead = readAsOnRead(serverAccessLevelSchema, "private");
const accessLevelRead = readVariant(accessLevelOnRead);

/**
 * Read a received descriptor's `accessLevel` as a level this version knows. A level added after
 * this version reads as `private`, the most restrictive.
 *
 * `verifyDescriptor` hands back the signed body as received, so a level a newer server added is
 * still in it. Read the field through here, which answers as the read twin does.
 */
export function readAccessLevel(level: string): ServerAccessLevel {
  return accessLevelRead.parse(level);
}

/**
 * Validates a {@link ServerDescriptor}, refusing unknown fields: the shape a server signs.
 *
 * The descriptor of `doc/spec/discovery.md` §3.2. A client reads with
 * {@link serverDescriptorReadSchema} instead, so that a field a newer server adds does not make the
 * server unreadable.
 */
export const serverDescriptorSchema = z
  .object({
    host: z.string(), // the `@host` authority this server serves (the host part of the `unique@host` ids it hosts)
    key: didKeySchema, // server identity (did:key) — the descriptor is self-signed by this key
    coverage: z.array(z.string()), // geohash prefixes it serves (may overlap peers; [""] = everywhere)
    name: z.string().optional(), // human display name
    description: z.string().max(280).optional(), // optional operator blurb: what this server is for
    contact: z.string().max(200).optional(), // optional operator contact (email / URL)
    version: z.string().min(1).max(32), // server software version (from config)
    startedAt: isoTimestampSchema, // process start — clients derive live uptime (now − startedAt)
    accessLevel: accessLevelOnRead, // open | request | private (enforced with "access:members"); see readAccessLevel
    // What this server advertises beyond the always-on rooms/discovery (beacon.server
    // `doc/spec/mailbox-and-media.md` §3.1), e.g. ["mailbox","media"]. Absent ⇒ the base set.
    // Per-capability limits come from each endpoint (413/429), not the signed descriptor, so this
    // stays a small, stable list.
    //
    // It carries two kinds of entry, and the second exists because **this schema is `.strict()`**:
    // a new top-level descriptor field reads as *malformed* to a client that predates the read
    // schemas, so its `verifyDescriptor` returns false and the server becomes unaddable. Adding entries to an
    // existing list is the one descriptor change that is not breaking, which makes this the
    // extension point for anything a federated client population has to learn incrementally
    // (`doc/spec/discovery.md` §3.2).
    //   - **Service capabilities** — an operator opt-in: "mailbox", "media", "geocode", "places",
    //     "places-proposals".
    //   - **Protocol markers**: "game:<slug>" once per game the operator admits, so no "game:" entry
    //     means open to every game. Then "op:<name>", "policy:<feature>" and "rule:<name>" for each
    //     op, policy feature and rule operator beyond the baseline (`markers.ts`), and
    //     "access:members" when the server enforces `accessLevel` (`access.ts`).
    capabilities: z.array(z.string()).optional(),
    updated: isoTimestampSchema, // when this descriptor was (re)signed
    proof: proofSchema,
  })
  .strict();
/**
 * A server's signed description of itself from `GET /server/descriptor`: its address, key,
 * coverage, operator details and capabilities.
 *
 * Check the descriptor with `verifyDescriptor` from `@beaconsgg/identity` before you trust any of
 * it. The client's `addServer` and `verifyServer` do that for you.
 *
 * - `host`: the authority in the ids this server hosts (`<unique>@<host>`).
 * - `key`: the server's identity, a `did:key`. The descriptor is signed by this key (`proof`).
 * - `coverage`: the geohash prefixes the server serves. `[""]` means everywhere.
 * - `name`, `description` (up to 280 characters) and `contact` (up to 200): set by the operator.
 * - `version`: the server software's version.
 * - `startedAt`: when the server process started. Work out uptime from it as now minus `startedAt`.
 * - `accessLevel`: see {@link ServerAccessLevel}.
 * - `capabilities`: the services the operator turned on (see {@link serviceCapabilities}) and the
 *   protocol markers (see {@link admittedGames}, `acceptsOp` and `enforcesAccess`).
 * - `updated`: when the descriptor was signed.
 */
export type ServerDescriptor = z.infer<typeof serverDescriptorSchema>;
/**
 * {@link ServerDescriptor} as a client reads it: the checks of `serverDescriptorSchema`, with
 * unknown fields dropped instead of refused. An unknown `accessLevel` reads as `private`.
 */
export const serverDescriptorReadSchema = readVariant(serverDescriptorSchema);

/**
 * A descriptor as `verifyDescriptor` hands it back: the signed body as received, with `accessLevel`
 * typed as any string.
 *
 * Keeping the body as received keeps the descriptor verifiable. A level a newer server added may be
 * in `accessLevel`, so read the field with {@link readAccessLevel}.
 */
export type ReceivedDescriptor = z.input<typeof serverDescriptorReadSchema>;

/** The admitted-game marker's prefix, for {@link admittedGames}. */
const GAME_ADMISSION_PREFIX = "game:";

/**
 * List the services a server's operator turned on, such as `mailbox` and `media`.
 *
 * Pass the `capabilities` of the server's descriptor. The protocol markers (`game:`, `op:`,
 * `policy:`, `rule:` and `access:`) are left out, so the result is the list to show players. To ask whether a
 * server understands something, read the raw list or use `acceptsOp`.
 *
 * A marker states what a build understands and is not something an operator turned on. Showing the
 * two together would read as though the operator enabled a service they did not, and an
 * unconditional marker would make "no extra capabilities" a state no server can be in again.
 */
export function serviceCapabilities(capabilities: readonly string[] | undefined): string[] {
  // A service is a bare word. Every marker is namespaced (`game:`, `op:`, `policy:`, `rule:`, `access:`; see
  // `understands.ts`), so one rule keeps a future marker off the player's list.
  return (capabilities ?? []).filter((c) => !c.includes(":"));
}

/**
 * List the game slugs a server admits, from the `game:<slug>` markers in its descriptor's
 * `capabilities`. An empty list means the server admits every game.
 */
export function admittedGames(capabilities: readonly string[] | undefined): string[] {
  return (capabilities ?? [])
    .filter((c) => c.startsWith(GAME_ADMISSION_PREFIX))
    .map((c) => c.slice(GAME_ADMISSION_PREFIX.length));
}

/**
 * Validates a game filter on a read: one or more game slugs.
 *
 * A filtered read keeps the rooms these games own or may act on (`roomOpenToGame` in `./server`) and these games'
 * scouts. To read every game, leave the filter out. An empty list is refused.
 */
export const gamesFilterSchema = z.array(gameSlugSchema).min(1);

/**
 * Validates a {@link DiscoveryQuery} with the bounds a server applies: 1 to 256 geohash cells, up to
 * 16 `types` of 1 to 32 characters each, and 1 to 16 game slugs.
 *
 * The query of `doc/spec/discovery.md` §4.1.
 */
export const discoveryQuerySchema = z.object({
  cells: z.array(geohashCellSchema).min(1).max(256), // geohash cells (coarsened for privacy)
  types: z.array(z.string().min(1).max(32)).max(16).optional(),
  games: gamesFilterSchema.max(16).optional(),
});
/**
 * The query of `GET /discovery`: 1 to 256 geohash cells to search, with optional room types (up to
 * 16) and games (up to 16).
 *
 * Scouts come back only when `types` is absent or includes `"scout"`. The server returns the whole
 * set at once (`doc/spec/discovery.md` §4). The request is anonymous and unsigned. Send geohash
 * cells rather than the player's position. The client's `discoverCells` builds this query.
 */
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;

/**
 * Validates a {@link Movement}, refusing unknown fields and any speed over
 * {@link MAX_SCOUT_SPEED_KMH}.
 *
 * The movement descriptor of `doc/spec/discovery.md` §5. Strict and finite because it rides inside
 * a signed report, like every other signed or relayed schema.
 *
 * Origin-private by construction: the movement holds only the last reported point and an optional
 * `destination`. A watcher can't work out where a scout launched from, since there is no origin and
 * no `progress` fraction.
 */
export const movementSchema = z
  .object({
    lastKnownLocation: latLngSchema,
    locationTimestamp: isoTimestampSchema,
    destination: latLngSchema.optional(),
    speedKmh: z.number().finite().nonnegative().max(MAX_SCOUT_SPEED_KMH),
  })
  .strict();
/**
 * How a scout moves: its last reported point and when, an optional destination, and its speed in
 * kilometers per hour.
 *
 * Clients work out a scout's current position from this locally, with `scoutPosition` in the client
 * SDK. `speedKmh` is a finite number from 0 to {@link MAX_SCOUT_SPEED_KMH}. The movement never
 * reveals where a scout started.
 */
export type Movement = z.infer<typeof movementSchema>;

/** The zod schema for a {@link RoomSummary}. */
export const roomSummarySchema = z.object({
  id: globalIdSchema, // live address — resolve/interact directly
  type: z.string(),
  location: latLngSchema,
  game: gameSlugSchema.optional(), // the room's game; absent only on a room that predates the slug
  mintedBy: mintedBySchema.optional(), // for client trust filtering
  live: z.string().optional(), // the live channel's origin; the Beacon server sets it on every room
  summary: z.record(z.string(), z.unknown()).optional(), // cheap display preview
});
/**
 * A room as discovery and the live map list it: its id, type, location, game and provenance, and a
 * short preview.
 *
 * - `id`: the room's global id. Fetch the whole room with the client's `resolveRoom`.
 * - `game`: the room's game. Absent only on a room placed before game slugs.
 * - `mintedBy`: the room's provenance, for display. The summary lacks the signed policy, so verify
 *   `mintedBy` after you fetch the whole room.
 * - `live`: the origin of the room's live channel. The Beacon server sets it on every room.
 * - `summary`: a small preview for a map marker, such as a count and a capacity.
 */
export type RoomSummary = z.infer<typeof roomSummarySchema>;

/** The zod schema for a {@link ScoutSummary}. */
export const scoutSummarySchema = z.object({
  id: z.string().min(1), // dedupe key (unique) across servers
  owner: z.object({ id: didKeySchema, handle: z.string().optional() }),
  config: scoutConfigSchema, // the game's baked type config, opaque here — verifiable via mintedBy
  mintedBy: mintedBySchema, // scout provenance over {unique, config} — a peer can verify offline
  name: displayNameSchema.optional(), // owner's custom display name (mutable) — surfaced to watching players
  game: gameSlugSchema.optional(), // the report envelope's signed game slug, when it had one
  movement: movementSchema,
  expiresAt: isoTimestampSchema, // report TTL
});
/**
 * A scout as discovery and the live map list it: its owner, config, provenance, movement and
 * expiry.
 *
 * - `id`: the scout's `unique`. The same scout can come from several servers, so drop duplicates by
 *   `id`.
 * - `config`: your game's scout config. The platform never reads it.
 * - `mintedBy`: the scout's provenance over `{ unique, config }`. Both are in the summary, so you
 *   can verify a scout from discovery alone with `verifyScoutProvenance`.
 * - `name`: the owner's display name for the scout.
 * - `game`: the game slug the report was signed with, when it had one.
 * - `expiresAt`: when the report lapses unless the owner reports again.
 */
export type ScoutSummary = z.infer<typeof scoutSummarySchema>;

/**
 * The zod schema for a {@link DiscoveryResponse}.
 *
 * The response of `doc/spec/discovery.md` §4.2.
 */
export const discoveryResponseSchema = z.object({
  coveredBy: z.string(), // who answered -> the custody/claim target for this area
  rooms: z.array(roomSummarySchema),
  scouts: z.array(scoutSummarySchema),
});
/**
 * The reply to `GET /discovery`: the rooms and scouts in the requested cells, and the host of the
 * server that answered.
 *
 * `coveredBy` names the server that holds the rooms in this area. The reply holds the whole set at
 * once.
 */
export type DiscoveryResponse = z.infer<typeof discoveryResponseSchema>;
/**
 * {@link DiscoveryResponse} as a client reads it: the checks of `discoveryResponseSchema`, with
 * unknown fields dropped instead of refused.
 */
export const discoveryResponseReadSchema = readVariant(discoveryResponseSchema);
