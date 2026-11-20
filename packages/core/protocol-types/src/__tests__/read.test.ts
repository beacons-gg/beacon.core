/**
 * `readVariant`, the tolerant READ twin of a strict wire schema: unknown keys are dropped at
 * every depth, and everything else the strict schema checks still holds.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { adminSettingReadSchema, type AdminSetting } from "../admin";
import {
  serverAccessLevelSchema,
  serverDescriptorReadSchema,
  type ReceivedDescriptor,
  type ServerAccessLevel,
  type ServerDescriptor,
} from "../discovery";
import { placeDetailReadSchema, placesQueryResultReadSchema } from "../places";
import { profileDocReadSchema, type ProfileDoc } from "../identity";
import { conformsTo, readAsOnRead, readVariant, rowsDroppedOnRead } from "../read";

const inner = z.object({ a: z.number().int(), b: z.string().optional() }).strict();

/** A value narrowed by `conformsTo(schema, …)`, returned so its type is what the guard narrows to. */
function _narrowedBy<S extends z.ZodType>(schema: S) {
  const value: unknown = undefined;
  if (!conformsTo(schema, value)) throw new Error("type-only helper");
  return value;
}
type Narrowed<S extends z.ZodType> = ReturnType<typeof _narrowedBy<S>>;

describe("readVariant", () => {
  it("drops an unknown key the strict schema refuses", () => {
    expect(inner.safeParse({ a: 1, extra: true }).success).toBe(false);
    expect(readVariant(inner).parse({ a: 1, extra: true })).toEqual({ a: 1 });
  });

  it("still refuses a missing or mistyped field, and still applies bounds and refinements", () => {
    const bounded = z
      .object({ items: z.array(inner).max(2), tag: z.string().min(1) })
      .strict()
      .refine((v) => v.tag !== "nope", { message: "refined" });
    const read = readVariant(bounded);
    expect(read.safeParse({ items: [], tag: "" }).success).toBe(false); // min(1)
    expect(read.safeParse({ items: [{ a: "x" }], tag: "t" }).success).toBe(false); // mistyped
    expect(read.safeParse({ items: [{ a: 1 }, { a: 2 }, { a: 3 }], tag: "t" }).success).toBe(false); // max(2)
    expect(read.safeParse({ items: [], tag: "nope" }).success).toBe(false); // the refinement
    expect(read.parse({ items: [{ a: 1, extra: 1 }], tag: "t", extra: 1 })).toEqual({
      items: [{ a: 1 }],
      tag: "t",
    });
  });

  it("reaches a strict object through every container kind", () => {
    const shape = z
      .object({
        list: z.array(inner),
        pair: z.tuple([inner, z.string()]),
        byKey: z.record(z.string(), inner),
        either: z.union([z.string(), inner]),
        tagged: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("x"), x: inner }).strict(),
          z.object({ kind: z.literal("y") }).strict(),
        ]),
        both: z.intersection(
          z.object({ p: z.number() }).strict(),
          z.object({ q: z.number() }).strict(),
        ),
        maybe: inner.optional(),
        orNull: inner.nullable(),
        withDefault: inner.default({ a: 0 }),
        later: z.lazy(() => inner),
        refined: inner.refine(() => true),
        caught: inner.catch({ a: 0 }),
        frozen: inner.readonly(),
        branded: inner.brand("Inner"),
        piped: inner.pipe(z.object({ a: z.number() })),
      })
      .strict();
    const noisy = { a: 1, extra: 1 };
    const parsed = readVariant(shape).parse({
      list: [noisy],
      pair: [noisy, "s"],
      byKey: { k: noisy },
      either: noisy,
      tagged: { kind: "x", x: noisy, extra: 1 },
      both: { p: 1, q: 2, extra: 1 },
      maybe: noisy,
      orNull: noisy,
      withDefault: noisy,
      later: noisy,
      refined: noisy,
      caught: noisy,
      frozen: noisy,
      branded: noisy,
      piped: noisy,
      extra: 1,
    });
    expect(parsed).toEqual({
      list: [{ a: 1 }],
      pair: [{ a: 1 }, "s"],
      byKey: { k: { a: 1 } },
      either: { a: 1 },
      tagged: { kind: "x", x: { a: 1 } },
      both: { p: 1, q: 2 },
      maybe: { a: 1 },
      orNull: { a: 1 },
      withDefault: { a: 1 },
      later: { a: 1 },
      refined: { a: 1 },
      caught: { a: 1 },
      frozen: { a: 1 },
      branded: { a: 1 },
      piped: { a: 1 },
    });
  });

  it("leaves the strict schema itself untouched", () => {
    readVariant(inner);
    expect(inner.safeParse({ a: 1, extra: true }).success).toBe(false);
  });

  it("is the identity on a scalar", () => {
    const s = z.string().min(2);
    expect(readVariant(s)).toBe(s);
  });
});

describe("conformsTo", () => {
  it("answers whether a value has the shape, without touching the value", () => {
    const value: unknown = { a: 1, extra: true };
    expect(conformsTo(readVariant(inner), value)).toBe(true);
    expect(value).toEqual({ a: 1, extra: true });
    expect(conformsTo(readVariant(inner), { extra: true })).toBe(false);
  });

  // The value is not parsed, so it is narrowed to what the schema accepts. Type-only checks,
  // run by the gate's typecheck.
  it("narrows a marked field to what a newer peer may send, and leaves the parsed type alone", () => {
    expectTypeOf<Narrowed<typeof serverDescriptorReadSchema>>().toEqualTypeOf<ReceivedDescriptor>();
    expectTypeOf<ReceivedDescriptor["accessLevel"]>().toEqualTypeOf<string>();
    expectTypeOf<Narrowed<typeof placeDetailReadSchema>["geometry"]>().toEqualTypeOf<unknown>();
    expectTypeOf<Narrowed<typeof placesQueryResultReadSchema>["places"]>().toEqualTypeOf<
      unknown[]
    >();
    expectTypeOf<
      Narrowed<typeof adminSettingReadSchema>["storedReason"]
    >().toEqualTypeOf<unknown>();
    // A parse still returns only values this build knows, and the strict types are unchanged.
    expectTypeOf<
      z.output<typeof serverDescriptorReadSchema>["accessLevel"]
    >().toEqualTypeOf<ServerAccessLevel>();
    expectTypeOf<ServerDescriptor["accessLevel"]>().toEqualTypeOf<ServerAccessLevel>();
    expectTypeOf<AdminSetting["storedReason"]>().toEqualTypeOf<
      "prerequisite" | "ceiling" | undefined
    >();
  });

  it("types a marked optional field as received, absent included", () => {
    const level = readVariant(
      z.object({ level: readAsOnRead(serverAccessLevelSchema.optional(), "private") }),
    );
    expectTypeOf<Narrowed<typeof level>["level"]>().toEqualTypeOf<string | undefined>();
    expect(conformsTo(level, {})).toBe(true);
  });

  it("refuses a method chained after a mark, which would drop it from the type or the node", () => {
    const level = readAsOnRead(serverAccessLevelSchema, "private");
    const rows = rowsDroppedOnRead(z.array(z.string()));
    // @ts-expect-error a wrapper keeps the mark at runtime, but types its input as unmarked
    expect(() => level.optional()).not.toThrow();
    // @ts-expect-error a copy of the node is a new node, without the mark
    expect(() => rows.max(5)).not.toThrow();
    // @ts-expect-error as above
    expect(() => rows.describe("rows")).not.toThrow();
    expect(z.safeParse(level, "open").success).toBe(true);
  });

  it("narrows a shape with no marks to the same type a parse returns", () => {
    expectTypeOf<Narrowed<typeof profileDocReadSchema>>().toEqualTypeOf<ProfileDoc>();
  });
});

describe("readVariant keeps what the strict schema says about itself", () => {
  it("runs a default on every parse, and never shares one object between parses", () => {
    let calls = 0;
    const read = readVariant(
      z.object({ at: z.object({ n: z.number() }).default(() => ({ n: ++calls })) }).strict(),
    );
    const first = read.parse({});
    const second = read.parse({});
    expect([first.at.n, second.at.n]).toEqual([1, 2]);
    expect(first.at).not.toBe(second.at);
  });

  it("drops only the catchall .strict() adds, and keeps one the schema declared", () => {
    const read = readVariant(z.object({ k: z.string() }).catchall(z.number()));
    expect(read.parse({ k: "a", extra: 1 })).toEqual({ k: "a", extra: 1 });
    expect(read.safeParse({ k: "a", bad: "x" }).success).toBe(false);
  });

  it("keeps a node's description and metadata", () => {
    const read = readVariant(
      z
        .object({ t: z.object({ a: z.string() }).strict().describe("inner") })
        .strict()
        .meta({ title: "X" }),
    );
    expect(read.meta()).toEqual({ title: "X" });
    expect((read as unknown as z.ZodObject).shape["t"]?.description).toBe("inner");
  });
});
