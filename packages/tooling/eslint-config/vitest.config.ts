import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "@beaconsgg/vitest-config";

// The standard scope plus the gate's check under `scripts/`. The suite runs ESLint over a made-up
// repo and over every directory of the real game apps, which takes longer than a unit test.
export default defineConfig({
  test: {
    coverage: coverageFor({ include: [...SRC_SCOPE, "scripts/**"] }),
    testTimeout: 180_000,
  },
});
