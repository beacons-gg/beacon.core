import { z } from "zod";
import {
  didKeySchema,
  displayNameSchema,
  gameSlugSchema,
  globalIdSchema,
  latLngSchema,
  levelsSchema,
  tagsSchema,
} from "./primitives";
import { mediaSchema } from "./mediaEntry";
import { mintedBySchema } from "./mintedBy";
import { absentOnRead, conformsTo, readVariant } from "./read";

/**
 * The zod schema for a {@link JsonLogicRule}: any JSON value. A rule's shape is checked where the
 * rule is used.
 *
 * The operator whitelist, the 4 aggregators and the integer guard are enforced by
 * `@beaconsgg/jsonlogic-profile` at evaluation time (`doc/spec/item-properties.md` §4 and
 * beacon.server `doc/spec/room-operation.md` §8.3).
 */
export const jsonLogicSchema: z.ZodType<unknown> = z.unknown();
/**
 * A JSONLogic rule as a policy carries it, such as a `derived` formula or a grant's `when`. The
 * wire treats a rule as opaque data, so the type is `unknown`. A server refuses a placement whose
 * rules use an operator outside the allowed set (see `unsupportedPolicyFeatures`).
 */
export type JsonLogicRule = unknown;

/**
 * How far past placement a room's phase transition may be scheduled, in seconds: 10 years of 365
 * days. The same limit caps a policy duration such as `claimTtl`.
 *
 * A placement or op that would schedule a later transition is refused as `invalid`, instead of
 * being read as "the phase never comes". A stored room left waiting on a transition past the limit,
 * with no op that could move it, closes.
 */
export const TRANSITION_HORIZON_SEC = 10 * 365 * 86_400;

const DURATION_RE = /^(\d+)([smhd])$/;
const UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

/**
 * Read a policy duration such as `"30m"` in seconds.
 *
 * A duration is a whole number followed by one unit: `s`, `m`, `h` or `d` (`"45s"`, `"30m"`,
 * `"12h"`, `"7d"`). Nothing may surround it. The value must be above zero and at most
 * {@link TRANSITION_HORIZON_SEC} seconds.
 *
 * A signed policy has one spelling for each duration, so no spaces or mixed units are read. Zero
 * would mean no window at all, and a window past the horizon is one no room outlives.
 *
 * @param value - The duration string, as a policy's `claimTtl` holds it.
 * @returns The duration in seconds, or `undefined` when `value` is not a valid duration.
 */
export function parseDuration(value: string): number | undefined {
  const match = DURATION_RE.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
  return seconds > 0 && seconds <= TRANSITION_HORIZON_SEC ? seconds : undefined;
}

/**
 * Validates a policy duration string: one that {@link parseDuration} reads, such as `"30m"` or
 * `"7d"`. Anything else is refused, so a placement fails as `invalid` instead of running with no
 * window.
 */
export const durationSchema = z.string().refine((value) => parseDuration(value) !== undefined, {
  message: `a duration is a whole number above zero and s, m, h or d, at most ${TRANSITION_HORIZON_SEC / 86_400}d`,
});

/**
 * The zod schema for a {@link Role}.
 *
 * Roles are resolved by signature, with the actor being the signing account (beacon.server
 * `doc/spec/room-operation.md` §8.2).
 */
export const roleSchema = z.union([
  z.literal("public"),
  z.literal("owner"),
  z.literal("contributor"),
  z.array(didKeySchema), // explicit key list
]);
/**
 * Who may apply an op to a room: `"public"` for any player, `"owner"` for the player who placed the
 * room, `"contributor"` for a player the room has recorded as a contributor, or a list of account
 * DIDs. The server compares the role with the account that signed the op (`actor`).
 */
export type Role = z.infer<typeof roleSchema>;

/**
 * The `games` entry that opens an op to every game, written `"*"`. When present, the entry must be
 * the only one in the list.
 *
 * The character is outside the slug charset, so the entry cannot collide with a real slug.
 */
export const ANY_GAME = "*";
/** The most games one op rule's `games` list may name: 32. */
export const MAX_RULE_GAMES = 32;

/**
 * The other games an op is open to (beacon.server `doc/spec/room-operation.md` §8.2): slugs, or
 * `[ANY_GAME]` for every game. A room's own game never needs listing, and an absent list means the
 * owning game only.
 *
 * One string schema rather than a union with a `"*"` literal, on purpose: `policyFeatures` turns a
 * literal into a feature of its own, and `ops.games.*` is not a marker any peer could parse.
 */
const ruleGamesSchema = z
  .array(
    z.string().refine((g) => g === ANY_GAME || conformsTo(gameSlugSchema, g), {
      message: `expected a lowercase game slug or "${ANY_GAME}"`,
    }),
  )
  .min(1)
  .max(MAX_RULE_GAMES)
  .refine((games) => new Set(games).size === games.length, { message: "a game is listed twice" })
  .refine((games) => !games.includes(ANY_GAME) || games.length === 1, {
    message: `"${ANY_GAME}" stands alone`,
  });

/** Validates an {@link OpRule}, refusing unknown fields and a malformed `games` list. */
export const opRuleSchema = z
  .object({
    role: roleSchema,
    phase: z.string().optional(), // required lifecycle phase, if any
    // Which other games may use this op. Who may act is `role`, when is `phase`, and which
    // application is this; the engine checks all three at the same step.
    games: ruleGamesSchema.optional(),
    // How many entries this op's own state ledger may hold, for the append-only ops that keep one
    // (today: `react` and `state.reactions`). Volume only — who may, and when, is `role`/`phase`
    // above. Absent = the engine's ceiling, which also caps whatever a policy asks for; the place
    // boundary refuses a bound above that ceiling, and refuses one on an op that keeps no ledger.
    // Positive, not just non-negative: `0` would place a room whose every react is refused `full`
    // ("this room has taken all the reactions it holds", which is not what happened). "No reactions
    // here" is already spelled by omitting `ops.react`, and that answers `denied` accurately.
    max: z.number().int().positive().optional(),
  })
  .strict();
/**
 * The rule for one op in a policy's `ops`: who may apply the op, in which phase, from which other
 * games, and how many entries its ledger may hold.
 *
 * - `role`: who may apply the op (see {@link Role}).
 * - `phase`: the lifecycle phase the room must be in, when set.
 * - `games`: the other games that may apply the op. Up to {@link MAX_RULE_GAMES} distinct slugs, or
 *   `[ANY_GAME]` for every game. The room's own game never needs listing. Absent means the room's
 *   own game only.
 * - `max`: for an op that keeps a ledger in room state, such as `react`, the most entries the
 *   ledger may hold. A positive integer. Absent means the server's own ceiling. A server refuses a
 *   `max` above its ceiling and a `max` on an op that keeps no ledger.
 */
export type OpRule = z.infer<typeof opRuleSchema>;

/**
 * The zod schema for an {@link AcceptPredicate}.
 *
 * The categorical admission predicate of `doc/spec/item-properties.md` §6: a shorthand the engine
 * compiles to JSONLogic boolean ops.
 */
export const acceptPredicateSchema = z
  .object({
    class: z.array(z.string()).optional(), // OR across listed classes; omit = any
    tags: tagsSchema.optional(), // OR logic across keys
    minLevels: levelsSchema.optional(), // AND logic across keys
    capacity: z.number().int().nonnegative().optional(),
  })
  .strict();
/**
 * Which items a room admits, matched against each item's `match` attributes, plus how many items
 * the room holds.
 *
 * - `class`: the item's class must be one of these. Absent admits any class.
 * - `tags`: the item must share a value with at least one listed key. A key mapped to `[]` matches
 *   any item that has that key.
 * - `minLevels`: the item must reach every one of these levels.
 * - `capacity`: the most items the room holds.
 */
export type AcceptPredicate = z.infer<typeof acceptPredicateSchema>;

/** The zod schema for a {@link Lifecycle}. */
export const lifecycleSchema = z
  .object({
    phases: z.array(z.string()),
    transitions: z.record(z.string(), z.string()), // phase -> derived-key that fires the entry
  })
  .strict();
/**
 * A room's phases: the ordered `phases` list and the `transitions` that enter them. `transitions`
 * maps a phase name to the name of the `derived` value that fires the entry into that phase.
 */
export type Lifecycle = z.infer<typeof lifecycleSchema>;

/**
 * The zod schema for an {@link UnlockRule}.
 *
 * The rule is the client-applied item transform of `doc/spec/item-properties.md` §5.2. The
 * condition stays separate from the formula on purpose: a predicate coerces cleanly to a boolean,
 * and the arithmetic profile cannot take a boolean operand.
 */
export const unlockRuleSchema = z
  .object({
    when: jsonLogicSchema.optional(),
    set: z.record(z.string(), jsonLogicSchema),
  })
  .strict();
/**
 * One rule of a policy's `unlockTransform`, which your game applies to items as an unlock reward.
 * When `when` matches an item, each `set` formula is evaluated over the item and replaces that
 * level.
 *
 * `when` is a JSONLogic predicate over the item's `levels`, `class` and `tags`. Without `when` the
 * rule applies to every item. The server carries these rules as data and never evaluates them.
 */
export type UnlockRule = z.infer<typeof unlockRuleSchema>;

/**
 * The zod schema for a {@link GrantRule}.
 *
 * The engine runs a grant as a generic custody transfer of opaque signed items and never interprets
 * the items (beacon.server `doc/spec/room-operation.md` §9.6). Grants are tracked in
 * `state.granted`, where a legacy plain-array entry reads as consumed for the policy's single pool.
 */
export const grantRuleSchema = z
  .object({
    op: z.string(), // the op whose successful application grants items (e.g. "claim")
    from: z.string(), // the room-state pool key to draw from (e.g. "rewards")
    count: z.number().int().positive(), // how many items to hand the actor per grant
    when: jsonLogicSchema.optional(), // state condition (>= 1 passes); absent = unconditional
  })
  .strict();
/**
 * A reward rule: when a player applies `op` successfully, the room hands that player up to `count`
 * items from the reward pool named `from`.
 *
 * For example `{ op: "claim", from: "rewards", count: 1 }` hands one item from `state.rewards` to
 * each player who claims. Each player receives from each pool at most once. The items are your
 * game's pre-minted, signed items, seeded at placement through `initialRewards` or `initialPools`.
 *
 * `when` makes the rule conditional on room state. The JSONLogic formula is evaluated over the
 * state after the op, and the rule applies when the result is an integer of at least 1. A result
 * that is not an integer, such as `true` from `==`, or a formula that fails, means the rule does
 * not apply. Write a condition as clamped arithmetic: `max(0, 1 - deficit)` is 1 exactly when the
 * deficit is zero. Several rules with different `when` conditions let one room stage several pools.
 */
export type GrantRule = z.infer<typeof grantRuleSchema>;

/**
 * Validates a {@link Policy}, refusing by name any field this version does not know.
 *
 * Strict at every level, because the policy is signed (beacon.server `doc/spec/room-operation.md`
 * §8.1): the room's minter signs `{unique, kind, policy}`, so a field this build stripped on the
 * way in would still be covered by the signature it then checked, and the placement would read as
 * forged when the truth is that this server predates the app. Refusing by name instead lets the
 * boundary say which field it does not understand. The engine would otherwise half-understand the
 * policy, which is a room that behaves differently from the one its placer signed. A new policy
 * field therefore ships with a capability marker so a client can ask before it places:
 * `policy:<path>`, which a server derives from this schema, so adding the field is what advertises
 * it (`markers.ts`).
 *
 * That covers new KEYS. A new VALUE on a closed set (a role beyond `roleSchema`'s, an `onEmpty`
 * other than `"close"`) fails as an ordinary malformed placement, because this build cannot tell a
 * value it has never heard of from a client bug. So a new value needs its marker even more than a
 * new key does.
 *
 * Rule BODIES stay opaque (`derived`, `unlockTransform.set` hold `jsonLogicSchema`), so a new
 * operator inside a formula is not an unknown field.
 */
export const policySchema = z
  .object({
    type: z.string().optional(), // informational tag (the engine does not branch on it)
    ops: z.record(z.string(), opRuleSchema),
    lifecycle: lifecycleSchema.optional(),
    derived: z.record(z.string(), jsonLogicSchema).optional(),
    // Client-applied unlock transform (`doc/spec/item-properties.md` §5.2): an ordered list of
    // conditional rules a client computes over frozen contents at claim — the server carries it as data, never
    // evaluates it.
    unlockTransform: z.array(unlockRuleSchema).optional(),
    accept: acceptPredicateSchema.optional(),
    // Reward-handoff rules the engine runs as generic custody transfer (beacon.server
    // `doc/spec/room-operation.md` §9.6).
    // One rule or several: an array stages multiple pools behind per-rule `when` conditions
    // (each rule draws from its own pool; granted-tracking is per actor per pool).
    grant: z.union([grantRuleSchema, z.array(grantRuleSchema)]).optional(),
    // Max distinct contributors admitted — a generic count, distinct from `accept.capacity` (which caps
    // item count). `contribute` rejects a NEW contributor past this; sizes a room's reward pool.
    maxContributors: z.number().int().nonnegative().optional(),
    onEmpty: z.literal("close").optional(),
    // How long a settled room stays open for claims. A reader that meets a value this build does not
    // read as a duration (one stored before the rule, or a unit added later) reads it as absent.
    claimTtl: absentOnRead(durationSchema.optional()),
  })
  .strict();
/**
 * The rules a room runs by: its allowed ops, admitted items, phases, derived values and rewards.
 *
 * - `ops`: one {@link OpRule} per op the room allows, keyed by op name.
 * - `lifecycle`: the room's phases (see {@link Lifecycle}).
 * - `derived`: named JSONLogic formulas the server recomputes over room state.
 * - `unlockTransform`: rules your game applies to items as an unlock reward (see {@link
 *   UnlockRule}).
 * - `accept`: which items the room admits (see {@link AcceptPredicate}).
 * - `grant`: one reward rule or a list of them (see {@link GrantRule}).
 * - `maxContributors`: the most distinct contributors the room admits.
 * - `onEmpty`: `"close"` to let the server close the room. A room with no `lifecycle` closes when
 *   its contents are empty. A room with a `lifecycle` closes in its last phase once any of these
 *   holds: every contributor has claimed, nobody contributed, no grant is still owed, or
 *   `claimTtl` has run out.
 *   Closing drops any item still in the room. Without `onEmpty`, the room stays until an operator
 *   removes it.
 * - `claimTtl`: how long a settled room stays open for claims, as a duration such as `"7d"` (see
 *   {@link parseDuration}). The window applies only with `onEmpty: "close"` and a `lifecycle`.
 * - `type`: a label for your own use. The server does not act on it.
 *
 * The room's minter signs the policy, so a server refuses a field it does not know instead of
 * dropping it. Before you place a room on a server, check the policy with
 * `unsupportedPolicyFeatures`.
 */
export type Policy = z.infer<typeof policySchema>;

/**
 * The zod schema for a {@link Room}, which refuses unknown fields. Only the keys of `state` are
 * free.
 *
 * Check a room a server sent with {@link roomReadSchema}, which ignores unknown keys, so a field a
 * newer server adds does not fail the read. The room shape of beacon.server
 * `doc/spec/room-operation.md` §4.
 */
export const roomSchema = z
  .object({
    id: globalIdSchema,
    type: z.string(),
    version: z.number().int().nonnegative(), // monotonic; bumped on every applied op
    location: latLngSchema,
    state: z.record(z.string(), z.unknown()), // { contents, phase, … } — kind-specific
    policy: policySchema,
    placedBy: didKeySchema, // who placed it on the map (the place-op actor) — also the "owner" role
    // The game that placed it: the `place` envelope's slug, stamped by the server and never changed.
    // Optional only for rooms that predate the slug; a server stamps every room it places.
    game: gameSlugSchema.optional(),
    // Who minted this room (`doc/spec/identity.md` §5.1), carried from the place op's signed
    // `mintedBy`, which the server verifies at place (over `{unique, kind, policy}`). Optional at the
    // schema layer only. Powers client trust/block lists (`doc/spec/identity.md` §9).
    mintedBy: mintedBySchema.optional(),
    // The placer's custom display name for the room — mutable, set at place time from the owner's
    // room label (and frozen once placed; there's no rename-a-placed-room op). Display only.
    name: displayNameSchema.optional(),
    // The room's content-addressed preview media header (beacon.server
    // `doc/spec/mailbox-and-media.md` §5): set at place from the room's media, display-only (integrity comes from the content-address hash, as an
    // item's does).
    media: z.array(mediaSchema).optional(),
    live: z.string().optional(), // the live channel's origin; the Beacon server sets it on every room
  })
  .strict();
/**
 * A room as a server returns it from `GET /rooms/:id`: its id, type, location, state, policy and
 * the player who placed it.
 *
 * - `id`: the room's global id, `<unique>@<host>`.
 * - `version`: goes up with every op that changes the room and with every phase change. A `list`
 *   leaves it unchanged.
 * - `state`: the room's state, such as `contents` and `phase`. The keys depend on the room's type.
 * - `placedBy`: the account that placed the room, which holds the `"owner"` role.
 * - `game`: the game that placed the room. Absent only on a room placed before game slugs.
 * - `mintedBy`: the room's signed provenance, from the placement.
 * - `name` and `media`: display fields set at placement. A placed room cannot be renamed.
 * - `live`: the origin of the room's live channel. The Beacon server sets it on every room.
 */
export type Room = z.infer<typeof roomSchema>;
/**
 * {@link Room} as a client reads it: the checks of `roomSchema`, with unknown fields dropped instead
 * of refused at every depth.
 *
 * The room's `policy` is signed in its `mintedBy`, and a parse drops a field a newer game signed.
 * Check the raw room with `conformsTo(roomReadSchema, raw)`, which keeps it as it is, and verify
 * `mintedBy` over that.
 */
export const roomReadSchema = readVariant(roomSchema);

/**
 * Return `true` when `game` may apply `op` to `room`. The room's own game always may. Another game
 * may when the op's rule lists that game or {@link ANY_GAME}.
 *
 * This checks only the game. The op's `role` and `phase` still decide who may apply the op and
 * when. An `undefined` game gets `false`. So does every game on a room that has no game and opens
 * no op, as on a room placed before game slugs.
 */
export function gameMayApply(
  room: Pick<Room, "game" | "policy">,
  op: string,
  game: string | undefined,
): boolean {
  if (game === undefined) return false;
  if (room.game === game) return true;
  // Own keys only: an op named after an `Object.prototype` member must find nothing.
  const rule = Object.hasOwn(room.policy.ops, op) ? room.policy.ops[op] : undefined;
  return opensTo(rule?.games, game);
}

function opensTo(games: readonly string[] | undefined, game: string): boolean {
  return games?.some((g) => g === ANY_GAME || g === game) ?? false;
}
