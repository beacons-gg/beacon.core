#!/usr/bin/env node
// `beacon-check-tier-gate`: check that every game app of the repo at the working directory carries
// its tier gate. The check itself, and why it exists, is tier-gate.mjs.
import { checkGameApps } from "./tier-gate.mjs";

const { total, failures } = await checkGameApps(process.cwd(), (line) => console.log(line));
console.log(
  total === 0
    ? "\nno game app here lints itself: nothing to check"
    : `\n${total - failures.length}/${total} checks hold for this repo's game apps`,
);
if (failures.length > 0) {
  console.error(
    "\nA game app's own ESLint config lost the tier gate. Spread gameAppGate's `patterns` into " +
      "every block that sets no-restricted-imports, and its `syntax` into every block that sets " +
      "no-restricted-syntax.",
  );
  process.exit(1);
}
