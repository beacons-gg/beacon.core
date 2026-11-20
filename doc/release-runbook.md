# Release a change that spans repositories

This guide is for Beacon's maintainers. Beacon ships from more than one repository, and a change to
the wire or the primitives reaches players only after each repository has released the change in
turn. The guide gives the order of the releases, how to read the skew matrix before one and how to
back a release out.

The rules the guide applies are in [`core-compatibility.md`](core-compatibility.md). The seven core
packages move as one version (§3). A client and a server work together within one major version of
each other (§6). Publishing is covered in §7.

## 1. Where each piece ships from

| Piece                                                             | Ships how                                                                                                                                                                                                                                                                                                                                          | From                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| The seven core packages and the four tooling presets              | The Release workflow, run by hand on `main` with a version (`gh workflow run release.yml -f version=0.3.1`). The run sets the version on every published package and runs the gate. The run then pushes the version commit and publishes the packages. Last the run tags `v<version>` and creates a GitHub Release with notes from the merged PRs. | this repository       |
| `@beaconsgg/admin-plugin`, the operator console's plugin contract | The console's Release workflow, run by hand on its `main` with a version. The run is the same as this repository's, for one package. The same run also ships the console image (next row).                                                                                                                                                         | beacon.admin          |
| The operator console                                              | The console's Release workflow builds the console's Docker image and pushes the image as `beacon-admin:<version>` and `beacon-admin:latest` before the tag and the GitHub Release. Operators deploy by pulling the tag, as the console's README describes under "Deploying the console".                                                           | beacon.admin          |
| The server and Atlas images, and the flows driver                 | The server's Release workflow, run by hand on its `main`. The run gates the server and pushes the images tagged `<release tag>` and `latest`. The run publishes `@beaconsgg/flows` when its version is new. Last the run creates the tag and the GitHub Release.                                                                                   | beacon.server         |
| A game and its console plugin                                     | The game's own release process. Each game ships from its own repository on its own schedule.                                                                                                                                                                                                                                                       | the game's repository |

## 2. The order when a change spans repositories

A consumer of a published package can move only after the package is on the registry. Release the
producers first:

1. **Core.** Merge the change. Then run the Release workflow on `main` with the version. A breaking
   change takes a major version and waits for the next planned one, an addition takes a minor and a
   fix a patch. The run's summary links the
   GitHub Release. When a run fails, run the workflow again with the same version. The second run
   finishes what the first one left undone.
2. **The server.** In beacon.server raise the `@beaconsgg/*` ranges if the change needs the new
   version. The ranges are carets, so a lockfile refresh alone picks up a new minor or patch. Run
   `lockfile.yml` on the branch and merge. The server's CI and its skew matrix then run over the new
   core. Next run the server's Release workflow on `main`. The workflow validates the server and
   pushes the images, which carry the release tag. Deploy by pulling the tag, as the server's
   `doc/deploy.md` describes.
3. **The console.** In beacon.admin raise the `@beaconsgg/*` ranges the same way, run `lockfile.yml`
   on the branch and merge. The game plugins a console image carries are named in `CONSOLE_PLUGINS`
   (a build argument, or a variable on the console's `release` environment). The image build installs
   them from the registry. Then run the console's Release workflow
   on `main` with a version. Use a major if the plugin contract broke, a minor for an addition to the
   contract and a patch otherwise. The run publishes
   the contract when that version is new and pushes the console image tagged with the version. A
   change to the console alone also needs this release before an operator can run the change, since
   merging ships nothing. Deploy by pulling the image tag.
4. **A game.** In the game's repository raise the `@beaconsgg/*` ranges if the change needs the new
   version, refresh the lockfile and merge. Read the skew matrix (§4) before the game ships, then
   release the game the way that game ships.
5. **A game's console plugin**, when its screens changed or its peers' major version moved. Raise
   the plugin's version in the game's repository and publish the plugin. Then build and release a
   console that carries the new version (step 3).

A breaking change is a major version (`core-compatibility.md` §3). A core change that touches the
wire ships to the server and to the games in the same release round, and the maintainers read the
skew matrix before a game ships (§4 below).

## 3. Before a game ships

A game decides how it ships, and Beacon's repositories hold none of a game's release steps. A game
that reaches players as an installed app should check two things before an update goes out:

- The skew matrix (§4) shows the new client working against the servers its players use.
- An update that changes native code goes out as a new build. An over-the-air update reaches only
  the builds whose native code matches the update.

## 4. Reading the skew matrix

The matrix lives in beacon.server, in `.github/workflows/skew.yml`. A PR that changes the server, the
flows driver or the lockfile runs the matrix. A maintainer can also run the matrix by hand. A cell is one
direction of the window (`core-compatibility.md` §6). One direction runs the head's server against a
released client. The other runs the server as last released against the head's driver. Each cell
runs the five flows. The matrix tests published core, so a core change shows up there once its
release is out and the server has taken the release. Read the latest run before you ship a game
update or a server release:

- **All cells green:** the head and every release the matrix tests work together. Ship in any order.
- **A cell red with the head as the server and a released client:** installed apps at that version
  would break against the new server. Hold the server change. From `1.0.0` a red cell is a broken
  promise, and the change waits for the next major (`core-compatibility.md` §6).
- **A cell red with the head as the client and a released server:** a new app would run against an
  operator's older server. Hold the game update until that server has upgraded. The other way out
  is to make the client's use of the change depend on the server's marker (`core-compatibility.md`
  §4).
- **The edges job fails with "empty window":** the registry's version list has no release in the
  window to test against. The run gives no verdict.

The matrix is information until `1.0.0`. From then on a red cell blocks the release.

## 5. Backing out

| What went wrong                             | Back out by                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A server release misbehaves                 | Pull the previous image tag on the host and restart. The compose files take the tag. Migrations run on boot and only move forward. A release that migrated is backed out to the previous release with the new schema in place, and every release so far reads the schema that later releases migrate to.                     |
| A console release misbehaves                | Run the previous `beacon-admin` image tag. The console holds no server-side state, so nothing else moves.                                                                                                                                                                                                                    |
| A server shipped ahead of installed clients | Nothing needs backing out if the change kept the window. Clients read what they know and ask for the rest through markers (`core-compatibility.md` §4). If a cell was red, pull the previous tag.                                                                                                                            |
| A game release is wrong                     | Back the game out the way that game ships. Beacon's repositories hold nothing to undo.                                                                                                                                                                                                                                       |
| A core release is wrong                     | A release is never unpublished, because the registry keeps releases and consumers may already pin one. Release the next version with the fix and move the consumers to it. A canary (`0.0.0-canary.*`) never reaches the registry, because the install check publishes the canary to a throwaway registry inside its CI job. |
| A console plugin version is wrong           | Publish a fixed plugin version from the game's repository. The next console image build takes the fix if the range in `CONSOLE_PLUGINS` admits the new version.                                                                                                                                                              |

## 6. What needs a maintainer

- Every place that publishes to the registry needs the registry token: a repository secret for
  GitHub Actions and the user config on a machine. A new repository that publishes needs the
  secret before its first release.
- A maintainer starts each release by hand. Each repository's Release workflow runs on its `main`
  and writes its tag and GitHub Release last. Merging validates, and releasing ships.
