#!/usr/bin/env node
// `beacon-check-copy`: check the prose of the files the arguments name, in the repo at the working
// directory, against STYLE.md. Exits 1 on a finding that fails, 0 with `--report`. The check
// itself is copy.mjs.
import { main } from "./copy.mjs";

process.exitCode = main(process.argv.slice(2), process.cwd());
