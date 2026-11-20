import { z } from "zod";
import { didKeySchema, signatureSchema } from "./primitives";
import { readVariant } from "./read";

/**
 * Object provenance (`doc/spec/identity.md` §5.1): the `mintedBy` block an item, a room or a scout
 * carries, signed over its birth fields by `@beaconsgg/identity`'s `sign*Provenance`.
 */

/**
 * Validates a {@link MintedBy}, refusing unknown fields. A client reads with
 * {@link mintedByReadSchema} instead.
 */
export const mintedBySchema = z
  .object({
    id: didKeySchema, // the minter's key (a server domain key or a player key)
    handle: z.string().optional(), // display only
    sig: signatureSchema, // minter signature over the object's immutable birth fields
  })
  .strict();
/**
 * Who minted an item, a room or a scout: the minter's key, an optional display handle, and the
 * minter's signature over the object's birth fields.
 *
 * Make one with the `sign*Provenance` functions of `@beaconsgg/identity` and check one with the
 * matching `verify*Provenance` function. Use it to let players trust or block a minter
 * (`doc/spec/identity.md` §4.3 and §9).
 *
 * - `id`: the minter's `did:key`, a player's account or a server's key.
 * - `handle`: a name to show. The signature does not cover the handle.
 * - `sig`: the signature over the object's birth fields.
 */
export type MintedBy = z.infer<typeof mintedBySchema>;
/**
 * {@link MintedBy} as a client reads it: the checks of `mintedBySchema`, with unknown fields
 * dropped instead of refused. Use it for a `mintedBy` from a server or from a newer version's
 * storage.
 */
export const mintedByReadSchema = readVariant(mintedBySchema);
