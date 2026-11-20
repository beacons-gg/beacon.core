/**
 * Walking a zod tree, for the structural tests that assert a property of every node rather than of
 * one fixture. Not a `.test.ts`, so vitest does not collect it as a suite.
 */
import { z } from "zod";
import { childrenOf, isDegradation } from "../zodTree";

/**
 * Every ZodObject in the tree, however it is wrapped, one entry per occurrence: a schema the strict
 * tree shares by reference appears once per use in the read tree, since each use is rebuilt. Nothing
 * on the wire is recursive, so the depth cap only guards a future lazy loop.
 */
export function objects(schema: z.ZodType, depth = 0): z.ZodObject[] {
  if (depth > 32) throw new Error("schema tree deeper than any wire shape");
  const found: z.ZodObject[] = schema instanceof z.ZodObject ? [schema] : [];
  for (const child of childrenOf(schema)) found.push(...objects(child, depth + 1));
  return found;
}

/**
 * Is every object in the tree set to drop unknown keys, or does one still refuse them? An object
 * refuses them with a `never` catchall, keeps them with any other, and drops them with none.
 */
export function strictness(schema: z.ZodType): string[] {
  return objects(schema).map((o) => {
    const catchall = o.def.catchall;
    if (!catchall) return "strip";
    return catchall._zod.def.type === "never" ? "strict" : "passthrough";
  });
}

/**
 * Every node in the tree that would make the parsed value differ from the input, apart from a read
 * variant's degradations (`read.ts`), which are the rewrites it is declared to make.
 */
export function rewrites(schema: z.ZodType, depth = 0): string[] {
  if (depth > 32) throw new Error("schema tree deeper than any wire shape");
  if (isDegradation(schema)) return [];
  const def = schema.def;
  const found: string[] = ["default", "prefault", "catch", "transform"].includes(def.type)
    ? [def.type]
    : [];
  // A codec is a pipe that rewrites by itself, with no transform node inside it.
  if (def.type === "pipe" && "transform" in def) found.push("codec");
  for (const child of childrenOf(schema)) found.push(...rewrites(child, depth + 1));
  return found;
}
