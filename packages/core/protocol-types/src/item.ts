import { z } from "zod";
import { didKeySchema, levelsSchema, tagsSchema } from "./primitives";
import { mintedBySchema } from "./mintedBy";

/**
 * Validates {@link MatchAttributes}, refusing unknown fields.
 *
 * The projection mirrors `AcceptCandidate` in `@beaconsgg/jsonlogic-profile`. The server matches
 * these declared keys without knowing what they mean to the game, so it never reads the opaque
 * `birth` or `state`.
 */
export const matchAttributesSchema = z
  .object({
    class: z.string().optional(),
    tags: tagsSchema.optional(),
    levels: levelsSchema.optional(),
  })
  .strict();
/**
 * The attributes a room's `accept` rule matches an item on: the `class`, `tags` and `levels` your
 * game declares for the item.
 *
 * The attributes are self-attested and unsigned. A room's `accept` rule keeps honest state
 * consistent, and a dishonest client can still claim any attributes (radical trust,
 * `doc/spec/identity.md` §3).
 */
export type MatchAttributes = z.infer<typeof matchAttributesSchema>;

/**
 * Validates an {@link OpaqueItem}, refusing unknown top-level fields and a `birth` that holds
 * `unique` or `minter`.
 *
 * The server carries an item as an opaque, provenance-verified payload it never interprets
 * (beacon.server `doc/known-couplings.md`). `mintedBy` is optional at the schema layer, as on a
 * game's own model. A gate that requires provenance refuses an item without one through the generic
 * check (`verifyItemProvenance`).
 */
// Strict, so a new TOP-LEVEL item field is refused by name rather than stripped. A game's own
// fields ride in `birth`, the passthrough record item provenance signs as `{unique, ...birth,
// minter}`.
export const opaqueItemSchema = z
  .object({
    unique: z.string().min(1), // engine-managed identity / dedupe
    // opaque, SIGNED — the game's immutable core. Rejects the reserved keys `unique` / `minter`: they'd
    // collide with the signed envelope `{ unique, ...birth, minter }`, and a `birth.unique` could otherwise
    // shadow the real top-level `unique` and let a valid signature be replayed under a forged identity.
    birth: z.record(z.string(), z.unknown()).refine((b) => !("unique" in b) && !("minter" in b), {
      message: "birth must not carry the reserved keys `unique` or `minter`",
    }),
    mintedBy: mintedBySchema.optional(), // sig over JCS({ unique, ...birth, minter })
    state: z.record(z.string(), z.unknown()).optional(), // opaque, mutable, trusted (radical trust)
    owner: didKeySchema.nullable().optional(), // engine-managed custody
    match: matchAttributesSchema.optional(), // generic projection for server-side accept
  })
  .strict();
/**
 * A game-defined item in a room, such as an item in its `contents` or in a reward pool. The server
 * carries the item without reading your game's fields.
 *
 * - `unique`: the item's id. A room holds an item once.
 * - `birth`: your game's fields that never change. They are signed, and must not include `unique`
 *   or `minter`.
 * - `mintedBy`: the signature over `{ unique, ...birth, minter }`. Make it with
 *   `signItemProvenance` from `@beaconsgg/identity`.
 * - `state`: your game's fields that change. They are not signed.
 * - `owner`: the account holding the item, set by the server.
 * - `match`: the attributes a room's `accept` rule reads (see {@link MatchAttributes}).
 *
 * Define your item model in your own game and parse `birth` and `state` there.
 */
export type OpaqueItem = z.infer<typeof opaqueItemSchema>;
