import { z } from "zod";
import { didKeySchema, globalIdSchema, signatureSchema } from "./primitives";

/**
 * The codes every peer understands: the protocol as it stood when capability markers started.
 * **Frozen.** A new code goes in {@link ERROR_CODES} after these, and the type of
 * {@link CODE_FALLBACKS} then refuses to compile until it names the baseline code an older client
 * gets instead.
 */
const BASELINE_ERROR_CODES = [
  "badsig", // signature invalid
  "invalid", // malformed envelope / failed schema validation
  "unknownRoom", // room gone / never existed
  "expired", // room closed (at-risk)
  "denied", // role not permitted
  "gameNotAdmitted", // this server does not admit the game that produced the op, or the op named no game
  "phase", // op not allowed in current phase
  "full", // capacity reached
  "gone", // targeted item already taken
  "empty", // nothing to take
  "locked", // time window not open
  "rateLimited", // spawn-pool self-protection; the per-actor budget on a room op
  "stale", // baseVersion no longer current
] as const;

/**
 * The 404 for a route that doesn't exist or is turned off. Every Beacon server has answered it and
 * every client has read it since before capability markers, so it counts as baseline. It is listed
 * after the newer codes only because {@link ERROR_CODES} grows at its end.
 */
const UNKNOWN_ROUTE = "unknownRoute";
type BaselineErrorCode = (typeof BASELINE_ERROR_CODES)[number] | typeof UNKNOWN_ROUTE;

/**
 * The 404 codes that name what is missing, on a route that exists and is turned on. Each falls back
 * to `unknownRoute` at 404 ({@link NOT_FOUND_FALLBACKS}).
 */
const NOT_FOUND_CODES = [
  "unknownPlace", // no such place (also a 400 code of `places.propose`)
  "unknownMedia", // no such media object (also a 400 code of `places.propose`)
  "unknownProposal", // no such place proposal
  "unknownRun", // no such import run
  "noAbout", // the server has no about text
] as const;
type NotFoundCode = (typeof NOT_FOUND_CODES)[number];

/**
 * Every error code a refused op can carry in `error`, and the 404 codes of the routes.
 * {@link ErrorCode} says what each one means.
 *
 * The first 13 codes and `unknownRoute` are the baseline every client understands. A server sends a
 * later code only to a client that declares it, and the older code `CODE_FALLBACKS` names to any
 * other client. The 404 codes that name what is missing fall back to `unknownRoute`, at 404 only
 * (`NOT_FOUND_FALLBACKS`). Both lists are in `@beaconsgg/protocol-types/server`.
 *
 * `gameNotAdmitted` and `denied` are both a 403 and call for different responses. After `denied`,
 * retry nothing on that server as that player. After `gameNotAdmitted`, stop offering that server
 * for writes and tell the player why: the player is welcome there and your game is not. After
 * `notMember`, stop offering that server for writes until the player becomes a member.
 *
 * A rejection reports an outcome. Rejections keep honest concurrent state consistent
 * (beacon.server `doc/spec/room-operation.md` §11).
 */
export const ERROR_CODES = [
  ...BASELINE_ERROR_CODES,
  // After the baseline, so each needs a CODE_FALLBACKS entry below (the compiler checks).
  "deviceRevoked", // the signing device was revoked by its account; a block still answers `denied`
  "clockSkew", // `issuedAt` is outside the replay window: the device clock, not the request
  "gameNotAccepted", // this room does not open this op to the caller's game (room `game` + `ops.games`)
  "notMember", // the server takes writes from members only (`accessLevel` request | private)
  UNKNOWN_ROUTE,
  ...NOT_FOUND_CODES,
] as const;

/** Validates an {@link ErrorCode}: one of {@link ERROR_CODES}. */
export const errorCodeSchema = z.enum(ERROR_CODES);
/**
 * Why a server refused an op, as an {@link ErrorResult}'s `error` carries it.
 *
 * - `badsig`: the signature does not verify.
 * - `invalid`: the envelope or params are malformed.
 * - `unknownRoom`: the room is gone or never existed.
 * - `expired`: the room has closed.
 * - `denied`: the player's role does not allow the op, the account is blocked, the policy has no
 *   such op, the server does not handle the op, or the room's `accept` rule refuses the item.
 * - `gameNotAdmitted`: this server does not admit your game, or the op named no game.
 * - `phase`: the op is not allowed in the room's current phase.
 * - `full`: the room has reached its item capacity or `maxContributors`, or a reaction ledger is at
 *   its limit, or the player already left another reaction on the same target.
 * - `gone`: the item was already taken, the player already claimed, or the `react` target is not in
 *   the room.
 * - `empty`: there is nothing to take.
 * - `locked`: the time window is not open. The Beacon server answers `phase` for this case instead.
 * - `rateLimited`: the request went over a rate limit, such as a player's budget for a room op.
 * - `stale`: the envelope's `baseVersion` is no longer the room's version.
 * - `deviceRevoked`: the account revoked the signing device.
 * - `clockSkew`: `issuedAt` is too far from the server's clock.
 * - `gameNotAccepted`: this room does not open the op to your game.
 * - `notMember`: the server's `accessLevel` is `request` or `private` and the player is not a
 *   member. On a `request` server the player may ask to join (`access.request`).
 * - `unknownRoute`: a 404 for a route that doesn't exist or is turned off, such as a capability the
 *   server doesn't run.
 * - `unknownPlace`, `unknownMedia`, `unknownProposal`, `unknownRun`: a 404 for a place, a media
 *   object, a place proposal or an import run that doesn't exist. `unknownPlace` and `unknownMedia`
 *   are also the 400 of a proposal that names a missing place or file.
 * - `noAbout`: a 404 for a server that has no about text.
 *
 * Declare `code:<name>` (see `UNDERSTANDS_HEADER`) to receive the five 404 codes. Without it a
 * server answers `unknownRoute` at the same 404.
 */
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * The older code a server sends in place of each newer error code, to a client that has not
 * declared the newer one.
 *
 * A client declares `code:<name>` to receive a newer code (see `UNDERSTANDS_HEADER`). Any other
 * client gets the fallback at the same HTTP status, so a client that predates the code keeps
 * working as before.
 *
 * Exactly the codes after the baseline, each to a baseline code, so one lookup is always enough and
 * a new code without a fallback does not compile. The 404 codes that name a missing thing are in
 * `NOT_FOUND_FALLBACKS` instead, since they fall back only at 404.
 */
export const CODE_FALLBACKS = {
  deviceRevoked: "denied",
  clockSkew: "invalid",
  gameNotAccepted: "denied", // not `gameNotAdmitted`: one room refuses, not the whole server
  notMember: "denied",
} as const satisfies Record<
  Exclude<ErrorCode, BaselineErrorCode | NotFoundCode>,
  BaselineErrorCode
>;

/**
 * The code a server sends at 404 in place of each code that names a missing thing, to a client that
 * has not declared it: `unknownRoute`, which every such 404 carried before.
 *
 * A client declares `code:<name>` to receive the code itself. The fallback applies at 404 only:
 * `unknownPlace` and `unknownMedia` are also 400 codes a proposal has always answered, and those
 * reach every client unchanged. `codeFor` applies this list when it is given the status.
 */
export const NOT_FOUND_FALLBACKS = {
  unknownPlace: UNKNOWN_ROUTE,
  unknownMedia: UNKNOWN_ROUTE,
  unknownProposal: UNKNOWN_ROUTE,
  unknownRun: UNKNOWN_ROUTE,
  noAbout: UNKNOWN_ROUTE,
} as const satisfies Record<NotFoundCode, BaselineErrorCode>;

/**
 * Validates a {@link GrantReceipt}.
 *
 * The receipt of beacon.server `doc/spec/room-operation.md` §7, kept as the natural mechanism for
 * cross-room handoff trust.
 */
export const grantReceiptSchema = z
  .object({
    by: didKeySchema, // server identity
    room: globalIdSchema,
    item: z.string(), // the item's `unique`
    newOwner: didKeySchema,
    version: z.number().int().nonnegative(),
    sig: signatureSchema,
  })
  .strict();
/**
 * A server-signed proof that a player took an item from a room. Reserved: the protocol defines the
 * receipt but no server issues one yet, so don't depend on receiving one.
 */
export type GrantReceipt = z.infer<typeof grantReceiptSchema>;

/** Validates an {@link OkResult}. */
export const okResultSchema = z.object({
  ok: z.literal(true),
  version: z.number().int().nonnegative(),
  result: z.unknown().optional(), // op-specific payload (e.g. the taken item)
  receipt: grantReceiptSchema.optional(),
});
/**
 * The result of an op the server applied: `ok: true`, the room's new `version`, and the op's own
 * `result` when it has one (such as the item a `take` returns).
 */
export type OkResult = z.infer<typeof okResultSchema>;

/** Validates an {@link ErrorResult}. */
export const errorResultSchema = z.object({
  ok: z.literal(false),
  error: errorCodeSchema,
  message: z.string().optional(),
  // Set on an `invalid` whose only problem is fields this server has never heard of, each with its
  // path (`item.state2`): the sender is newer than the server. See {@link unknownFields}.
  fields: z.array(z.string()).optional(),
});
/**
 * The result of an op the server refused: `ok: false` and the {@link ErrorCode} in `error`, with an
 * optional `message` for people.
 *
 * `fields` is set on an `invalid` whose only problem is fields this server has never heard of, each
 * as a dotted path such as `item.state2`. That means your app is newer than the server.
 */
export type ErrorResult = z.infer<typeof errorResultSchema>;

/**
 * List the fields a zod parse refused only because they are unknown, as dotted paths such as
 * `policy.ops.take.burst`.
 *
 * A request that fails on nothing else is a client NEWER than this server, which wants the opposite
 * response from a malformed one: upgrade the server, versus fix the client. Mixed with any other
 * problem it reads as empty, because "this server is behind" would then be half the story, and the
 * half the caller cannot act on. Every shape a server accepts is strict for this reason.
 *
 * Keys only. A new VALUE on a closed set (`role: "friends"`) is indistinguishable here from a
 * client bug, so it answers as malformed; that is why a new value has to ship behind a marker.
 *
 * `prefix` places the paths inside a larger request, as a handler that parses one param does.
 *
 * @param error - The error from a failed parse of a strict schema.
 * @param prefix - A path to put in front of each field, when the parsed value sits inside a larger
 *   request.
 * @returns The unknown fields, or `[]` when the parse failed for any other reason too.
 */
export function unknownFields(
  error: z.ZodError,
  prefix: readonly (string | number)[] = [],
): string[] {
  const unrecognized = error.issues.filter((issue) => issue.code === "unrecognized_keys");
  if (unrecognized.length !== error.issues.length) return [];
  return unrecognized.flatMap((issue) =>
    issue.keys.map((key) => [...prefix, ...issue.path, key].join(".")),
  );
}

/**
 * Build the `invalid` result a server answers params with when they fail to parse.
 *
 * When the only problem is unknown fields, the result names them in `fields` and in the `message`.
 * Otherwise the result carries `message`, which defaults to zod's own. A client can then tell an
 * outdated server from a malformed request without reading prose.
 *
 * @param error - The error from the failed parse.
 * @param prefix - As for {@link unknownFields}.
 * @param message - The message to send when the problem is not unknown fields.
 */
export function paramsRefusal(
  error: z.ZodError,
  prefix: readonly (string | number)[] = [],
  message?: string,
): { ok: false; error: "invalid"; message: string; fields?: string[] } {
  const fields = unknownFields(error, prefix);
  if (fields.length === 0)
    return { ok: false, error: "invalid", message: message ?? error.message };
  const named = `this server does not understand: ${fields.join(", ")}. It may predate the app that sent them.`;
  return { ok: false, error: "invalid", message: named, fields };
}

/**
 * Validates an {@link OpResult}.
 *
 * The result of beacon.server `doc/spec/room-operation.md` §5, step 10.
 */
export const opResultSchema = z.discriminatedUnion("ok", [okResultSchema, errorResultSchema]);
/**
 * The result of a room op: an {@link OkResult} when `ok` is `true` and an {@link ErrorResult} when
 * `ok` is `false`. A refusal arrives as a result to read.
 */
export type OpResult = z.infer<typeof opResultSchema>;
