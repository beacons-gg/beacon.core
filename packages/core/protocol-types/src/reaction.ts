import { z } from "zod";
import { didKeySchema, ulidSchema } from "./primitives";

/**
 * Reactions (beacon.server `doc/spec/room-operation.md` §9.6): a tiny, signed gesture one player in
 * a room leaves on something inside it. This file is the wire half: the record the engine appends
 * to `state.reactions` and broadcasts, and the two field schemas the `react` op's params share with
 * it.
 *
 * Like every other room contract this is generic: the engine never learns what a `kind` MEANS. A
 * kind is an opaque short string (a game's curated vocabulary lives in that game's package),
 * bounded only in length so a room's state can't be inflated one reaction at a time.
 */

/** The longest a reaction `kind` may be: 32 characters, enough for a vocabulary key. */
export const MAX_REACTION_KIND_LEN = 32;

/**
 * Validates a reaction `kind`: a key of 1 to {@link MAX_REACTION_KIND_LEN} characters from your
 * game's vocabulary, such as `like`. The server never reads what a kind means.
 */
export const reactionKindSchema = z.string().min(1).max(MAX_REACTION_KIND_LEN);

/**
 * The longest a reaction `target` may be: 128 characters.
 *
 * The bound is sized from what a target can be, in both directions: a DID is at most 73 characters
 * (`DID_KEY_RE`), and an item's `unique` is a ULID at 26, so 128 leaves generous headroom while
 * keeping the ledger's worst case honest (see `MAX_OP_LEDGER` in `@beaconsgg/policy-engine`, whose
 * size arithmetic is priced against this bound).
 *
 * The coupling to watch: `opaqueItemSchema.unique` is `z.string().min(1)` with no upper bound of
 * its own, so an item whose `unique` ran past this would be genuinely held by the room and yet
 * unreactable, and rejected `invalid` at the wire rather than the `gone` this file documents for a
 * target the room does not hold. Every item `unique` minted today is a ULID; if a game mints one
 * that can run past this, bound `unique` and derive this from it rather than raising this alone.
 */
export const MAX_REACTION_TARGET_LEN = 128;

/**
 * Validates a reaction `target`: 1 to {@link MAX_REACTION_TARGET_LEN} characters.
 *
 * A target is an item's `unique` or a player's DID. The item must be in the room's contents or a
 * reward pool, and the player must be a contributor the room records. The room must hold the
 * target, which the server checks when it applies the op. The engine tells the two kinds apart by
 * looking them up, with no tag.
 */
export const reactionTargetSchema = z.string().min(1).max(MAX_REACTION_TARGET_LEN);

/** The zod schema for a {@link Reaction}. */
export const reactionSchema = z.object({
  unique: ulidSchema,
  by: didKeySchema,
  at: z.number().int().nonnegative(),
  target: reactionTargetSchema,
  kind: reactionKindSchema,
});
/**
 * One reaction a room records in `state.reactions`: who left it, when, on what, and which kind.
 *
 * - `unique`: the nonce of the `react` op that left the reaction.
 * - `by`: the account that signed the op.
 * - `at`: the server's time, in seconds since the Unix epoch.
 * - `target` and `kind`: as in the `react` op's params (`ReactParams`).
 */
export type Reaction = z.infer<typeof reactionSchema>;
