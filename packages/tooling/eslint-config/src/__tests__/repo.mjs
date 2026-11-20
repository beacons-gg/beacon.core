import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { afterAll } from "vitest";
import { errorRules } from "../../scripts/tier-gate.mjs";

/**
 * A git repo on disk, removed after the suite, holding `files` (by path) added to the index and
 * `untracked` written beside them.
 * @param {Record<string, string>} files
 * @param {Record<string, string>} [untracked]
 */
export function gitRepo(files, untracked = {}) {
  const dir = mkdtempSync(join(tmpdir(), "git-repo-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: dir });
  return dir;
}

/**
 * Run a check's `main` on `dir`, capturing what it prints.
 * @param {(args: string[], cwd: string, io: object) => number} main
 * @param {string} dir
 * @param {string[]} [args]
 */
export function runMain(main, dir, args = []) {
  const out = [];
  const err = [];
  const code = main(args, dir, { log: (l) => out.push(l), error: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** The monorepo's workspace globs: every tier, the apps, and one app per game. */
export const MONOREPO_GLOBS = ["packages/*/*", "apps/*", "apps/games/*", "apps/atlas/*"];

/**
 * A made-up repo on disk, removed after the suite: its workspace globs, a manifest per workspace
 * directory, any other files, and the root manifest's `beacon.foreign` if it names any.
 *
 * @param {object} shape
 * @param {string[]} shape.globs
 * @param {Record<string, object>} shape.manifests by root-relative directory
 * @param {Record<string, string[]>} [shape.foreign]
 * @param {Record<string, string>} [shape.files] by root-relative path
 */
export function madeUpRepo({ globs, manifests, foreign, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "eslint-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write("pnpm-workspace.yaml", `packages:\n${globs.map((glob) => `  - "${glob}"\n`).join("")}`);
  write("package.json", JSON.stringify({ name: "made-up", beacon: foreign && { foreign } }));
  for (const [path, manifest] of Object.entries(manifests)) {
    write(join(path, "package.json"), JSON.stringify(manifest));
  }
  for (const [path, text] of Object.entries(files)) write(path, text);
  return { dir, root: pathToFileURL(`${dir}/`) };
}

/**
 * Lint under `config` as if in `dir`: `fired(file, source)` is the error rules that fire, and
 * `ignored(file)` whether the config skips the file.
 *
 * @param {string} dir
 * @param {import("eslint").Linter.Config[]} config
 */
export function linting(dir, config) {
  const eslint = new ESLint({ cwd: dir, overrideConfigFile: true, overrideConfig: config });
  return {
    fired: (file, source) => errorRules(eslint, join(dir, file), source),
    ignored: (file) => eslint.isPathIgnored(join(dir, file)),
  };
}
