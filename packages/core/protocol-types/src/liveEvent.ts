import { z } from "zod";
import { didKeySchema, globalIdSchema, levelsSchema } from "./primitives";
import { opaqueItemSchema } from "./item";
import { reactionSchema } from "./reaction";

/**
 * The zod schema for a {@link RoomChange}.
 *
 * The delta of beacon.server `doc/spec/room-operation.md` §10. The channel carries events from the
 * server only, and every op goes over REST.
 */
export const roomChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("itemAdded"), item: opaqueItemSchema, by: didKeySchema }),
  // item = `unique`; left custody entirely (e.g. a `take`)
  z.object({ type: z.literal("itemRemoved"), item: z.string(), by: didKeySchema }),
  // `by` took custody of the item, but it STAYS in the frozen `contents` (the server keeps it so a
  // derived aggregate over `contents` stays stable for the remaining claimants, and the TTL tick
  // can drop unclaimed ones). Distinct from `itemRemoved` precisely because nothing leaves. (e.g. a
  // `claim`.)
  z.object({ type: z.literal("itemClaimed"), item: z.string(), by: didKeySchema }), // item = `unique`
  // `by` was granted this pool item (custody transfer on a lifecycle op — e.g. a `claim` or
  // `collect` handing out a pre-minted reward). `item` = `unique`; it STAYS in `state.rewards`
  // marked owned (like itemClaimed), so a watcher marks that reward taken while the recipient gets
  // the full item over REST.
  z.object({ type: z.literal("itemGranted"), item: z.string(), by: didKeySchema }), // item = `unique`
  z.object({ type: z.literal("phaseChanged"), phase: z.string() }),
  z.object({ type: z.literal("derivedUpdated"), derived: levelsSchema }),
  // `by` left a reaction on something in the room (beacon.server `doc/spec/room-operation.md`
  // §9.6). The whole record rides along, so a watcher renders it without re-reading the room.
  z.object({ type: z.literal("reactionAdded"), reaction: reactionSchema }),
  z.object({ type: z.literal("closed") }), // tombstone
]);
/**
 * One change to a room, as the room's live channel reports it. `type` says which change:
 *
 * - `itemAdded`: `by` added `item` to the room.
 * - `itemRemoved`: the item with `unique` `item` left the room, as after a `take`.
 * - `itemClaimed`: `by` took custody of the item, as after a `claim`. The item stays in the room's
 *   `contents`.
 * - `itemGranted`: `by` received the reward pool item `item`. The item stays in its pool marked as
 *   owned, and the recipient reads the whole item over REST.
 * - `phaseChanged`: the room entered `phase`.
 * - `derivedUpdated`: the room's derived values are now `derived`.
 * - `reactionAdded`: a player left `reaction`.
 * - `closed`: the room has closed.
 */
export type RoomChange = z.infer<typeof roomChangeSchema>;

/** The zod schema for a {@link LiveEvent}. */
export const liveEventSchema = z.object({
  room: globalIdSchema,
  version: z.number().int().nonnegative(),
  change: roomChangeSchema,
});
/**
 * A `delta` event on a room's live channel: the room's id, its `version` after the change, and the
 * change.
 *
 * Receive these with the client's `subscribeRoom`. Apply them in `version` order. When a version is
 * missing, re-read the room with `resolveRoom`.
 */
export type LiveEvent = z.infer<typeof liveEventSchema>;
