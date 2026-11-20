#!/usr/bin/env node
/**
 * Gate: an example a document shows is the example the tests run.
 *
 * `doc/game-author.md` walks an outside author through policies they will copy, and the engine's
 * suite places and plays each one (`@beaconsgg/protocol-types/examples`). Those are only the same policy
 * if something compares them. A document marks each example block with the file it shows:
 *
 *     <!-- example: packages/core/protocol-types/src/examples/pot-policy.json -->
 *     ```json
 *     { ... }
 *     ```
 *
 * and this checks both directions: every marked block equals its file, and every example file is
 * shown by some document, so deleting a marker fails rather than passing with nothing checked. Key
 * order counts, because a policy's `derived` formulas run in declaration order.
 *
 * A repo-wide script rather than a test, because CI scopes tests to the packages a PR touches and a
 * document belongs to none: a PR that only edits the prose would otherwise never be checked.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const DOC_DIR = join(repoRoot, "doc");
const EXAMPLE_DIR = join(repoRoot, "packages/core/protocol-types/src/examples");
const MARKED = /<!--\s*example:\s*(\S+)\s*-->\s*```json\n([\s\S]*?)\n```/g;

const failures = [];
const shown = new Set();

for (const name of readdirSync(DOC_DIR).filter((n) => n.endsWith(".md"))) {
  const doc = readFileSync(join(DOC_DIR, name), "utf8");
  for (const [, path, block] of doc.matchAll(MARKED)) {
    const label = `doc/${name} shows ${path}`;
    shown.add(path);
    let want;
    let got;
    try {
      want = JSON.stringify(JSON.parse(readFileSync(join(repoRoot, path), "utf8")));
      got = JSON.stringify(JSON.parse(block));
    } catch (err) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (got === want) console.log(`  ok   ${label}`);
    else failures.push(`${label}, but the block differs from the file`);
  }
}

for (const name of readdirSync(EXAMPLE_DIR).filter((n) => n.endsWith(".json"))) {
  const path = relative(repoRoot, join(EXAMPLE_DIR, name));
  if (shown.has(path)) continue;
  failures.push(`${path} is an example no document shows`);
}

for (const failure of failures) console.log(`  FAIL ${failure}`);
console.log(`\n${shown.size} example(s) shown, ${failures.length} problem(s)`);
if (failures.length) {
  console.error(
    "\nA document's example must be the file the tests play. Change both together: the file under " +
      "packages/core/protocol-types/src/examples and the marked block that shows it.",
  );
  process.exit(1);
}
