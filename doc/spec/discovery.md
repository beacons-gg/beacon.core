# Discovery

How a client finds what is near a place, across many independent servers that may overlap. This spec
covers how servers advertise the area they cover, the anonymous discovery query and how moving scouts
show up. The live map channel and how a client picks the servers to ask are covered too.
`@beaconsgg/geo` holds the geohash rules, `@beaconsgg/protocol-types` the wire shapes and
`@beaconsgg/client-sdk` the client's routing.

Checked against Beacon 0.3.

## 1. Goals

Discovery is built to these goals:

1. **Answer "what is near here" across servers.** Many independent servers can cover the same area.
   A query returns the rooms placed there and the scouts moving through.
2. **Stay anonymous.** A read needs no identity ([identity §7.2](identity.md#72-reading-is-anonymous-and-writing-is-attributable)).
   The only thing a query exposes is the area of interest, kept coarse.
3. **Keep the server simple.** A server indexes its own rooms by location and answers region queries.
   A server never copies another server's state.
4. **Tolerate overlap and churn.** Coverage areas overlap and scouts move. A client dedupes results
   and keeps them fresh with little machinery.
5. **Respect trust.** Results carry the provenance a client needs to filter by allow and block lists
   ([identity §9](identity.md#9-trust-filtering)).

## 2. Ways to reach things

Discovery is one of two ways to reach something:

| Mechanism         | Input                    | How                                                      |
| ----------------- | ------------------------ | -------------------------------------------------------- |
| Direct resolution | a GlobalId `unique@host` | go straight to `host` to read or act on the room         |
| Spatial discovery | a map view               | query the servers that cover the area for room summaries |

A shared link uses direct resolution. A map uses spatial discovery, and a client must first know
which servers to ask (§7). Beacon 0.3 has no people search.

## 3. Geospatial model

### 3.1 Geohash everywhere

Every placed room carries a geohash. A query for an area is a prefix match, and a server's coverage
is a set of geohash prefixes. A client turns its map view into the set of geohash cells that cover
the view, plus each cell's eight edge and corner neighbors as a margin.

Cell precision follows the map's zoom level (`cellsForView` applies these steps):

| Zoom      | Precision |
| --------- | --------- |
| below 5   | 2         |
| 5 to 7    | 3         |
| 8 to 10   | 4         |
| 11 to 12  | 5         |
| 13 to 15  | 6         |
| 16 to 17  | 7         |
| 18 and up | 8         |

A zoom that isn't a finite number gets precision 2. `cellsForView` builds the cell set from the
coarsest precision up and stops before the set exceeds 64 cells (`maxCells`). A zoomed-out view
therefore never produces a cell list too long for a URL. Coarse cells still match finer rooms,
because matching is by prefix. Two cells intersect when one is a prefix of the other.

`coveringCells` handles two edge cases. An inverted latitude range is put in order. A view that
crosses the antimeridian is split into two boxes and the results are merged. A room is indexed at
precision 7 (`DEFAULT_PRECISION`).

### 3.2 Server descriptor

Each server publishes a descriptor it signs with its own key, so a client knows what the server
covers and who runs it. `GET /server/descriptor` returns it:

```jsonc
{
  "host": "beacon.example", // the `@host` part of the GlobalIds this server hosts
  "key": "did:key:z6Mk…", // the server's identity
  "coverage": ["9q5", "9q4c"], // geohash prefixes it serves; [""] means everywhere
  "name": "Example Beacon",
  "description": "Rooms for the north side of town", // optional, up to 280 characters
  "contact": "ops@beacon.example", // optional, up to 200 characters
  "version": "0.3.0", // the server software version
  "startedAt": "2026-11-11T08:00:00Z", // process start, so a client computes live uptime
  "accessLevel": "open", // open | request | private
  "capabilities": ["mailbox", "media", "game:example-game"],
  "updated": "2026-11-11T09:30:00Z", // when this copy was signed
  "proof": { "type": "Ed25519", "key": "did:key:z6Mk…", "sig": "…" },
}
```

- **The client verifies first.** `verifyDescriptor` checks the shape with the read schema, checks
  that `proof.key` equals `key` and checks the signature over the body as received. A field from a
  newer server still verifies, because the server signed that field with the rest. A client trusts
  nothing in a descriptor that fails.
- **`coverage` filters the fan-out.** A client sends a query only to servers whose coverage
  intersects the view (`coverageIntersects`). A map pan reaches the few servers that can answer.
  The client SDK treats an empty `coverage` as the whole world.
- **`accessLevel`** says who may write to the server. At `open` anyone may. At `request` and
  `private` only members may, and anyone else is refused `notMember`. A player asks to join a
  `request` server with `access.request`; a `private` server takes no requests, and its operator
  adds members. Reads are open at every level. A server enforces the level only when it lists the
  `access:members` marker (`enforcesAccess`); without it the level is for display. A level this
  build doesn't know reads as `private`, the most restrictive (`readAccessLevel`).
- **`capabilities`** holds two kinds of entry. Service capabilities are bare words an operator turns
  on: `mailbox`, `media`, `geocode`, `places` and `places-proposals`. Protocol markers are namespaced.
  A server lists `game:<slug>` once for each game the operator admits. An op beyond the baseline is listed as `op:<name>`. `access:members` says the server enforces `accessLevel`.
  A policy feature is listed as `policy:<feature>` and a rule operator as `rule:<name>`. No `game:` entry means the server is open to
  every game. `serviceCapabilities` and `admittedGames` split the list.

**The strict schema governs what a server signs.** A client reads with the tolerant read schema,
which drops keys it doesn't know. A new top-level field therefore still verifies, and an older
client ignores it. A server announces a feature that clients should act on as an entry in
`capabilities`.

The server signs the descriptor on each request, with a fresh `updated`. The descriptor route has a
rate limit of its own, separate from discovery's. A busy map can't use up the budget a client needs
to add the server.

## 4. The spatial discovery query

### 4.1 Request

The request is anonymous and carries no signature:

```text
GET /discovery?cells=9q5cs,9q5ct,9q5cw&types=bag,scout&games=example-game
```

- **Cells and no coordinates.** The client sends geohash cells (§3.1) and never its exact position.
  The server takes 1 to 256 cells and checks each against the geohash alphabet before any store
  query.
- **`types`** filters what comes back, with up to 16 entries. A room matches on its `type`, and
  `scout` asks for scouts. Without `types` the server returns every room and every scout. An empty
  `types` returns every room and no scout.
- **`games`** keeps the rooms those games own or may act on, and only their scouts. Without `games`
  the server returns every game's rooms and scouts.
- There is no paging. The server answers the whole set, which the 256-cell cap bounds.
- **A refusal is an error.** The server refuses a bad query with a 4xx and an `{ok: false, error}` body. Too many cells
  and a malformed `games` slug are two such queries. The SDK's `discoverCells` throws it as
  an `ApiError` with the `code`.

### 4.2 Response

```jsonc
{
  "coveredBy": "beacon.example", // the host that answered
  "rooms": [
    {
      "id": "01J…@beacon.example", // the live address, to resolve or act on directly
      "type": "bag",
      "location": { "lat": 47.61, "lng": -122.34 },
      "game": "example-game",
      "mintedBy": { "id": "did:key:…", "sig": "…" }, // for trust filtering
      "live": "https://beacon.example", // the live channel origin; the Beacon server sets it on every room
      "summary": { "count": 3, "capacity": 10 }, // a cheap preview for the marker
    },
  ],
  "scouts": [
    {
      "id": "01J…", // the scout's unique, the dedupe key across servers
      "owner": { "id": "did:key:…" },
      "config": {}, // the game's scout config, opaque to Beacon
      "mintedBy": { "id": "did:key:…", "sig": "…" }, // over { unique, config }
      "name": "Scout one",
      "game": "example-game",
      "movement": {
        "lastKnownLocation": { "lat": 47.6, "lng": -122.3 },
        "locationTimestamp": "2026-11-11T09:30:00Z",
        "destination": { "lat": 47.7, "lng": -122.4 },
        "speedKmh": 40,
      },
      "expiresAt": "2026-11-11T10:30:00Z", // when the report lapses
    },
  ],
}
```

A room summary's `mintedBy` is for display. The policy a room's minter signed isn't in the summary,
so a client verifies `mintedBy` after it resolves the full room. A scout's `mintedBy` covers
`{ unique, config }`, and both ride in the summary. A client can therefore verify a scout from
discovery alone.

`speedKmh` is a finite number from 0 to 16100 (`MAX_SCOUT_SPEED_KMH`). The movement schema is
strict, since a scout report is signed and relayed.

### 4.3 Merge and dedupe

A client queries every server that covers its view and merges the answers:

- **Rooms** live on exactly one server, so their result sets don't overlap. The client keeps one
  entry per `id`.
- **Scouts** can be reported to many servers. The game's client dedupes them by `id` and should
  keep the report with the latest `expiresAt`.
- The client then applies its trust filters (§10) and draws.

## 5. Moving scouts in a view

A scout report is a movement descriptor, sent once per trip. The server doesn't store a position.
For each query the server interpolates every active scout's current position along its path and
returns the scouts whose current cell intersects the queried cells. The response carries the
original descriptor, and the client interpolates the exact motion itself with
`@beaconsgg/scout-interp`. The server's filter decides only which scouts are in the set. The client
decides where to draw them.

**Scouts don't hand off between cells.** A scout that moves into a cell the client hasn't loaded
appears on the client's next discovery read. The server doesn't predict which scouts will enter a
view.

**The origin stays private.** A movement descriptor carries `lastKnownLocation` and an optional
`destination`. `lastKnownLocation` is the last point the owner reported. The descriptor never carries
where the scout set out from. No field reports progress along the trip either, so a watcher can't work back to where the
scout and its owner started. A client derives a heading for the scout's sprite from the current point
toward the destination, which reveals nothing about the past.

## 6. Live discovery

Discovery is the snapshot. The live map channel is the tail that keeps a map fresh while the view
stays put. The pattern matches opening a room, which is a read and then a subscription.

|         | Snapshot                     | Live tail                               |
| ------- | ---------------------------- | --------------------------------------- |
| Source  | `GET /discovery` (§4)        | the map channel on the live socket      |
| When    | each pan or zoom             | while the view is still                 |
| Carries | every room and scout in view | upsert and remove deltas                |
| State   | the client's marker set      | none on the server, which only fans out |

The server keeps no per-cell roster. A client that missed deltas reads discovery again, which sets a
new baseline. No other resync protocol exists.

The live channel uses a fixed cell precision of 5 (`LIVE_CELL_PRECISION`), a cell of about 4.9 km by
4.9 km. A fixed grid means a small pan keeps the same cells. `liveCellsForView` estimates the cell
count before it lists cells. Above 64 cells (`MAX_LIVE_CELLS`) the result is `capped` and empty.

The cell decides who hears a delta. The cell doesn't decide what is drawn. A geohash-5 cell is far
larger than a street-level view, so the client filters each upsert by its own viewport.

### 6.1 Declare watched cells with `setCells`

The client sends its full watched set on every pan or zoom:

```jsonc
// the client emits setCells:
{ "cells": ["c23nb", "c23nc", "c23n8"] } // up to 256 geohash cells
// the server acknowledges:
{ "ok": true, "cells": 3 }
```

Each `setCells` replaces the previous set, so no unsubscribe message exists. A socket that named a
game in its handshake hears that game's rooms and scouts, plus what is open to every game. A socket
that named no game hears everything in its cells.

### 6.2 Map deltas

The server emits `map` events, keyed by cell:

```jsonc
// a room appeared or changed (placement, a new count, a phase change)
{ "cell": "c23nb", "kind": "room", "room": { "id": "01J…@beacon.example" } }
// a room is gone (closed or removed)
{ "cell": "c23nb", "kind": "roomGone", "id": "01J…@beacon.example" }
// a scout was deployed or refreshed, keyed by its interpolated cell at report time
{ "cell": "c23nb", "kind": "scout", "scout": { "id": "01J…" } }
// a scout was canceled or its report lapsed
{ "cell": "c23nb", "kind": "scoutGone", "id": "01J…" }
```

A `room` delta carries a full room summary, the shape discovery returns (§4.2). A placement, a count
change and a phase change are therefore all one action for the client: replace the marker. A `scout`
delta carries a full scout summary. Map deltas are separate from a room's own live events, which
carry item-level changes and are ordered by the room's version.

### 6.3 Client lifecycle

On every view change the client:

1. computes `liveCellsForView` for the view;
2. sends `setCells` with that set to every map socket, unless the result is `capped`;
3. falls back to reading discovery every 15 seconds (`DISCOVERY_POLL_MS`) while the view is capped;
4. reads discovery as the baseline either way.

The client opens one map socket per server it knows and sends its cells again on every reconnect.
The server sends no snapshot on a subscribe. A client therefore reads discovery again after a
reconnect, since deltas sent during the gap are lost.

`applyMapDelta` adds an upsert only when it falls inside the viewport padded by 25% for rooms and 50%
for scouts, which move into view. A removal always applies. Only a room's host emits deltas for that
room. The client still dedupes by `id`, so overlapping coverage does no harm.

## 7. Server discovery

A client must know which servers cover an area before it can query them. In Beacon 0.3 the player
or an operator enters servers by address. That list is the client's set of approved servers.
Beacon has no registry, seed list or aggregator.

- **Add a server.** `normalizeServerUrl` turns a typed address into an origin. An explicit scheme is
  kept. A loopback, private-network or `.local` host gets `http` and every other host gets `https`.
  The client fetches the descriptor and keeps the server as verified only when the signature checks
  out (§3.2).
- **One routing rule.** Every routing function in the SDK takes the registry's state and applies the
  same rule. Nothing goes to a server the registry refused for a changed key. A function that
  chooses among the servers also chooses only a server whose descriptor verified. Routing a
  `unique@host` id chooses nothing, since the id names its server. A caller with no player list
  makes a state of its own list with `registryOf`, as a console does.
- **Reads fan out.** `serversForCells` returns every verified server whose coverage intersects the
  view, in the player's priority order. The client merges their snapshots (§4.3).
- **A placement goes to one server.** A room's GlobalId names its host for good, so exactly one
  server must hold it. `selectCoveringServer` picks the verified server whose coverage pins the
  point down most specifically, which is the longest coverage prefix that contains the point. A tie
  goes to the server earlier in the player's list.
- **A scout report fans out.** A report has no host in its id and is a short-lived cache entry.
  `scoutReportServers` returns every verified server covering the points it is given that the
  player reports scouts to. The caller passes where the scout set out from and where it is heading,
  and sends the report to each server. Both ends of the trip can then see the scout.
- **An existing object goes to its host.** `resolveServerForId` routes a `unique@host` id to the
  server whose host matches, verified or not. A host the list does not hold is reached over
  `https`. A local or private host keeps `http`: `localhost`, a `.local` name or a private address.
  A bare `unique` like a scout's goes to the first verified server in the list. A server refused for
  a changed key gets nothing, so the answer is `null` for an id it holds. A read-only screen passes
  `{ allowKeyRefused: true }` to show what that server holds.

## 9. Privacy

Reads carry no signature, so a query exposes two things: the client's network address and the area
it asks about. Beacon keeps both small:

- **Coarse cells.** A query names geohash cells and never a position. A coarser cell widens the
  result set and reveals less.
- **Only approved servers.** A client asks only the servers on its own list and never broadcasts a
  location to a server it doesn't know.
- **Block-listed servers are skipped** altogether (§10).
- **The player picks where scouts are reported.** The client SDK's registry keeps the set of
  servers a player's scouts are reported to. By default the set is every server on the list.

The live map channel exposes the watched area at geohash-5 precision, the same exposure as a
discovery query. A map socket carries no identity.

Discovery reveals roughly where a player is looking. Beacon reduces that exposure and doesn't claim
to remove it.

## 10. Trust filtering

Discovery results carry the provenance a client needs to curate what it shows
([identity §9](identity.md#9-trust-filtering)):

- **Per server.** A client doesn't query block-listed servers. A client may query only allow-listed
  ones.
- **Per object.** Each summary carries `mintedBy`, and its id names its host. A client hides
  block-listed sources when it draws. `mintedBy` is a key, so provenance can't be forged to dodge a
  block ([identity §4.3](identity.md#43-how-owner-and-mintedby-reference-identities)).
