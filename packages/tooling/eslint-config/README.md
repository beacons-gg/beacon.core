# @beaconsgg/eslint-config

The ESLint config every Beacon repository lints with. The config holds the base rules, the RN-safety
gate and the tier gate. Every repository holds the same gates by version instead of by a copy.

```js
// eslint.config.mjs
import { repoConfig } from "@beaconsgg/eslint-config";

export default repoConfig(new URL("./", import.meta.url));
```

## What the package exports

- **`repoConfig(root)`** is the whole config for a repository laid out in tiers. `repoConfig` reads
  the tiers, their packages and the workspaces that lint themselves from `pnpm-workspace.yaml` and
  the manifests under `root`. The config names no game and enforces these rules:
  - `core/` imports no other tier;
  - server code imports no game and no client SDK;
  - a game imports no server package and no other game's packages;
  - only a game's `admin-plugin` builds against `admin/`.

  The platform tiers are `core`, `server`, `client`, `admin` and `tooling`. Every other directory
  under `packages/` is one game's tier. The directory names are a fixed convention and no option
  changes them, because the directory is the tier.

- **`gameAppGate(root, appDir)`** is the gate a game's app spreads into its own config, since an app
  lints itself under its framework's config. `patterns` goes into every block that sets
  `no-restricted-imports`, and `syntax` goes into every block that sets `no-restricted-syntax`.
- **`base({ ignores?, gates? })`** is the base preset on its own. The preset holds these rules:
  - the recommended sets;
  - no `any`;
  - no unused names unless the name starts with an underscore;
  - no linting of build output or `scripts/`;
  - Prettier's overrides last.
- **`rnSafe(files)`** is the RN-safety gate on its own. Client-bound code imports no Node built-in,
  in any import form.
- **`@beaconsgg/eslint-config/copy`** exports the rules and readers of the copy check, described
  under `beacon-check-copy` below.

## A repository that holds one tier

In a repository that holds every tier, the config reads each tier from the workspace. A repository
that holds one tier installs what it may use from the registry. A package the repository doesn't
install fails to resolve on its own. The gap is a package the repository installs for one purpose
and must refuse everywhere else. A game's repository installs the console's plugin contract for its
console plugin. That install would also let the game's model import the contract and carry the
console's React DOM onto the phone. Nothing in that repository's workspace says the package belongs
to the admin tier, so the root manifest says so:

```json
{ "beacon": { "foreign": { "admin": ["@beaconsgg/admin-plugin"] } } }
```

`foreign` takes `server`, `client`, `admin`, `games` and `console`. Each takes a list of names in
the spelling of `no-restricted-imports` patterns, and the config gates those names as if the
workspace held them. The config reads `foreign` from the manifest and takes no argument for the
list. The repository's lint, a game app's own config and the check below therefore can't disagree.
Name only packages the repository installs.

Each repository keeps this list by hand. The list wouldn't be needed if every published package
named its own tier in its manifest and the gate read the tier from what is installed.

## `beacon-check-tier-gate`

`beacon-check-tier-gate` is the package's first bin. Run the bin from a repository's root in the repository's gate:

```sh
pnpm exec beacon-check-tier-gate
```

The check runs ESLint on every game app that lints itself. For a file in every directory of the app
the check asks what the config resolves to. The check fails if either rule lost the gate or stopped
being an error. Flat config replaces a rule's options per block, so one block that sets
`no-restricted-imports` for a subtree without spreading the gate removes the gate there without a
word. The check then plants an import the gate bans at the app's root, once in each import form. A
repository with no such app has nothing to check and says so. The check itself is
`scripts/tier-gate.mjs`, and the bin beside that file only runs the check.

Whether the tier gate covers a game the config doesn't name depends on this package and not on the
repository that installs the package. This package's own suite therefore tests the gate over a
made-up repository with a second game.

## `beacon-check-internal-refs`

The package's second bin lists what a repository's public text points at that a public reader can't
open. Run the bin from the repository's root:

```sh
pnpm exec beacon-check-internal-refs                              # report mode: lists every finding, exits 0
pnpm exec beacon-check-internal-refs --strict                     # exits 1 on any finding
pnpm exec beacon-check-internal-refs --strict --allow org-names   # exits 1 on any finding of the other rules
pnpm exec beacon-check-internal-refs --strict --patterns refs.json # adds the private names in refs.json
```

`--allow <rule>` names a rule whose findings the strict check still lists but doesn't fail on. The
flag takes one rule and can be repeated, and `--allow=<rule>` works too. The flag needs `--strict`,
since report mode fails on nothing. An unknown rule is an error.

The check reads every file `git ls-files` lists and skips these files:

- lockfiles;
- build output such as `dist/`, `coverage/` and `.next/`;
- minified files, source maps and snapshots;
- binary files, which git tells by a NUL byte.

Findings print with their file and line, grouped by rule. The report ends with a count per rule and
the number of files left out for each reason.

| Rule            | Finds                                                                                           | Where                               |
| --------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| `org-names`     | the names the repo lists for its organization, private registry and private repos               | anywhere                            |
| `issue-refs`    | an issue or pull request number after `#`, bare or after `org/repo`                             | comments, string literals and prose |
| `private-docs`  | the unpublished planning docs the repo lists, and `§` section references to docs the repo lacks | anywhere                            |
| `phase-wording` | plan wording: release and numbered decisions, `P` tags, lettered tracks and phases              | comments and prose                  |
| `people`        | the people the repo lists, in any case and also at the start of a handle                        | anywhere                            |

### Private names

The check carries no organization's names, docs or people of its own. Built in are only the shapes
that mean the same in every repository: issue references, phase wording and a `§` section of a doc
the repository doesn't ship. A repository lists its own private names in its root manifest:

```json
{
  "beacon": {
    "internalRefs": {
      "privatePatterns": {
        "orgNames": ["example-org", "packages.example.dev"],
        "privateDocs": ["roadmap.md"],
        "people": ["Robin"],
        "allow": ["Example Org LLC"]
      }
    }
  }
}
```

- `orgNames` match in any case, anywhere.
- `privateDocs` match by file name in any case, with any `§` section after the name.
- `people` match in any case and also at the start of a handle such as `RobinOnGit`. A name
  inside a longer lowercase word doesn't count.
- `allow` holds exact phrases, case included. A match inside one of these phrases is not a finding,
  whatever its rule. A copyright holder's legal name in `NOTICE` is the usual case.

Every list is optional. An unknown field is an error, so a misspelled list fails instead of
matching nothing. The check doesn't scan the `privatePatterns` value in the root manifest, since
that value is the check's own data.

`--patterns <file>` reads the same object from a JSON file, relative to the working directory. The
flag can be repeated and works with or without `--strict`. Each file's lists add to the
manifest's. Pass the flag when the names must not sit in the repository, such as a check run over
a public export. The check doesn't scan a patterns file that the repository tracks.

### What the check reads

The check treats Markdown, plain text, JSON and unknown file types as prose and reads every line. In
a code file a small lexer separates comments from code, so a `#` or a `//` inside a string or a
regex literal is not a comment. An HTML, Vue, Svelte or Astro file has both markup and script
comments.

The issue rule tells most colors and anchors from references. A bare `#` counts only at the start of
a line or after whitespace, `(` or `-`. The rule never counts a number that matches one of these:

- starts with `0`;
- runs to six digits or more;
- is followed by a letter or `;`.

A three-digit color written after a space in a string still reads as a reference. A border value
that ends in `1px solid` and then a three-digit gray is one example. A `P` tag has one digit, so a Wikidata property such as `P649` is not one.

A doc stops counting when the repository ships a file of that name or the root manifest lists the
doc as published:

```json
{ "beacon": { "internalRefs": { "publishedDocs": ["sync-protocol.md"] } } }
```

A doc linked by its URL in the public GitHub organization counts as public too, even when the
repository doesn't hold the doc. Name the organization in the root manifest:

```json
{ "beacon": { "internalRefs": { "publicOrg": "beacons-gg" } } }
```

With that setting a link such as
`https://github.com/beacons-gg/beacon.server/blob/main/doc/spec/places.md` is not a finding.
The setting covers `github.com/<org>/`, `raw.githubusercontent.com/<org>/` and `<org>.github.io`.

The check's patterns live in `scripts/internal-refs.mjs`. That file and this package's suite hold
patterns and fixtures as data. Each of the two files therefore carries the line
`beacon-internal-refs: pattern data` in its first ten lines, and the check skips the file. The
report names every file that opts out this way, and every tracked patterns file.

A repository runs the check in report mode until its cleanup is done, and then adds `--strict` to
its gate. The organization's names and URLs only change on the day a repository moves to the public
organization, so until then the gate runs `--strict --allow org-names`. Every other rule then fails
the gate, and the `org-names` findings stay listed for moving day. This repository runs the check by
path in its gate, as `pnpm run check:refs`. The root manifest doesn't depend on this package, since
turbo counts every file of a root dependency as a global input.

## `beacon-check-copy`

The package's third bin checks the writing rules a script can see in Beacon's public text: docs,
READMEs, specs and product copy. Run the bin from the repository's root with the files the check should read:

```sh
pnpm exec beacon-check-copy 'docs/**/*.md' 'app/**/*.tsx'  # exits 1 on a finding that fails
pnpm exec beacon-check-copy --strict 'docs/**/*.md'        # exits 1 on a warning too
pnpm exec beacon-check-copy --report 'doc/**/*.md'         # lists every finding and exits 0
```

An argument is a path, a directory or a glob in git's syntax. In a glob `**` crosses directories.
The check reads the files git tracks or would track and skips ignored ones. A pattern that matches
no file is an error, so a typo can't pass as a clean run. Markdown files are read as docs pages,
where a question fails. A `.ts`, `.tsx`, `.js` or `.jsx` file is read for its JSX text and string
literals. Each finding prints with its file, its line and its rule. The report ends with a count per
rule.

The rules live in `scripts/copy.mjs`. A repository that runs them over text of its own imports them,
with their types:

```ts
import { checkProse, proseOfMarkdown, proseOfSource } from "@beaconsgg/eslint-config/copy";
```

This repository runs the check by path with `--strict` in its gate, as `pnpm run check:copy`.

`eslint` and `typescript` are peer dependencies. The package moves on the version of the seven core packages ([`doc/core-compatibility.md`](../../../doc/core-compatibility.md) §7). A
new ban or a new base rule can fail a consumer's lint, so either is a major version.
