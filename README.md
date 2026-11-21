# Beacon Core

Beacon Core contains the shared packages used by the Beacon platform. These packages define the protocol between games and servers and provide the client SDK. The packages also supply common utilities and development tooling.

The packages are published under the `@beaconsgg/*` npm scope.

[beacons.gg](https://beacons.gg) explains how Beacon works, and the [docs](https://beacons.gg/docs) cover building a game and running a server.

If you're building a game with Beacon, start with the [game development quickstart](https://beacons.gg/docs/quickstart) and the [SDK reference](https://beacons.gg/docs/sdk-reference). A game starts with `@beaconsgg/client-sdk`. The quickstart names the other packages a game installs beside the SDK.

## Packages

This repository contains three groups of packages.

### Core

Shared by Beacon servers and games. These packages define the protocol and common primitives used across the network.

| Package                        | Description                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `@beaconsgg/protocol-types`    | Protocol schemas and types for identities, operations, rooms, policies, discovery, scouts, profiles, and items |
| `@beaconsgg/identity`          | Account and device identities, cryptographic signing, verification, and device management                      |
| `@beaconsgg/jsonlogic-profile` | Restricted JSONLogic evaluation and policy-related utilities                                                   |
| `@beaconsgg/geo`               | Geohash coverage and geographic cell queries                                                                   |
| `@beaconsgg/scout-interp`      | Geographic interpolation for moving scouts                                                                     |

### Client

Packages used by game clients and other applications that communicate with Beacon servers.

| Package                 | Description                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@beaconsgg/client-sdk` | Client integration for signed requests, server discovery, platform reads, live updates, and identity/key management |
| `@beaconsgg/event-bus`  | Small typed publish/subscribe event bus                                                                             |

The client packages are framework-agnostic and designed to work in both browsers and React Native environments.

### Tooling

Shared development configuration used across Beacon repositories.

| Package                      | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `@beaconsgg/tsconfig`        | Shared TypeScript compiler configuration           |
| `@beaconsgg/prettier-config` | Shared Prettier configuration                      |
| `@beaconsgg/vitest-config`   | Shared Vitest configuration and coverage utilities |
| `@beaconsgg/eslint-config`   | Shared ESLint rules and architecture checks        |

## Package architecture

Core defines what games and servers agree on. [beacon.server](https://github.com/beacons-gg/beacon.server) implements the server side of that contract, and a game implements the client side with the SDK.

Packages are organized into tiers based on their dependencies:

- **Core** packages are shared by games and servers.
- **Client** packages build on Core and provide client-side functionality.
- **Server** packages are maintained in [beacon.server](https://github.com/beacons-gg/beacon.server).
- **Admin** packages are maintained in [beacon.admin](https://github.com/beacons-gg/beacon.admin).
- **Tooling** packages provide shared development configuration.

Dependencies flow downward between tiers. Core packages cannot depend on client, server, admin, or game-specific code.

Client-bound packages must remain safe for React Native, using framework-agnostic TypeScript without Node.js built-ins. These boundaries are enforced by the shared lint configuration.

See [`packages/README.md`](packages/README.md) for the complete package architecture and dependency rules.

## Compatibility and versioning

The seven Core and Client packages are published together under a shared version. The four tooling packages use the same version.

The public API and client/server compatibility guarantees are documented in [`doc/core-compatibility.md`](doc/core-compatibility.md).

For game developers, the [game author guide](doc/game-author.md) describes the contract between a game and a Beacon server. The guide covers what the platform provides and what the game is responsible for.

Technical specifications are maintained in [`doc/spec/`](doc/spec/README.md).

## Repository structure

| Path                | Description                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| `packages/core/`    | Shared protocol and platform packages                                         |
| `packages/client/`  | Client SDK and event bus                                                      |
| `packages/tooling/` | Shared development presets                                                    |
| `doc/`              | Game development contract, compatibility policy, and technical specifications |
| `scripts/`          | Repository validation and package checks                                      |

## Development

### Requirements

- Node.js 22
- pnpm 10.33

The repository uses `.nvmrc` for the Node.js version and `packageManager` in `package.json` for pnpm.

### Setup

```sh
nvm use
corepack enable
pnpm install
```

### Common commands

| Command             | Description                   |
| ------------------- | ----------------------------- |
| `pnpm build`        | Build all packages            |
| `pnpm typecheck`    | Run TypeScript checks         |
| `pnpm test`         | Run package tests             |
| `pnpm lint`         | Run ESLint checks             |
| `pnpm run gate`     | Run the complete quality gate |
| `pnpm format:check` | Check formatting              |

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development conventions, testing requirements, and contribution guidelines.

## Contributing

External pull requests are not currently accepted, but issues and bug reports are welcome.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for details and [`SECURITY.md`](SECURITY.md) for private vulnerability reporting.

For release procedures and cross-repository release ordering, see [`doc/release-runbook.md`](doc/release-runbook.md).

## License

The packages are licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).

NorthCtrl LLC holds the copyright, as documented in [`NOTICE`](NOTICE).
