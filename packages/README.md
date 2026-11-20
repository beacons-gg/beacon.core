# packages/

The packages in this directory are the reusable code of the Beacon platform. Every package is
published under the **`@beaconsgg/*`** scope and is framework-agnostic TypeScript. The packages are
grouped into **tiers by who depends on them**. Three tiers live here. The server's tier lives with
the server and the console's tier with the console. A game is a tier of its own in the game's own
repository.

The directory tree encodes the tier:

```text
packages/
  core/      @beaconsgg/*   shared by the server AND every game (the wire contract + primitives)
  client/    @beaconsgg/*   generic client SDK (games, not the server)
  tooling/   @beaconsgg/*   build, format and lint presets (every workspace, at build time only)
```

A package marked `[C]` is client-bound. A client-bound package must stay safe for React Native:
pure TypeScript with no Node built-ins. ESLint enforces the rule.

## `core/`: Beacon platform, shared by the server and every game `[C]`

The core tier is the single definition of the wire contract that a server and a game agree on.

| Package             | What it holds                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `protocol-types`    | Zod schemas and types for the whole wire, and `canonicalJson()` for signing                             |
| `identity`          | identity from an account root and device keys; signing and verifying; the signed profile and revocation |
| `jsonlogic-profile` | the bounded JSONLogic evaluator (a whitelist, four aggregators and integers only) and `accepts()`       |
| `geo`               | geohash coverage and the cells for a viewport, with cost guards                                         |
| `scout-interp`      | the great-circle math that interpolates a moving scout                                                  |

## `server/`: Beacon server internals `[S]`

The server tier holds the server-side and operator-side packages: the policy engine, the server
runtime and the code Atlas builds place data with. No client imports them, and they may use Node
built-ins. The packages ship with the server in
[beacon.server](https://github.com/beacons-gg/beacon.server) and are not published. This repository
therefore holds no `packages/server/`. The tier gate still knows the tier and holds a repository
that contains server code to the rules below.

## `client/`: generic client SDK `[C]`

Any game's client can use the client tier. The server does not need the tier.

- `client-sdk` holds what any game's client needs to talk to a Beacon server:
  - signed REST with a same-nonce retry;
  - the platform reads;
  - the mailbox and profile calls;
  - descriptor verification;
  - the approved-server registry and its routing;
  - the read-only live channel;
  - `understands` negotiation;
  - the game slug on every write and as the default read filter;
  - key custody (secure storage on a phone and a passphrase vault in a browser).

  The caller injects `fetch`, the clock, the socket and the key store. The same SDK therefore runs
  in React Native and in a browser.

- `event-bus` is a small typed publish and subscribe kernel (`TypedEventBus`). A game's app bus can
  build on the kernel.

## `admin/`: the operator console's plugin contract

The `admin/` tier belongs to the operator console. The tier holds `@beaconsgg/admin-plugin`, which
defines what a game plugin is (`GamePlugin`) and what the console hands a plugin (`AdminHost`). A
game's operator screens plug into the console through this contract. The contract ships from the
console's repository [beacon.admin](https://github.com/beacons-gg/beacon.admin) on its own version
([`doc/core-compatibility.md`](../doc/core-compatibility.md) §7). This repository therefore holds no
`packages/admin/`. The tier gate still knows the tier. A package under `packages/admin/` here would
be held to the rules below. A repository that installs the contract names the contract under
`beacon.foreign.admin` in its root manifest.

## `tooling/`: the shared presets

The presets are published beside the seven core packages. Each Beacon repository therefore takes its
config by version and keeps no copy ([`doc/core-compatibility.md`](../doc/core-compatibility.md)
§7). A preset is config only. A preset depends on no other tier, and every tier may depend on a
preset. The presets move on the core packages' version.

- `tsconfig` (`@beaconsgg/tsconfig`) holds `base.json`. The file has the compiler options every
  workspace extends: the target, the module format and every strictness flag.
- `prettier-config` (`@beaconsgg/prettier-config`) holds the format options. A repository's root
  manifest names the preset.
- `vitest-config` (`@beaconsgg/vitest-config`) holds the shared vitest config, `coverageFor` and the
  line floor that every vitest workspace routes through. The preset also ships
  `beacon-check-coverage-tasks`, the gate's check that every suite reports coverage and holds a
  floor.
- `eslint-config` (`@beaconsgg/eslint-config`) holds the base rules, the RN-safety gate and the tier
  gate (see [Rules](#rules)). The gates read the tiers from the repository's workspace. `gameAppGate` hands a game
  app's own config its bans. The preset ships three checks: `beacon-check-tier-gate`,
  `beacon-check-internal-refs` and `beacon-check-copy`.

## A game's tier `[C]`

A game's packages are a tier of their own: the game's model and its console plugin. A game tier is
RN-safe like `core/` and depends on `core/`. The console plugin also depends on `admin/`. Nothing in
the platform depends on a game. A game develops its packages in its own repository and publishes them to the registry. A game called Kites might publish `@kites/game` and `@kites/beacon-admin-plugin`. A console image installs the game plugins it carries when the image is built. The console's root manifest names the plugin pattern `@*/beacon-admin-plugin` under `beacon.foreign.games`, so the tier gate holds any plugin to a game's bans although no plugin is in the console's workspace. No server package depends on a game's model, not even in tests.

## Rules

### Tiers depend downward only

| Tier                                                    | May depend on         |
| ------------------------------------------------------- | --------------------- |
| a game                                                  | `core/`               |
| `server/`                                               | `core/`               |
| `client/`                                               | `core/`               |
| `admin/`                                                | `core/` and `client/` |
| a game's console plugin (`@<game>/beacon-admin-plugin`) | `admin/`              |

**Every directory under `packages/` other than `core/`, `server/`, `client/`, `admin/` and
`tooling/` is a game tier.** A new _platform_ tier therefore has to be added to `PLATFORM_TIERS` in
`@beaconsgg/eslint-config` ([`tiers.mjs`](tooling/eslint-config/src/tiers.mjs)), or the gate treats
the new tier as a game. A package installed from the registry that belongs to a tier is named as
foreign in the root manifest of the repository that installs it (`beacon.foreign`).

The tier gate reads the tiers and their packages from the repository and names no game. The gate
enforces these bans:

- A `core/` package never imports a game or a server package. A `core/` package also never imports
  the client SDK or `admin/`.
- Server code never imports a game, the client SDK or `admin/`. Server code is `server/`,
  `apps/server` and `apps/atlas` in the server's repository.
- `client/` never imports a game, a server package or `admin/`.
- `admin/` never imports a game or a server package.
- The console (`apps/admin` in its repository) never imports a server package. The console imports
  a game only as the game's plugin, listed in `plugins.ts`.
- A game tier never imports a server package or another game's packages.
- Only a game's plugin imports `admin/`, and the game's other packages never import the plugin.
- No package and no server code imports the console app itself.

A game is its packages plus its app under `apps/games/<game>`. The bans cover the app as well. The
app also may not import any console plugin, its own included. A plugin would bundle the console's
React DOM into the app. The app lints itself under Expo's config, so the preset hands the
app its bans (`gameAppGate`). The app's config spreads the bans into every block that sets
`no-restricted-imports`. The tier-gate check plants a banned import in each app to prove the bans
are there.

The gate covers these forms of import:

- `import` and `export ... from` declarations;
- `import("x")` types;
- dynamic `import()`;
- `require()`.

The root pass rejects every `require` anyway through `@typescript-eslint/no-require-imports`. A game
app's config sets that rule to a warning, so the gate names `require` as well. Server tests are held
to the gate too, and they run on the generic policies of `@beaconsgg/policy-engine/testing`. The
preset's own suite runs the config over a made-up repository with a second game to prove the gate
covers a game it does not name. The preset's bin `beacon-check-tier-gate` runs as part of the gate. The bin checks that each game
app's own config still carries its gate.

### Keep `[C]` packages RN-safe

The ESLint gate in `@beaconsgg/eslint-config` bans Node built-ins across `core/`, `client/`,
`admin/` and every game tier.

### Game logic belongs in its game's tier

Platform logic belongs in the `@beaconsgg/*` tiers, and game logic in the game's tier. A game's
nouns in a `@beaconsgg/*` package are a regression. The wire carries a game's objects as opaque
values, such as an item's `birth` and a scout's `config`. The game's own model lives in the game's
packages, so `core/` holds nothing of any game. The server repository's
[`doc/known-couplings.md`](https://github.com/beacons-gg/beacon.server/blob/main/doc/known-couplings.md)
describes where the game-agnostic server and the first game's wire shapes meet.
