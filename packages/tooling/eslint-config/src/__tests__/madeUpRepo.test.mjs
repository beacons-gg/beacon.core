/**
 * The tier gate covers a game it has never heard of.
 *
 * The preset names no game. It reads the tiers, their packages and the workspaces that lint
 * themselves from the repo it is handed. This is a made-up repo with a SECOND game
 * (`packages/othergame`, `apps/games/othergame`) that no line of the preset mentions, linted under
 * the real config, with every tier asserted to refuse what it must. Each "may" row is the control:
 * a ban that refused everything would pass every "may not" row. The platform's own bans (core,
 * server, test fixtures) are held here too, since they share the config.
 *
 * Linting a real repo cannot show this: it has one game, so a config that still named it would lint
 * it identically.
 */
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { gameAppGate, repoConfig } from "../index.mjs";
import { MONOREPO_GLOBS, linting, madeUpRepo } from "./repo.mjs";

/** The made-up repo: one package per tier, and two games. */
const MANIFESTS = {
  "packages/core/geo": { name: "@beaconsgg/geo" },
  "packages/server/engine": { name: "@beaconsgg/engine" },
  "packages/client/sdk": { name: "@beaconsgg/sdk" },
  "packages/admin/plugin": { name: "@beaconsgg/admin-plugin" },
  // A tooling preset: a platform tier every other tier may import, and no game's.
  "packages/tooling/preset": { name: "@beaconsgg/preset" },
  "packages/kites/game": { name: "@kites/game" },
  "packages/othergame/model": { name: "@other/model" },
  "packages/othergame/admin-plugin": { name: "@other/beacon-admin-plugin" },
  // A lint script of its own does not take a gated workspace out of the gate.
  "apps/server": { name: "@beaconsgg/server-app", scripts: { lint: "eslint ." } },
  // The second game's app, which lints itself: its own config spreads `gameAppGate`...
  "apps/games/othergame": { name: "@other/app", scripts: { lint: "eslint ." } },
  // ...and one that does not, which the root pass lints in full, gate included. It is no tier's app.
  "apps/games/plain": { name: "@plain/app" },
  // The console, with a lint script of its own: its gate still holds.
  "apps/admin": { name: "@beaconsgg/admin", scripts: { lint: "eslint ." } },
};

/** `[file, source, rule that must fire, or null for none]`. */
const CASES = [
  // The second game's packages, from every tier that may not have them.
  ["apps/server/src/a.ts", 'import "@other/model";', "no-restricted-imports"],
  ["apps/server/src/a.ts", 'export type T = import("@other/model").X;', "no-restricted-syntax"],
  ["apps/server/src/a.ts", 'import "@other/app";', "no-restricted-imports"],
  ["packages/server/engine/src/a.ts", 'import "@other/model/deep";', "no-restricted-imports"],
  ["packages/core/geo/src/a.ts", 'import "@other/model";', "no-restricted-imports"],
  ["packages/client/sdk/src/a.ts", 'import "@other/model";', "no-restricted-imports"],
  ["packages/kites/game/src/a.ts", 'import "@other/model";', "no-restricted-imports"],
  // The second game's own tier: gated like the first, without being named.
  ["packages/othergame/model/src/a.ts", 'import "@beaconsgg/engine";', "no-restricted-imports"],
  ["packages/othergame/model/src/a.ts", 'import "@kites/game";', "no-restricted-imports"],
  ["packages/othergame/model/src/a.ts", 'import "node:fs";', "no-restricted-imports"],
  [
    "packages/othergame/model/src/a.ts",
    'void import("@beaconsgg/engine");',
    "no-restricted-syntax",
  ],
  ["packages/othergame/model/src/a.tsx", 'import "@beaconsgg/engine";', "no-restricted-imports"],
  // The console reaches a game only through its plugin list, and never a server package.
  ["apps/admin/features/a.tsx", 'import "@other/model";', "no-restricted-imports"],
  ["apps/admin/features/a.tsx", 'import "@kites/game";', "no-restricted-imports"],
  ["apps/admin/features/a.tsx", 'void import("@other/model");', "no-restricted-syntax"],
  ["apps/admin/features/a.ts", 'import "@beaconsgg/engine";', "no-restricted-imports"],
  ["apps/admin/features/a.tsx", 'import "@other/beacon-admin-plugin";', "no-restricted-imports"],
  ["apps/admin/plugins.ts", 'import "@beaconsgg/engine";', "no-restricted-imports"],
  ["apps/admin/plugins.ts", 'import "@other/model";', "no-restricted-imports"],
  // Only a game's plugin reaches the console's contract, and the rest of the game never the plugin.
  [
    "packages/othergame/model/src/a.tsx",
    'import "@beaconsgg/admin-plugin";',
    "no-restricted-imports",
  ],
  [
    "packages/othergame/model/src/a.ts",
    'import "@other/beacon-admin-plugin";',
    "no-restricted-imports",
  ],
  ["packages/othergame/admin-plugin/src/a.tsx", 'import "@kites/game";', "no-restricted-imports"],
  [
    "packages/othergame/admin-plugin/src/a.tsx",
    'import "@beaconsgg/engine";',
    "no-restricted-imports",
  ],
  // A game's app with no lint script of its own: the root pass holds it to its tier's bans, and it
  // may not bundle a console plugin. `plain` is no tier's app, so every game's is another's.
  ["apps/games/plain/src/a.ts", 'import "@beaconsgg/engine";', "no-restricted-imports"],
  ["apps/games/plain/src/a.ts", 'import "@other/model";', "no-restricted-imports"],
  ["apps/games/plain/src/a.tsx", 'import "@other/beacon-admin-plugin";', "no-restricted-imports"],
  ["apps/games/plain/src/a.ts", 'void import("@beaconsgg/admin");', "no-restricted-syntax"],
  ["apps/games/plain/src/a.ts", 'require("@beaconsgg/engine");', "no-restricted-syntax"],
  // The console's plugin contract builds against no game and no server.
  ["packages/admin/plugin/src/a.ts", 'import "@other/model";', "no-restricted-imports"],
  ["packages/admin/plugin/src/a.ts", 'import "@beaconsgg/engine";', "no-restricted-imports"],
  // Nothing imports the console app itself: a plugin reaches it only through the host.
  [
    "packages/othergame/admin-plugin/src/a.tsx",
    'import "@beaconsgg/admin/lib/api";',
    "no-restricted-imports",
  ],
  ["packages/othergame/model/src/a.ts", 'import "@beaconsgg/admin";', "no-restricted-imports"],
  ["packages/admin/plugin/src/a.ts", 'import "@beaconsgg/admin/lib/api";', "no-restricted-imports"],
  ["packages/core/geo/src/a.ts", 'import "@beaconsgg/admin";', "no-restricted-imports"],
  ["packages/client/sdk/src/a.ts", 'import "@beaconsgg/admin";', "no-restricted-imports"],
  ["apps/server/src/a.ts", 'type T = import("@beaconsgg/admin").X;', "no-restricted-syntax"],
  // The platform's own bans, which name no game but live in the same rewritten config.
  ["packages/core/geo/src/a.ts", 'import "@beaconsgg/engine";', "no-restricted-imports"],
  ["packages/core/geo/src/a.ts", 'import "@beaconsgg/admin-plugin";', "no-restricted-imports"],
  ["packages/client/sdk/src/a.ts", 'import "@beaconsgg/admin-plugin";', "no-restricted-imports"],
  ["apps/server/src/a.ts", 'import "@beaconsgg/admin-plugin";', "no-restricted-imports"],
  ["apps/server/src/a.ts", 'import "@beaconsgg/sdk";', "no-restricted-imports"],
  ["apps/server/src/a.ts", 'import "@beaconsgg/policy-engine/testing";', "no-restricted-imports"],
  // Controls: what each tier may import.
  ["apps/server/src/__tests__/a.test.ts", 'import "@beaconsgg/policy-engine/testing";', null],
  ["packages/othergame/model/src/a.ts", 'import "@beaconsgg/geo";', null],
  ["packages/othergame/model/src/a.ts", 'import "@beaconsgg/sdk";', null],
  ["apps/server/src/a.ts", 'import "@beaconsgg/engine";', null],
  ["apps/admin/plugins.ts", 'import "@other/beacon-admin-plugin";', null],
  ["apps/admin/features/a.tsx", 'import "@beaconsgg/admin-plugin";', null],
  ["apps/admin/features/a.tsx", 'import "@beaconsgg/sdk";', null],
  ["packages/othergame/admin-plugin/src/a.tsx", 'import "@beaconsgg/admin-plugin";', null],
  ["packages/othergame/admin-plugin/src/a.tsx", 'import "@other/model";', null],
  ["apps/games/plain/src/a.ts", 'import "@beaconsgg/geo";', null],
  // The tooling tier is nobody's game: every tier may import a preset. Were `tooling` missing
  // from PLATFORM_TIERS it would be gated as one, and each of these would be refused.
  ["packages/core/geo/vitest.config.ts", 'import "@beaconsgg/preset";', null],
  ["packages/client/sdk/src/a.ts", 'import "@beaconsgg/preset";', null],
  ["packages/admin/plugin/src/a.ts", 'import "@beaconsgg/preset";', null],
  ["packages/server/engine/src/a.ts", 'import "@beaconsgg/preset";', null],
  ["packages/othergame/model/src/a.ts", 'import "@beaconsgg/preset";', null],
  ["apps/admin/features/a.tsx", 'import "@beaconsgg/preset";', null],
  ["apps/games/plain/src/a.ts", 'import "@beaconsgg/preset";', null],
  // A preset is build-time code, so Node is its home: it is not held to the device's ban.
  ["packages/tooling/preset/src/a.ts", 'import "node:path";', null],
];

/**
 * What `gameAppGate` hands the second game's app for its own config: its tier's bans, plus every
 * console plugin, its own included. Linted through a config made of nothing but the gate, the
 * way the app's config spreads it. `[source, rule that must fire, or null]`.
 */
const APP_GATE_CASES = [
  ['import "@beaconsgg/engine";', "no-restricted-imports"],
  ['import "@kites/game";', "no-restricted-imports"],
  ['import "@beaconsgg/admin-plugin";', "no-restricted-imports"],
  ['import "@other/beacon-admin-plugin";', "no-restricted-imports"],
  ['import "@beaconsgg/admin";', "no-restricted-imports"],
  ['void import("@beaconsgg/engine");', "no-restricted-syntax"],
  ['export type T = import("@other/beacon-admin-plugin").X;', "no-restricted-syntax"],
  ['require("@other/beacon-admin-plugin");', "no-restricted-syntax"],
  ['require("@beaconsgg/engine/deep");', "no-restricted-syntax"],
  ['import "@other/model";', null],
  ['require("@other/model");', null],
  ['import "@beaconsgg/sdk";', null],
  ['import "@beaconsgg/geo";', null],
];

/**
 * A workspace with a lint script of its own is the root pass's to skip, unless a tier gate applies to
 * it; the rest are its to lint. A game app that lints itself carries its gate in its own config
 * (`APP_GATE_CASES`, and the planted import below), so it is skipped.
 */
const IGNORED = [
  ["apps/games/othergame/src/a.ts", true],
  ["apps/games/plain/src/a.ts", false],
  ["apps/server/src/a.ts", false],
  ["apps/admin/features/a.tsx", false],
];

const { dir, root } = madeUpRepo({ globs: MONOREPO_GLOBS, manifests: MANIFESTS });

describe("the repo's root pass, over a repo with a second game", () => {
  const { fired, ignored } = linting(dir, repoConfig(root));

  it.each(CASES)("%s: %s fires %s", async (file, source, rule) => {
    const rules = await fired(file, source);
    if (rule === null) expect(rules).toEqual([]);
    else expect(rules).toContain(rule);
  });

  it.each(IGNORED)("%s is left to its own lint: %s", async (file, expected) => {
    expect(await ignored(file)).toBe(expected);
  });
});

describe("the gate a self-linting game app spreads into its own config", () => {
  // Linted through a config made of nothing but the gate, the way the app's config spreads it.
  const gate = gameAppGate(root, "apps/games/othergame");
  const { fired } = linting(dir, [
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: { parser: tseslint.parser },
      rules: {
        "no-restricted-imports": ["error", { patterns: gate.patterns }],
        "no-restricted-syntax": ["error", ...gate.syntax],
      },
    },
  ]);

  it.each(APP_GATE_CASES)("%s fires %s", async (source, rule) => {
    const rules = await fired("apps/games/othergame/src/a.tsx", source);
    if (rule === null) expect(rules).toEqual([]);
    else expect(rules).toContain(rule);
  });

  it("is refused for a directory that is not a game app", () => {
    expect(() => gameAppGate(root, "apps/games/nope")).toThrow(/is not a game app/);
  });
});
