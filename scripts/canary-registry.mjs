#!/usr/bin/env node
/**
 * Writes the config of the throwaway registry the install check publishes its canary to
 * (.github/workflows/install-check.yml, through .github/actions/canary-registry): a Verdaccio that
 * lives only inside one CI job, so a canary never reaches a real registry.
 *
 *   UPSTREAM_REGISTRY=https://packages.example.dev/ node scripts/canary-registry.mjs /tmp/registry
 *
 * The registry holds every package this repository publishes and nothing else, with no uplink: a
 * canary is published there, and a name with a release elsewhere is not looked up there, so the
 * consumer gets the canary or nothing. Every other `@beaconsgg/*` package, such as the server
 * repository's five-flow driver, comes through from `UPSTREAM_REGISTRY`, the real registry the
 * scope is installed from. With `UPSTREAM_TOKEN` in the environment the registry sends that token
 * to the upstream; Verdaccio reads it from its own environment when it starts, so the token is
 * never written down. The consumers map only `@beaconsgg` here, and install the rest from npmjs.
 *
 * The config is JSON, which Verdaccio reads as YAML. Storage is `<directory>/storage`, so a later
 * job can start a registry over a copy of what an earlier job published. A publish needs a user,
 * which the htpasswd file beside it holds, and anyone may read.
 *
 * Not a check script: it writes a file, and the action starts the registry over it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_DIRS = ["packages/core", "packages/client", "packages/tooling"];

const [target] = process.argv.slice(2);
const upstream = process.env.UPSTREAM_REGISTRY;
if (!target || target.startsWith("-") || !upstream) {
  console.error("usage: UPSTREAM_REGISTRY=<url> node scripts/canary-registry.mjs <directory>");
  process.exit(2);
}

const published = PUBLISHED_DIRS.flatMap((dir) =>
  readdirSync(join(repoRoot, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(repoRoot, dir, entry.name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")))
    .filter((manifest) => !manifest.private)
    .map((manifest) => manifest.name),
).sort();

const local = { access: "$all", publish: "$authenticated", unpublish: "$authenticated" };
const config = {
  storage: join(resolve(target), "storage"),
  auth: { htpasswd: { file: join(resolve(target), "htpasswd") } },
  uplinks: {
    upstream: {
      url: upstream,
      ...(process.env.UPSTREAM_TOKEN
        ? { auth: { type: "bearer", token_env: "UPSTREAM_TOKEN" } }
        : {}),
    },
  },
  // The first entry a name matches wins: the published names before the scope.
  packages: {
    ...Object.fromEntries(published.map((name) => [name, local])),
    "@beaconsgg/*": { access: "$all", proxy: "upstream" },
  },
  log: { type: "stdout", format: "pretty", level: "warn" },
};

mkdirSync(target, { recursive: true });
writeFileSync(join(target, "config.yaml"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`registry config: ${join(target, "config.yaml")}`);
console.log(`local only: ${published.join(", ")}`);
console.log(`@beaconsgg/* otherwise from ${upstream}`);
