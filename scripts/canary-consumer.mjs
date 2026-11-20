#!/usr/bin/env node
/**
 * Writes a consumer of what this repository publishes, for the canary
 * (.github/workflows/install-check.yml): a small repository outside this workspace whose manifest names
 * every published package at one version, the seven core packages (`packages/core/*` and
 * `packages/client/*`, doc/core-compatibility.md) and the tooling presets (`packages/tooling/*`),
 * and which uses each the way a repository that installs them does.
 *
 *   node scripts/canary-consumer.mjs 0.0.0-canary.gabc1234.1 /tmp/consumer http://127.0.0.1:4873/
 *
 * The canary used to turn THIS checkout into the consumer and run the server, the console and the
 * game over the registry copies. They are their own repositories now and run their own CI
 * over the published packages, so nothing here is left to rewrite. What the canary still proves is
 * the published artifact, which the workspace copies cannot: `files`, the exports maps, the
 * rewritten `workspace:*` and `catalog:` ranges, the peers, and each preset resolved by name from
 * `node_modules`. The consumer it writes:
 *
 * - `load.mjs` loads every entry point of every published package (each key of each exports map),
 *   so a missing file or a bad map fails by name;
 * - `src/a.ts` and its test import one of the seven, typecheck under `@beaconsgg/tsconfig`, and run
 *   under `@beaconsgg/vitest-config` with its coverage floor. The consumer is a CommonJS package, as
 *   every workspace that re-exports the vitest preset is: the preset's build is CommonJS, and an
 *   ES-module package re-exporting its default gets the module object, not the config;
 * - `eslint.config.mjs` is `@beaconsgg/eslint-config`'s `repoConfig`, and the manifest formats with
 *   `@beaconsgg/prettier-config`;
 * - its scripts are what the presets' two bins check.
 *
 * Not a check script: it writes a directory, and the workflow runs what is in it.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_DIRS = ["packages/core", "packages/client", "packages/tooling"];
/** What the consumer uses beside the published packages' own peers. */
const TOOLS = ["prettier"];

const [version, target, registry] = process.argv.slice(2);
if (!version || version.startsWith("-") || !target || !registry) {
  console.error(
    "usage: node scripts/canary-consumer.mjs <published version> <directory> <registry>",
  );
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
// `yaml` is the lint preset's dependency, not the root's.
const { parse } = createRequire(join(repoRoot, "packages/tooling/eslint-config/package.json"))(
  "yaml",
);
const { catalog } = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));

/** Every published manifest: a public package under a published directory. */
const published = PUBLISHED_DIRS.flatMap((dir) =>
  readdirSync(join(repoRoot, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJson(join(repoRoot, dir, entry.name, "package.json"))),
).sort((a, b) => a.name.localeCompare(b.name));
const privateOnes = published.filter((manifest) => manifest.private);
if (privateOnes.length > 0) {
  throw new Error(`${privateOnes.map((m) => m.name).join(", ")}: private, so not published`);
}
const names = published.map((manifest) => manifest.name);

/** A peer or tool at the catalogued range: what a consumer of this repository's catalog installs. */
function catalogued(name) {
  const range = catalog[name];
  if (!range) throw new Error(`${name} is not in the catalog (pnpm-workspace.yaml)`);
  return range;
}
const peers = published
  .flatMap((manifest) => Object.keys(manifest.peerDependencies ?? {}))
  .filter((name) => !names.includes(name));
const dependencies = Object.fromEntries([
  ...names.map((name) => [name, version]),
  ...[...new Set([...peers, ...TOOLS])].sort().map((name) => [name, catalogued(name)]),
]);

/** Every entry point: each key of the exports map, or the bare name when there is none. */
const entryPoints = published.flatMap(({ name, exports: map }) =>
  map ? Object.keys(map).map((key) => name + key.slice(1)) : [name],
);

const write = (path, text) => {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), text);
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

write(
  "package.json",
  json({
    name: "canary-consumer",
    private: true,
    // The same pnpm as this repository: without the pin, a runner's default pnpm installs it.
    packageManager: readJson(join(repoRoot, "package.json")).packageManager,
    scripts: { test: "vitest run", "test:coverage": "vitest run --coverage" },
    dependencies,
    prettier: "@beaconsgg/prettier-config",
  }),
);
// The scope from the throwaway registry the canary went to, and everything else from npmjs.
writeFileSync(join(target, ".npmrc"), `@beaconsgg:registry=${registry}\n`);
// A repository of one package: no members, and the one install script vitest needs.
write("pnpm-workspace.yaml", "packages: []\nonlyBuiltDependencies:\n  - esbuild\n");
// As Prettier writes it, since the format check below reads it.
write(
  "tsconfig.json",
  [
    "{",
    '  "extends": "@beaconsgg/tsconfig/base.json",',
    '  "compilerOptions": { "noEmit": true },',
    '  "include": ["src"]',
    "}",
    "",
  ].join("\n"),
);
write("vitest.config.ts", 'export { default } from "@beaconsgg/vitest-config";\n');
write(
  "eslint.config.mjs",
  [
    'import { URL } from "node:url";',
    'import { repoConfig } from "@beaconsgg/eslint-config";',
    "",
    'export default repoConfig(new URL("./", import.meta.url));',
    "",
  ].join("\n"),
);
write(
  "src/a.ts",
  [
    'import { canonicalJson } from "@beaconsgg/protocol-types";',
    "",
    "/** One call into one of the seven, through its published types. */",
    "export const canonical: string = canonicalJson({ b: 1, a: 2 });",
    "",
  ].join("\n"),
);
write(
  "src/__tests__/a.test.ts",
  [
    'import { describe, expect, it } from "vitest";',
    'import { canonical } from "../a";',
    "",
    'describe("a consumer of the published packages", () => {',
    '  it("runs the published build", () => {',
    '    expect(canonical).toBe(\'{"a":2,"b":1}\');',
    "  });",
    "});",
    "",
  ].join("\n"),
);
// A JSON entry (a tsconfig, a manifest) is resolved, anything else is imported: both fail by name
// when the exports map points at a file the tarball does not hold.
write(
  "load.mjs",
  [
    'import { createRequire } from "node:module";',
    "",
    "const require = createRequire(import.meta.url);",
    `const entryPoints = ${JSON.stringify(entryPoints, null, 2)};`,
    "for (const entry of entryPoints) {",
    '  if (entry.endsWith(".json")) require.resolve(entry);',
    "  else await import(entry);",
    "  console.log(`ok   ${entry}`);",
    "}",
    "",
  ].join("\n"),
);

console.log(`a consumer of ${names.length} published packages at ${version}: ${target}`);
console.log(`entry points: ${entryPoints.join(", ")}`);
