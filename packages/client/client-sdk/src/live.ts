/**
 * Live channels, read-only (`doc/spec/discovery.md` §6, `doc/spec/mailbox-client.md` §3). One
 * socket per server; the client emits only control messages (`subscribe` / `setCells` /
 * `mailbox:subscribe`) and receives `delta` / `map` / `mail` events. Every state-changing op goes
 * over REST (see ./client.ts).
 *
 * The socket is injected (see {@link LiveConnect}): the SDK names no socket library, so an app
 * hands in socket.io-client's `io`, or a test double. The map's viewport-filter rules are pure and
 * live in ./liveApply.ts; ordering a room's deltas is the caller's (see `subscribeRoom`).
 */
import {
  formatUnderstands,
  type LiveEvent,
  type MailboxMessage,
  type MapDelta,
  type Movement,
  type OpEnvelope,
} from "@beaconsgg/protocol-types";
import { interpolateScout } from "@beaconsgg/scout-interp";

/**
 * An open live channel socket, as the `subscribe...` methods return it. socket.io-client's `Socket`
 * fits this type.
 *
 * Keep the socket to close it with `disconnect()` when the screen closes, to check `connected`, or
 * to pass `subscribeMap`'s socket to {@link pushCells}. From `subscribeRoom` and `subscribeMailbox`
 * the value is a handle for that one subscription, and only `connected` and `disconnect()` are
 * promised on it: a later release may share one socket between the subscriptions to a server.
 */
export interface LiveSocket {
  /** `true` while the socket is connected. */
  readonly connected: boolean;
  /** Listen for a socket event. */
  on(event: string, listener: (...args: never[]) => void): unknown;
  /** Send a socket event. */
  emit(event: string, ...args: unknown[]): unknown;
  /** Close the socket. A closed socket does not reconnect. */
  disconnect(): unknown;
}

/** The options every live socket is opened with. */
export interface LiveSocketOptions {
  transports: "websocket"[];
  /** The markers this build reads, and the client's game (see `liveChannel`'s `open`). */
  auth: { understands?: string; game?: string };
}

/**
 * The function the client opens live sockets with, passed as `ClientConfig.connect`:
 * socket.io-client's `io` fits.
 *
 * @example
 * ```ts
 * import { io } from "socket.io-client";
 * const client = createClient({ game: "my-game", connect: io });
 * ```
 */
export type LiveConnect = (url: string, options: LiveSocketOptions) => LiveSocket;

/** What {@link liveChannel} is built from: the client's config, less everything REST. */
export interface LiveConfig {
  connect: LiveConnect | undefined;
  understands: readonly string[] | undefined;
  game: string | undefined;
}

/** The socket subscriptions, bound to one client's socket factory and declaration. */
export function liveChannel(config: LiveConfig) {
  const auth: LiveSocketOptions["auth"] = {
    ...(config.understands === undefined
      ? {}
      : { understands: formatUnderstands(config.understands) }),
    ...(config.game === undefined ? {} : { game: config.game }),
  };
  // Called as a plain function, like the transport's `fetch`: a factory is not a method of the config.
  const connect = config.connect;

  /**
   * Every socket declares the codes this build reads, in the handshake: a browser cannot set a
   * header on a WebSocket, and the server's HTTP filter never sees a socket, so this is the
   * socket's own declaration. `mailbox:subscribe` is the refusal that can carry one today. As on
   * REST, a client that configured no declaration sends none.
   *
   * The game rides the same handshake, once per socket, rather than on each `subscribe` and
   * `setCells`: it is a fact about the client, and {@link pushCells} callers need not know it. The
   * server scopes the map channel by it (rooms that game owns or may act on, and its scouts). A
   * room `subscribe` is by id, which the client already chose, so it is not filtered; mail is
   * scoped by the signed `mailbox:subscribe` envelope's own slug.
   */
  function open(url: string): LiveSocket {
    if (connect === undefined) {
      throw new Error("the live channel needs a socket: pass `connect` to createClient");
    }
    // Fresh per socket: socket.io writes path, host and query into the options it is handed.
    return connect(url, {
      transports: ["websocket"],
      auth: { ...auth },
    });
  }

  // Room channel: one `subscribe` on each connect, then only `delta` events. Ordering is the
  // caller's: a version-gap re-read fires only when a later delta arrives, so a delta lost during a
  // drop with nothing after it (a phase change) is recovered only by the `onReconnect` re-read.
  function subscribeRoom(
    origin: string,
    roomId: string,
    onDelta: (event: LiveEvent) => void,
    onReconnect?: () => void,
  ): LiveSocket {
    const socket = open(origin);
    onEveryConnect(socket, () => socket.emit("subscribe", { room: roomId }), onReconnect);
    socket.on("delta", onDelta);
    return socket;
  }

  // Map channel: `setCells` with `cellsToWatch()` on each connect, then `map` events. The gateway
  // sends no snapshot on a (re)subscribe, so deltas fired during a drop are lost; the caller
  // re-reads discovery in `onReconnect`.
  function subscribeMap(
    origin: string,
    cellsToWatch: () => string[],
    onMap: (delta: MapDelta) => void,
    onReconnect?: () => void,
  ): LiveSocket {
    const socket = open(origin);
    onEveryConnect(socket, () => pushCells(socket, cellsToWatch()), onReconnect);
    socket.on("map", onMap);
    return socket;
  }

  // Mailbox channel (`doc/spec/mailbox-client.md` §8): the `/mailbox` namespace, and a freshly
  // signed `mailbox:subscribe` on each connect, so the server joins the socket to the signing
  // account's private room. Only mail sent while subscribed is pushed; `onReconnect` is the
  // caller's `mailbox.fetch` catch-up.
  function subscribeMailbox(
    host: string,
    buildSubscribe: () => OpEnvelope,
    onMail: (message: MailboxMessage) => void,
    onReconnect?: () => void,
  ): LiveSocket {
    const socket = open(`${host}/mailbox`);
    onEveryConnect(
      socket,
      () => socket.emit("mailbox:subscribe", { env: buildSubscribe() }),
      onReconnect,
    );
    socket.on("mail", onMail);
    return socket;
  }

  // The reader-facing docs of these three sit on `createClient`'s returned object, which is where
  // the type of `BeaconClient` takes them from.
  return { subscribeRoom, subscribeMap, subscribeMailbox };
}

/**
 * Run `onConnect` on the first connect AND every reconnect, and `onReconnect` on reconnects only.
 * The three channels share this shape: re-declare what the socket is for, then let the caller
 * recover whatever it missed while the connection was down.
 */
function onEveryConnect(socket: LiveSocket, onConnect: () => void, onReconnect?: () => void): void {
  let hasConnected = false;
  socket.on("connect", () => {
    onConnect();
    if (hasConnected) onReconnect?.();
    hasConnected = true;
  });
}

/**
 * Send a new set of watched cells on an open map socket, after the player pans or zooms the map.
 *
 * The set replaces the previous one, and a server accepts at most 256 cells. Nothing is sent while
 * the socket is disconnected, since the socket sends `cellsToWatch()` itself when it reconnects.
 */
export function pushCells(socket: LiveSocket, cells: string[]): void {
  if (socket.connected) socket.emit("setCells", { cells });
}

/**
 * The default interval of {@link pollDiscovery}, in milliseconds: 15000 (15 seconds).
 */
export const DISCOVERY_POLL_MS = 15_000;

/**
 * Call `poll` every `intervalMs` milliseconds, for a map view too wide for the live map channel.
 *
 * Use this when `liveCellsForView` reports `capped`, and read discovery in `poll`. The first call
 * comes after one interval, not at once.
 *
 * @returns A function that stops the polling.
 */
export function pollDiscovery(poll: () => void, intervalMs = DISCOVERY_POLL_MS): () => void {
  const handle = setInterval(poll, intervalMs);
  return () => clearInterval(handle);
}

/**
 * Compute where a scout is at `nowMs` (default: now), from its movement report.
 *
 * Pass this as the `scoutPosition` function of {@link applyMapDelta}, so the map tests the point it
 * would draw. The math is `interpolateScout` from `@beaconsgg/scout-interp`.
 */
export function scoutPosition(
  scout: { movement: Movement },
  nowMs: number = Date.now(),
): { lat: number; lng: number } {
  return interpolateScout(scout.movement, nowMs);
}
