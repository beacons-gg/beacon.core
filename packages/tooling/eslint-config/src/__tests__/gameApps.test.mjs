/**
 * The check behind `beacon-check-tier-gate`, over made-up game apps that lint themselves: one whose
 * config spreads the gate into every block, and one that sets `no-restricted-imports` again for a
 * subtree without it, which is the mistake the check exists to catch. Then the real repo,
 * and the bin.
 */
import { spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGameApps } from "../../scripts/tier-gate.mjs";
import { madeUpRepo } from "./repo.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(packageDir, "../../..");
const BIN = join(packageDir, "scripts/check-tier-gate.mjs");

// A made-up app's config lives in a temp directory, so it imports by absolute URL.
const TIERS = pathToFileURL(join(packageDir, "src/tiers.mjs")).href;
const TSESLINT = pathToFileURL(createRequire(import.meta.url).resolve("typescript-eslint")).href;

/** An app config that spreads the gate, plus `extra` blocks after it. */
const appConfig = (app, extra = "") => `
import tseslint from "${TSESLINT}";
import { gameAppGate } from "${TIERS}";
const gate = gameAppGate(new URL("../../../", import.meta.url), "apps/games/${app}");
const gated = {
  "no-restricted-imports": ["error", { patterns: gate.patterns }],
  "no-restricted-syntax": ["error", ...gate.syntax],
};
export default [
  { files: ["**/*.{ts,tsx}"], languageOptions: { parser: tseslint.default.parser }, rules: gated },
  ${extra}
];
`;

/** A repo with one server package and one game, whose app lints itself under `config`. */
const repoWithApp = (config) =>
  madeUpRepo({
    globs: ["packages/*/*", "apps/games/*"],
    manifests: {
      "packages/server/engine": { name: "@beaconsgg/engine" },
      "packages/game/model": { name: "@game/model" },
      "apps/games/game": { name: "@game/app", scripts: { lint: "eslint ." } },
    },
    files: {
      "apps/games/game/eslint.config.mjs": config,
      "apps/games/game/components/deep/.keep": "",
      "apps/games/game/features/.keep": "",
    },
  });

describe("checkGameApps", () => {
  it("holds for an app whose config spreads the gate into every block", async () => {
    const gatedBlock = `{ files: ["components/**/*.{ts,tsx}"], rules: { ...gated, curly: "error" } },`;
    const repo = repoWithApp(appConfig("game", gatedBlock));
    const lines = [];
    const { total, failures } = await checkGameApps(repo.dir, (line) => lines.push(line));
    expect(failures, lines.join("\n")).toEqual([]);
    // Four directories (the root, components, components/deep, features), two extensions each,
    // plus the banned import planted in its three forms.
    expect(total).toBe(4 * 2 + 3);
    expect(lines.join("\n")).toMatch(
      /import "@beaconsgg\/engine"; is refused by the app's own config/,
    );
  });

  it("fails for a block that sets the rule again without the gate, naming every directory under it", async () => {
    const reset = `{
      files: ["components/**/*.{ts,tsx}"],
      rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["lodash"], message: "x" }] }] },
    },`;
    const repo = repoWithApp(appConfig("game", reset));
    const { failures } = await checkGameApps(repo.dir);
    expect(failures).toEqual([
      "apps/games/game/components: a .ts file there resolves to a config without the gate",
      "apps/games/game/components: a .tsx file there resolves to a config without the gate",
      "apps/games/game/components/deep: a .ts file there resolves to a config without the gate",
      "apps/games/game/components/deep: a .tsx file there resolves to a config without the gate",
    ]);
  });

  it("fails for a gate downgraded to a warning", async () => {
    const warn = `{
      files: ["features/**/*.{ts,tsx}"],
      rules: { "no-restricted-syntax": ["warn", ...gate.syntax] },
    },`;
    const { failures } = await checkGameApps(repoWithApp(appConfig("game", warn)).dir);
    expect(failures).toEqual([
      "apps/games/game/features: a .ts file there resolves to a config without the gate",
      "apps/games/game/features: a .tsx file there resolves to a config without the gate",
    ]);
  });

  it("has nothing to check in a repo with no game app that lints itself", async () => {
    const repo = madeUpRepo({
      globs: ["packages/*/*", "apps/*"],
      manifests: { "packages/server/engine": { name: "@beaconsgg/engine" } },
    });
    expect(await checkGameApps(repo.dir)).toEqual({ total: 0, failures: [] });
  });

  it("holds for this repository's own game apps", async () => {
    const lines = [];
    const { failures } = await checkGameApps(repoRoot, (line) => lines.push(line));
    expect(failures, lines.join("\n")).toEqual([]);
  });
});

describe("the bin", () => {
  const run = (script, cwd) => spawnSync(execPath, [script], { cwd, encoding: "utf8" });

  it("passes a repo with nothing to check, and says so", () => {
    const repo = madeUpRepo({ globs: ["packages/*/*"], manifests: {} });
    const result = run(BIN, repo.dir);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/no game app here lints itself: nothing to check/);
  });

  it("fails, through a symlink as node_modules/.bin reaches it, when an app lost the gate", () => {
    const reset = `{ files: ["**/*.ts"], rules: { "no-restricted-imports": "off" } },`;
    const repo = repoWithApp(appConfig("game", reset));
    const link = join(repo.dir, "beacon-check-tier-gate");
    symlinkSync(BIN, link);
    const result = run(link, repo.dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(
      /FAIL apps\/games\/game\/\*\.ts resolves to a config without the gate/,
    );
    expect(result.stderr).toMatch(/lost the tier gate/);
  });
});
