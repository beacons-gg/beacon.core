import { z } from "zod";

/**
 * Walking a zod tree: the one place that knows which `def` slots hold a node's children. Shared by
 * the read twins (`read.ts`), the policy-feature walk (`markers.ts`) and the structural tests. Not
 * in the barrel: it is an internal of this package, not wire contract.
 */

type Kind = z.core.$ZodTypeDef["type"];

/**
 * The `def` slots that hold each kind of node's children. Every kind zod has is listed, so a kind a
 * newer zod adds fails to compile here until someone says what it holds. A slot holds one schema, a
 * list of them (`options`, `items`), a record of them (`shape`), or a function that returns one
 * (`getter`).
 */
const CHILD_SLOTS: Record<Kind, readonly string[]> = {
  any: [],
  bigint: [],
  boolean: [],
  custom: [],
  date: [],
  enum: [],
  file: [],
  int: [],
  literal: [],
  nan: [],
  never: [],
  null: [],
  number: [],
  string: [],
  symbol: [],
  template_literal: [],
  transform: [],
  undefined: [],
  unknown: [],
  void: [],
  array: ["element"],
  catch: ["innerType"],
  default: ["innerType"],
  function: ["input", "output"],
  intersection: ["left", "right"],
  lazy: ["getter"],
  map: ["keyType", "valueType"],
  nonoptional: ["innerType"],
  nullable: ["innerType"],
  object: ["shape", "catchall"],
  optional: ["innerType"],
  pipe: ["in", "out"],
  prefault: ["innerType"],
  promise: ["innerType"],
  readonly: ["innerType"],
  record: ["keyType", "valueType"],
  set: ["valueType"],
  success: ["innerType"],
  tuple: ["items", "rest"],
  union: ["options"],
};

const isSchema = (value: unknown): value is z.core.$ZodType => value instanceof z.core.$ZodType;

/**
 * The def slots `f` changes, each child mapped by `f`, in the slot's own form. A slot with no child
 * (an unset catchall or tuple rest) is left out. A `getter` slot becomes a getter of the mapped
 * child, called when zod first resolves it.
 */
export function mapChildren(
  schema: z.core.$ZodType,
  f: (child: z.core.$ZodType) => z.core.$ZodType,
): Record<string, unknown> {
  const def = schema._zod.def as unknown as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  for (const slot of CHILD_SLOTS[schema._zod.def.type]) {
    const value = def[slot];
    if (slot === "getter") {
      mapped[slot] = () => f((value as () => z.core.$ZodType)());
    } else if (Array.isArray(value)) {
      mapped[slot] = value.map((child) => (isSchema(child) ? f(child) : child));
    } else if (isSchema(value)) {
      mapped[slot] = f(value);
    } else if (slot === "shape" && value) {
      mapped[slot] = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, f(child as z.core.$ZodType)]),
      );
    }
  }
  return mapped;
}

/** The children a zod node wraps, whatever kind of container it is. */
export function childrenOf(schema: z.ZodType): z.ZodType[] {
  const found: z.ZodType[] = [];
  mapChildren(schema, (child) => {
    found.push(child as z.ZodType);
    return child;
  });
  // A lazy node's child is only reached through its getter, which mapChildren leaves unresolved.
  if (schema.def.type === "lazy")
    found.push((schema.def as z.core.$ZodLazyDef).getter() as z.ZodType);
  return found;
}

/**
 * The nodes a read variant adds to read a value it cannot: the only nodes in a read variant
 * allowed to make its output differ from its input. `read.ts` marks each fallback's transform; the
 * structural tests skip those transforms when they check that nothing else rewrites.
 */
const degradations = new WeakSet<z.core.$ZodType>();

export function markDegradation<T extends z.core.$ZodType>(node: T): T {
  degradations.add(node);
  return node;
}

export function isDegradation(node: z.core.$ZodType): boolean {
  return degradations.has(node);
}
