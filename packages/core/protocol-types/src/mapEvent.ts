import { z } from "zod";
import { roomSummarySchema, scoutSummarySchema } from "./discovery";
import { geohashCellSchema, globalIdSchema } from "./primitives";

/**
 * Validates a {@link MapDelta}.
 *
 * The delta of `doc/spec/discovery.md` §6.2. The map channel is a geohash-cell pub/sub with coarse
 * room and scout lifecycle. The per-room deltas (`RoomChange`) are separate, keyed by room id and
 * higher in volume.
 */
export const mapDeltaSchema = z.discriminatedUnion("kind", [
  z.object({ cell: geohashCellSchema, kind: z.literal("room"), room: roomSummarySchema }).strict(),
  z.object({ cell: geohashCellSchema, kind: z.literal("roomGone"), id: globalIdSchema }).strict(),
  z
    .object({ cell: geohashCellSchema, kind: z.literal("scout"), scout: scoutSummarySchema })
    .strict(),
  z
    .object({ cell: geohashCellSchema, kind: z.literal("scoutGone"), id: z.string().min(1) })
    .strict(),
]);
/**
 * A change on the live map channel: a room or scout in a watched cell appeared, changed or left.
 * `kind` says which:
 *
 * - `room`: replace the marker for `room`, a fresh `RoomSummary`. A placement, a count change
 *   and a phase change all arrive this way.
 * - `roomGone`: remove the room with id `id`.
 * - `scout`: replace the marker for `scout`, a fresh `ScoutSummary`.
 * - `scoutGone`: remove the scout with id `id`.
 *
 * Each delta names the geohash `cell` it happened in. Receive deltas with the client's
 * `subscribeMap` and apply them with `applyMapDelta`. The server sends no snapshot when a socket
 * subscribes, so read discovery for the starting set and again after a reconnect.
 */
export type MapDelta = z.infer<typeof mapDeltaSchema>;

/**
 * Validates a {@link CellsSubscribe}: up to 256 geohash cells.
 *
 * The server updates the socket's `cell:*` channel membership to match the set
 * (`doc/spec/discovery.md` §6.1).
 */
export const cellsSubscribeSchema = z
  .object({ cells: z.array(geohashCellSchema).max(256) })
  .strict();
/**
 * The `setCells` message a client sends on the live map channel: every geohash cell to watch, up
 * to 256.
 *
 * Each message replaces the previous set, so send the whole set every time. There is no separate
 * unsubscribe. The client's `subscribeMap` and `pushCells` send this message.
 */
export type CellsSubscribe = z.infer<typeof cellsSubscribeSchema>;
