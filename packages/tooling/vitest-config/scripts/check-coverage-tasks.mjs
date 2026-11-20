#!/usr/bin/env node
// `beacon-check-coverage-tasks`: run the coverage-task check on the repo at the working directory.
// The check itself, and why it exists, is coverage-tasks.mjs.
import { repoProblems } from "./coverage-tasks.mjs";

const problems = repoProblems(process.cwd());
if (problems.length > 0) {
  console.error(
    "Coverage is measured everywhere and floored everywhere (CONTRIBUTING.md). Not here:\n" +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(1);
}
