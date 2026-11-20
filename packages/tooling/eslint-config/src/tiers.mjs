// @ts-check
import { base } from "./base.mjs";
import { clientBound, importExpressionBans, tierBound, unique } from "./imports.mjs";
import { foreignPackages, workspaces } from "./workspace.mjs";

/**
 * The platform's tiers. **Every other directory under `packages/` is one game's tier**, so a new
 * platform tier must be added here, or it is gated as a game.
 * `admin/` is the operator console's: the plugin contract a game's operator screens build against.
 * `tooling/` is the shared build, format and lint presets: config every tier may depend on,
 * which depends on none of them, so no gate names it.
 */
const PLATFORM_TIERS = ["core", "server", "client", "admin", "tooling"];

/** The tier a workspace sits in, or undefined outside `packages/`. @param {string} dir */
const tierOf = (dir) => dir.match(/^packages\/([^/]+)\//)?.[1];
/** @param {string | undefined} tier */
const isGame = (tier) => tier !== undefined && !PLATFORM_TIERS.includes(tier);

/** The server repo's code: held to the server's gate. */
const SERVER_DIRS = ["packages/server", "apps/server", "apps/atlas"];

/**
 * A game's app lives at `apps/games/<game>`, the app of the game tier `packages/<game>`. It is the
 * phone bundle, so it is held to its game tier's bans plus one more: every console plugin, its own
 * included, which would carry the console's React DOM into it. An app lints itself under
 * Expo's config, which the root pass cannot run (its `eslint-disable` directives name Expo's plugins'
 * rules, which only its own config loads), so its config spreads {@link gameAppGate} into every block
 * that sets `no-restricted-imports`; `beacon-check-tier-gate` checks that it did.
 */
const GAME_APPS_DIR = "apps/games";

/**
 * The operator console, and the one file in it that may name a game: its plugin list. The
 * console repo builds with no game in it, so a game's screens arrive as a plugin, listed there.
 */
const ADMIN_DIR = "apps/admin";
const ADMIN_PLUGIN_LIST = `${ADMIN_DIR}/plugins.ts`;

/**
 * A game's console plugin is the package named `@<game>/beacon-admin-plugin`: the only package in a
 * game that may import `admin/`, and the only one the plugin list may import. It is read by name
 * whether the game is in the workspace or named as foreign (a game develops in its own repository
 * and publishes its plugin). The console's Tailwind `@source` globs the same name.
 */
const PLUGIN_NAME = /\/beacon-admin-plugin$/;

/**
 * Modules that ship in a package's `dist` so other suites can share them, which also makes them
 * importable from code that runs. `@beaconsgg/policy-engine/testing` mints an account key when it
 * loads; `@beaconsgg/identity/conformance` is signing vectors. Tests only.
 */
const TEST_ONLY_MODULES = ["@beaconsgg/policy-engine/testing", "@beaconsgg/identity/conformance"];
const testOnlyMessage = "A test fixture module: import it from a test, never from code that runs.";

const coreMessage =
  "core/ may not import a game, server/, client/ or admin/ package, or the console (packages/README.md).";
const clientMessage =
  "client/ may not import a game, server/ or admin/ package, or the console (packages/README.md).";
const adminTierMessage =
  "admin/ may not import a game or server/ package, or the console it is the contract of (packages/README.md).";
const adminMessage =
  "The console may not import a server/ package, or a game except as a plugin listed in plugins.ts (packages/README.md).";
const gameMessage =
  "A game tier may not import a server/ package, another game's, or the console; only its admin-plugin may import admin/ or be imported by the console (packages/README.md).";
const gameAppMessage =
  "A game's app may not import a server/ package, another game's, admin/, a console plugin (it would bundle the console's React DOM), or the console (packages/README.md).";
const serverMessage =
  "Server code may not import a game, client/ or admin/ package, or the console (packages/README.md).";

/**
 * Who is in which tier, for the repo at `root`: the workspace's packages, read from its manifests,
 * plus the ones its root manifest names as foreign. Everything below asks this and nothing else,
 * so the repo's own lint, a game app's gate and the gate's check cannot disagree about a tier.
 *
 * @param {URL} root
 */
function tiersOf(root) {
  const all = workspaces(root);
  const foreign = foreignPackages(root);
  /** @param {string} tier */
  const inTier = (tier) => all.filter((w) => tierOf(w.dir) === tier).map((w) => w.name);

  const games = [...new Set(all.map((w) => tierOf(w.dir)).filter(isGame))];
  // Each game's console plugin (see PLUGIN_NAME): a workspace game's, with its directory, and a
  // foreign game's, by name alone.
  const plugins = all.filter((w) => isGame(tierOf(w.dir)) && PLUGIN_NAME.test(w.name));
  const foreignPlugins = foreign.games.filter((name) => PLUGIN_NAME.test(name));
  const gameApps = all
    .filter((w) => w.dir.startsWith(`${GAME_APPS_DIR}/`))
    .map((w) => ({ ...w, game: w.dir.slice(GAME_APPS_DIR.length + 1) }));

  const serverTier = [...inTier("server"), ...foreign.server];
  const clientTier = [...inTier("client"), ...foreign.client];
  const adminTier = [...inTier("admin"), ...foreign.admin];
  // The console app itself, which no package imports: a plugin reaches it only through admin/'s
  // host, and it lives in its own repository.
  const consoleApp = [
    ...all.filter((w) => w.dir === ADMIN_DIR).map((w) => w.name),
    ...foreign.console,
  ];
  // What a platform tier may not import from any game: its packages, and its app.
  const anyGame = [
    ...all
      .filter((w) => isGame(tierOf(w.dir)) || w.dir.startsWith(`${GAME_APPS_DIR}/`))
      .map((w) => w.name),
    ...foreign.games,
  ];
  /** Every other game's packages, as the game tier `tier` sees them. @param {string | undefined} tier */
  const otherGames = (tier) => [
    ...games.filter((other) => other !== tier).flatMap(inTier),
    ...foreign.games,
  ];
  /**
   * What a game's app is held to: its game tier's bans (no server package, no other game's, no
   * `admin/`, not the console) plus every console plugin, its own first of all. No RN-safety half:
   * an app's jest tests read the filesystem, and the phone bundle is Metro's to refuse.
   *
   * @param {{ game: string }} app
   */
  const gameAppBans = (app) =>
    unique([
      ...serverTier,
      ...adminTier,
      ...consoleApp,
      ...otherGames(app.game),
      ...plugins.map((w) => w.name),
      ...foreignPlugins,
    ]);

  return {
    all,
    games,
    plugins,
    foreignPlugins,
    gameApps,
    serverTier,
    clientTier,
    adminTier,
    consoleApp,
    anyGame,
    otherGames,
    gameAppBans,
  };
}

/**
 * The gate a game's app spreads into its own ESLint config, since the repo's root pass does not
 * lint it (see GAME_APPS_DIR): `patterns` go into every block that sets `no-restricted-imports`
 * (flat config replaces a rule's options per block), `syntax` into every block that sets
 * `no-restricted-syntax`. `beacon-check-tier-gate` reads the config each directory of the app
 * resolves to and fails if either rule lost them.
 *
 * @param {URL} root the repo root
 * @param {string} appDir the app's directory, root-relative (`apps/games/<game>`)
 */
export function gameAppGate(root, appDir) {
  const { gameApps, gameAppBans } = tiersOf(root);
  const app = gameApps.find((w) => w.dir === appDir);
  if (!app) {
    throw new Error(`@beaconsgg/eslint-config: ${appDir} is not a game app in ${root.pathname}`);
  }
  const banned = gameAppBans(app);
  return {
    patterns: [{ group: banned, message: gameAppMessage }],
    syntax: importExpressionBans(banned, gameAppMessage),
  };
}

/** The game apps of the repo at `root` that lint themselves, root-relative. @param {URL} root */
export function selfLintingGameApps(root) {
  return tiersOf(root)
    .gameApps.filter((w) => w.lints)
    .map((w) => w.dir);
}

/**
 * The whole config, for the repo at `root`.
 *
 * **The tier gate: tiers depend downward only.** `core/` is shared by the server and every
 * game. `server/`, `apps/server` and `apps/atlas` ship as the server repo; `client/` is the generic
 * client SDK; `admin/` and `apps/admin` ship as the console's repo, which reaches a game only through
 * a plugin; each game tier ships with its game. In one repository every tier is in the workspace
 * and is read from it. In a repository that holds one tier, an import of a package it does not
 * install fails to resolve, and the ones it does install but may not import everywhere are named
 * as foreign in its root manifest (see `foreignPackages`). Patterns match subpaths too.
 *
 * @param {URL} root
 */
export function repoConfig(root) {
  const {
    all,
    games,
    plugins,
    foreignPlugins,
    gameApps,
    serverTier,
    clientTier,
    adminTier,
    consoleApp,
    anyGame,
    otherGames,
    gameAppBans,
  } = tiersOf(root);
  const serverBans = [...anyGame, ...clientTier, ...adminTier, ...consoleApp];
  const serverFiles = SERVER_DIRS.map((dir) => `${dir}/**/*.ts`);
  /** Does a tier gate below apply to this workspace? @param {string} dir */
  const gated = (dir) =>
    dir.startsWith("packages/") ||
    dir === ADMIN_DIR ||
    SERVER_DIRS.some((d) => dir === d || dir.startsWith(`${d}/`));

  return base({
    // A workspace with its own `lint` script (a game app, with Expo's flat config) is linted by that
    // script, which the repo's lint runs beside this root pass, so the root pass skips it and each
    // file is linted once. **Except where a tier gate applies:** the gates live only here, so a
    // gated workspace stays in the root pass whatever scripts it has, rather than leave the gate by
    // adding one. A game app is the exception the other way: its own config carries its gate (see
    // GAME_APPS_DIR), so skipping it here leaves nothing out.
    ignores: all.filter((w) => w.lints && !gated(w.dir)).map((w) => `${w.dir}/**`),
    gates: [
      // core/: shared by the server and every game, so it imports no other tier.
      clientBound(
        ["packages/core/**/*.{ts,tsx}"],
        [...anyGame, ...serverTier, ...clientTier, ...adminTier, ...consoleApp],
        coreMessage,
      ),
      // client/: the generic SDK every game uses, so no game, no server, and not the console's.
      clientBound(
        ["packages/client/**/*.{ts,tsx}"],
        [...anyGame, ...serverTier, ...adminTier, ...consoleApp],
        clientMessage,
      ),
      // admin/: the console's plugin contract, which every game's plugin builds against: no game,
      // no server.
      clientBound(
        ["packages/admin/**/*.{ts,tsx}"],
        [...anyGame, ...serverTier, ...consoleApp],
        adminTierMessage,
      ),
      // Each game tier ships with its own game: no server tier, and no other game's packages. Only
      // its console plugin reaches admin/, and nothing else in the game reaches the plugin: the
      // model the phone app bundles stays clear of the console's React DOM.
      ...games.map((tier) =>
        clientBound(
          [`packages/${tier}/**/*.{ts,tsx}`],
          [
            ...serverTier,
            ...otherGames(tier),
            ...adminTier,
            ...plugins.filter((w) => tierOf(w.dir) === tier).map((w) => w.name),
            ...consoleApp,
          ],
          gameMessage,
        ),
      ),
      // ...and the plugin itself, which a later block lets build against admin/.
      ...plugins.map((plugin) =>
        clientBound(
          [`${plugin.dir}/**/*.{ts,tsx}`],
          [...serverTier, ...otherGames(tierOf(plugin.dir)), ...consoleApp],
          gameMessage,
        ),
      ),
      // A game's app, when the root pass lints it (no lint script of its own): the same bans its
      // own config would spread (see GAME_APPS_DIR).
      ...gameApps.map((app) =>
        tierBound([`${app.dir}/**/*.{ts,tsx}`], gameAppBans(app), gameAppMessage),
      ),
      // The server repo: game-agnostic, so no game and no client SDK, tests included. Its suites
      // run generic policies from `@beaconsgg/policy-engine/testing` and the policies a game ships as
      // frozen JSON, so the server repo builds and tests on its own.
      tierBound(serverFiles, serverBans, serverMessage),
      {
        // ...and outside its tests, no test fixtures either. Flat config replaces a rule's options
        // per block, so this restates the tier bans above rather than adding to them. In a repo
        // where the server has nothing to ban (see `tierBound`), only the fixture ban is left, and
        // an empty `patterns` list would be rejected, so the tier half is only spelled when it has
        // names.
        files: serverFiles,
        ignores: ["**/__tests__/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: TEST_ONLY_MODULES.map((name) => ({ name, message: testOnlyMessage })),
              ...(serverBans.length > 0
                ? { patterns: [{ group: unique(serverBans), message: serverMessage }] }
                : {}),
            },
          ],
          "no-restricted-syntax": [
            "error",
            ...(serverBans.length > 0 ? importExpressionBans(serverBans, serverMessage) : []),
            ...importExpressionBans(TEST_ONLY_MODULES, testOnlyMessage),
          ],
        },
      },
      // The console: over the wire to any server, so no server package, and no game...
      tierBound([`${ADMIN_DIR}/**/*.{ts,tsx}`], [...anyGame, ...serverTier], adminMessage),
      // ...except a game's plugin, in the plugin list, whether the game is in the workspace or
      // installed from the registry and named as foreign. Flat config replaces a rule's options per
      // block, so for this one file the ban above is replaced, not added to.
      tierBound(
        [ADMIN_PLUGIN_LIST],
        [
          ...anyGame.filter(
            (name) => !plugins.some((p) => p.name === name) && !foreignPlugins.includes(name),
          ),
          ...serverTier,
        ],
        adminMessage,
      ),
    ],
  });
}
