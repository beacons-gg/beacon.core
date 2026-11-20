import { z } from "zod";
import { readAsOnRead, readVariant } from "./read";
import { serverDescriptorSchema } from "./discovery";

// Server membership: who may write to a server whose `accessLevel` is `request` or `private`.
// Reads never need membership. Both player ops are signed `OpEnvelope`s open to any account. The
// admin ops that manage the member list are in `admin.ts`.

/**
 * The marker a server lists in its descriptor's `capabilities` when it enforces its `accessLevel`
 * and takes the `access.*` ops: `access:members`.
 *
 * A server without it advertises its level for display only, and accepts writes from anyone. Ask
 * {@link enforcesAccess} rather than reading the list.
 */
export const ACCESS_MARKER = "access:members";

/**
 * Whether a server enforces its access level, from its descriptor's `capabilities`.
 *
 * When this is `false`, a `request` or `private` level is for display only: the server takes
 * writes from anyone and has no `access.*` routes.
 */
export function enforcesAccess(capabilities: readonly string[] | undefined): boolean {
  return (capabilities ?? []).includes(ACCESS_MARKER);
}

/** Validates an {@link AccessStatus}. */
export const accessStatusSchema = z.enum(["member", "pending", "declined", "none"]);
/**
 * Where a player stands on one server.
 *
 * - `member`: the player may write. Every player is a member of an `open` server, and an admin is
 *   a member of every server.
 * - `pending`: the player asked to join and no admin has answered yet.
 * - `declined`: an admin declined the request. The player cannot ask again until an admin approves
 *   them or removes the entry.
 * - `none`: the player has not asked.
 */
export type AccessStatus = z.infer<typeof accessStatusSchema>;

/** An unknown status reads as `none`. */
const accessStatusOnRead = readAsOnRead(accessStatusSchema, "none");
/** The descriptor's own level node, so the two read an unknown level the same way. */
const accessLevelOnRead = serverDescriptorSchema.shape.accessLevel;

/** Validates a player's note to the operator in an `access.request`: 1 to 280 characters. */
export const accessNoteSchema = z.string().min(1).max(280);

/** Validates {@link AccessRequestParams}: `note` is 1 to 280 characters. */
export const accessRequestParamsSchema = z.object({ note: accessNoteSchema.optional() }).strict();
/**
 * The params of an `access.request` op (`POST /access/request`): an optional note to the server's
 * operator, such as who the player is.
 *
 * Only a server at the `request` level takes a request; a `private` server refuses it with
 * `denied`. Asking again while the request is pending replaces the note. Publish the player's
 * profile to the server first, so the operator can see who is asking.
 *
 * The reply is an {@link AccessResult}.
 */
export type AccessRequestParams = z.infer<typeof accessRequestParamsSchema>;

/** Validates {@link AccessStatusParams}: an empty object. */
export const accessStatusParamsSchema = z.object({}).strict();
/** The params of an `access.status` op (`POST /access/status`): always empty. */
export type AccessStatusParams = z.infer<typeof accessStatusParamsSchema>;

/** Validates an {@link AccessResult}, refusing unknown fields. */
export const accessResultSchema = z
  .object({
    ok: z.literal(true),
    accessLevel: accessLevelOnRead,
    status: accessStatusOnRead,
  })
  .strict();
/**
 * The reply to `access.request` and `access.status`: the server's current access level and where
 * the signing player stands.
 *
 * `status` is `member` on an `open` server, whatever was recorded before the server opened. On
 * read an unknown level becomes `private` and an unknown status becomes `none`, so a player never
 * shows as admitted on a value this build cannot read.
 */
export type AccessResult = z.infer<typeof accessResultSchema>;
/** {@link AccessResult} as a client reads it, with unknown fields dropped. */
export const accessResultReadSchema = readVariant(accessResultSchema);
