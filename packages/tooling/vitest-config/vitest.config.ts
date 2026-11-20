import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "./src/coverage";

// The preset tests itself with itself, from source (its own `dist` is what it is building), and
// its floor counts the gate's check under `scripts/` as well as `src/`.
export default defineConfig({
  test: { coverage: coverageFor({ include: [...SRC_SCOPE, "scripts/**"] }) },
});
