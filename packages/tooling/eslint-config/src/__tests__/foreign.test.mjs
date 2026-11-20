/**
 * A game's own repository: its tier and its app, and nothing of the server, the console
 * or another game. What it installs and may not import everywhere is no longer in the workspace to
 * be read as a tier's, so its root manifest names those packages as foreign. The app has no
 * lint script here, so the root pass lints it and its bans can be read off one config.
 */
import { describe, expect, it } from "vitest";
import { gameAppGate, repoConfig } from "../index.mjs";
import { linting, madeUpRepo } from "./repo.mjs";

const GAME_REPO = {
  globs: ["packages/*/*", "apps/games/*"],
  manifests: {
    "packages/kites/game": { name: "@kites/game" },
    "packages/kites/admin-plugin": { name: "@kites/beacon-admin-plugin" },
    "apps/games/kites": { name: "@kites/app" },
  },
};
const FOREIGN = {
  server: ["@beaconsgg/policy-engine", "@beaconsgg/server-*"],
  admin: ["@beaconsgg/admin-plugin"],
  console: ["@beaconsgg/admin"],
  games: ["@other/*"],
};

const MODEL = "packages/kites/game/src/a.ts";
const PLUGIN = "packages/kites/admin-plugin/src/a.tsx";
const APP = "apps/games/kites/src/a.ts";

describe("a split game repo, with what it may not import named as foreign", () => {
  const named = madeUpRepo({ ...GAME_REPO, foreign: FOREIGN });
  const { fired } = linting(named.dir, repoConfig(named.root));

  it.each([
    [MODEL, 'import "@beaconsgg/admin-plugin";', "no-restricted-imports"],
    [MODEL, 'import "@beaconsgg/policy-engine";', "no-restricted-imports"],
    [MODEL, 'import "@beaconsgg/server-runtime/deep";', "no-restricted-imports"],
    [MODEL, 'import "@beaconsgg/admin";', "no-restricted-imports"],
    [MODEL, 'import "@other/model";', "no-restricted-imports"],
    [MODEL, 'void import("@beaconsgg/admin-plugin");', "no-restricted-syntax"],
    [MODEL, 'export type T = import("@beaconsgg/policy-engine").X;', "no-restricted-syntax"],
    [PLUGIN, 'import "@beaconsgg/policy-engine";', "no-restricted-imports"],
    [PLUGIN, 'import "@other/model";', "no-restricted-imports"],
    [APP, 'import "@beaconsgg/admin-plugin";', "no-restricted-imports"],
    [APP, 'import "@kites/beacon-admin-plugin";', "no-restricted-imports"],
    [APP, 'import "@beaconsgg/policy-engine";', "no-restricted-imports"],
    [APP, 'import "@other/model";', "no-restricted-imports"],
  ])("%s refuses %s", async (file, source, rule) => {
    expect(await fired(file, source)).toContain(rule);
  });

  it.each([
    // The plugin is the one package of a game that builds against the console's contract.
    [PLUGIN, 'import "@beaconsgg/admin-plugin";'],
    [PLUGIN, 'import "@kites/game";'],
    [MODEL, 'import "@beaconsgg/geo";'],
    [MODEL, 'import "@beaconsgg/client-sdk";'],
    [APP, 'import "@kites/game";'],
    [APP, 'import "@beaconsgg/client-sdk";'],
  ])("%s allows %s", async (file, source) => {
    expect(await fired(file, source)).toEqual([]);
  });

  it("hands a self-linting app the same names, each once", () => {
    const gate = gameAppGate(named.root, "apps/games/kites");
    expect(gate.patterns).toHaveLength(1);
    expect([...gate.patterns[0].group].sort()).toEqual([
      "@beaconsgg/admin",
      "@beaconsgg/admin-plugin",
      "@beaconsgg/policy-engine",
      "@beaconsgg/server-*",
      "@kites/beacon-admin-plugin",
      "@other/*",
    ]);
    expect(gate.syntax).toHaveLength(3);
  });
});

describe("the same repo with nothing named", () => {
  const unnamed = madeUpRepo(GAME_REPO);
  const { fired } = linting(unnamed.dir, repoConfig(unnamed.root));

  it("refuses none of the foreign packages: nothing in the workspace says they are a tier's", async () => {
    // The control, and the hole a split repo has if it only reads its own workspace.
    expect(await fired(MODEL, 'import "@beaconsgg/admin-plugin";')).toEqual([]);
    expect(await fired(MODEL, 'import "@beaconsgg/policy-engine";')).toEqual([]);
    expect(await fired(APP, 'import "@beaconsgg/admin-plugin";')).toEqual([]);
  });

  it("still reads what the workspace does hold", async () => {
    expect(await fired(APP, 'import "@kites/beacon-admin-plugin";')).toContain(
      "no-restricted-imports",
    );
    expect(gameAppGate(unnamed.root, "apps/games/kites").patterns[0].group).toEqual([
      "@kites/beacon-admin-plugin",
    ]);
  });
});

describe("the root manifest's beacon.foreign", () => {
  it("is refused when it names a tier the gate does not know", () => {
    const typo = madeUpRepo({ ...GAME_REPO, foreign: { servers: ["@beaconsgg/policy-engine"] } });
    expect(() => repoConfig(typo.root)).toThrow(/beacon\.foreign names servers; it knows server,/);
  });
});
