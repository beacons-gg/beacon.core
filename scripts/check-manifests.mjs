#!/usr/bin/env node
/**
 * Gate: every published manifest matches the root where it must. Each package ships the
 * repository's license and its notice, and declares the repository's minimum Node.
 *
 * npm and pnpm pack a package from its own directory, so the root `LICENSE` and `NOTICE` never
 * reach a tarball. Each package therefore keeps a copy of both next to its `package.json`, names
 * them in `files`, and declares the same SPDX id. This checks all of that for every package under
 * the published tiers, so a new package cannot merge without them and a copy cannot drift from the
 * root.
 *
 * The minimum runtime is part of what a package promises (`doc/core-compatibility.md` §3), so each
 * published manifest declares the root's `engines.node` too.
 *
 *     node scripts/check-manifests.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const SPDX = "Apache-2.0";
const PUBLISHED_TIERS = ["packages/core", "packages/client", "packages/tooling"];
const SHIPPED_FILES = ["LICENSE", "NOTICE"];

const rootNode = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).engines?.node;
if (typeof rootNode !== "string") {
  console.error("check-manifests: the root package.json declares no engines.node to check against");
  process.exit(1);
}
const rootCopies = Object.fromEntries(
  SHIPPED_FILES.map((name) => [name, readFileSync(join(repoRoot, name), "utf8")]),
);
const problems = [];

for (const tier of PUBLISHED_TIERS) {
  for (const entry of readdirSync(join(repoRoot, tier), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(repoRoot, tier, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.private) continue;
    const where = relative(repoRoot, dir);

    if (manifest.license !== SPDX) {
      problems.push(
        `${where}: "license" is ${JSON.stringify(manifest.license)}, expected "${SPDX}"`,
      );
    }
    if (manifest.engines?.node !== rootNode) {
      problems.push(
        `${where}: "engines.node" is ${JSON.stringify(manifest.engines?.node)}, expected ${JSON.stringify(rootNode)} as in the root manifest`,
      );
    }
    for (const name of SHIPPED_FILES) {
      if (!manifest.files?.includes(name)) {
        problems.push(
          `${where}: "files" does not list ${name}, so the tarball would ship without it`,
        );
      }
      const path = join(dir, name);
      if (!existsSync(path)) {
        problems.push(`${where}: no ${name} file (copy the root ${name})`);
      } else if (readFileSync(path, "utf8") !== rootCopies[name]) {
        problems.push(`${where}: ${name} differs from the root ${name} (copy it again)`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`check-manifests: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  "check-manifests: every published package ships the root LICENSE and NOTICE and the root's engines.node.",
);
