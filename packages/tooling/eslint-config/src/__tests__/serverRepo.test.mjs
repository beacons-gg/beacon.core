/**
 * The server's repository on its own: the server tier and its apps, and nothing else in
 * the workspace. Nothing it installs belongs to another tier, so its root manifest names nothing as
 * foreign, and the server gate has nothing to ban. ESLint rejects an empty `patterns` list, so a
 * gate with nothing to ban has to say so without one; the canary found this once the server
 * tier's list emptied in the consumer shape.
 */
import { describe, expect, it } from "vitest";
import { repoConfig } from "../index.mjs";
import { linting, madeUpRepo } from "./repo.mjs";

const SERVER_REPO = {
  globs: ["packages/*/*", "apps/*", "apps/atlas/*"],
  manifests: {
    "packages/server/policy-engine": { name: "@beaconsgg/policy-engine" },
    "packages/server/server-runtime": { name: "@beaconsgg/server-runtime" },
    "apps/server": { name: "@beaconsgg/server-app" },
    "apps/atlas/cartographer": { name: "@beaconsgg/cartographer" },
  },
};

const SERVER = "apps/server/src/a.ts";
const SERVER_TEST = "apps/server/src/__tests__/a.test.ts";
const FIXTURE = "@beaconsgg/policy-engine/testing";

describe("a split server repo with nothing to ban", () => {
  const repo = madeUpRepo(SERVER_REPO);
  const { fired } = linting(repo.dir, repoConfig(repo.root));

  it.each([
    [SERVER, 'import "@beaconsgg/geo";'],
    [SERVER, 'import "@beaconsgg/server-runtime";'],
    ["packages/server/policy-engine/src/a.ts", 'import "@beaconsgg/protocol-types";'],
    ["apps/atlas/cartographer/src/a.ts", 'import "@beaconsgg/geo";'],
  ])("%s lints under a config ESLint accepts: %s", async (file, source) => {
    expect(await fired(file, source)).toEqual([]);
  });

  it.each([
    [SERVER, `import "${FIXTURE}";`, "no-restricted-imports"],
    [SERVER, `void import("${FIXTURE}");`, "no-restricted-syntax"],
    [SERVER, `export type T = import("${FIXTURE}").X;`, "no-restricted-syntax"],
  ])("%s still refuses the test fixture module: %s", async (file, source, rule) => {
    expect(await fired(file, source)).toContain(rule);
  });

  it("allows the fixture module in a test", async () => {
    expect(await fired(SERVER_TEST, `import "${FIXTURE}";`)).toEqual([]);
  });
});
