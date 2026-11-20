/**
 * Gate: every game app's own ESLint config carries its tier gate.
 *
 *   beacon-check-tier-gate        (from the repo root; `@beaconsgg/eslint-config`'s bin)
 *
 * A game's app lints itself under its framework's config, so the repo's root pass cannot hold it to
 * the tier gate; its own config spreads `gameAppGate` instead. Nothing but this check notices if a
 * block of that config sets either rule again without the gate.
 *
 * It reads the repo it is run in and nothing else, so it means the same in any repository: one with
 * no game app has nothing to check and says so. Whether the tier gate itself covers a game it does
 * not name is a property of this package, and is held by its own suite over a made-up repo.
 *
 * This module only defines the check; `check-tier-gate.mjs` beside it is the bin that runs it on
 * the working directory, with no entry-point guard (through `node_modules/.bin` one never matches).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import { gameAppGate, selfLintingGameApps } from "../src/tiers.mjs";

/**
 * The rules that fire as errors when `source` is linted as `filePath`.
 *
 * @param {ESLint} eslint
 * @param {string} filePath
 * @param {string} source
 * @returns {Promise<(string | null)[]>}
 */
export async function errorRules(eslint, filePath, source) {
  const [result] = await eslint.lintText(`${source}\n`, { filePath });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId);
}

/**
 * Each game app, through its OWN config. Two checks, naming no game (the apps are read from the
 * workspace):
 *
 * - every directory of the app resolves to a config whose `no-restricted-imports` still carries the
 *   gate's patterns and whose `no-restricted-syntax` still carries its selectors, both as errors. A
 *   block that sets either rule for some subtree without spreading the gate (flat config replaces a
 *   rule's options per block) is caught whatever `files` glob it uses, since this asks ESLint what a
 *   file in each directory would get rather than planting one in a few;
 * - and at the app's root, an import of a package its gate bans is planted in each form and
 *   refused, so the resolved config is also shown to fire.
 */
/** The three import forms, for a name the gate bans. @param {string} name */
const planted = (name) => [
  [`import "${name}";`, "no-restricted-imports"],
  [`void import("${name}");`, "no-restricted-syntax"],
  [`require("${name}");`, "no-restricted-syntax"],
];
const NOT_APP_SOURCE = new Set([
  "node_modules",
  "coverage",
  "dist",
  ".expo",
  ".turbo",
  "__tier_gate__",
]);

/** Every directory under `appDir` that holds app source, app-relative, the root as "". @param {string} appDir */
function sourceDirs(appDir) {
  /** @param {string} rel @returns {string[]} */
  const walk = (rel) => [
    rel,
    ...readdirSync(join(appDir, rel), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NOT_APP_SOURCE.has(e.name))
      .flatMap((e) => walk(rel ? `${rel}/${e.name}` : e.name)),
  ];
  return walk("");
}

/**
 * Does the config `file` resolves to still carry the gate, as errors? The gate's one pattern entry
 * must be among `no-restricted-imports`'s patterns, and each of its selectors among
 * `no-restricted-syntax`'s, compared whole (group, selector and message).
 *
 * @param {ESLint} eslint
 * @param {string} file
 * @param {ReturnType<typeof gameAppGate>} gate
 */
async function carriesGate(eslint, file, gate) {
  const config = await eslint.calculateConfigForFile(file);
  const rule = (/** @type {string} */ name) => {
    const entry = config?.rules?.[name];
    const [severity, ...options] = Array.isArray(entry) ? entry : [entry];
    return { error: severity === 2 || severity === "error", options };
  };
  const imports = rule("no-restricted-imports");
  const syntax = rule("no-restricted-syntax");
  const has = (/** @type {unknown[]} */ list, /** @type {unknown} */ item) =>
    list.some((x) => JSON.stringify(x) === JSON.stringify(item));
  const patterns = imports.options.flatMap((o) => o?.patterns ?? []);
  return (
    imports.error &&
    gate.patterns.every((p) => has(patterns, p)) &&
    syntax.error &&
    gate.syntax.every((s) => has(syntax.options, s))
  );
}

/**
 * Check every game app of the repo at `repoRoot` that lints itself.
 *
 * @param {string} repoRoot
 * @param {(line: string) => void} [log] one line per app and per planted import, and one per failure
 * @returns {Promise<{ total: number, failures: string[] }>}
 */
export async function checkGameApps(repoRoot, log = () => {}) {
  const root = pathToFileURL(`${repoRoot}/`);
  /** @type {string[]} */
  const failures = [];
  let total = 0;
  for (const app of selfLintingGameApps(root)) {
    const appDir = join(repoRoot, app);
    const eslint = new ESLint({ cwd: appDir });
    const gate = gameAppGate(root, app);
    const dirs = sourceDirs(appDir);
    let lost = 0;
    for (const place of dirs) {
      for (const ext of ["ts", "tsx"]) {
        total += 1;
        if (await carriesGate(eslint, join(appDir, place, `__tier_gate__.${ext}`), gate)) continue;
        lost += 1;
        failures.push(
          `${app}/${place}: a .${ext} file there resolves to a config without the gate`,
        );
        log(
          `  FAIL ${app}/${place ? `${place}/` : ""}*.${ext} resolves to a config without the gate`,
        );
      }
    }
    log(
      `  ${lost ? "FAIL" : "ok  "} ${app}: every one of its ${dirs.length} directories resolves to a config carrying the gate, for .ts and .tsx`,
    );
    // The first name the gate bans, with any `*` segment filled in: banned here by construction.
    const banned = gate.patterns[0]?.group[0]?.replace(/\*/g, "x");
    for (const [source, rule] of banned ? planted(banned) : []) {
      total += 1;
      const fired = await errorRules(eslint, join(appDir, "__tier_gate__.ts"), source);
      const ok = fired.includes(rule);
      const label = `${app}: ${source} is refused by the app's own config (${rule})`;
      log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
      if (!ok) {
        log(`         fired: ${JSON.stringify(fired)}`);
        failures.push(label);
      }
    }
  }
  return { total, failures };
}
