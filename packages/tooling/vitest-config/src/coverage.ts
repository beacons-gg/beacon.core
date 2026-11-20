import { coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * The shared vitest config, and the one place the coverage scope and floor are defined,
 * published as `@beaconsgg/vitest-config` so each Beacon repository holds the same floor by version
 * rather than by a copy.
 *
 * Every vitest workspace has the same shape: sources under `src/`, tests beside them in
 * `__tests__` directories. So the ones that hold the floor re-export the default config below, the
 * same way each one's `tsconfig.json` extends `@beaconsgg/tsconfig/base.json`. The rest call
 * `coverageFor` themselves: a Next app has no `src/`, some sit under the floor and carry their
 * own, and some add a setup of their own (the server needs a Postgres).
 */

/**
 * The line-coverage floor.
 *
 * A **floor and not a target**: it exists to stop a regression, not to ask for work. When it was
 * set, most workspaces cleared it with room to spare. One that sits below it names its own
 * floor in its `vitest.config.ts`, just under what it measures, so it cannot slide while it climbs.
 *
 * Only lines are gated. Branches and functions are reported and deliberately not enforced yet,
 * and they are often the more interesting numbers: a package can clear this floor on lines while a
 * third of its functions are never called. Setting those floors is its own round, with its own
 * argument about where each should sit.
 */
export const REPO_FLOOR = 81;

/** The standard layout: sources in `src/`, tests in `__tests__` beside them. */
export const SRC_SCOPE = ["src/**"];

/**
 * Barrels, excluded everywhere.
 *
 * An `index.ts` here is a pure re-export list: no statement that is not an `import`, an `export`
 * or a comment. Tests import the module that holds the code rather than the barrel in front of it,
 * so a barrel reports 0% no matter how well its package is tested, and a small package's number
 * becomes a statement about how many things it re-exports: one fully tested module beside a
 * seven-line barrel read 83%. Excluding barrels is what makes the floor mean anything there.
 *
 * If an `index.ts` ever grows real logic, the logic wants its own named file rather than an
 * exemption here.
 */
const BARRELS = ["**/index.ts"];

export interface CoverageScope {
  /** The opt-in scope: every file matching this counts, tested or not. */
  include: string[];
  /** Paths inside `include` that do not count, on top of vitest's own defaults. */
  exclude?: string[];
  /** This workspace's line floor. Only a workspace below {@link REPO_FLOOR} names one. */
  floor?: number;
}

/**
 * The coverage block for one workspace: which files count, what it must hold, and how the report
 * reads.
 *
 * `include` is the opt-in scope. Vitest reports every file that matches it, tested or not, so an
 * untested module shows up as a 0% row rather than silently not existing. `exclude` layers on top
 * of vitest's own defaults (which already drop `dist/`, `.d.ts` files, dotted dirs, and the test
 * files themselves) plus {@link BARRELS}, and is for code that is in scope by path but is not
 * ours to test.
 *
 * Neither reporter writes to disk. `text` with `skipFull` is the list of gaps: fully covered files
 * drop out, so what prints is what is missing. `text-summary` is there because `skipFull` hides
 * the totals row too, and a workspace at 100% would otherwise print an empty table and no number
 * at all; it also gives the absolute counts, which is how you tell whether a percentage floor is
 * one line of slack or fifty. For the whole picture, or a browsable one, run a suite directly:
 *
 *     pnpm --filter @beaconsgg/geo exec vitest run --coverage \
 *       --coverage.skipFull=false --coverage.reporter=html
 */
export function coverageFor({ include, exclude = [], floor = REPO_FLOOR }: CoverageScope) {
  return {
    provider: "v8" as const,
    include,
    exclude: [...coverageConfigDefaults.exclude, ...BARRELS, ...exclude],
    reporter: ["text", "text-summary"],
    skipFull: true,
    // Whole-workspace, not `perFile`: the floor is a statement about the workspace, and per-file
    // enforcement at one number would fail on the first data table or thin adapter.
    thresholds: { lines: floor },
  };
}

export default defineConfig({
  test: {
    coverage: coverageFor({ include: SRC_SCOPE }),
  },
});
