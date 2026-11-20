import { z } from "zod";
import { mapChildren, markDegradation } from "./zodTree";

/**
 * Tolerant READ variants of the strict wire schemas.
 *
 * A `.strict()` schema does two jobs. As what a server ACCEPTS it is a signing decision: an unknown
 * field on a signed shape would be canonicalized and signed silently, so it is refused. As what a
 * client READS it is a forward-compatibility break: every field a newer server adds fails the parse
 * of every app already in players' hands, and the server it came from becomes unreadable.
 *
 * {@link readVariant} keeps one declaration per shape and derives the second job from the first:
 * the same tree, with every object switched from refusing unknown keys to dropping them.
 * Everything else (required fields, types, bounds, refinements) still holds, so a read variant is
 * exactly as strict about what it knows and indifferent to what it does not.
 *
 * Two rules keep this honest:
 * - **Request params and envelopes stay strict.** Additions there go through capability markers
 *   (`understands.ts`), not through tolerance.
 * - **A signed document is verified over the raw body, then shape-checked with its read variant.**
 *   Stripping a field first would change the signed bytes; see `verifyDescriptor` in
 *   `@beaconsgg/identity`.
 *
 * A new KEY is the easy half. A new VALUE on a closed set (a place category, an access level) fails
 * the read variant as it fails the strict shape, and what a reader should do instead depends on the
 * field, so the strict declaration says so where the field is declared and the read variant
 * derives it: {@link rowsDroppedOnRead} for a list, {@link absentOnRead} for an optional field,
 * {@link readAsOnRead} for a required one. The strict shape is unchanged by any of them.
 */

type Read<T extends z.core.$ZodType> = z.ZodType<z.output<T>, z.input<T>>;

/**
 * The type of a schema node marked with {@link rowsDroppedOnRead}, {@link absentOnRead} or
 * {@link readAsOnRead}: the node's own output, with the wider input its read variant accepts.
 *
 * You meet it in the type of a schema that has such a field. `Received` is what
 * {@link conformsTo} narrows a raw value to, so the narrowing stays honest.
 *
 * The strict schema embeds the same node, so its `z.input` widens too, on the safe side: nothing
 * narrows a value with a strict schema.
 *
 * A mark is the outermost call on its node, so `.optional()` goes inside it. The marked node is
 * typed as zod's core schema, which has no methods: a wrapper such as `.optional()` would keep the
 * mark at runtime but type its input as the unmarked `T`, and a copy such as `.max()` or
 * `.describe()` would drop it, so the read variant would refuse the new value again. The rest of
 * the node's internals stay as they were, so an optional field stays optional in the object around
 * it.
 */
export type ReadsAs<T extends z.ZodType, Received> = z.core.$ZodType<
  z.output<T>,
  Received,
  Omit<T["_zod"], "input" | "output"> & z.core.$ZodTypeInternals<z.output<T>, Received>
>;

/** How a read variant reads a node its strict schema marked, given the node's own read. */
type Degrade = (read: z.core.$ZodType) => z.core.$ZodType;
const onRead = new WeakMap<z.core.$ZodType, Degrade>();

/**
 * A copy of `schema` with some of its def's slots replaced. The other slots keep their property
 * descriptors, so a getter such as a default's value still runs on every parse, and the copy keeps
 * the original's metadata (`.describe()`, `.meta()`).
 */
function copyWith(schema: z.core.$ZodType, slots: Record<string, unknown>): z.core.$ZodType {
  return z.core.clone(schema, z.core.util.mergeDefs(schema._zod.def, slots), { parent: true });
}

/** What a dropped row reads as, until the list filters it out. */
const UNREADABLE = Symbol("unreadable");

/**
 * Mark a copy of `node`, never the node itself: a shared schema (an enum several shapes use) would
 * otherwise degrade in every read variant that embeds it, asked or not. The mark is the outermost
 * call on its node (see {@link ReadsAs}).
 */
function mark<T extends z.ZodType, Received>(node: T, degrade: Degrade): ReadsAs<T, Received> {
  const copy = copyWith(node, {});
  onRead.set(copy, degrade);
  return copy as unknown as ReadsAs<T, Received>; // the same node, retyped as its read accepts
}

/**
 * A transform the structural tests know is the rewrite its node declared, because it is marked as a
 * degradation.
 */
function declared<I, O>(rewrite: (value: I) => O): z.ZodTransform<O, I> {
  return markDegradation(z.transform(rewrite));
}

/**
 * `read`, or when it cannot read a value that `instead` accepts, `rewrite` of it. One parse either
 * way: a union returns its first option that reads.
 */
function orElse<I>(read: z.core.$ZodType, instead: z.ZodType<I>, rewrite: (value: I) => unknown) {
  return z.union([read, instead.pipe(declared(rewrite))]);
}

/**
 * Mark a list in a strict schema so its read variant drops each row it cannot read, and the rest of
 * the list still arrives.
 *
 * Use it where a missing row costs a reader nothing it acts on, such as the places a newer server
 * lists under a category this build has never heard of. The strict schema is unchanged. Make the
 * mark the outermost call on the list (see {@link ReadsAs}).
 *
 * An operator's review queue is the counterexample: one that silently loses a proposal is worse
 * than one that says it cannot be read. Leave such a list unmarked, or read it with
 * `readVariant(schema, { degrade: false })`.
 */
export function rowsDroppedOnRead<T extends z.ZodArray<z.ZodType>>(list: T): ReadsAs<T, unknown[]> {
  return mark<T, unknown[]>(list, (read) => {
    const array = read as z.ZodArray<z.ZodType>;
    const rows = copyWith(array, {
      element: orElse(array.element, z.unknown(), () => UNREADABLE),
    }) as z.ZodArray<z.ZodType>;
    return rows.pipe(declared((all: unknown[]) => all.filter((row) => row !== UNREADABLE)));
  });
}

/**
 * Mark an optional field in a strict schema so its read variant reads a value it cannot read as
 * absent.
 *
 * Use it for an optional closed set a newer server may extend. The strict schema is unchanged. Make
 * the mark the outermost call, with `.optional()` inside it (see {@link ReadsAs}).
 */
export function absentOnRead<T extends z.ZodOptional<z.ZodType>>(field: T): ReadsAs<T, unknown> {
  return mark<T, unknown>(field, (read) => orElse(read, z.unknown(), () => undefined));
}

/**
 * Mark a required closed set in a strict schema so its read variant reads a string it has never
 * heard of as `fallback`.
 *
 * Pick the safest value as `fallback`: for an access level, the most restrictive one. Only a string
 * falls back, so the field stays required and a value of the wrong type is still an error. The
 * strict schema is unchanged.
 *
 * On a signed document `conformsTo` narrows the raw body, which keeps the newer value (typed
 * `string` there); that is why such a field has its own reader beside it.
 *
 * @param fallback - The value an unknown string reads as.
 */
export function readAsOnRead<T extends z.ZodType>(
  field: T,
  fallback: z.output<T>,
): ReadsAs<T, z.input<T> | string> {
  return mark<T, z.input<T> | string>(field, (read) => orElse(read, z.string(), () => fallback));
}

/**
 * Derive the schema to read a server's reply with: `schema` with every object, at any depth, set to
 * drop unknown keys instead of refusing them.
 *
 * Every other check still holds: required fields, types, bounds and refinements. A field the
 * strict schema marks with {@link rowsDroppedOnRead}, {@link absentOnRead} or {@link readAsOnRead}
 * degrades as marked. This package already exports a `*ReadSchema` built this way for each reply,
 * so you rarely call this function yourself.
 *
 * Containers (arrays, tuples, records, unions, intersections, optionals, pipes, lazies) are rebuilt
 * around their converted children with their own checks intact; scalars come back as they are.
 *
 * @param options.degrade - `false` leaves out the marked degradations, so a value this build has
 *   never heard of fails the read again. Use it when you act on every row or write a value back: an
 *   operator's moderation list must not lose a place without saying so. Defaults to `true`.
 */
export function readVariant<T extends z.core.$ZodType>(
  schema: T,
  { degrade = true }: { degrade?: boolean } = {},
): Read<T> {
  return (degrade ? convert : convertKeysOnly)(schema) as Read<T>;
}

/**
 * Return `true` when `value` passes `schema`, and narrow `value` to the type the schema accepts.
 *
 * The value itself is left as it is: nothing is dropped, defaulted or transformed. Use it with a
 * read schema on a signed document, which you verify over the raw body and so must not reshape.
 *
 * The narrowed type is the schema's input (`z.input`), the one a parse would start from. On a read
 * variant a closed set a newer peer may extend is typed `string`, and a field that degrades is
 * typed `unknown`, because the raw value still holds whatever was sent.
 */
export function conformsTo<T extends z.core.$ZodType>(
  schema: T,
  value: unknown,
): value is z.input<T> {
  return z.safeParse(schema, value).success;
}

/**
 * Each strict node's read, once per kind of read. A node several wire shapes share (a media entry)
 * is converted once and the result shared, which is safe because a read depends only on its node.
 */
const reads = new WeakMap<z.core.$ZodType, z.core.$ZodType>();
const keysOnlyReads = new WeakMap<z.core.$ZodType, z.core.$ZodType>();

/** Unknown keys dropped, and every marked node degraded. */
function convert(schema: z.core.$ZodType): z.core.$ZodType {
  let read = reads.get(schema);
  if (!read) {
    const rebuilt = rebuild(schema, convert);
    read = onRead.get(schema)?.(rebuilt) ?? rebuilt;
    reads.set(schema, read);
  }
  return read;
}

/** Unknown keys dropped, and nothing else. */
function convertKeysOnly(schema: z.core.$ZodType): z.core.$ZodType {
  let read = keysOnlyReads.get(schema);
  if (!read) {
    read = rebuild(schema, convertKeysOnly);
    keysOnlyReads.set(schema, read);
  }
  return read;
}

/** Is a slot's mapped value the same children as before? */
function sameChildren(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length === after.length && before.every((child, i) => child === after[i]);
  }
  if (
    typeof before !== "object" ||
    before === null ||
    typeof after !== "object" ||
    after === null
  ) {
    return false; // a lazy's new getter, or a child where there was none
  }
  const entries = Object.entries(before);
  return (
    entries.length === Object.keys(after).length &&
    entries.every(([key, child]) => (after as Record<string, unknown>)[key] === child)
  );
}

/**
 * `schema` rebuilt around its children, each read by `convert`. A copy keeps its own checks, since
 * zod keeps a refinement on the node it refines. A node whose children all read as themselves, and
 * which refuses no unknown keys, is its own read, so the strict and read trees share it.
 */
function rebuild(
  schema: z.core.$ZodType,
  convert: (child: z.core.$ZodType) => z.core.$ZodType,
): z.core.$ZodType {
  const def = schema._zod.def as unknown as Record<string, unknown>;
  const slots = mapChildren(schema, convert);
  if (
    def["type"] === "object" &&
    (def["catchall"] as z.core.$ZodType | undefined)?._zod.def.type === "never"
  ) {
    // `.strict()` refuses unknown keys with a `never` catchall. Without it the object drops them,
    // which is what a read wants. Any other catchall is the schema's own and is kept, converted.
    slots["catchall"] = undefined;
  }
  if (def["type"] === "lazy") {
    // zod keeps the resolved inner type on the def; the copy resolves its own through its getter.
    slots["_cachedInner"] = undefined;
  }
  if (Object.entries(slots).every(([slot, value]) => sameChildren(def[slot], value))) return schema;
  return copyWith(schema, slots);
}
