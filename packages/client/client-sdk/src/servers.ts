/**
 * The approved-server entry and the routing over the registry's state (`doc/spec/discovery.md` §7):
 * which servers a read fans out to, which one a write goes to, and which advertise a capability.
 * Every helper here takes the state and applies one rule itself. Nothing goes to a server the
 * registry refused for a changed key, and a helper that chooses among the servers chooses only a
 * verified one. Routing a `unique@host` id chooses nothing, because the id names its server. Pure:
 * the descriptor fetch that produces an entry is the client's `addServer`.
 *
 * The list is user-entered: the servers a player (or an operator) added *are* the known/approved
 * set, each trusted only once its signed `ServerDescriptor` verifies. There is no registry or
 * aggregator.
 */
import { coverageIntersects, coverageSpecificity, encode } from "@beaconsgg/geo";
import {
  knownServerForHost,
  parseGlobalId,
  type LatLng,
  type ReceivedDescriptor,
  originForHost,
} from "@beaconsgg/protocol-types";
import {
  approvedServers,
  entryKeyRefused,
  emptyRegistry,
  relaysScoutsTo,
  usableServer,
  type ServerRegistryState,
} from "./registry";
import { trimUrl } from "./transport";

/**
 * One server in the player's list: its origin, its signed descriptor and whether the descriptor
 * verified. `client.addServer` returns one.
 *
 * The routing helpers in this package take the registry's state and skip an entry whose key the
 * registry refused. A helper that chooses among the servers also skips an entry whose `verified` is
 * `false`.
 */
export interface ServerEntry {
  /**
   * The base URL of the server's REST routes and live channel, such as `https://beacon.example`.
   * `client.addServer` makes it from the address the player typed with {@link normalizeServerUrl},
   * and switches to the server's own host when the server answers there with the same key.
   */
  origin: string;
  /**
   * The server's descriptor as received, or `null` when the server was unreachable or the signature
   * did not verify. The `accessLevel` may be a level this build does not know, so read it through
   * `readAccessLevel` from `@beaconsgg/protocol-types`.
   */
  descriptor: ReceivedDescriptor | null;
  /** `true` only when the descriptor was fetched and its self-signature verified. */
  verified: boolean;
  /**
   * Set by the registry when the server's last check found a different key than the one saved, so
   * nothing goes to the server. Every routing helper skips such an entry. The registry clears the
   * mark when an entry for the server is written again. Leave the field out of an entry you build.
   */
  keyRefused?: true;
}

/** True when the entry's verified descriptor lists `capability`. Reads the descriptor only. */
function advertises(entry: ServerEntry, capability: string): boolean {
  return entry.descriptor?.capabilities?.includes(capability) ?? false;
}

/**
 * Turn a server address a player typed into the origin the client calls, such as
 * `https://beacon.example` for `beacon.example`.
 *
 * A scheme the player typed is kept. A host without one gets `http` when it is `localhost`, a
 * `.local` name or a private network address (`127.*`, `10.*`, `192.168.*`, `172.16.*` to
 * `172.31.*`), and `https` otherwise. Trailing slashes are removed.
 *
 * @returns The origin, or `null` when `input` is empty or only whitespace.
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  return trimmed.length > 0 ? originForHost(trimmed) : null;
}

/**
 * A verified server whose advertised coverage overlaps `cells`. The one covering predicate, shared
 * by the read fan-out (`serversForCells`) and the single-server write pick (`selectCoveringServer`)
 * so the two can't drift.
 *
 * **Dev assumption:** a server that declares **no coverage** (empty `coverage`) is treated as
 * covering the **whole world**, so it always matches. Real coverage still filters normally. This
 * keeps dev servers that haven't set up coverage usable; we may tighten it later.
 */
function coversCell(
  entry: ServerEntry,
  cells: readonly string[],
): entry is ServerEntry & { descriptor: ReceivedDescriptor } {
  return (
    entry.descriptor != null &&
    (entry.descriptor.coverage.length === 0 || coverageIntersects(entry.descriptor.coverage, cells))
  );
}

/**
 * List the origins of every verified server whose coverage overlaps `cells`, in the order of the
 * player's list.
 *
 * Use this to choose the servers a read such as `client.discoverCells` goes to, and merge their
 * answers. A server whose descriptor declares no coverage counts as covering the whole world. A
 * server the registry refused for a changed key is skipped, as in every routing helper.
 *
 * @param state - The registry's state, or {@link registryOf} for a list you verified yourself.
 * @param cells - Geohash cells, such as the cells `cellsForView` from `@beaconsgg/geo` gives for a
 * map view.
 */
export function serversForCells(state: ServerRegistryState, cells: readonly string[]): string[] {
  return approvedServers(state)
    .filter((e) => coversCell(e, cells))
    .map((e) => e.origin);
}

/**
 * List the origins of every verified server that covers at least one of `coordinates`, in the order
 * of the player's list.
 *
 * Each server is listed once. A server whose descriptor declares no coverage counts as covering the
 * whole world. To pick the servers for a scout report, use {@link scoutReportServers}, which also
 * applies the player's scout reporting choice.
 *
 * This is the point-shaped form of {@link serversForCells}, and both use the same coverage test.
 *
 * A scout report fans out rather than picking one server, unlike a room placement ({@link
 * selectCoveringServer}). The difference is what the write *is*: a placement creates a room that a
 * single server then custodies, and its `unique@host` id names that server forever, so exactly one
 * has to be chosen. A scout report is a perishable cache entry with no host in its id, which a
 * client's live map merges "deduped by id, keep the freshest by expiry" precisely because a scout
 * may be advertised on many. Reporting to only the most specific server made a scout invisible to
 * anyone whose own server list didn't happen to include that one.
 *
 * Passing both ends of the trip is what makes the scout discoverable at both ends. The caller
 * passes where the scout set out from and where it is heading (`relayPoints`), because a report is
 * not a position update: the descriptor is sent once per trip and the server interpolates the
 * scout's live position from it, so a server that receives it can answer for the scout anywhere
 * along the route. Matching on the departure point alone meant the destination's server never held
 * the descriptor, and players there could not see the scout coming or see it land.
 */
export function serversCovering(
  state: ServerRegistryState,
  coordinates: readonly LatLng[],
): string[] {
  // Not `.map(encode)`: `encode`'s second parameter is the precision, and `Array.map` would hand it the
  // index, so the first point would be encoded at precision 0 and the second at 1. The arrow is the fix,
  // not clutter to tidy away.
  return serversForCells(
    state,
    coordinates.map((c) => encode(c)),
  );
}

/**
 * List the origins a scout report goes to: every server that covers either end of the trip and
 * that the player reports scouts to, in the order of the player's list.
 *
 * Pass the point the scout leaves from and the point the scout is heading to, such as from
 * `relayPoints`. This is {@link serversCovering} narrowed by the player's choice in
 * `state.scoutRelay`, so a server the player turned reporting off for never receives the report.
 */
export function scoutReportServers(
  state: ServerRegistryState,
  coordinates: readonly LatLng[],
): string[] {
  return serversCovering(state, coordinates).filter((origin) => relaysScoutsTo(state, origin));
}

/**
 * Pick the one server a room placed at `coordinate` goes to.
 *
 * Among the verified servers that cover the point, the server whose coverage is most specific wins:
 * the server with the longest coverage prefix that contains the point. A tie goes to the server
 * earlier in the player's list. A server that declares no coverage covers the whole world at the
 * lowest specificity. A server the registry refused for a changed key is skipped.
 *
 * @param state - The registry's state, or {@link registryOf} for a list you verified yourself.
 * @returns The winning server's origin, or `null` when no verified server covers the point.
 */
export function selectCoveringServer(
  state: ServerRegistryState,
  coordinate: LatLng,
): string | null {
  const cell = encode(coordinate);
  const cells = [cell];
  let best: string | null = null;
  let bestSpecificity = -1;
  for (const entry of approvedServers(state)) {
    if (!coversCell(entry, cells)) continue;
    // Strict `>` keeps the earliest (highest-priority) server on a specificity tie.
    const specificity = coverageSpecificity(entry.descriptor.coverage, cell);
    if (specificity > bestSpecificity) {
      best = entry.origin;
      bestSpecificity = specificity;
    }
  }
  return best;
}

/**
 * Return `true` when the entry is verified and its descriptor lists `capability`, such as
 * `"mailbox"` or `"media"`.
 *
 * An unverified entry, an entry the reducer marked `keyRefused` and a descriptor with no
 * `capabilities` list have none of the optional capabilities. Use this to describe one server, such
 * as on a settings row. To pick servers, use {@link serversWithCapability}. The mailbox's live
 * channel has no capability of its own: a server with `"mailbox"` serves the live channel too
 * (beacon.server `doc/spec/mailbox-and-media.md` §3.1).
 */
export function serverHasCapability(entry: ServerEntry, capability: string): boolean {
  // An entry alone: its own `keyRefused` mark is the refusal there is to read.
  return usableServer(emptyRegistry, entry) && advertises(entry, capability);
}

/**
 * List the origins of every verified server that advertises `capability`, in the order of the
 * player's list. A server the registry refused for a changed key is skipped.
 */
export function serversWithCapability(state: ServerRegistryState, capability: string): string[] {
  return approvedServers(state)
    .filter((e) => advertises(e, capability))
    .map((e) => e.origin);
}

/**
 * List the origins of every verified server that covers `cells` and advertises `capability`, in the
 * order of the player's list.
 *
 * Use this to choose a server for the optional location reads, `"geocode"` and `"places"`, which
 * only some servers offer. The list is empty when no server qualifies.
 */
export function serversForCellsWithCapability(
  state: ServerRegistryState,
  cells: readonly string[],
  capability: string,
): string[] {
  return approvedServers(state)
    .filter((e) => coversCell(e, cells) && advertises(e, capability))
    .map((e) => e.origin);
}

/**
 * Return the player's mailbox host: the server their profile names for incoming mail, and the
 * server the live inbox subscribes to.
 *
 * There is no default. The player picks a host, which the registry keeps as `mailboxOrigin` (the
 * `setMailbox` action).
 *
 * Use this one rule both when you publish the profile and when you send or subscribe, so the two
 * never disagree (`doc/spec/mailbox-client.md` §6).
 *
 * @returns `state.mailboxOrigin` while that server is verified, not refused for a changed key and
 * advertising `"mailbox"`, and `undefined` otherwise. Treat `undefined` as messaging turned off
 * until the player picks a host.
 */
export function selectMailboxHost(state: ServerRegistryState): string | undefined {
  return selectDesignatedHost(state, "mailbox", state.mailboxOrigin);
}

/**
 * Honor a designated host only while it's still a usable server advertising `capability`, else
 * `undefined`: the shared "no default; a stale/removed pick turns the capability off" rule behind
 * both {@link selectMailboxHost} and {@link selectMediaHost}.
 */
function selectDesignatedHost(
  state: ServerRegistryState,
  capability: string,
  chosen: string | undefined,
): string | undefined {
  const ok = state.servers.some(
    (e) => e.origin === chosen && usableServer(state, e) && advertises(e, capability),
  );
  return ok ? chosen : undefined;
}

/**
 * Return the player's media host: the server their image uploads go to.
 *
 * The rule is the one {@link selectMailboxHost} uses, over `state.mediaOrigin` (the `setMedia`
 * action). There is no default, and the result is the chosen server while it is verified, not
 * refused for a changed key and advertising `"media"`. Otherwise the result is `undefined`, and
 * uploads are off until the player picks a host.
 *
 * The media host stays on the device and is not published in the profile. Each uploaded file's
 * address already names its server (`<hash>@host`), so other players fetch it without knowing the
 * media host.
 */
export function selectMediaHost(state: ServerRegistryState): string | undefined {
  return selectDesignatedHost(state, "media", state.mediaOrigin);
}

/**
 * Turn a server origin into the `host[:port]` form a profile publishes as its mailbox `endpoint`:
 * `https://beacon.example/` becomes `beacon.example`.
 *
 * The scheme and trailing slashes are removed. {@link mailboxOrigin} turns the endpoint back into
 * an origin, and gives back the same `https` origin for any host that is not local
 * (`doc/spec/mailbox-client.md` §6).
 */
export function mailboxEndpoint(origin: string): string {
  return origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
}

/**
 * Return a server's address to show a player without the scheme: the descriptor's `host` when
 * there is one, else `origin` formatted by {@link mailboxEndpoint}.
 *
 * Use this wherever your UI shows a server's address, so every screen shows the same one.
 *
 * @param host - The server descriptor's `host`, or `undefined` when there is no descriptor.
 */
export function serverHost(host: string | undefined, origin: string): string {
  return host ?? mailboxEndpoint(origin);
}

/**
 * Return the name to show a player for a server: the `name` its operator set in the descriptor, or
 * `origin` when the name is missing or blank.
 *
 * Use this where a server appears as a choice or as the source of something. Use {@link serverHost}
 * where you show an address.
 */
export function serverLabel(entry: ServerEntry | undefined, origin: string): string {
  return entry?.descriptor?.name?.trim() || origin;
}

/** Find the entry whose `origin` is exactly `origin`, or `undefined` when the list has none. */
export function serverEntryFor(
  entries: readonly ServerEntry[],
  origin: string,
): ServerEntry | undefined {
  return entries.find((e) => e.origin === origin);
}

/**
 * Turn a mailbox `endpoint` from a profile (`host[:port]`) into an origin the client can call.
 *
 * A host gets `https`, except `localhost`, a `.local` name or a private network address, which get
 * `http` so that two devices on one network can test against a local server. An endpoint that
 * already has a scheme keeps it (`doc/spec/mailbox-client.md` §6).
 */
export function mailboxOrigin(endpoint: string): string {
  return originForHost(endpoint); // the one shared scheme-on-read rule (protocol-types)
}

/** The host part of a `unique@host` id (protocol-types `GLOBAL_ID_RE`): what a server may call itself. */
export const ID_HOST_RE = /^[A-Za-z0-9.:-]+$/;

/** The options of {@link resolveServerForId} and {@link mediaUrl}. */
export interface RouteOptions {
  /**
   * `true` to route to a server the registry refused for a changed key too. Pass it only for a
   * read, such as showing a room or an image the player already has, or on a screen that asks the
   * player to approve the new key. Defaults to `false`.
   */
  allowKeyRefused?: boolean;
}

/**
 * The origin for `host`: a listed server's, unless the registry refused it, else the one scheme
 * rule's. `null` when the server at `host` is refused, since the fallback would reach the same host.
 * The lookup is over every entry, refused ones included, for exactly that reason.
 *
 * No `verified` check: the id already names the host, and a host not on the list is reached too, so
 * skipping an entry that never verified would only reach the same host by the fallback's scheme
 * rather than the origin the player saved, or refuse a listed host that an unlisted one would not.
 * Nothing read back is trusted on the descriptor's account: a room carries its own `mintedBy`, and
 * a media file its hash.
 */
function originFor(host: string, state: ServerRegistryState, options: RouteOptions): string | null {
  // A host outside the id host class (`h@http://…`, `h@file:///…`) names no server to call.
  if (!ID_HOST_RE.test(host)) return null;
  const matches = state.servers.filter((e) => knownServerForHost(host, [e.origin]) !== undefined);
  if (matches.length === 0) return originForHost(host);
  // The scheme is not part of an id's host, so two entries can match. Any refused one refuses the
  // host, and a verified one is preferred over one that never verified.
  if (options.allowKeyRefused !== true && matches.some((e) => entryKeyRefused(state, e)))
    return null;
  return (matches.find((e) => e.verified) ?? matches[0]!).origin;
}

/**
 * Return the origin of the server that holds a room, from the room's id.
 *
 * For a `unique@host` id the result is the origin of the listed server whose `host[:port]` equals
 * `host`, whether or not that server verified, since the id already names it. A room on a server the
 * player has not added is still reachable: when no server matches, the result is `https://<host>`,
 * or `http://<host>` for `localhost`, a `.local` name or a private address. An id without `@host`,
 * such as a scout's, names no server, so the result is the first verified server in the list.
 *
 * Nothing goes to a server the registry refused for a changed key (`keyRefused`), so the result is
 * `null` when the room's server is refused. The result is also `null` when an id without `@host`
 * finds no server, and when the host is not a host name, such as one that carries a scheme.
 *
 * @param state - The registry's state, or {@link registryOf} for a list you verified yourself.
 * @param options - `allowKeyRefused: true` routes to a refused server too, for a read.
 */
export function resolveServerForId(
  id: string,
  state: ServerRegistryState,
  options: RouteOptions = {},
): string | null {
  const at = id.lastIndexOf("@");
  if (at > 0) return originFor(id.slice(at + 1), state, options);
  const first = state.servers.find((e) => usableServer(state, e, options.allowKeyRefused));
  return first?.origin ?? null;
}

/**
 * Build the URL that downloads a media file, from its address `<hash>@host`.
 *
 * Pass one entry of a resource's `media[].uris`. The URL is `GET /media/<hash>` on the listed
 * server that matches `host`, verified or not, or on `https://<host>` (`http` for a local or private
 * host) when none matches. The route needs no signature, and the file at a hash never changes, so
 * the response can be cached for good.
 *
 * @param state - The registry's state, or {@link registryOf} for a list you verified yourself.
 * @param options - `allowKeyRefused: true` builds the URL for a refused server too, for a read.
 * @returns The URL, or `null` when the file's server is one the registry refused for a changed
 * key, when the address's host is not a host name, or when `contentAddress` is not a `unique@host`
 * address. The wire allows any string there, so a server's bad address never throws.
 */
export function mediaUrl(
  contentAddress: string,
  state: ServerRegistryState,
  options: RouteOptions = {},
): string | null {
  // Both the parse and the encode throw on a malformed address (`encodeURIComponent` on a lone
  // surrogate), and the wire allows any string.
  try {
    const { unique: hash, host } = parseGlobalId(contentAddress);
    const origin = originFor(host, state, options);
    return origin === null ? null : `${trimUrl(origin)}/media/${encodeURIComponent(hash)}`;
  } catch {
    return null;
  }
}
