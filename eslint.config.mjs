// @ts-check
// The repo's lint config is @beaconsgg/eslint-config (packages/tooling/eslint-config): the base
// rules, the RN-safety gate and the tier gate, read from this repo's workspace. Imported by path
// rather than by name: turbo counts every file of a package the ROOT manifest depends on as a
// global input, so a root dependency on the preset would make each edit to it invalidate every
// task in the repo. Every other Beacon repository depends on the published package instead.
import { URL } from "node:url";
import { repoConfig } from "./packages/tooling/eslint-config/src/index.mjs";

export default repoConfig(new URL("./", import.meta.url));
