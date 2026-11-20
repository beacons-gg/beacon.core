/**
 * Gate: every workspace that runs tests reports coverage, and holds a floor.
 *
 *   beacon-check-coverage-tasks        (from the repo root; `@beaconsgg/vitest-config`'s bin)
 *
 * Two invariants, both of the same shape: something the gate relies on that nothing else would
 * notice the absence of.
 *
 * 1. **`test` without `test:coverage`.** The gate's test step is `turbo run test:coverage`, not
 *    `turbo run test` (CONTRIBUTING.md says why). Turbo silently skips a package that does not
 *    declare the task it was asked for, so such a workspace sails through a green gate with
 *    nothing having run its suite.
 *
 * 2. **`test:coverage` without a floor.** Every vitest workspace gets its floor by routing through
 *    `@beaconsgg/vitest-config`, whose `coverageFor` always sets `thresholds.lines`. A workspace that
 *    writes its own config instead reports a number and gates nothing, which is exactly the state
 *    this gate exists to end, and it would look identical in the log.
 *
 * The second check is on the **route**, not the resolved number: it asserts the coverage block is
 * one of the two shapes that always carry a floor, rather than loading each config and reading the
 * value back. That is deliberate. `vitest.config.ts` is TypeScript resolving `vitest/config` per
 * workspace, so reading the effective value would mean running vitest, which the gate is already
 * doing three lines later. The route is the property worth holding anyway: floors belong together.
 *
 * The two shapes are `export { default } from "@beaconsgg/vitest-config"` (the workspaces on the repo
 * floor) and a call to `coverageFor(…)` imported from it (the ones under the floor, and the ones
 * that add something of their own, such as the server's global setup). Testing for the module name
 * alone would not do: the preset also exports `SRC_SCOPE` and `REPO_FLOOR`, and a config that
 * imports `SRC_SCOPE` and hand-rolls the rest sets no threshold while looking routed. Testing for
 * the shape alone would not do either: `export { default } from "./anything"` has the shape and
 * may carry no floor, so the shape has to come from the preset. And the re-export only carries
 * the floor in a CommonJS package (see `vitestConfigProblem`), so an ES-module package must call.
 *
 * Plain JavaScript on purpose, not compiled: the gate runs it before anything is built, and on a
 * pull request the affected build may not build this package at all.
 *
 * This module only defines the check. `check-coverage-tasks.mjs` beside it is the bin that runs
 * it, and has no "am I the entry point" guard to get wrong: a bin is reached through a symlink in
 * `node_modules/.bin`, where the path node was given and this file's own URL never match.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const PRESET = "@beaconsgg/vitest-config";

/** A workspace's config routes through the preset: by name, or from source for the preset itself. */
function importsThePreset(workspaceName, text) {
  const from = workspaceName === PRESET ? String.raw`\./src/coverage` : PRESET;
  return new RegExp(String.raw`from\s+["']${from}["']`).test(text);
}

/**
 * Why a `vitest.config.ts` holds no floor, or undefined when it does.
 *
 * The re-export is refused in an ES-module package (`"type": "module"`). The preset's build is
 * CommonJS, and what an ES module gets as the `default` of a CommonJS module is the whole module
 * object, not its `default` export: vitest would read `{ default, coverageFor, … }` as a config,
 * find no `test` key, and run with no coverage scope and no floor, while the route this check
 * holds stayed intact. `coverageFor` is a named export, which an ES
 * module does get, so the call is the form that works there.
 * @param {string} workspaceName
 * @param {string} text the config's source
 * @param {{ esm?: boolean }} [workspace] whether the workspace is an ES-module package
 * @returns {string | undefined}
 */
export function vitestConfigProblem(workspaceName, text, { esm = false } = {}) {
  const calls = text.includes("coverageFor(");
  const reexports = /export\s*\{\s*default\s*\}\s*from/.test(text);
  if (!((calls || reexports) && importsThePreset(workspaceName, text))) {
    return (
      `${workspaceName}: vitest.config.ts builds its own coverage block, so it reports a number ` +
      `without a floor. Re-export ${PRESET}'s config, or call its \`coverageFor\`.`
    );
  }
  if (esm && reexports && !calls) {
    return (
      `${workspaceName}: is an ES-module package ("type": "module") and re-exports ${PRESET}'s ` +
      `default, which there is the module object and not the config: vitest would run with no ` +
      `coverage scope and no floor. In vitest.config.ts, call its \`coverageFor\` inside ` +
      `\`defineConfig\` instead.`
    );
  }
  return undefined;
}

/**
 * What is wrong with one workspace, or undefined. One problem at most: each rule presupposes the
 * one before it.
 * @param {{ name: string, path: string }} workspace
 * @returns {string | undefined}
 */
export function workspaceProblem(workspace) {
  const manifest = JSON.parse(readFileSync(join(workspace.path, "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};

  if (scripts.test !== undefined && scripts["test:coverage"] === undefined) {
    return (
      `${workspace.name}: has a \`test\` script and no \`test:coverage\`, so the gate would not ` +
      `run its suite at all. Add one.`
    );
  }
  if (scripts["test:coverage"] === undefined) return undefined;

  const vitestConfig = join(workspace.path, "vitest.config.ts");
  const jestConfig = join(workspace.path, "jest.config.js");
  if (existsSync(vitestConfig)) {
    return vitestConfigProblem(workspace.name, readFileSync(vitestConfig, "utf8"), {
      esm: manifest.type === "module",
    });
  }
  if (existsSync(jestConfig)) {
    return readFileSync(jestConfig, "utf8").includes("coverageThreshold")
      ? undefined
      : `${workspace.name}: jest.config.js declares no \`coverageThreshold\`.`;
  }
  return (
    `${workspace.name}: has a \`test:coverage\` script and no vitest or jest config, so nothing ` +
    `gives it a coverage floor.`
  );
}

/**
 * Every problem in the repo at `cwd`. Asks pnpm for the workspace list rather than re-globbing
 * pnpm-workspace.yaml, so a new member cannot be in the workspace and outside this check at the
 * same time.
 *
 * The root of a multi-workspace repo is left out: its `test:coverage` passes the task on to its
 * members and has no suite of its own. A single-package repo's root is its only workspace, runs
 * its suite itself, and is checked like any other.
 * @param {string} cwd the repo's root
 * @returns {string[]}
 */
export function repoProblems(cwd) {
  const workspaces = JSON.parse(
    execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { cwd, encoding: "utf8" }),
  );
  const root = realpathSync(cwd);
  const members =
    workspaces.length > 1 ? workspaces.filter((w) => realpathSync(w.path) !== root) : workspaces;
  return members.map(workspaceProblem).filter((problem) => problem !== undefined);
}
