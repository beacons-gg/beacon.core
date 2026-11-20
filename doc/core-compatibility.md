# Core packages: public API, versions and compatibility

This page states what the seven published `@beaconsgg/*` packages promise to whoever installs them.
The page calls them the core packages:

- the five in `packages/core`: `@beaconsgg/protocol-types`, `@beaconsgg/identity`,
  `@beaconsgg/jsonlogic-profile`, `@beaconsgg/geo` and `@beaconsgg/scout-interp`;
- the two shared client packages in `packages/client`: `@beaconsgg/client-sdk` and
  `@beaconsgg/event-bus`.

The page covers:

- what counts as the public API (section 2);
- what a major, a minor and a patch mean (section 3);
- how the wire grows (section 4);
- how something leaves the public API (section 5);
- which versions a server and a client must work across (section 6);
- how the packages are published (section 7);
- what the operator console's plugin contract promises (section 8);
- how changes are announced (section 9).

The rules hold from `1.0.0`. Section 3 says how the `0.x` line before it differed. Server and game
packages make no such promise.

## 1. Names

The packages keep the `@beaconsgg/*` scope on every registry that hosts them. A package's name is
part of its public API, so a new name or scope for a package is a major (section 3).

## 2. The public API

The public API has three parts:

- the names the packages export, described below;
- the wire: what a client and a server send each other (section 4);
- the operator console's plugin contract, which has a version of its own (section 8).

A package's exported API is every name its `exports` map reaches. That means the root entry and the
subpaths the map declares. Three subpaths exist: `@beaconsgg/identity/conformance`,
`@beaconsgg/protocol-types/examples` and `@beaconsgg/protocol-types/server`. Nothing else is public.
The `server` subpath holds the helpers only a server needs, so the root a game imports does not
carry them. They are public all the same, for anyone who writes a server. Importing a file under
`dist` directly is not supported. Node refuses such an import through the `exports` map. Metro only
warns and TypeScript's `node` resolution does not check the map, so the import can appear to work
and still break in any release.

The promise covers what a name does as well as the name itself:

- what a schema accepts and what it outputs;
- what a function takes and returns;
- the bytes a signer produces for a given input, which the signing vectors pin;
- the answers a conformance vector expects;
- what the package calls on an interface the consumer implements and hands in. The client SDK's
  socket, `fetch`, key store and vault crypto are such interfaces;
- what the client SDK writes to the key store it is handed;
- what the client SDK defines for a consumer to persist and hand back, such as
  `ServerRegistryState` through the registry's `rehydrate`. A newer version reads what an older one
  stored, and an absent field keeps the meaning it had. A player's wallet and saved servers outlive
  the app build that stored them.

The wire is everything a client and a server send each other:

- the routes, the ops and each op's params and result;
- the error codes and the HTTP statuses they come with;
- the live channel's messages;
- the server descriptor and its markers;
- the documents a client signs or reads, and their signed byte layouts.

The admin API the operator console calls is part of the wire too. The schemas in
`@beaconsgg/protocol-types` define each shape. The specs in [`spec/`](spec/README.md) and in the
server's repository give the rules, and [`game-author.md`](game-author.md) is the contract a game
reads.

Each package commits the list of its names in `public-api.txt` in the source repository, with one
`<entry point> <value|type> <name>` line per export. `node scripts/check-core-api.mjs` fails the
gate and CI when the list and the source disagree. Adding, removing or renaming a public name
therefore always shows up in review as a change to that file. A change to what a name does or to its
type doesn't show up there, so the reviewer has to catch it. After a deliberate change run the
script with `--write` and commit the list.

Some things are outside the promise:

- the text of an error's `message`. Match on the error's class, `status` or `code`;
- the value of a client SDK default the docs give. `REQUEST_TIMEOUT_MS`, `DISCOVERY_POLL_MS` and
  `VAULT_SESSION_TTL_SEC` are such defaults. The name is promised, and a minor may tune the value. A
  protocol limit such as `MAX_PROFILE_BYTES` is a wire form and is promised;
- the shape of an object the SDK hands out for calling only, such as `BeaconClient` and
  `PassphraseVault`. A consumer calls these and does not implement them, so a new method on one is a
  minor.

The client SDK's socket is an interface the consumer implements. The promise covers the socket's
members (`connected`, `on`, `emit` and `disconnect`) and how `LiveConnect` is called. The event
names and payloads the SDK sends and listens for through the socket are wire forms (section 4).

A name that has to be exported but is not meant for consumers is marked `@internal` in its JSDoc and
is free to change. Such a name still appears in `public-api.txt`, and removing it there is not a
major. None exists today, and the bar for adding one is high.

## 3. Version numbers

- **Lockstep.** All seven packages share one version number, so "core N" means the same thing for
  every package. The tooling presets share the number too: a release names one version and
  everything this repository publishes moves to it.
- **Semantic versioning** judges a change to anything in section 2 from the consumer's side. A
  break of the public API or of the wire is a major.
  - **Major.** Any of these is a major:
    - a public name removed or renamed;
    - a new required field or parameter;
    - a function or type otherwise changed so that existing callers break;
    - a schema that refuses input it used to accept, or whose output loses a field or changes the
      type of one;
    - any change to the bytes a signer produces or a vector pins;
    - a wire form removed or given a new meaning, which section 4 allows only past the skew window.
      A wire form is a field, an op, an error code or a marker;
    - an interface the consumer implements that asks more of it, such as a new required member or a
      call the package did not make before;
    - stored state (section 2) that a newer version no longer reads, or reads differently;
    - a higher minimum runtime (Node or React Native) or a new major of a peer dependency.
  - **Minor:** a new name; a new optional field or parameter; a schema that accepts more; a new
    error code with its fallback; a new conformance vector; a new capability marker; an optional
    member on an interface the consumer implements; a deprecation. A new member of a union or enum
    is a minor for TypeScript callers (code that switches over one keeps a default branch), but on
    the wire only where section 4 says so.
  - **Patch:** a fix that changes none of the above. A fix that refuses input no conforming
    implementation can produce is a patch too, and its release note says so. A value with no
    canonical JSON form is one example, because no signer could have signed that value.
- **Majors are rare and planned, for all seven.** Sections 5 and 6 count majors: a client and a
  server work together within one, and a deprecated wire form can go two majors on. A major cut for
  one package's TypeScript API alone would move both counts for every package while the wire stays
  the same. The client SDK has the largest and fastest-moving API of the seven. A breaking change to
  any package's API is therefore never released on its own account, and that includes the SDK. The
  change waits for the next planned major. Until then the change ships as an addition beside what it
  replaces, with the old form deprecated (section 5).
- **Release candidates.** A major is published first as candidates (`2.0.0-rc.1`) under the `next`
  dist-tag (section 7). Candidates may break each other until `N.0.0`, so the promises above start
  at the stable version. A minor or a patch may have candidates too, and those follow the rules of
  the release they lead to.
- **The `0.x` line comes before `1.0.0`.** From `0.1.0` until `1.0.0` the packages are on `0.x`. On
  that line each kind of change moves down one place: a breaking change is a minor (`0.3` to `0.4`),
  and an addition or a fix is a patch. A `^0.4.0` range therefore pins one compatible line. On `0.x`
  a red cell of the skew matrix (section 6) is information for the release and breaks no promise.
  `1.0.0` keeps the wire of `0.4`, so the skew window carries over (section 6).
- **Fixes land on the newest line.** A release runs only from `main` and never goes below the
  version `main` names (section 7). Once a major's first candidate is on `main`, a fix for the line
  before it ships in the next candidate and in `N.0.0`.

## 4. Wire changes

The protocol grows by additions, and each addition reaches the other side without breaking it:

- A server advertises what it newly **accepts** as a marker in its descriptor. The markers for
  additions include `op:<name>`, `policy:<feature>` and `rule:<name>`
  ([`game-author.md`](game-author.md) section 5.5). A client checks for the marker before using the
  addition.
- Something new a server **sends** that an older client could misread goes only to a client that
  declared it reads the addition. A new error code is the usual case, declared as `code:<name>` in
  the `beacon-understands` header.
- A new field in a shape with a read twin needs no marker, and neither does a new room change. An
  older reader ignores the field or re-reads the room.
- A read twin ignores unknown keys, but an unknown **value** in a closed set still fails the read.
  Categories, roles and access levels are closed sets of this kind. A new value in one of them is an
  addition only where the field's read declares what an older reader does with an unknown value, or
  where the value goes only to a client that declared it reads it. Anywhere else the value
  waits for a major or ships as a new field.

A protocol addition is therefore a minor version of the packages that describe it.

Nothing already on the wire changes meaning inside the skew window (section 6). That covers a field,
an op, an error code and a signed byte layout. To replace one, add its successor behind a marker and
keep accepting the old form for as long as a supported version can send it. A major version almost
always changes the TypeScript API and leaves the wire alone.

## 5. Deprecation

Something leaves the public API in two steps:

1. **Deprecate it in a minor.** Mark it `@deprecated` in its JSDoc with the name of the replacement.
   Add a changelog entry that says the same (section 9). The replacement ships in the same minor or
   an earlier one.
2. **Remove it in a later major,** and only once no version inside the skew window still needs it.

A deprecated name keeps working for at least one minor. A deprecation therefore never ships in the
major that removes the name. The deprecating minor is a stable release before the major's first
candidate, so consumers get at least one stable release with both forms and move at their own pace.

An export that reads or writes nothing on the wire can go in the next major at the earliest. An
export deprecated in `N.x` is then gone in `N+1.0.0`. A wire form takes one major longer, and so
does any export that reads or writes one. That holds whichever side sends or accepts the form. A
client on `N` is inside the window of a server on `N+1`, so a form deprecated in `N.x` is still
handled by `N+1` and can go in `N+2.0.0`.

The changelog lists every deprecation with its replacement and the earliest major that may remove
it.

## 6. The skew window

A server and a client work together when their core versions are **at most one major apart in
either direction**, at any minor. A client on core `N` works with a server on `N` or `N-1`, and a
server on core `N` works with a client on `N` or `N-1`. A client's core version is the version of
the core packages the client is built with, including the client SDK. The lockstep makes that one
number.

What each side must do inside the window:

- **A server on `N` accepts** everything a client on `N-1` sends at any minor. The server also
  accepts everything a client on `N` sends up to the server's own minor. That includes a form
  deprecated since, as section 5 says. A newer client's additions wait for the server's marker
  (section 4). The server answers in shapes the client's read twins read. A new error code or a new
  value in a closed set goes only where section 4 allows.
- **A client on `N` works with** a server on `N` or `N-1`. The client reads that server's documents
  with the read twins, which ignore the fields the client does not know. An older server lacks what
  was added after its version. The client therefore checks the server's marker before the client
  uses an addition (section 4).

**The window's floor is 0.3.0, and 1.0 keeps the window.** For the window the whole `0.x` line from
the floor counts as the major before `1`. Release 0.3 renamed the wire's terms once so that 1.0
could freeze them, and nothing below 0.3.0 talks to a 0.3 server or client. Release 0.4 changed the
meaning of no field, op or error code. Release 1.0 changes none. Release 0.4 did narrow two forms.
The three discovery paging fields went, and no client or server had used them. A mailbox body's
limit counts UTF-8 bytes instead of characters, so a 0.4 server refuses a body that fits the limit
in characters but not in bytes. Apart from those two forms a server on `1.x` works with clients from
0.3.0 on, and a client on `1.x` works with servers from 0.3.0 on. From `2.0.0` the window spans
`1.x` and `2.x`.

The skew matrix tests the edges of the window. The matrix lives with the server in
[beacon.server](https://github.com/beacons-gg/beacon.server) as `.github/workflows/skew.yml`. A cell
needs a server at its head and at its releases, and that repository has both and takes core from
the registry. The matrix runs against published core on every change to the server or to the core
versions the server installs. The cells are:

- within `N-1`: the oldest minor in the window at its latest patch and the latest release, each as
  the client against the head's server. "At any minor" puts the oldest app still installed inside
  the window, and that app stays inside when the first candidate of the next major is published;
- within `N`: the same two ends;
- while `N` has no stable release: only its latest release candidate. Candidates may break each
  other until `N.0.0` (section 3), so an older candidate is outside the window;
- the other direction: the server as last released against the head's driver, over the newest SDK
  that repository has taken. Only the latest server release is tested this way. An older server in
  the window relies on markers and read twins.

The core versions come from the registry's list. A release **as the client** is the compiled
five-flow driver running over the published SDK and core at that version. That cell stands for an
installed app that has not updated. A release **as the server** is the server repository's tree at
its release tag, installed from its own lockfile and built as it was. An empty window fails the run,
so a run with no cells never passes.

The matrix cannot see a core change that is not published yet. This repository's canary covers that
case with one cell (section 7). The canary runs the driver the server's repository publishes
(`@beaconsgg/flows`) over the throwaway build of a pull request's core. The server the canary runs
against is the server as released, which is the image operators pull. A release then makes the
change visible to everything else. The consumers' own CI runs over the release, and the matrix tests
the release before a stable version follows ([`release-runbook.md`](release-runbook.md) §4).

Both sides of the window also share the conformance vectors that each side ships:

- the signing vectors (`@beaconsgg/identity/conformance`);
- the JSONLogic vectors (`CONFORMANCE_VECTORS` in `@beaconsgg/jsonlogic-profile`);
- the containment vectors (`CONTAINMENT_VECTORS` in `@beaconsgg/geo`).

A cell of the matrix runs the five flows through the client SDK against a running server. The
flows are a place, a contribute, a claim, a profile publish and a live update over the map channel.
The driver is `apps/flows` in the server's repository, published as `@beaconsgg/flows` with the
`beacon-flows` command. The driver depends on core and on nothing of a game, so the driver installs
from the registry at any core version. The driver reports each flow instead of throwing, so a cell
that fails says which flow did. The driver's own suite boots the real server on Postgres and runs
the five flows at one version, the diagonal of the matrix. That suite runs in every gate of the
server's repository. The driver speaks for the oldest client in the window, so the driver calls only
what that version's SDK has. An addition to the SDK is fine for a consumer. The driver can't use
one, because the cell that runs the driver over the older SDK would then fail.

From `1.0.0` a red cell is a broken promise. The change does not ship until the cell is green, or
the change waits for the next major. The matrix runs only on changes to the server, so the check is
the release's to read and is not a required status of every pull request.

## 7. Publishing

This repository publishes the seven in lockstep to the public npm registry under the `@beaconsgg`
scope. Installing them needs no token. Publishing needs the `NPM_TOKEN` repository secret, an npm
token with publish rights to the scope.

**Build format: CommonJS with type declarations.** Each of the seven packages builds only that way.
The three consumers all take CommonJS: Node for the server, Next for the console and Metro for a
game app. A second ESM build would double every file for no consumer. The second build would also be
a hazard. A graph that reaches `@beaconsgg/protocol-types` through both forms gets two module
instances. Every other package composes the schemas of `@beaconsgg/protocol-types`, so one
`instanceof` check or one `zod` registry would see objects from the other instance as strangers. If
a consumer needs ESM, the ESM build comes as a minor for all seven packages at once. The `exports`
map of each package also names the package's own `package.json` for tooling that reads a manifest by
package name. That entry reaches no names, so the entry is not part of the API list (section 2).

**`zod` is a peer dependency of `@beaconsgg/protocol-types`** at the range the workspace catalog
sets. The package also lists `zod` as a dev dependency for its own build and tests. Every consumer
composes the schemas the package exports, and two copies of `zod` in one app would make a schema
from one copy unusable by the other. A consumer declares `zod` itself. The other six packages reach
`zod` through `protocol-types`. Moving to a new major of `zod` is a major of all seven (section 3).
The range is zod 4 (`^4.6.7`, the version CI tests). Zod 3 is not supported.

**Minimum runtimes.** From `1.0.0` every published package declares `"engines": { "node": ">=22" }`,
the seven and the tooling presets alike. Core's CI runs on Node 22. The server, the console and the
games build and run on Node 22 too. Node 22 is also the oldest Node line still maintained. The gate
checks that each published manifest names the root manifest's minimum
(`scripts/check-manifests.mjs`). npm and pnpm warn when the installing Node is older, and refuse
under `engine-strict`.

No package declares React Native as a peer dependency, so no manifest names a React Native version.
The minimum the seven support in an app is **React Native 0.86 on Expo SDK 57**, the version a game
runs them on today. An older React Native may work but is not tested. Raising either minimum is a
major (section 3).

**Versions and releases.** Everything this repository publishes moves as one version (section 3),
and a release names the version when it runs. A pull request's title is its line in the release
notes.

- **A pull request that changes a package** has a one-sentence title that says what a consumer will
  notice. The bump the change implies follows section 3: a breaking change is a major and waits for
  the next planned major, an addition is a minor and a fix is a patch. A deprecation or a breaking
  change also needs its changelog entry (section 9).
- **A release is one run of `.github/workflows/release.yml` on `main`** with a version
  (`gh workflow run release.yml -f version=1.0.1`, or the Actions tab). The run takes these steps in
  order:
  1. sets that version on every published manifest;
  2. runs the whole gate on that tree;
  3. pushes the commit `Release <version>` to `main`;
  4. builds and runs `pnpm -r publish`, which puts up each package the registry lacks and skips the
     rest. A pre-release such as `2.0.0-rc.1` goes up under the `next` tag and never moves `latest`;
  5. for a stable version, points `latest` at that version;
  6. tags `v<version>` and creates the GitHub Release on the tag, with notes generated from the pull
     requests merged since the previous release.

  Every step is safe to repeat: a run that did not finish is run again with the same version.
  Internal ranges stay `workspace:*` in the repository. On the way out `pnpm publish` rewrites them
  and the `catalog:` ranges to the resolved versions.

- **Pre mode ended at `0.1.0`.** The first builds were `1.0.0-rc.N` candidates under the earlier
  `@beacon` scope, and they are deprecated in favor of `0.1.0`. Releases up to `0.1.0` also carry
  one tag per package (`@beacon/geo@0.1.0`). From `0.1.1` the one tag is `v<version>`.

What a consumer installs is `dist` plus `README.md` and the manifest (`files`). Only the published
packages leave out `private`: the seven, the operator plugin contract and the tooling presets.
`pnpm publish -r` skips a private package, so no other workspace can go up by accident.

**A new published package arrives at the version `main` names**, and the next release moves the new
package with the rest and publishes it. `pnpm publish -r` puts up every public version the registry
lacks.

**The operator plugin contract** (`@beaconsgg/admin-plugin`) is published too. The contract is
defined and published in the console's repository,
[beacon.admin](https://github.com/beacons-gg/beacon.admin). A game's console plugin is written
against the contract, and a game is developed outside both repositories. The contract is released
the same way as the seven, on a version of its own. Section 8 says what the contract promises.

The contract is the one published package built as ES modules (`"type": "module"`). Next needs the
contract's `"use client"` directive to stay the first statement of the module, and no consumer of
the contract is Metro or a CommonJS server. The contract's build compiles under Node's resolution
(`tsconfig.build.json`), so a relative import without its extension fails the build instead of an
install. Every consumer in the contract's repository is a bundler, and a bundler would never notice
the missing extension.

**The tooling presets** (`packages/tooling/*`) are published beside the seven. Core, the server and
the console all use the presets. Each of those repositories changes its build, format and lint
config by raising a version instead of editing a copy. A game takes none of the presets, because a
game is developed as an outside project with its own config. The presets are:

- `@beaconsgg/tsconfig`: the compiler options every workspace extends;
- `@beaconsgg/prettier-config`: the format options;
- `@beaconsgg/vitest-config`: the coverage scope and floor, with the check that every suite holds
  one;
- `@beaconsgg/eslint-config`: the base rules, the RN-safety gate and the tier gate. The package also
  holds three checks. `beacon-check-tier-gate` checks that the tier gate covers a game the config
  does not name. `beacon-check-internal-refs` finds references a public reader cannot open.
  `beacon-check-copy` checks the writing in public text.

The presets are tooling. None of this document's promises about names, wire forms or the skew window
applies to them. The presets move with the seven on the one version a release names, because one
version for everything this repository publishes is simpler than two. A change that can fail a
consumer's gate or reformat the consumer's files is a breaking change:

- a tightened compiler flag;
- a raised coverage floor;
- a new lint ban;
- a changed format option.

Such a change is a major of the whole line (section 3), so the change waits for the next planned
major. Until then the change can ship as an option a consumer turns on, which is a minor.

**The install check** (`.github/workflows/install-check.yml`) runs on a pull request that changes
something published: one of the seven or a tooling preset. The check starts a throwaway registry
inside the CI job, a Verdaccio on the runner (`scripts/canary-registry.mjs`). The check publishes a
throwaway build of everything published to that registry, as `0.0.0-canary.g<sha>.<attempt>` under
the `canary` dist-tag. The throwaway registry holds the published names and nothing else. Every
other `@beaconsgg/*` package comes through it from the real registry, which is one setting in the
workflow (`UPSTREAM_REGISTRY`). Every npm config the check reads names the throwaway registry for
the scope and holds a token for that registry alone, so a canary never reaches a real registry. The
check then writes a small consumer outside the workspace (`scripts/canary-consumer.mjs`) whose
manifest names every published package at that version. The consumer installs the build from the
throwaway registry. Inside the consumer the check then:

- loads every entry point of every package;
- typechecks a file that imports one of the seven under the tsconfig preset;
- runs the consumer's test under the vitest preset with the floor;
- lints and formats under the other two presets by name;
- runs the presets' checks from their bins;
- checks that the lockfile holds no other version of anything published.

The check proves the artifact's `files`, exports maps, rewritten ranges and peers. The suites over
the workspace copies can't prove those, and they also can't prove a preset that resolves from
`node_modules`. The throwaway registry ends with its job, so nothing is left to unpublish. The real
registry holds releases only.

The server, the console and the games run their own CI over what is published. Whether a consumer
still builds and passes is therefore learned from a release in the consumer's repository, before the
next release depends on it.

The install check does run one consumer, a client. The check's `flows` job starts the throwaway
registry again over the build the first job published. The job installs the five-flow driver through
that registry with the seven forced to the throwaway build (`scripts/canary-driver.mjs`). The job
starts the server as released on a fresh Postgres database, from the server's `beacon-server:latest`
image. The job then runs the five flows, which stand for an app built on this change meeting the
server operators already run. From `1.0.0` a red `flows` job blocks the merge, as a red cell of the
skew matrix does. The job's summary names the release the job ran against and which flows passed.

The workflow runs on every pull request, and its `Install check summary` job is the check a merge
requires. The summary passes when every job that ran passed, and when the install jobs were skipped
because the pull request changes nothing published. The summary fails when any of them failed.

The release tag (`v<version>`) and the GitHub Release on the tag let a consumer find the commit
behind a version and read what changed.

A registry that needs a token to read leaves each consumer to decide where the token lives in an
image build or a device build. A BuildKit secret and an EAS pre-install hook both work.

## 8. The console's plugin contract

`@beaconsgg/admin-plugin` is the seam between the operator console and a game's operator screens. A
game ships its screens as a `GamePlugin` that depends on the contract and never on the console. The
console hands the plugin an `AdminHost` through `useAdminHost()`.

The contract promises:

- **The contract's names and what they do.** The contract's public API is every name its `exports`
  map reaches, listed in its own `public-api.txt` and checked like the seven's (section 2). The
  promise covers the members of `AdminHost` the console hands a plugin and the component props the
  contract declares for the console's `ui` components.
- **Semantic versioning on a version of its own.** The rules of section 3 apply. A removed or
  renamed name is a major. So is a new required member of `GamePlugin`, because a plugin implements
  `GamePlugin`. A new member of `AdminHost`, a new optional member of `GamePlugin` and a new
  optional component prop are minors. A plugin reads `AdminHost` and does not implement it. A test
  double of `AdminHost` in a plugin's own tests is the plugin's to update. A plugin built against
  contract `N.y` therefore works in every console built on `N.y` or on a later minor of `N`, when
  the console's core packages are at the core minor the plugin was built against or later.
- **The deprecation period of section 5.** A deprecated name keeps working for at least one minor
  and goes in the next major at the earliest.
- **The core packages under its types.** The contract's types are written in three of the seven:
  `@beaconsgg/client-sdk`, `@beaconsgg/identity` and `@beaconsgg/protocol-types`. Those three are
  peer dependencies by caret range, as `react` is. The console hands a plugin its own SDK client and
  wallet, so the contract's types have to come from the host's copy of the SDK. A minor or a patch
  of the seven stays inside that range and leaves the contract's version alone. **A major of the
  seven is a major of the contract**, because the major moves under the contract's public types. A
  release that takes the seven to a major is followed by a major of the contract.

The contract describes the console and leaves the wire alone, so the skew window (section 6) does
not apply to the contract itself. A plugin reaches servers only through the client the console hands
it. The calls a plugin makes are therefore the console's calls, inside the window of the console's
core version. The contract is versioned outside the fixed group of the seven, and the console's
repository releases the contract (section 7). The contract's `1.0.0` comes with core's `1.0.0`, and
the rules of this section hold from then.

## 9. How changes are announced

Every release is announced in its GitHub Release, and some releases have a changelog entry too:

- **The GitHub Release** on the `v<version>` tag. The release's notes list the pull requests merged
  since the previous release. A pull request's title is a sentence a consumer can read (section 7).
- **`CHANGELOG.md`** at the repository root, the changelog. The changelog adds what a consumer
  has to do, and the newest release comes first.

The changelog has an entry for each of these releases:

- **every major**, with what changed and how each kind of consumer migrates. The kinds are the
  server, the console, a game and a game's console plugin;
- **every release that deprecates something**: the deprecated form, its replacement and the earliest
  major that may remove the form (section 5);
- **every release that asks a consumer to act**, such as a tooling preset that reads a new setting.

A release that asks nothing of a consumer may have no changelog entry.

A deprecation also shows in the code: the `@deprecated` tag in the JSDoc names the replacement, and
an editor shows the tag wherever the deprecated name is used.

A major comes as release candidates first (section 3). The changelog entry comes with the first
candidate. The server, the console and the games can then move before the stable version is out.

The console's repository announces the plugin contract the same way: in its GitHub Releases, with a
changelog entry for each major and each deprecation of the contract.
