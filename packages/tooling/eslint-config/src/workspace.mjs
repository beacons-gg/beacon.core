// @ts-check
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import { parse } from "yaml";

/**
 * Every workspace in the repo at `root`: its root-relative directory, its package name, and whether
 * it lints itself. Read from `pnpm-workspace.yaml` and each manifest, once, so the tier gate names
 * no package, tier or game.
 *
 * The workspace globs use `*` for one directory level and nothing else; any other glob stops the lint
 * rather than silently covering less. A folder with no manifest is skipped, not an error: pnpm leaves a
 * git-ignored `node_modules` behind in every workspace package, so checking out a branch that moved or
 * deleted one leaves exactly that.
 *
 * @param {URL} root
 * @returns {{ dir: string, name: string, lints: boolean }[]}
 */
export function workspaces(root) {
  const globs = parse(readFileSync(new URL("pnpm-workspace.yaml", root), "utf8")).packages;
  return globs.flatMap((/** @type {string} */ glob) => {
    const segments = glob.split("/");
    if (segments.some((s) => s !== "*" && /[*?[\]{}!]/.test(s))) {
      throw new Error(`@beaconsgg/eslint-config: a workspace glob it cannot read: ${glob}`);
    }
    const dirs = segments.reduce(
      (found, segment) =>
        segment === "*"
          ? found.flatMap((d) => subdirs(root, d))
          : found.map((d) => `${d}${segment}/`),
      [""],
    );
    return dirs.flatMap((dir) => {
      const manifest = new URL(`${dir}package.json`, root);
      if (!existsSync(manifest)) return [];
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      return [{ dir: dir.slice(0, -1), name: json.name, lints: Boolean(json.scripts?.lint) }];
    });
  });
}

/** @param {URL} root @param {string} dir */
function subdirs(root, dir) {
  const at = new URL(dir, root);
  if (!existsSync(at)) return [];
  return readdirSync(at, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}${entry.name}/`);
}

/** The tiers a foreign package can be named into. */
const FOREIGN_TIERS = ["server", "client", "admin", "games", "console"];

/**
 * Packages that belong to a tier but are not in this repository's workspace, by name (the
 * `no-restricted-imports` pattern spelling: `*` is one path segment), read from the root manifest:
 *
 *     "beacon": { "foreign": { "admin": ["@beaconsgg/admin-plugin"] } }
 *
 * A console's repository names the game packages it installs under `games`: the plugin it lists
 * (`@<game>/beacon-admin-plugin`, which only the plugin list may import) and whatever the plugin
 * brings with it, which the console may import nowhere.
 *
 * In a repository that holds every tier this is absent, and every tier is read from the workspace.
 * A repository that holds one tier installs what it may use from the registry, so a package it
 * installs for one purpose and must refuse everywhere else is no longer there to be read as a
 * tier's: a game's repo installs the console's plugin contract for its console plugin, and that
 * install is what would let the game's model import it. Only installed packages are worth naming;
 * one the repo does not install fails to resolve on its own.
 *
 * It lives in the manifest rather than in an argument so that the repo's lint, a game app's own
 * config and the gate's check all read the same list.
 *
 * @param {URL} root
 * @returns {{ server: string[], client: string[], admin: string[], games: string[], console: string[] }}
 */
export function foreignPackages(root) {
  const manifest = new URL("package.json", root);
  const declared = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")).beacon?.foreign ?? {})
    : {};
  const unknown = Object.keys(declared).filter((tier) => !FOREIGN_TIERS.includes(tier));
  if (unknown.length > 0) {
    throw new Error(
      `@beaconsgg/eslint-config: beacon.foreign names ${unknown.join(", ")}; it knows ${FOREIGN_TIERS.join(", ")}`,
    );
  }
  return { server: [], client: [], admin: [], games: [], console: [], ...declared };
}
