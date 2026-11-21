# Contributing

This repository holds Beacon's published packages: the seven core packages and the tooling presets.
The server, the operator console and each game live in their own repositories and build against
what this repository publishes. The [README](README.md) lists the repositories. The specs that the
code cites are in [`doc/spec/`](doc/spec/README.md). The packages are licensed under the Apache
License 2.0 ([`LICENSE`](LICENSE)), and [`NOTICE`](NOTICE) names the copyright holder.

## Issues and pull requests

The project doesn't accept pull requests from outside contributors yet. This file will say so when
that changes.

Issues are welcome. Open an issue to report a bug, ask a question or suggest an idea.

Report a vulnerability through GitHub's private vulnerability reporting. Don't open a public issue
for a vulnerability. [`SECURITY.md`](SECURITY.md) gives the fallback email address and
the response target.

## How the project is built

The rest of this file describes how the maintainers build and release the packages. The same steps
let you build the packages yourself, run the gate and follow the fix for an issue you reported.

## Prerequisites

You need **Node 22** (`.nvmrc`, so run `nvm use`) and **pnpm 10.33**. Run `corepack enable` and
corepack picks pnpm up from `packageManager`. You need no database and no Docker, and an install
needs no registry token.

```bash
pnpm install
```

## The golden rule

**The packages here are the one definition of the wire and its primitives.** The server, the
console and each game are shells over these packages in their own repositories. A change that adds
a game's nouns to a `@beaconsgg/*` package is a bug, and the change belongs in the game.

Client-bound `[C]` packages must stay safe for React Native: pure TypeScript with no Node built-ins.
Tiers depend downward only. ESLint enforces both rules. The tier map and the rules for each tier are
in [`packages/README.md`](packages/README.md).

## Quality gates

CI runs these gates, and every one must pass:

```bash
pnpm run build         # turbo: tsc across packages
pnpm run typecheck     # turbo: tsc --noEmit
pnpm run test:coverage # turbo: vitest; fails under a floor
pnpm run lint          # eslint . (incl. the RN-safety and tier gates)
pnpm run format:check  # prettier --check .
```

Run `pnpm run format` before you commit. **`pnpm run gate` runs the whole list in one command**,
and CI runs exactly that script. The gate puts these repository-wide checks in front of the list:

- every suite holds a coverage floor;
- the tier gate covers a game that the tier gate's config does not name;
- a document's examples are the files the document shows;
- a public API changes only on purpose;
- every published package ships the root `LICENSE` and `NOTICE` and declares `Apache-2.0`;
- the docs pass the copy check.

`main` is protected. CI must pass, and nobody pushes to `main` directly.

The gate's test step is `test:coverage`, so every suite runs once and reports what it covered.
`pnpm run test` runs the same suites without the instrumentation, for a faster local loop.

**Every workspace holds a line coverage floor**, and the gate fails under the floor. The repository
floor is **81%**, and every workspace here clears it. A workspace that cannot clear the floor names
its own floor in its `vitest.config.ts`. That floor sits a little under what the workspace measures,
so coverage cannot slide while the workspace climbs. The server's repository has three such
workspaces.

The floors cover **lines**. Branch and function coverage are reported and not enforced. The floor
and what each workspace counts as in scope live in
[`@beaconsgg/vitest-config`](packages/tooling/vitest-config/src/coverage.ts).

### Public text

`@beaconsgg/eslint-config` ships `beacon-check-copy`, the check every Beacon repository runs over
its public text. `pnpm run check:copy` runs the check with `--strict` over `doc/`, every README and
this file. The gate fails
on any finding, warnings included.

`pnpm run check:refs` lists every reference in the repository that a public reader cannot open:

- the organization's private repositories and registry;
- issue and pull request numbers;
- unpublished planning docs;
- internal phase and decision wording;
- people's names.

The check is `beacon-check-internal-refs` from `@beaconsgg/eslint-config`. Cite a spec by its public
path. A spec in this repository gets a relative link, such as `doc/spec/identity.md` §4.3. A spec in
another Beacon repository is named in prose, such as the server's places spec (beacon.server
`doc/spec/places.md` §7). The root `package.json` lists the other repositories' published specs
under `beacon.internalRefs.publishedDocs`. A link to a spec in the public `beacons-gg` organization
on GitHub counts as public too, since `beacon.internalRefs.publicOrg` names that organization. A
comment that rests on a decision states the reasoning and cites no issue. The gate runs the check
with `--strict --allow org-names`. Any finding fails the gate except the organization's own names.
Those names change on the day the repositories move to the public organization.

The check knows no private names of its own. The root `package.json` lists this repository's names
under `beacon.internalRefs.privatePatterns`: the organization's names, the unpublished docs and
people's names. The same object's `allow` list holds the copyright holder's legal name, which is
never a finding.

## CI and releases

- **Every PR and every push to `main` runs the whole gate**
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). CI has no scoping to affected packages
  and no optional job. Eleven packages need neither, and the turbo cache keeps a run cheap.
- **Merging to `main` validates and publishes nothing.** The Release workflow below publishes. The
  server's images and each game's updates ship from their own repositories.
- **Shared config is a package.** A workspace extends `@beaconsgg/tsconfig/base.json` and formats
  with `@beaconsgg/prettier-config`. The workspace takes its vitest config and coverage floor from
  `@beaconsgg/vitest-config`. The lint config and its gates are `@beaconsgg/eslint-config`. Each
  preset is in `packages/tooling/*`, and every workspace names a preset as a package and never by a
  path to the repository root. Each Beacon repository therefore takes the same config by version.
  The one path left is the root's own. `eslint.config.mjs` and the gate reach the lint and vitest
  presets by path, because turbo counts every file of a package that the root manifest depends on as
  a global input.
- **The seven core packages and the tooling presets publish from `main` on one version.** The
  **Install check** workflow runs on a PR that changes one of them. The workflow publishes a
  throwaway build of all of them to a throwaway registry inside the CI job, and uses the build from
  a consumer written outside the workspace. No canary reaches a real registry.
  Every entry point must load, and each preset must work by name. The **skew matrix** runs the five
  flows between versions of the client and the server. The matrix lives with the server in
  beacon.server and tests what this repository publishes.
- **A release is one run** of [`.github/workflows/release.yml`](.github/workflows/release.yml) on
  `main` with a version (`gh workflow run release.yml -f version=0.3.1`). The run sets the version
  in its own checkout, runs the gate and publishes what the registry lacks. The run commits nothing,
  so the manifests on `main` name `0.0.0`.
  Last the run tags `v<version>` and creates a GitHub Release. The release notes are the titles of
  the PRs merged since the previous release, so write a PR title as a sentence a consumer can read.
  The rules and the steps are in [`doc/core-compatibility.md`](doc/core-compatibility.md) §7.
- **A change that spans repositories** ships core first. The server and the console
  follow, and a game and its console plugin come last. [`doc/release-runbook.md`](doc/release-runbook.md) gives the order,
  how to read the skew matrix first and how to back out.
- **CI expects these repository settings.** Branch protection on `main` requires the check
  `validate`. The `NPM_TOKEN` repository secret holds the registry token. CI and the
  release pass the secret to `setup-workspace`, which writes the token to the runner's `~/.npmrc`.
  An empty token only warns because a plain install here fetches nothing from the registry. A
  Dependabot run has an empty token.
  The release publishes with the token and fails without it. The install check's `flows` job reads
  the five-flow driver through its throwaway registry, and any upstream token goes to that registry
  alone.

## Workflow and conventions

- **Branches:** work on a feature branch off `main` and open a PR. CI must pass before a merge.
- **Commits** follow Conventional Commits with the package name as the scope: `feat(client-sdk): …`,
  `fix(geo): …`, `docs(...)` and `chore(...)`.
- **Parallel work:** two concurrent workstreams cannot share one `pnpm install` and lockfile. Give a
  large parallel effort its own **git worktree** (`git worktree add -b <branch> ../<dir>`). Merge
  the work back and regenerate the lockfile with `pnpm install`.
- **The lockfile needs no registry token.** Nothing here installs from the registry, so
  `pnpm install` resolves the lockfile on any machine.

## Adding code

- **A new package** follows the shape of an existing `packages/*` package. The package needs its own
  `package.json`, `tsconfig.build.json`, `src/`, tests and `README.md`. The package also needs
  copies of the root `LICENSE` and `NOTICE` that `files` lists, and its manifest declares
  `"license": "Apache-2.0"`. A published API package also needs a `public-api.txt`. Keep `[C]`
  packages RN-safe. A new package arrives already versioned
  ([`doc/core-compatibility.md`](doc/core-compatibility.md) §7).
- **A game feature** belongs in the game's own repository. **Server code** belongs in
  [beacon.server](https://github.com/beacons-gg/beacon.server). Both build against the published
  `@beaconsgg/*` packages.

## Where things are

[`README.md`](README.md) gives the layout, and [`packages/README.md`](packages/README.md) gives the
tiers. [`doc/game-author.md`](doc/game-author.md) is the contract a game builds against. The worked
example in `doc/game-author.md` is a file in `@beaconsgg/protocol-types`, and
`scripts/check-doc-examples.mjs` holds the document to that file. The server's repository plays the
example through the engine in its own gate.
