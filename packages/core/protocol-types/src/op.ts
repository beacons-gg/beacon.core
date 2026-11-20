import { z } from "zod";
import { deviceAuthorizationSchema } from "./identity";
import {
  didKeySchema,
  displayNameSchema,
  gameSlugSchema,
  globalIdSchema,
  isoTimestampSchema,
  latLngSchema,
  signatureSchema,
  ulidSchema,
} from "./primitives";
import { mediaSchema } from "./mediaEntry";
import { mintedBySchema } from "./mintedBy";
import { policySchema } from "./room";
import { opaqueItemSchema } from "./item";
import { reactionKindSchema, reactionTargetSchema } from "./reaction";

/**
 * Validates an {@link OpEnvelope}, refusing unknown top-level fields.
 *
 * The envelope of beacon.server `doc/spec/room-operation.md` §3. Unknown keys are refused because
 * they would otherwise be signed silently.
 */
export const opEnvelopeSchema = z
  .object({
    op: z.string(), // op name (e.g. "add", "take", "contribute", "claim")
    // Named by a room op; omitted by `place`, the scout ops and the capability routes.
    room: globalIdSchema.optional(),
    actor: didKeySchema, // the account — attribution target
    device: didKeySchema, // the signing device key
    auth: deviceAuthorizationSchema, // root-signed authorization of `device` for `actor`
    // The application that produced this op (beacon.server `doc/spec/room-operation.md` §3): an
    // opaque, self-attested slug like `my-game`. It rides *inside* the signed envelope, so the
    // existing device signature covers it (tamper-evident) without any new key or extra crypto; see
    // `gameSlugSchema` for why tamper-evident is not the same as true.
    //
    // **Required on every game write, and still optional here.** A server refuses a game write
    // without one, but an operator console's envelope is no game's and carries none, so the
    // requirement is the route's, not the schema's.
    game: gameSlugSchema.optional(),
    nonce: ulidSchema, // idempotency + replay protection (§6.2)
    issuedAt: isoTimestampSchema,
    baseVersion: z.number().int().nonnegative().optional(), // optional optimistic concurrency
    // op-specific intent. Unconstrained here; validated per op-type downstream (e.g. `item` as an
    // opaqueItemSchema for `add`/`contribute`, placeParamsSchema for `place`). Signed numbers MUST be
    // safe integers — see jcs.ts on the canonicalization gap for large/fractional numbers.
    params: z.record(z.string(), z.unknown()),
    sig: signatureSchema,
  })
  .strict(); // reject unknown top-level keys — they would otherwise be signed silently
/**
 * A signed op: the request body your game sends to apply an op to a room or to call a signed route.
 *
 * Build one with `signOpWithWallet` from `@beaconsgg/identity`, or let the client's methods sign
 * for you. The op is attributed to the account (`actor`) and signed by one of its authorized
 * devices (`device`, with its authorization in `auth`).
 *
 * - `op`: the op name, such as `"take"` or `"place"`.
 * - `room`: the target room's id. Absent on `place`, the scout ops and the capability routes.
 * - `game`: your game's slug. A server refuses a game write without one.
 * - `nonce`: a fresh ULID per op. Retry a lost request with the same nonce and the server replays
 *   the first result instead of applying the op twice.
 * - `issuedAt`: when the op was signed. Every signed op, room ops included, is refused as
 *   `clockSkew` when `issuedAt` is more than five minutes from the server's clock (the Beacon
 *   server's default). The check runs before the replay check, so resending the same envelope
 *   replays the first result only within that window.
 * - `baseVersion`: the room version you acted on. When set and no longer current, the op fails
 *   with `stale`.
 * - `params`: the op's own fields. Numbers must be safe integers.
 * - `sig`: the device's Ed25519 signature over the canonical JSON of the envelope without `sig`.
 */
export type OpEnvelope = z.infer<typeof opEnvelopeSchema>;

/** Validates an {@link UnsignedOpEnvelope}. */
export const unsignedOpEnvelopeSchema = opEnvelopeSchema.omit({ sig: true });
/** An op envelope without its `sig`: the exact value that is canonicalized and signed. */
export type UnsignedOpEnvelope = z.infer<typeof unsignedOpEnvelopeSchema>;

/**
 * Validates {@link PlaceParams}, refusing by name any param this version does not know.
 *
 * The `place` params of beacon.server `doc/spec/room-operation.md` §9.1. Strict, like every other
 * request shape: a param this build does not know is refused by name
 * rather than dropped. Dropping is worse than it sounds for a placement, because the params that
 * grow are the ones that SEED a room (`initialRewards`, `initialPools`), so a silent drop places a
 * room without what the player was promised. Additions ride a capability marker.
 */
export const placeParamsSchema = z
  .object({
    type: z.string(),
    unique: ulidSchema,
    mintedBy: mintedBySchema,
    location: latLngSchema,
    policy: policySchema,
    name: displayNameSchema.optional(), // the room's custom display name → becomes the placed room's `name`
    // Seeds the room's contents: opaque signed items (beacon.server `doc/spec/room-operation.md`
    // §9.1), verified generically; the server never reads a game's item shape.
    initialContents: z.array(opaqueItemSchema).optional(),
    // The room's content-addressed preview media header → becomes the placed room's `media`.
    media: z.array(mediaSchema).optional(),
    // A pre-minted reward pool the room hands out via `policy.grant` (seeds the first grant rule's
    // `from` pool).
    // Opaque signed items: the server provenance-verifies each but never interprets them
    // (beacon.server `doc/spec/room-operation.md` §9.6).
    initialRewards: z.array(opaqueItemSchema).optional(),
    // Named reward pools for a multi-rule `grant` (each rule draws `from` its own pool). Only keys some
    // grant rule names are seeded (reserved state keys rejected); every item passes the same signed-
    // provenance gate as `initialRewards`. Additive beside it — single-pool placements stay unchanged.
    initialPools: z.record(z.string(), z.array(opaqueItemSchema)).optional(),
  })
  .strict();
/**
 * The params of a `place` op: the new room's type, id, provenance, location, policy and starting
 * contents. Send the params with the client's `placeRoom`.
 *
 * - `type`: your game's room type, which becomes the room's `type`.
 * - `unique`: a ULID your game mints for the room. The placed room's id is `<unique>@<host>`.
 * - `mintedBy`: the room's signed provenance over `{ unique, kind, policy }`, where `kind` is
 *   `type`. Make it with `signRoomProvenance` from `@beaconsgg/identity`.
 * - `location` and `policy`: where the room is and the rules it runs (see {@link Policy}).
 * - `name` and `media`: the room's display name and preview media.
 * - `initialContents`: signed items the room starts with.
 * - `initialRewards`: the reward pool the first `policy.grant` rule hands out, seeded under that
 *   rule's `from` key.
 * - `initialPools`: named reward pools for several grant rules. Each key must be a pool some grant
 *   rule draws `from`, and a reserved state key is refused.
 *
 * The server checks the provenance of every item and never reads your game's item fields.
 */
export type PlaceParams = z.infer<typeof placeParamsSchema>;

/**
 * Validates {@link ReactParams}: both fields within their length limits.
 *
 * The `react` params of beacon.server `doc/spec/room-operation.md` §9.6. Whether `target` resolves
 * to something the room holds is a question about state, so the schema checks only the bounds.
 */
export const reactParamsSchema = z
  .object({
    target: reactionTargetSchema,
    kind: reactionKindSchema,
  })
  .strict();
/**
 * The params of a `react` op: the `target` in the room and the reaction `kind`. The target is an
 * item's `unique` or a contributor's DID, and the room must hold it (see `Reaction`).
 */
export type ReactParams = z.infer<typeof reactParamsSchema>;
