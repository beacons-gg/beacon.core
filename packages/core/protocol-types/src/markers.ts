import { z } from "zod";
import { jsonLogicSchema, policySchema } from "./room";
import { childrenOf } from "./zodTree";

/**
 * The `op:`, `policy:` and `rule:` markers: what a server ACCEPTS beyond the baseline,
 * advertised in its signed descriptor's `capabilities` (the convention is in `understands.ts`).
 *
 * **The baseline is implied, never advertised.** Every op and policy feature below existed when
 * markers started, so every server accepts them, including one that predates this file and
 * advertises nothing. A marker appears only for an addition, which keeps "this server says nothing"
 * and "this server accepts the baseline" the same statement. A client asks with {@link acceptsOp}
 * and {@link unsupportedPolicyFeatures}, which answer yes for the baseline and otherwise read the
 * list.
 *
 * **Nothing here is a hand-kept list of additions.** A server derives its markers from what it
 * runs: `op:` from the engine's handler table, `policy:` from {@link policySchema} itself, so a new
 * field or value is advertised by the build that can take it. A client derives the features a
 * policy uses from the policy, the same way.
 *
 * **The op vocabulary is the platform's, not a game's.** A game composes rooms out of these ops and
 * says what they mean through policy (roles, phases, `accept`, `derived`, `grant`) and its own
 * opaque items; it cannot register a verb of its own. A new op is a platform release that ships
 * with its `op:` marker, the way a later `unreact` op would. A policy may already NAME an op its
 * server does not have: placement takes any key under `ops`, and the op is refused (`denied`,
 * "unsupported op") until a server that handles it hosts the room. So a game can place rooms that
 * gain a verb on upgrade, and asks {@link acceptsOp} before it offers the player that verb.
 *
 * **So is the rule-operator set.** Placement refuses any operator outside
 * `@beaconsgg/jsonlogic-profile`'s `ALLOWED_OPERATORS` in a rule body (`derived`, `grant.when`,
 * `unlockTransform`), so that set is a closed vocabulary the platform owns and extends by release,
 * like the ops. Today's set is {@link BASELINE_RULE_OPERATORS}; each operator added to it is
 * advertised as `rule:<name>`, and {@link unsupportedPolicyFeatures} reports an operator a
 * policy uses that its server has not advertised.
 */

/**
 * The room ops every server handles: `add`, `take`, `list`, `contribute`, `claim`, `collect` and
 * `react`.
 *
 * A server advertises each op beyond these as `op:<name>` in its descriptor's `capabilities`. Ask
 * {@link acceptsOp} rather than reading this list.
 *
 * Frozen: the engine's vocabulary when markers started. A new op is an addition, advertised by the
 * build that handles it.
 */
export const BASELINE_OPS: readonly string[] = Object.freeze([
  "add",
  "take",
  "list",
  "contribute",
  "claim",
  "collect",
  "react",
]);

/**
 * The policy features every server accepts, as dotted paths such as `ops.max` and `onEmpty.close`.
 *
 * A server advertises each feature beyond these as `policy:<feature>`. Ask
 * {@link unsupportedPolicyFeatures} rather than reading this list.
 *
 * Frozen: `policyFeatures` of the policy schema when markers started. A test holds each entry
 * to the live schema, since dropping one would refuse placements an older app still sends.
 */
export const BASELINE_POLICY_FEATURES: readonly string[] = Object.freeze([
  "type",
  "ops",
  "ops.role",
  "ops.role.public",
  "ops.role.owner",
  "ops.role.contributor",
  "ops.phase",
  "ops.max",
  "lifecycle",
  "lifecycle.phases",
  "lifecycle.transitions",
  "derived",
  "unlockTransform",
  "unlockTransform.when",
  "unlockTransform.set",
  "accept",
  "accept.class",
  "accept.tags",
  "accept.minLevels",
  "accept.capacity",
  "grant",
  "grant.op",
  "grant.from",
  "grant.count",
  "grant.when",
  "maxContributors",
  "onEmpty",
  "onEmpty.close",
  "claimTtl",
]);

/**
 * The JSONLogic operators every server accepts in a policy's rules, such as `derived` and a grant's
 * `when`.
 *
 * A server advertises each operator beyond these as `rule:<name>`. Ask
 * {@link unsupportedPolicyFeatures} rather than reading this list.
 *
 * Frozen: `ALLOWED_OPERATORS` of `@beaconsgg/jsonlogic-profile` when rule markers started. A test
 * holds each entry to the live set.
 */
export const BASELINE_RULE_OPERATORS: readonly string[] = Object.freeze([
  "var",
  "+",
  "-",
  "*",
  "min",
  "max",
  "sum",
  "count",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "and",
  "or",
  "!",
  "!!",
  "in",
  "some",
]);

/**
 * The word a `rule:` marker uses for each symbolic operator, such as `rule:div` for `/`.
 *
 * A marker carries only `[A-Za-z0-9._-]`, so an operator that is a word names itself (`rule:if`).
 * The baseline's symbols are never advertised and need no name.
 *
 * Frozen: a shipped name is part of the wire.
 */
export const RULE_OPERATOR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "/": "div",
  "%": "mod",
  "?:": "ternary",
});

const MARKER_WORD_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The name an operator's `rule:` marker carries, or `undefined` for a symbol with no name yet. */
function ruleOperatorName(operator: string): string | undefined {
  if (MARKER_WORD_RE.test(operator)) return operator;
  return Object.hasOwn(RULE_OPERATOR_NAMES, operator) ? RULE_OPERATOR_NAMES[operator] : undefined;
}

/**
 * List every feature a policy schema accepts, in the spelling a `policy:` marker carries.
 *
 * A feature is the dotted path of a field from the policy root (`ops.max`). A value of a closed set
 * adds one more segment to its field's path (`onEmpty.close`, `ops.role.owner`). Records and arrays
 * add no segment, so every op's rule is under `ops` and one grant rule reads the same as several.
 *
 * Features are what a strict parse refuses: a new key, or a new value on a closed set. Open values
 * (strings, numbers, rule bodies) are not features, so neither is widening one: a field that grows
 * from an integer to a string, or a bound that relaxes, needs a new field rather than a marker.
 */
export function policyFeatures(): string[] {
  return featuresOfSchema(policySchema);
}

/** {@link policyFeatures} for any policy schema. */
function featuresOfSchema(schema: z.ZodType): string[] {
  const found = new Set<string>();
  collect(schema, [], found, 0);
  return [...found];
}

function collect(schema: z.ZodType, path: string[], found: Set<string>, depth: number): void {
  if (depth > 32) throw new Error("policy schema deeper than any wire shape");
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      found.add([...path, key].join("."));
      collect(child, [...path, key], found, depth + 1);
    }
  } else if (schema instanceof z.ZodLiteral) {
    found.add([...path, String(schema.value)].join("."));
  } else if (schema instanceof z.ZodEnum) {
    for (const value of schema.options as string[]) found.add([...path, value].join("."));
  } else {
    for (const child of childrenOf(schema)) collect(child, path, found, depth + 1);
  }
}

/**
 * List the features `policy` uses, as dotted paths such as `ops.max`: each field the policy sets
 * and each closed value it picks, which adds one more segment (`onEmpty.close`).
 *
 * A part of the policy that this version's policy schema does not describe is skipped, since this
 * version cannot name it.
 */
export function policyFeaturesOf(policy: unknown): string[] {
  return [...usesOf(policy, policySchema).features];
}

/**
 * List the JSONLogic operators `policy` uses in its rules: `derived`, `grant.when`, and the `when`
 * and `set` of `unlockTransform`.
 *
 * Those are the slots the schema types as a rule ({@link jsonLogicSchema}), which are the slots
 * placement validates.
 */
export function ruleOperatorsOf(policy: unknown): string[] {
  return [...usesOf(policy, policySchema).operators];
}

/** What one walk of a policy finds: its features and its rule operators. */
interface Uses {
  features: Set<string>;
  operators: Set<string>;
}

function usesOf(policy: unknown, schema: z.ZodType): Uses {
  const found: Uses = { features: new Set(), operators: new Set() };
  uses(schema, policy, [], found, 0);
  return found;
}

/** Each operator in a rule: a JSONLogic operation is an object with exactly one key. */
function operatorsIn(rule: unknown, operators: Set<string>, depth: number): void {
  if (depth > 64 || rule === null || typeof rule !== "object") return;
  if (Array.isArray(rule)) {
    for (const item of rule) operatorsIn(item, operators, depth + 1);
    return;
  }
  const keys = Object.keys(rule);
  if (keys.length !== 1) return; // not an operation; placement refuses it anyway
  const operator = keys[0] as string;
  operators.add(operator);
  operatorsIn((rule as Record<string, unknown>)[operator], operators, depth + 1);
}

function uses(schema: z.ZodType, value: unknown, path: string[], found: Uses, depth: number): void {
  if (depth > 32 || value === undefined) return;
  if (schema === jsonLogicSchema) {
    operatorsIn(value, found.operators, 0);
  } else if (schema instanceof z.ZodObject) {
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      const field = (value as Record<string, unknown>)[key];
      if (field === undefined) continue;
      found.features.add([...path, key].join("."));
      uses(child, field, [...path, key], found, depth + 1);
    }
  } else if (schema instanceof z.ZodLiteral || schema instanceof z.ZodEnum) {
    if (schema.safeParse(value).success) found.features.add([...path, String(value)].join("."));
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    // The branch the value takes is the one whose features it uses.
    const options = schema.options as z.ZodType[];
    const taken = options.find((option) => option.safeParse(value).success);
    if (taken) uses(taken, value, path, found, depth + 1);
  } else if (schema instanceof z.ZodArray) {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      uses(schema.element as z.ZodType, item, path, found, depth + 1);
    }
  } else if (schema instanceof z.ZodRecord) {
    if (typeof value !== "object" || value === null) return;
    const inner = schema.valueType as z.ZodType;
    for (const entry of Object.values(value)) uses(inner, entry, path, found, depth + 1);
  } else {
    for (const child of childrenOf(schema)) uses(child, value, path, found, depth + 1);
  }
}

/**
 * Build the `op:` markers a server advertises for the ops it handles: one per op beyond
 * {@link BASELINE_OPS}.
 */
export function opMarkers(ops: Iterable<string>): string[] {
  return [...ops].filter((op) => !BASELINE_OPS.includes(op)).map((op) => `op:${op}`);
}

/**
 * Build the `policy:` markers a server advertises for a policy schema: one per feature beyond
 * {@link BASELINE_POLICY_FEATURES}.
 */
export function policyMarkers(): string[] {
  return markersOfSchema(policySchema);
}

/**
 * {@link policyMarkers} for any policy schema. Internal: the tests pass a later schema to stand in
 * for the next policy field, and neither entry point exports this.
 */
export function markersOfSchema(schema: z.ZodType): string[] {
  return featuresOfSchema(schema)
    .filter((feature) => !BASELINE_POLICY_FEATURES.includes(feature))
    .map((feature) => `policy:${feature}`);
}

/**
 * Build the `rule:` markers a server advertises for the rule operators it accepts: one per operator
 * beyond {@link BASELINE_RULE_OPERATORS}.
 *
 * The throw makes adding an operator to the allowed set without naming it fail the build's tests
 * rather than advertise nothing.
 *
 * @throws `Error` for a symbolic operator with no name in {@link RULE_OPERATOR_NAMES}.
 */
export function ruleMarkers(operators: Iterable<string>): string[] {
  return [...operators]
    .filter((operator) => !BASELINE_RULE_OPERATORS.includes(operator))
    .map((operator) => {
      const name = ruleOperatorName(operator);
      if (name === undefined) {
        throw new Error(`rule operator "${operator}" has no marker name in RULE_OPERATOR_NAMES`);
      }
      return `rule:${name}`;
    });
}

/**
 * Return `true` when a server handles the room op `op`, judged from the `capabilities` of its
 * verified descriptor.
 *
 * The ops in {@link BASELINE_OPS} are always handled. Ask before you offer the player an op a later
 * release added: a policy can name the op on any server, but a server that does not advertise
 * `op:<name>` refuses the op with `denied`.
 *
 * @param capabilities - The descriptor's `capabilities`, or `undefined` when it lists none.
 * @param op - The op name, such as `"react"`.
 */
export function acceptsOp(capabilities: readonly string[] | undefined, op: string): boolean {
  return BASELINE_OPS.includes(op) || (capabilities ?? []).includes(`op:${op}`);
}

/**
 * List what `policy` uses that a server does not accept, or return `[]` when the server accepts all
 * of it.
 *
 * Call this before you place a room: a server refuses a placement that uses a policy feature or
 * rule operator the server lacks. A feature is spelled as a dotted path
 * (`onEmpty.archive`). A rule operator is spelled as its whole marker (`rule:if`). A feature never
 * holds a colon, so the two kinds cannot collide.
 *
 * @param capabilities - The `capabilities` of the server's verified descriptor.
 * @param policy - The policy you are about to place.
 */
export function unsupportedPolicyFeatures(
  capabilities: readonly string[] | undefined,
  policy: unknown,
): string[] {
  return unsupportedBySchema(capabilities, policy, policySchema);
}

/** {@link unsupportedPolicyFeatures} for any policy schema. Internal, as {@link markersOfSchema} is. */
export function unsupportedBySchema(
  capabilities: readonly string[] | undefined,
  policy: unknown,
  schema: z.ZodType,
): string[] {
  const advertised = capabilities ?? [];
  const found = usesOf(policy, schema);
  const features = [...found.features].filter(
    (feature) =>
      !BASELINE_POLICY_FEATURES.includes(feature) && !advertised.includes(`policy:${feature}`),
  );
  const operators = [...found.operators]
    .filter((operator) => !BASELINE_RULE_OPERATORS.includes(operator))
    // An operator this build cannot name, no server can advertise either: report it as written.
    .map((operator) => `rule:${ruleOperatorName(operator) ?? operator}`)
    .filter((marker) => !advertised.includes(marker));
  return [...features, ...operators];
}
