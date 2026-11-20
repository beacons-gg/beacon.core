# @beaconsgg/vitest-config

The vitest config every Beacon workspace tests with. The preset is the one place that defines the
coverage scope and the line floor, so every repository holds the same floor by version instead of
by a copy.

A workspace with the standard shape keeps its sources in `src/` and its tests in `__tests__`. Such a
workspace re-exports the preset:

```ts
// vitest.config.ts
export { default } from "@beaconsgg/vitest-config";
```

A workspace that differs calls `coverageFor` and passes what differs. That can be a scope of its
own, a lower floor or a setup file beside the coverage block. **An ES-module package
(`"type": "module"`) always calls `coverageFor`.** This package builds to CommonJS, and an ES
module that imports `default` from CommonJS gets the module object instead of the config. The
one-line re-export would then run with no floor, so the check below refuses the re-export there.

```ts
import { defineConfig } from "vitest/config";
import { SRC_SCOPE, coverageFor } from "@beaconsgg/vitest-config";

export default defineConfig({
  test: { coverage: coverageFor({ include: SRC_SCOPE, floor: 60 }) },
});
```

`coverageFor` does three things:

- sets `thresholds.lines` to `REPO_FLOOR` (81) unless the workspace names a lower floor;
- counts every file in `include` whether a test touches the file or not;
- leaves barrels (`index.ts`) out.

The comments in `src/coverage.ts` give the reason for each.

## `beacon-check-coverage-tasks`

`beacon-check-coverage-tasks` is the package's bin. Run the bin from a repository's root in the repository's gate:

```sh
pnpm exec beacon-check-coverage-tasks
```

The check fails in these cases:

- a workspace has a `test` script and no `test:coverage`, so turbo would skip its suite without a
  word;
- a `vitest.config.ts` doesn't route through this package, so the suite would report a number and
  gate nothing;
- an ES-module package routes through this package by the re-export;
- a jest workspace doesn't declare a `coverageThreshold`.

The check is plain JavaScript and has no build step, because a gate runs the check before anything
is built. The check itself is `scripts/coverage-tasks.mjs`. The bin beside that file only runs the
check and has no entry-point guard. A bin is reached through a symlink, where such a guard never
matches.

This repository runs the check by path
(`node packages/tooling/vitest-config/scripts/check-coverage-tasks.mjs`), and its root manifest
doesn't depend on this package. Turbo counts every file of a package the root depends on as a
global input, and nearly every task here already depends on this package's build.

`vitest` and `@vitest/coverage-v8` are peer dependencies, so the workspace supplies its own. The
preset moves on the version of the seven core packages
([`doc/core-compatibility.md`](../../../doc/core-compatibility.md) §7). Raising `REPO_FLOOR` can fail
a consumer's gate, so a higher floor is a major version.
