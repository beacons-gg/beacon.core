# Beacon: the published packages

Beacon is a network of servers for games played at real places. [beacons.gg](https://beacons.gg)
explains how Beacon works, and [the docs](https://beacons.gg/docs) take a game from the
[quickstart](https://beacons.gg/docs/quickstart) to the [SDK reference](https://beacons.gg/docs/sdk-reference).

This repository holds the **Beacon platform's shared code** as the `@beaconsgg/*` packages:

- the single definition of the wire and its primitives;
- the client SDK that every game talks to a server with;
- the build, test, lint and format presets that Beacon's own repositories use.

Everything here is published as a package, and the rest of Beacon is built against what is
published:

| Repository                                                   | What it is                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| this one                                                     | the seven core packages and the four tooling presets               |
| [beacon.server](https://github.com/beacons-gg/beacon.server) | the server and its server-side packages, Atlas and the skew matrix |
| [beacon.admin](https://github.com/beacons-gg/beacon.admin)   | the operator console and its plugin contract                       |

A game is developed in a repository of its own, outside the platform's repositories.

To build a game, start with [`doc/game-author.md`](doc/game-author.md). The page is the platform
contract: what a Beacon server guarantees and what a game supplies.
[`doc/core-compatibility.md`](doc/core-compatibility.md) gives what these packages promise across
versions and how they are published. The specs the code cites are in [`doc/spec/`](doc/spec/README.md).

## Layout

```
packages/                 # tiered by who depends on them. [C] = client-bound (RN-safe)
  core/                   # [C] shared by the server AND every game (wire contract + primitives)
    protocol-types/       #     zod schemas + types: ids, ops, rooms, policy, discovery, scouts, profile, items
    identity/             #     Ed25519, did:key, account+device auth, multi-device profile + revocation, JCS
    jsonlogic-profile/    #     whitelisted JSONLogic + 4 aggregators + integer guard + conformance vectors
    geo/                  #     geohash coverage + cell queries (antimeridian-safe view cells)
    scout-interp/         #     great-circle movement interpolation (moving scouts)
  client/                 # [C] the generic client SDK (games and the console, not the server)
    client-sdk/           #     signed REST + reads + live channel + server registry + key custody
    event-bus/            #     tiny typed pub/sub kernel (TypedEventBus)
  tooling/                #     presets: tsconfig, prettier-config, vitest-config, eslint-config
doc/                      # the game-author contract, the compatibility policy, the specs, the release guide
scripts/                  # the gate's repo-wide checks, and the canary's consumer
```

The seven packages under `core/` and `client/` move as one version. The rules for each tier are in
[`packages/README.md`](packages/README.md). Tiers depend downward only. A client-bound package stays
safe for React Native: pure TypeScript with no Node built-ins. ESLint enforces both rules.

## Working here

You need **Node 22** (`.nvmrc`, so run `nvm use`) and **pnpm 10.33**. Run `corepack enable` and
corepack picks pnpm up from `packageManager`. An install needs no registry token, because every
`@beaconsgg/*` package is a workspace member.

```bash
pnpm install
pnpm run gate       # every quality gate in one command (see CONTRIBUTING.md)
pnpm build          # turbo: tsc -> dist across packages
pnpm typecheck      # turbo: tsc --noEmit across packages
pnpm test           # turbo: vitest across packages
pnpm test:coverage  # the same suites, each held to its coverage floor
pnpm lint           # eslint, including the RN-safety and tier gates
pnpm format:check   # prettier --check
```

## CI and releases

Three workflows run here:

- **CI** (`ci.yml`) runs the whole gate on every PR and on every push to `main`.
- **Install check** (`install-check.yml`) runs on a PR that changes something published. A
  throwaway build goes to a throwaway registry that lives only inside the CI job, and is installed
  into a project outside the workspace. The project uses the build as a consumer would and then runs
  the five client flows against the server as released. No canary reaches a real registry. The
  workflow's `Install check summary` job runs on every PR and is the required check. The summary
  passes when the install jobs passed or had nothing published to check.
- **Release** (`release.yml`) runs by hand on `main` with a version. One run sets every published
  package to the version and runs the gate. The run then pushes the version commit and publishes
  what the registry lacks. Last the run tags `v<version>` and creates a GitHub Release with notes
  from the merged PRs. Merging publishes nothing. Only a release run publishes.

## Contributing

The project doesn't accept pull requests from outside contributors yet. Issues are welcome, and a
vulnerability goes through GitHub's private vulnerability reporting ([`SECURITY.md`](SECURITY.md)).
[`CONTRIBUTING.md`](CONTRIBUTING.md) has the details, the gates and the conventions. The order of the
releases when a change spans repositories is in [`doc/release-runbook.md`](doc/release-runbook.md).

## History

These packages were developed inside an earlier Beacon monorepo until October 2026. The server, the console
and the first game lived in the same monorepo. Each of those moved to its own repository, and the packages
moved here with their history and their version tags. An issue or pull request number in an older
commit message refers to that earlier repository, which is archived and was never public.

## License

The packages are licensed under the Apache License 2.0 ([`LICENSE`](LICENSE)). NorthCtrl LLC holds
the copyright, as [`NOTICE`](NOTICE) states.
