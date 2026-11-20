/**
 * A repo with no tiers to read: a single client-bound package. It takes the base preset and the
 * RN-safety gate on their own, without the tier assembly.
 */
import prettier from "eslint-config-prettier";
import { describe, expect, it } from "vitest";
import { base, rnSafe } from "../index.mjs";
import { linting, madeUpRepo } from "./repo.mjs";

const { dir } = madeUpRepo({ globs: [], manifests: {} });

describe("base", () => {
  const { fired, ignored } = linting(dir, base());

  it("holds the two rules this codebase adds to the recommended sets", async () => {
    expect(await fired("src/a.ts", "export const a: any = 1;")).toEqual([
      "@typescript-eslint/no-explicit-any",
    ]);
    expect(await fired("src/a.ts", "const unused = 1;")).toEqual([
      "@typescript-eslint/no-unused-vars",
    ]);
    expect(await fired("src/a.ts", "const _unused = 1;\nexport {};")).toEqual([]);
  });

  it("never lints build output or a repo's scripts, and takes a repo's own ignores on top", async () => {
    expect(await ignored("dist/a.js")).toBe(true);
    expect(await ignored("scripts/build.mjs")).toBe(true);
    expect(await ignored("src/a.ts")).toBe(false);
    expect(await ignored("generated/a.ts")).toBe(false);
    const own = linting(dir, base({ ignores: ["generated/**"] }));
    expect(await own.ignored("generated/a.ts")).toBe(true);
  });

  it("puts Prettier's overrides last, after the repo's gates", () => {
    const gate = { files: ["src/**/*.ts"], rules: { curly: "error" } };
    const config = base({ gates: [gate] });
    expect(config.at(-2)).toBe(gate);
    expect(config.at(-1)).toBe(prettier);
  });
});

describe("rnSafe", () => {
  const { fired } = linting(dir, base({ gates: [rnSafe(["src/**/*.ts"])] }));

  it.each([
    ['import "fs";', "no-restricted-imports"],
    ['import "node:path";', "no-restricted-imports"],
    ['export * from "crypto";', "no-restricted-imports"],
    ['void import("node:fs");', "no-restricted-syntax"],
    ['export type T = import("stream").Readable;', "no-restricted-syntax"],
  ])("refuses %s in client-bound code", async (source, rule) => {
    expect(await fired("src/a.ts", source)).toContain(rule);
  });

  it("leaves everything else alone, and code outside its files", async () => {
    expect(await fired("src/a.ts", 'import "zod";')).toEqual([]);
    expect(await fired("tools/build.ts", 'import "node:fs";')).toEqual([]);
  });
});
