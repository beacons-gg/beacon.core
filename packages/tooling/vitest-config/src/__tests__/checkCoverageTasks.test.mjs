import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  PRESET,
  repoProblems,
  vitestConfigProblem,
  workspaceProblem,
} from "../../scripts/coverage-tasks.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(packageDir, "../../..");
const BIN = join(packageDir, "scripts/check-coverage-tasks.mjs");

const REEXPORT = `export { default } from "${PRESET}";\n`;
const CALL = `import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "${PRESET}";
export default defineConfig({ test: { coverage: coverageFor({ include: SRC_SCOPE, floor: 60 }) } });
`;
const TESTED = { test: "vitest run", "test:coverage": "vitest run --coverage" };

const scratch = mkdtempSync(join(tmpdir(), "coverage-tasks-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A directory holding a manifest with `scripts` (and any other `fields`), plus `files`. */
function workspace(name, scripts, files = {}, fields = {}) {
  const path = join(scratch, name.replace(/[@/]/g, "_"));
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, scripts, ...fields }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
  return { name, path };
}

describe("vitestConfigProblem", () => {
  it("accepts the two shapes that always carry a floor, from the preset", () => {
    expect(vitestConfigProblem("@beaconsgg/geo", REEXPORT)).toBeUndefined();
    expect(vitestConfigProblem("@beaconsgg/cartographer", CALL)).toBeUndefined();
  });

  it("refuses a config that imports the scope and hand-rolls the rest", () => {
    const handRolled = `import { SRC_SCOPE } from "${PRESET}";
export default { test: { coverage: { include: SRC_SCOPE } } };
`;
    expect(vitestConfigProblem("@beaconsgg/geo", handRolled)).toMatch(
      /builds its own coverage block/,
    );
  });

  it("refuses the re-export shape when it does not come from the preset", () => {
    expect(
      vitestConfigProblem("@beaconsgg/geo", `export { default } from "./my-config";\n`),
    ).toMatch(/builds its own coverage block/);
  });

  it("refuses the re-export in an ES-module package, where it is not the config", () => {
    // The preset's build is CommonJS: an ES module's `default` from it is the module object, so
    // vitest would run with no coverage scope and no floor.
    expect(vitestConfigProblem("@x/esm", REEXPORT, { esm: true })).toMatch(
      /^@x\/esm: is an ES-module package .* call its `coverageFor`/s,
    );
    // The call builds the config itself from a named export, which an ES module does get.
    expect(vitestConfigProblem("@x/esm", CALL, { esm: true })).toBeUndefined();
  });

  it("lets the preset route through its own source, and nobody else", () => {
    const own = `import { SRC_SCOPE, coverageFor } from "./src/coverage";
export default { test: { coverage: coverageFor({ include: SRC_SCOPE }) } };
`;
    expect(vitestConfigProblem(PRESET, own)).toBeUndefined();
    expect(vitestConfigProblem("@beaconsgg/geo", own)).toMatch(/builds its own coverage block/);
  });
});

describe("workspaceProblem", () => {
  it("passes a workspace with no tests, and one routed through the preset", () => {
    expect(workspaceProblem(workspace("@x/untested", { build: "tsc" }))).toBeUndefined();
    expect(
      workspaceProblem(workspace("@x/routed", TESTED, { "vitest.config.ts": REEXPORT })),
    ).toBeUndefined();
  });

  it("refuses a test script with no test:coverage beside it", () => {
    expect(workspaceProblem(workspace("@x/half", { test: "vitest run" }))).toMatch(
      /^@x\/half: has a `test` script and no `test:coverage`/,
    );
  });

  it("holds a jest workspace to a coverageThreshold", () => {
    const floored = { "jest.config.js": "module.exports = { coverageThreshold: {} };" };
    const bare = { "jest.config.js": "module.exports = {};" };
    expect(workspaceProblem(workspace("@x/jest", TESTED, floored))).toBeUndefined();
    expect(workspaceProblem(workspace("@x/jest-bare", TESTED, bare))).toBe(
      "@x/jest-bare: jest.config.js declares no `coverageThreshold`.",
    );
  });

  it("reads whether a workspace is an ES-module package from its manifest", () => {
    const esm = { type: "module" };
    expect(
      workspaceProblem(workspace("@x/esm-reexport", TESTED, { "vitest.config.ts": REEXPORT }, esm)),
    ).toMatch(/^@x\/esm-reexport: is an ES-module package/);
    expect(
      workspaceProblem(workspace("@x/esm-call", TESTED, { "vitest.config.ts": CALL }, esm)),
    ).toBeUndefined();
    expect(
      workspaceProblem(
        workspace("@x/cjs", TESTED, { "vitest.config.ts": REEXPORT }, { type: "commonjs" }),
      ),
    ).toBeUndefined();
  });

  it("refuses a suite with no config, and a vitest config that does not route", () => {
    expect(workspaceProblem(workspace("@x/bare", TESTED))).toMatch(/no vitest or jest config/);
    const own = { "vitest.config.ts": "export default { test: { coverage: {} } };" };
    expect(workspaceProblem(workspace("@x/own", TESTED, own))).toMatch(
      /^@x\/own: vitest.config.ts builds its own coverage block/,
    );
  });
});

describe("repoProblems", () => {
  it("finds none in this repository, every workspace asked through pnpm", () => {
    expect(repoProblems(repoRoot)).toEqual([]);
  });

  it("checks the root of a single-package repo, which runs its suite itself", () => {
    const single = workspace("single-package", TESTED);
    expect(repoProblems(single.path)).toEqual([
      expect.stringMatching(/^single-package: .*no vitest or jest config/),
    ]);
  });

  it("leaves out the root of a multi-workspace repo, and checks its members", () => {
    const passthrough = { test: "turbo run test", "test:coverage": "turbo run test:coverage" };
    const root = workspace("multi-root", passthrough, {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    });
    mkdirSync(join(root.path, "packages/member"), { recursive: true });
    writeFileSync(
      join(root.path, "packages/member/package.json"),
      JSON.stringify({ name: "@multi/member", scripts: { test: "vitest run" } }),
    );
    expect(repoProblems(root.path)).toEqual([
      expect.stringMatching(/^@multi\/member: has a `test` script and no `test:coverage`/),
    ]);
  });
});

describe("the bin", () => {
  const broken = workspace("broken-repo", { test: "vitest run" });
  const run = (script, cwd) => spawnSync(execPath, [script], { cwd, encoding: "utf8" });

  it("fails a repo with a problem, and names it", () => {
    const result = run(BIN, broken.path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/broken-repo: has a `test` script and no `test:coverage`/);
  });

  it("fails the same way through a symlink, which is how node_modules/.bin reaches it", () => {
    const link = join(scratch, "beacon-check-coverage-tasks");
    symlinkSync(BIN, link);
    const result = run(link, broken.path);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/broken-repo/);
  });

  it("passes this repository", () => {
    expect(run(BIN, repoRoot).status).toBe(0);
  });
});
