#!/usr/bin/env node
/**
 * Writes the consumer the canary runs the five flows from (.github/workflows/install-check.yml, the
 * `flows` job): a directory outside this workspace that installs the five-flow driver,
 * `@beaconsgg/flows`, with the seven core packages forced to one version.
 *
 *   node scripts/canary-driver.mjs 0.0.0-canary.gabc1234.1 /tmp/driver http://127.0.0.1:4873/
 *
 * The driver is the server repository's (beacon.server publishes it): a client that
 * places, contributes, claims, publishes a profile and reads a live update through the SDK. It
 * names the seven at a release range, which a throwaway `0.0.0-canary.*` build can never satisfy,
 * so the directory's pnpm `overrides` point each of the seven at the canary: the driver as
 * published, over the core this pull request would publish. Run against the server as released,
 * that is the cell the server's own skew matrix cannot have, a core that is not published yet.
 *
 * Not a check script: it writes a directory, and the workflow installs and runs what is in it.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The seven: the one fixed group, which is what a client and a server must agree on. */
const CORE_DIRS = ["packages/core", "packages/client"];
const DRIVER = "@beaconsgg/flows";

const [version, target, registry] = process.argv.slice(2);
if (!version || version.startsWith("-") || !target || !registry) {
  console.error("usage: node scripts/canary-driver.mjs <published version> <directory> <registry>");
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
// `yaml` is the lint preset's dependency, not the root's.
const { parse } = createRequire(join(repoRoot, "packages/tooling/eslint-config/package.json"))(
  "yaml",
);
const { catalog } = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));

const seven = CORE_DIRS.flatMap((dir) =>
  readdirSync(join(repoRoot, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJson(join(repoRoot, dir, entry.name, "package.json")).name),
).sort();

mkdirSync(target, { recursive: true });
writeFileSync(
  join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "canary-driver",
      private: true,
      // The same pnpm as this repository: without the pin, a runner's default pnpm installs it.
      packageManager: readJson(join(repoRoot, "package.json")).packageManager,
      // The newest driver, and the peer the seven's schemas are written in.
      dependencies: { [DRIVER]: "latest", zod: catalog.zod },
    },
    null,
    2,
  )}\n`,
);
// The scope from the throwaway registry the canary went to, and everything else from npmjs.
writeFileSync(join(target, ".npmrc"), `@beaconsgg:registry=${registry}\n`);
const overrides = seven.map((name) => `  "${name}": ${version}`);
writeFileSync(
  join(target, "pnpm-workspace.yaml"),
  ["packages: []", "overrides:", ...overrides, ""].join("\n"),
);

console.log(`${DRIVER} over the seven at ${version}: ${target}`);
console.log(`overridden: ${seven.join(", ")}`);
