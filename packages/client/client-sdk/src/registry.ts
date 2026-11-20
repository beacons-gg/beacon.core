/**
 * Server registry reducer (`doc/spec/discovery.md` §7): the pure state machine behind the approved
 * server list. The servers are user-entered: the list the player builds *is* the known/approved
 * set. There is **no "home server"**: the client fans out reads to the servers that cover the view
 * and routes each write to the room's host (`unique@host`) or, for a new placement, the verified
 * server with the **most specific** coverage of the point (ties break by list order = priority).
 * When **no** server covers the point the placement is blocked (the caller alerts the user): there
 * is no fallback server. This module owns only the *shape + transitions* of that list (add, remove,
 * reorder, set-mailbox, set-media, set-scout-relay, reset-scout-relay, rehydrate); the descriptor
 * fetch/verify is the client's `addServer`.
 *
 * Three per-server preferences ride the list rather than living in stores of their own, because
 * each is an answer *about* the list and has to move when the list does: the designated mailbox
 * host, the designated media host, and {@link ServerRegistryState.scoutRelay} (which servers a
 * deployed scout is reported to). Removing a server settles all three in one place, and all three
 * persist, reset, and clear with the servers they name.
 *
 * Kept pure (no React, no storage, no network) so the transitions are unit-testable.
 */
import type { ServerEntry } from "./servers";

/**
 * The player's server list and the choices tied to it, as {@link serverRegistryReducer} keeps it.
 *
 * Save the whole object to storage and restore it with a `rehydrate` action. Start from {@link
 * emptyRegistry}, or from {@link registryOf} for a fixed list. Pass the state to the routing
 * helpers, such as `selectCoveringServer`, `resolveServerForId` and `selectMailboxHost`. Each one
 * skips a server refused for a changed key, and a helper that chooses among the servers also skips
 * one that never verified.
 */
export interface ServerRegistryState {
  /**
   * Every server the player has added, verified or not, with one entry per `origin`. The order is
   * the player's priority order: when two servers cover a point equally well, the earlier one wins.
   */
  servers: ServerEntry[];
  /**
   * The origin the player chose as their mailbox host: the server their profile names for incoming
   * mail, and the server the live inbox subscribes to (`doc/spec/mailbox-client.md` §6).
   *
   * There is no default. While the field is absent, messaging is off. Removing the server clears
   * the field.
   */
  mailboxOrigin?: string;
  /**
   * The origin the player chose as their media host: the server their image uploads go to
   * (beacon.server `doc/spec/mailbox-and-media.md` §5).
   *
   * The choice stays on the device and is not published in the profile. There is no default. While
   * the field is absent, uploads are off. Removing the server clears the field.
   */
  mediaOrigin?: string;
  /**
   * The servers the player's scouts are reported to. Other players find a scout only through a
   * server that received its report.
   *
   * The field has three states. Read them with {@link reportsScoutsEverywhere},
   * {@link reportsScoutsNowhere} and {@link relaysScoutsTo} rather than here.
   *
   * - Absent: every server, including servers added later. This is the default, and
   *   `resetScoutRelay` returns to it.
   * - `[]`: no server. Scouts still travel and still show on the owner's own map, but no one else
   *   can find them. `setScoutRelay` with `null` stores this.
   * - A list: exactly those origins, and no server added later.
   *
   * A listed server also needs coverage: the server receives a report only when its coverage
   * contains one end of the scout's trip (`serversCovering`).
   *
   * Removing a server takes it out of the list and keeps the key, so a list of one server becomes
   * `[]` and never turns back into "every server". A deny list could not work here: a server added
   * tomorrow would start receiving reports, which a player who turned reporting off did not agree
   * to.
   */
  scoutRelay?: string[];
  /**
   * Saved servers whose last check found them signing with a different key than the one saved: a
   * key rotation, or someone else answering at the address.
   *
   * Nothing goes to a listed server: no reads, placements, scout reports, mail or media. Every
   * routing helper reads this list, and the reducer also marks the server's entry `keyRefused`.
   * The player's choices for the server are kept, so accepting the new key restores everything. An origin leaves the list when an entry for it is
   * written: the player adds the address again, or a refresh finds the saved key again. Absent and
   * `[]` mean the same.
   */
  identityChanged?: string[];
}

/**
 * A change to the server list, for {@link serverRegistryReducer}.
 *
 * - `rehydrate`: replace the whole state, such as with the state loaded from storage. The entries'
 *   `keyRefused` marks are set again from `identityChanged`.
 * - `add`: add `entry`, or replace the entry with the same origin. An unverified entry never
 *   replaces a verified one. An entry with the same descriptor `key` as a saved server under
 *   another origin replaces that server and keeps its choices.
 * - `remove`: remove the server and clear any choice that named it.
 * - `move`: move the server one place up (higher priority) or down.
 * - `moveToTop`: move the server to the top of the list.
 * - `setMailbox`, `setMedia`: choose the mailbox or media host, or clear the choice with `null`.
 * - `setScoutRelay`: report scouts to exactly `origins`, or to no server with `null`.
 * - `resetScoutRelay`: report scouts to every server again, including servers added later.
 * - `identityChanged`: mark a saved server as signing with a different key, so nothing goes to it.
 *   The server's entry gets `keyRefused`.
 */
export type ServerRegistryAction =
  | { type: "rehydrate"; state: ServerRegistryState }
  | { type: "add"; entry: ServerEntry }
  | { type: "remove"; origin: string }
  | { type: "move"; origin: string; direction: "up" | "down" }
  | { type: "moveToTop"; origin: string }
  | { type: "setMailbox"; origin: string | null }
  | { type: "setMedia"; origin: string | null }
  | { type: "setScoutRelay"; origins: readonly string[] | null }
  | { type: "resetScoutRelay" }
  | { type: "identityChanged"; origin: string };

/** The state of a player with no servers: the start state on first run and after a reset. */
export const emptyRegistry: ServerRegistryState = { servers: [] };

/**
 * Make the registry state of a fixed list of servers, for a caller that keeps no player list, such
 * as an operator console that talks to one server or a test driver.
 *
 * Never build one from `approvedServers(state)`: that list leaves out a server refused for a
 * changed key, so an id on that server would fall back to its host and reach it anyway. The state
 * has no mailbox host, media host or scout relay choice. Build it once rather than on each render.
 */
export function registryOf(entries: readonly ServerEntry[]): ServerRegistryState {
  return { servers: [...entries] };
}

/**
 * Upsert an entry by `origin` (re-adding a server replaces its record, e.g. after re-verification).
 *
 * An unverified entry never replaces a verified one. A failed re-add (the server was unreachable,
 * or whoever answered failed the signature check) is not a reason to forget what was verified, and
 * replacing it would also clear the saved key's pin, so the next refresh would accept any key.
 */
function addEntry(state: ServerRegistryState, entry: ServerEntry): ServerRegistryState {
  const i = state.servers.findIndex((s) => s.origin === entry.origin);
  if (i === -1) {
    // The same server under another name (saved by an alias before `addServer` learned to save a
    // server under its own name, or re-added by its own name): one entry, in the old one's place,
    // with whatever the old origin was designated for carried over.
    const key = entry.descriptor?.key;
    const j = key === undefined ? -1 : state.servers.findIndex((s) => s.descriptor?.key === key);
    if (j === -1) return { ...state, servers: [...state.servers, entry] };
    const old = state.servers[j]!.origin;
    const renamed = (origin: string) => (origin === old ? entry.origin : origin);
    return {
      ...state,
      servers: state.servers.map((s, at) => (at === j ? entry : s)),
      ...(state.mailboxOrigin !== undefined ? { mailboxOrigin: renamed(state.mailboxOrigin) } : {}),
      ...(state.mediaOrigin !== undefined ? { mediaOrigin: renamed(state.mediaOrigin) } : {}),
      ...(state.scoutRelay ? { scoutRelay: state.scoutRelay.map(renamed) } : {}),
    };
  }
  if (!entry.verified && state.servers[i]!.verified) return state;
  return { ...state, servers: state.servers.map((s) => (s.origin === entry.origin ? entry : s)) };
}

/** Move a server one slot toward the front (`"up"` = higher priority) or back, within the full list. */
function moveEntry(
  state: ServerRegistryState,
  origin: string,
  direction: "up" | "down",
): ServerRegistryState {
  const i = state.servers.findIndex((s) => s.origin === origin);
  if (i === -1) return state;
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= state.servers.length) return state; // already at the edge
  const servers = [...state.servers];
  [servers[i], servers[j]] = [servers[j]!, servers[i]!];
  return { ...state, servers };
}

/** Move a server to the front (highest priority) in one step — the long-list-friendly reorder. */
function moveEntryToTop(state: ServerRegistryState, origin: string): ServerRegistryState {
  const i = state.servers.findIndex((s) => s.origin === origin);
  if (i <= 0) return state; // not found, or already first
  const moved = state.servers[i]!;
  const servers = [moved, ...state.servers.slice(0, i), ...state.servers.slice(i + 1)];
  return { ...state, servers };
}

/** Drop a designated host key, returning state with the key genuinely absent (matches `emptyRegistry`). */
function clearDesignation(
  state: ServerRegistryState,
  key: "mailboxOrigin" | "mediaOrigin",
): ServerRegistryState {
  const { [key]: _omit, ...rest } = state;
  return rest;
}

/**
 * Set `keyRefused` on exactly the entries {@link ServerRegistryState.identityChanged} lists, and
 * clear it from the rest. The entries that already agree are kept as they are.
 */
function withKeyRefusedMarks(state: ServerRegistryState): ServerRegistryState {
  let changed = false;
  const servers = state.servers.map((entry) => {
    const refused = serverKeyRefused(state, entry.origin);
    if (refused === (entry.keyRefused === true)) return entry;
    changed = true;
    if (refused) return { ...entry, keyRefused: true as const };
    const { keyRefused: _omit, ...rest } = entry;
    return rest;
  });
  return changed ? { ...state, servers } : state;
}

/** Drop `origin` from {@link ServerRegistryState.identityChanged}, removing the key once it's empty. */
function clearIdentityChanged(state: ServerRegistryState, origin: string): ServerRegistryState {
  if (!state.identityChanged?.includes(origin)) return state;
  const rest = state.identityChanged.filter((o) => o !== origin);
  if (rest.length > 0) return { ...state, identityChanged: rest };
  const { identityChanged: _omit, ...without } = state;
  return without;
}

/**
 * Apply one {@link ServerRegistryAction} to the server list and return the new state.
 *
 * The reducer is pure, with no storage or network, so it fits React's `useReducer`. The input state
 * is never changed. Fetching and
 * verifying a server is `client.addServer`, whose result you pass in an `add` action.
 */
export function serverRegistryReducer(
  state: ServerRegistryState,
  action: ServerRegistryAction,
): ServerRegistryState {
  // The marks follow from `identityChanged` after every action, so no branch can leave one stale. A
  // state saved before the marks existed (read through `rehydrate`) routes the same as one after.
  return withKeyRefusedMarks(reduce(state, action));
}

/** {@link serverRegistryReducer} before the `keyRefused` marks are brought in line. */
function reduce(state: ServerRegistryState, action: ServerRegistryAction): ServerRegistryState {
  switch (action.type) {
    case "rehydrate":
      return action.state;
    case "add": {
      // Only an entry that was actually written clears the flag: an unverified re-add that
      // `addEntry` refuses leaves the refusal standing too.
      const next = addEntry(state, action.entry);
      return next === state ? state : clearIdentityChanged(next, action.entry.origin);
    }
    case "remove": {
      const servers = state.servers.filter((s) => s.origin !== action.origin);
      // Removing a server that was a designated mailbox/media host clears that designation.
      let base = state;
      if (base.mailboxOrigin === action.origin) base = clearDesignation(base, "mailboxOrigin");
      if (base.mediaOrigin === action.origin) base = clearDesignation(base, "mediaOrigin");
      // An explicit scout-relay list is **pruned, never cleared**: the key is what carries "the player
      // chose these", so dropping it would read as "every server" and a player who had narrowed to one
      // server would start reporting to all the others the moment that one was removed. Pruning lets the
      // choice degrade toward nowhere, the safe direction for a control whose job is withholding.
      if (base.scoutRelay)
        base = { ...base, scoutRelay: base.scoutRelay.filter((o) => o !== action.origin) };
      base = clearIdentityChanged(base, action.origin);
      return { ...base, servers };
    }
    case "move":
      return moveEntry(state, action.origin, action.direction);
    case "moveToTop":
      return moveEntryToTop(state, action.origin);
    case "setMailbox":
      return action.origin === null
        ? clearDesignation(state, "mailboxOrigin")
        : { ...state, mailboxOrigin: action.origin };
    case "setMedia":
      return action.origin === null
        ? clearDesignation(state, "mediaOrigin")
        : { ...state, mediaOrigin: action.origin };
    case "setScoutRelay":
      // `null` is off, as for the hosts above: the empty list, which reports nowhere. An array is
      // stored verbatim, `[]` included: an empty list is a real answer, not a missing one.
      return { ...state, scoutRelay: action.origins === null ? [] : [...action.origins] };
    case "resetScoutRelay": {
      // The default is the key genuinely absent (every server, now and later), never a list.
      const { scoutRelay: _omit, ...rest } = state;
      return rest;
    }
    case "identityChanged": {
      // Only a saved server has a pin to disagree with, and one already listed stays listed once.
      const known = state.servers.some((s) => s.origin === action.origin);
      if (!known || state.identityChanged?.includes(action.origin)) return state;
      // The list is still written beside the mark, so an older build that reads this state refuses
      // the server too.
      return { ...state, identityChanged: [...(state.identityChanged ?? []), action.origin] };
    }
    default:
      return state;
  }
}

/**
 * Return `true` when the registry refused `entry` for a changed key: the entry's own `keyRefused`
 * mark, or the state's `identityChanged` list for a state built without the reducer. Internal: the
 * routing helpers in `servers.ts` share it.
 */
export function entryKeyRefused(state: ServerRegistryState, entry: ServerEntry): boolean {
  return entry.keyRefused === true || serverKeyRefused(state, entry.origin);
}

/**
 * Return `true` when the client may choose `entry`: the descriptor verified and the registry has not
 * refused the server for a changed key, unless `allowKeyRefused`. The check behind
 * {@link approvedServers}, {@link receivesScoutReports} and every routing helper that chooses among
 * the servers. Routing a `unique@host` id chooses nothing, since the id names its server, so there
 * only {@link entryKeyRefused} applies. Internal.
 */
export function usableServer(
  state: ServerRegistryState,
  entry: ServerEntry,
  allowKeyRefused = false,
): boolean {
  return entry.verified && (allowKeyRefused || !entryKeyRefused(state, entry));
}

/**
 * List the servers the client may choose in the order of the player's list: the verified servers
 * not refused for a changed key.
 *
 * Use the list to show or count the player's servers. The routing helpers such as `serversForCells`
 * and `resolveServerForId` take the state itself and apply the rule themselves.
 */
export function approvedServers(state: ServerRegistryState): ServerEntry[] {
  return state.servers.filter((s) => usableServer(state, s));
}

/**
 * Return `true` when the server at `origin` is refused because its last check found a different
 * key.
 *
 * Nothing goes to the server until the player accepts the new key by adding the server again, or a
 * check finds the saved key again.
 */
export function serverKeyRefused(state: ServerRegistryState, origin: string): boolean {
  return state.identityChanged?.includes(origin) ?? false;
}

/**
 * Return `true` when the player has at least one verified server, the server half of finishing
 * onboarding.
 *
 * A server refused for a changed key still counts. The player has finished setup, so ask about that
 * server where the player is instead of sending them back through onboarding.
 */
export function hasApprovedServer(state: ServerRegistryState): boolean {
  return state.servers.some((s) => s.verified);
}

/**
 * Return `true` when the player reports scouts to every server, including servers added later. This
 * is the default.
 *
 * A list that names every current server returns `false`, because a server added later is not in
 * that list. Show the two answers differently in a summary of the choice.
 */
export function reportsScoutsEverywhere(state: ServerRegistryState): boolean {
  return state.scoutRelay === undefined;
}

/** Return `true` when the player turned scout reporting off: the chosen list is empty. */
export function reportsScoutsNowhere(state: ServerRegistryState): boolean {
  return state.scoutRelay?.length === 0;
}

/**
 * Return `true` when the player chose to report scouts to `origin`, by name or through the "every
 * server" default.
 *
 * This is only the player's choice. A chosen server that is not verified receives nothing, so use
 * {@link receivesScoutReports} when you state whether reports reach a server. A settings screen
 * whose rows show the choice is the place for this function, and that screen labels an unverified
 * row itself.
 */
export function relaysScoutsTo(state: ServerRegistryState, origin: string): boolean {
  return state.scoutRelay === undefined || state.scoutRelay.includes(origin);
}

/**
 * Return `true` when scout reports go to this server: the player chose the server, the server is
 * verified and the server is not refused for a changed key.
 *
 * Use this wherever you tell the player whether a server receives their scouts, such as a summary
 * line. Coverage still decides which of these servers gets a given trip.
 */
export function receivesScoutReports(state: ServerRegistryState, entry: ServerEntry): boolean {
  return usableServer(state, entry) && relaysScoutsTo(state, entry.origin);
}

/**
 * List the servers scout reports may go to: every entry for which {@link receivesScoutReports} is
 * `true`, in the order of the player's list.
 *
 * Use the list to show or count those servers. To pick the servers for one report, pass the state
 * and the two ends of the trip to `scoutReportServers`.
 */
export function scoutRelayServers(state: ServerRegistryState): ServerEntry[] {
  return state.servers.filter((s) => receivesScoutReports(state, s));
}

/**
 * Compute the scout relay list after the player taps one server's row, to pass as the `origins` of
 * a `setScoutRelay` action.
 *
 * Turning a row off while on the "every server" default writes out every other saved server, so
 * servers added later are no longer included. Dispatch `resetScoutRelay` to return to the default.
 * The list keeps the order of the player's server list, whatever order the player tapped in.
 */
export function toggleScoutRelay(state: ServerRegistryState, origin: string): string[] {
  const all = state.servers.map((s) => s.origin);
  const chosen = state.scoutRelay ?? all;
  if (chosen.includes(origin)) return chosen.filter((o) => o !== origin);
  return all.filter((o) => chosen.includes(o) || o === origin);
}

/**
 * A stable key over the descriptor fields a stored snapshot exists to answer: identity
 * (`key`/`host`), routing (`coverage`), advertised `capabilities`, plus the display/version fields.
 * It deliberately omits the **volatile** fields (`startedAt` uptime and the `updated`/`proof`
 * re-sign metadata), which drift on their own as a server stays up or re-signs its descriptor.
 * `coverage`/`capabilities` are sorted so a pure reorder doesn't read as a change.
 */
function snapshotKey(entry: ServerEntry): string {
  const d = entry.descriptor;
  if (d == null) return `${entry.verified}:null`;
  return JSON.stringify({
    verified: entry.verified,
    key: d.key,
    host: d.host,
    name: d.name ?? "",
    description: d.description ?? "",
    contact: d.contact ?? "",
    version: d.version,
    accessLevel: d.accessLevel,
    coverage: [...d.coverage].sort(),
    capabilities: [...(d.capabilities ?? [])].sort(),
  });
}

/**
 * Return `true` when a re-fetched entry `next` differs from the saved `prev` in a field that
 * matters: verification, key, host, name, description, contact, version, access level, coverage or
 * capabilities.
 *
 * Uptime (`startedAt`) and re-signing (`updated`, `proof`) are ignored, and so is the order of
 * `coverage` and `capabilities`. Dispatch an `add` after a refresh only when this returns `true`.
 * Otherwise a refresh that found nothing new rebuilds the `servers` array and restarts everything
 * that depends on the list, such as map sockets and the scout relay.
 */
export function serverSnapshotChanged(prev: ServerEntry, next: ServerEntry): boolean {
  return snapshotKey(prev) !== snapshotKey(next);
}

/**
 * Return `true` when a refresh of a saved server found a verified descriptor signed with a
 * different key than the saved one.
 *
 * Do not save `next` in that case. Dispatch an `identityChanged` action instead, so nothing goes to
 * the server until the player decides. The result is `false` when `prev` never verified (its first
 * verified key is accepted) and when `next` did not verify.
 *
 * Use this on a refresh only. When the player adds the address again, that is their choice to trust
 * whoever answers now, and the way they accept a real key rotation.
 */
export function serverIdentityChanged(prev: ServerEntry, next: ServerEntry): boolean {
  const pinned = prev.verified ? prev.descriptor?.key : undefined;
  return pinned !== undefined && next.verified && next.descriptor?.key !== pinned;
}
