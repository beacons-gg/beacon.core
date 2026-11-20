#!/usr/bin/env node
// `beacon-check-internal-refs`: list what the repo at the working directory points at that a public
// reader cannot open. Exits 0 in report mode, and 1 with `--strict` when it finds any outside the
// rules named with `--allow`. The check itself, and why it exists, is internal-refs.mjs.
import { main } from "./internal-refs.mjs";

process.exitCode = main(process.argv.slice(2), process.cwd());
