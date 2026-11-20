import { coverageConfigDefaults } from "vitest/config";
import { describe, expect, it } from "vitest";
import shared, { REPO_FLOOR, SRC_SCOPE, coverageFor } from "../coverage";

describe("coverageFor", () => {
  it("holds the repo floor on lines unless the workspace names its own", () => {
    expect(coverageFor({ include: SRC_SCOPE }).thresholds).toEqual({ lines: REPO_FLOOR });
    expect(coverageFor({ include: SRC_SCOPE, floor: 40 }).thresholds).toEqual({ lines: 40 });
  });

  it("counts what the workspace opts in, less vitest's defaults, barrels and its own exclusions", () => {
    const coverage = coverageFor({ include: ["app/**"], exclude: ["src/testing.ts"] });
    expect(coverage.include).toEqual(["app/**"]);
    expect(coverage.exclude).toEqual([
      ...coverageConfigDefaults.exclude,
      "**/index.ts",
      "src/testing.ts",
    ]);
  });
});

describe("the default config", () => {
  it("is the standard shape at the repo floor: what a workspace re-exports", () => {
    expect(shared.test?.coverage).toEqual(coverageFor({ include: SRC_SCOPE }));
  });
});
