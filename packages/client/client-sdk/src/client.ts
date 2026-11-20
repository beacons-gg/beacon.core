/**
 * The Beacon client: sign ops with `@beaconsgg/identity` and POST them over REST, and read the
 * platform capabilities with plain GETs. The live channel is read-only; every state-changing op
 * goes over REST (the transport rule, `doc/spec/mailbox-client.md` §0.1).
 *
 * Endpoints:
 *   placeRoom             → POST /rooms          resolveRoom → GET /rooms/:id
 *   sendOp                → POST /rooms/:id/ops   discoverCells → GET /discovery
 *   reportScout/cancel    → POST /scouts          getDescriptor → GET /server/descriptor
 *
 * Nonce discipline (beacon.server `doc/spec/room-operation.md` §6.2): a fresh ULID nonce per op; on
 * a lost reply, retry with the **same** nonce so the server replays the original committed result
 * (exactly-once-ish). `sendOp` takes an optional `nonce` so a caller can drive that retry;
 * `sendOpWithRetry` does it for you.
 *
 * One client per app, built by {@link createClient}. Its methods close over the config rather than
 * reading `this`, so an app can destructure them and re-export them under its own names.
 */
import {
  bestVerifiedProfile,
  signOpWithWallet,
  verifyDescriptor,
  type Wallet,
} from "@beaconsgg/identity";
import {
  accessResultReadSchema,
  conformsTo,
  gameSlugSchema,
  gamesFilterSchema,
  geocodeResultReadSchema,
  placeDetailReadSchema,
  placesQueryResultReadSchema,
  placeTaxonomyReadSchema,
  profileDocReadSchema,
  type AccessStatus,
  type DidKey,
  type DiscoveryResponse,
  type GeocodeResult,
  type MailboxMessage,
  type MintedBy,
  type Movement,
  type OpEnvelope,
  type OpResult,
  type PlaceCategory,
  type PlaceDetail,
  type PlaceParams,
  type PlaceProposal,
  type PlaceProposalsFetchParams,
  type PlaceProposeParams,
  type PlacesQueryResult,
  type PlaceTaxonomy,
  type ProfileDoc,
  type ReceivedDescriptor,
  type Room,
  type ScoutConfig,
  type ServerAccessLevel,
  formatUnderstands,
  knownServerForHost,
  originForHost,
  UNDERSTANDS_HEADER,
} from "@beaconsgg/protocol-types";
import { ulid } from "ulid";
import { ID_HOST_RE, normalizeServerUrl, type ServerEntry } from "./servers";
import {
  answerOrAbsent,
  answerOrRefusal,
  isFault,
  jsonOrRefuse,
  jsonOrThrow,
  parseOrThrow,
  refusalCode,
  REQUEST_TIMEOUT_MS,
  ServerError,
  timedFetch,
  trimUrl,
  type WireFetch,
  type WireRequest,
} from "./transport";
import { liveChannel, type LiveConnect } from "./live";

/**
 * The settings of {@link createClient}: your game's slug, and the platform pieces the SDK does not
 * import itself. Every field is optional.
 */
export interface ClientConfig {
  /**
   * The `fetch` the client calls. Defaults to the global `fetch`.
   */
  // Looked up on every call rather than captured, so a test that swaps `globalThis.fetch` is still
  // the one called.
  fetch?: WireFetch;
  /**
   * The clock, in milliseconds since the epoch. The client uses it for a scout report's expiry and
   * to time a ping. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * The timeout of each request in milliseconds, or `null` for no timeout. Defaults to
   * {@link REQUEST_TIMEOUT_MS} (15000).
   *
   * Use `null` only where the caller limits its own waiting, such as an operator console.
   * `Infinity` does not mean no timeout, since `setTimeout` turns it into 1 ms.
   */
  timeoutMs?: number | null;
  /**
   * The markers your game declares it understands, such as `code:deviceRevoked` for an error code
   * your game has a message for.
   *
   * A marker is `<namespace>:<name>`, and an entry in another form is skipped. The client declares
   * the markers on every write and on every live socket. A server then sends a newer code only to a
   * client that declared it, and sends an older code in its place otherwise. Leave the field out to
   * declare nothing, which a server reads as the protocol baseline.
   */
  understands?: readonly string[];
  /**
   * Your game's slug, such as `my-game` (`doc/game-author.md` §5.6).
   *
   * The client adds the slug to every op it signs. Discovery, room reads and the live map channel
   * then return only what this game owns or may act on. A room's live channel is not filtered,
   * since you subscribe by the room's id, and the mailbox channel receives only mail for this game.
   * Leave the field out only for a tool that is not a game, such as an operator console: the client
   * then adds no slug and filters nothing.
   */
  game?: string;
  /**
   * The function that opens live sockets: socket.io-client's `io`.
   *
   * There is no default, since the SDK depends on no socket library. Without it, the REST methods
   * work and the `subscribe...` methods throw.
   */
  connect?: LiveConnect;
}

/**
 * The result of `client.placeRoom`: the new room on success, or the server's refusal.
 */
export interface PlaceResult {
  /** `true` when the server placed the room. */
  ok: boolean;
  /** The new room's `unique@host` id. */
  id?: string;
  /** The new room's version. */
  version?: number;
  /** The new room as the server stored it. */
  room?: Room;
  /** The refusal code, such as `invalid` or `gameNotAdmitted`. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
  /** The parts of the placement this server does not know, on a refusal for that reason. */
  fields?: string[];
}

/** The result of `client.reportScout` and `client.cancelScout`: success, or the server's refusal. */
export interface ScoutResult {
  /** `true` when the server accepted the report or the cancel. */
  ok: boolean;
  /** The scout's id, when the server returns one. */
  id?: string;
  /** The refusal code. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/**
 * A scout trip to report with `client.reportScout`: the scout's identity and signed provenance, its
 * movement, and how long the server keeps the report.
 *
 * The SDK builds the signed report from it. `ScoutReport` in `@beaconsgg/protocol-types` is the
 * stored report a server keeps.
 */
export interface ScoutReportInput<C extends ScoutConfig = ScoutConfig> {
  /** The scout's id, chosen by the client when the scout was made. */
  unique: string;
  /** Your game's configuration for this kind of scout, as signed in `mintedBy`. */
  config: C;
  /** The scout's provenance, from `signScoutProvenance` in `@beaconsgg/identity`. */
  mintedBy: MintedBy;
  /** The name the owner gave the scout, shown to other players. */
  name?: string | undefined;
  /** Where the scout was, when, where the scout is heading and how fast. */
  movement: Movement;
  /** How long the server keeps the report, in seconds. Defaults to 300. */
  ttlSec?: number;
}

/** The result of `client.putMedia`: the file's address on success, or the server's refusal. */
export interface MediaPutResult {
  /** `true` when the server stored the file. */
  ok: boolean;
  /** The file's address, `<hash>@host`, to put in a resource's `media[].uris`. */
  id?: string;
  /** The refusal code. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/** The result of `client.proposePlace`: the recorded proposal, or the server's refusal. */
export interface ProposeResult {
  /** `true` when the server recorded the proposal for review. */
  ok: boolean;
  /** The recorded proposal, with `status` `pending`. */
  proposal?: PlaceProposal;
  /** The refusal code, such as `rateLimited` or `tooManyPending`. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/** The result of `client.fetchMyProposals`: the player's own proposals and what became of them. */
export interface MyProposalsResult {
  /** `true` when the server answered with the list. */
  ok: boolean;
  /** The player's proposals, each with its `status`. */
  proposals?: PlaceProposal[];
  /**
   * The `cursor` that asks for the next page: the last proposal's `id`, present when the page is
   * full. Absent on the last page. A last page that is exactly full gives a cursor whose page is
   * empty.
   */
  nextCursor?: string;
  /** The refusal code. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/** The result of `client.sendMail`: the message's id on success, or the server's refusal. */
export interface MailboxSendResult {
  /** `true` when the server accepted the message. */
  ok: boolean;
  /** The message's id. */
  id?: string;
  /** The refusal code. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/** The result of `client.fetchMail`: the waiting messages, or the server's refusal. */
export interface MailboxFetchResult {
  /** `true` when the server answered with the messages. */
  ok: boolean;
  /** The messages that have not expired or been deleted. */
  messages?: MailboxMessage[];
  /** The refusal code. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/** The result of `client.ackMail`: how many messages were deleted, or the server's refusal. */
export interface MailboxAckResult {
  /** `true` when the server processed the request. */
  ok: boolean;
  /** The number of messages deleted. */
  deleted?: number;
  /** The refusal code. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/**
 * The result of `client.requestAccess` and `client.fetchAccess`: the server's access level and
 * where the player stands, or the server's refusal.
 */
export interface AccessReply {
  /** `true` when the server answered with the player's standing. */
  ok: boolean;
  /** The server's access level. */
  accessLevel?: ServerAccessLevel;
  /** Where the player stands: `member`, `pending`, `declined` or `none`. */
  status?: AccessStatus;
  /** The refusal code, such as `denied` from a `private` server. */
  error?: string;
  /** The server's explanation of a refusal, in English. */
  message?: string;
}

/** What `client.discoverCells` asks a server for: room types, scouts and the games to read. */
export interface DiscoverOptions {
  /**
   * The room types to return, such as `["jar"]`. There is no default, so name every type your game
   * shows. Pass `[]` to ask for scouts only, or `null` for rooms of every type, as a tool that has
   * to see everything in the cells does.
   */
  rooms: readonly string[] | null;
  /** `true` to return the scouts in the cells too. Required, so that leaving scouts out is a choice. */
  scouts: boolean;
  /**
   * Return only rooms these games own or may act on, and their scouts. Defaults to this client's
   * own game. Pass `null` for every game. The live map channel stays filtered to this client's own
   * game whatever you pass here.
   */
  games?: readonly string[] | null;
}

/**
 * What `client.probeDevice` found out about a device on one server.
 *
 * - `allowed`: the server accepts ops from the device.
 * - `revoked`: the player revoked the device from another device.
 * - `blocked`: the server's operator blocked the account. A revoked device on a blocked account
 *   reads as `blocked`, since the server checks the block first.
 * - `unknown`: the server refused the probe with another code, such as `clockSkew`, `rateLimited`
 *   or `gameNotAdmitted`, which `code` holds.
 *
 * A server that fails or cannot be reached gives no `DeviceProbe`: `probeDevice` throws a fault, as
 * every call does.
 */
export type DeviceProbe =
  | { status: "allowed" }
  | { status: "revoked" }
  | { status: "blocked" }
  | { status: "unknown"; code: string };

/** How `client.sendOpWithRetry` retries: the number of attempts and the first wait. */
export interface RetryOptions {
  /** The attempts in all, the first one included. Defaults to 3. */
  attempts?: number;
  /**
   * The wait before the second attempt, in milliseconds. Defaults to 500. Each later wait is three
   * times the one before, up to 10 times this value, and each is jittered by up to a quarter either
   * way. Pass `0` to retry at once, as a test does.
   */
  delayMs?: number;
}

/** The options of `client.verifyServer`. */
export interface VerifyServerOptions {
  /**
   * `true` to keep the origin made from the typed address, instead of switching to the server's
   * own host name. An operator console that reaches a server by an internal address sets it.
   */
  keepAddress?: boolean;
}

/**
 * Create the client your game uses to talk to Beacon servers. Create one client per app.
 *
 * The methods do not use `this`, so you can destructure them. See {@link ClientConfig} for each
 * setting and its default.
 *
 * @throws `TypeError` when `config.game` is not a valid game slug.
 *
 * @example
 * ```ts
 * import { io } from "socket.io-client";
 * import { createClient } from "@beaconsgg/client-sdk";
 *
 * const client = createClient({ game: "my-game", connect: io });
 * const entry = await client.addServer("beacon.example");
 * ```
 */
export function createClient(config: ClientConfig = {}) {
  const now = config.now ?? (() => Date.now());
  const request = timedFetch({
    fetch: config.fetch ?? ((url, init) => fetch(url, init)),
    // Not `??`: an explicit `null` (no timeout) must survive the default.
    timeoutMs: config.timeoutMs === undefined ? REQUEST_TIMEOUT_MS : config.timeoutMs,
    understands: config.understands,
  });

  // Checked here, once: the slug goes into every envelope and every read, so a malformed one would
  // fail every call later with nothing pointing at the config.
  if (config.game !== undefined && !conformsTo(gameSlugSchema, config.game)) {
    throw new TypeError(`createClient: ${JSON.stringify(config.game)} is not a game slug`);
  }
  const game = config.game === undefined ? {} : { game: config.game };
  const ownGames = config.game === undefined ? null : [config.game];

  /**
   * The `games` query value for a game-filtered read: `override` when given (`null` for every
   * game), otherwise this client's own game, otherwise no filter.
   */
  function gamesParam(override: readonly string[] | null | undefined): Record<string, string> {
    const games = override !== undefined ? override : ownGames;
    if (games === null) return {};
    if (!conformsTo(gamesFilterSchema, games)) {
      throw new TypeError("games: one or more game slugs, or null for every game");
    }
    return { games: games.join(",") };
  }

  /**
   * Sign `intent`: a fresh ULID nonce unless one is pinned, and this client's game slug. Every
   * signed envelope the client produces comes from here, so every write names its game.
   */
  function signFor(
    wallet: Wallet,
    intent: { op: string; room?: string; params: Record<string, unknown>; nonce?: string },
  ): OpEnvelope {
    return signOpWithWallet(wallet, {
      op: intent.op,
      ...(intent.room !== undefined ? { room: intent.room } : {}),
      nonce: intent.nonce ?? ulid(),
      ...game,
      params: intent.params,
    });
  }

  // The shared shape behind the placement, mailbox, scout and places routes: a signed envelope
  // POSTed to a standalone capability path (`doc/spec/mailbox-client.md` §0.1, §5).
  async function postSigned<T>(
    server: string,
    path: string,
    wallet: Wallet,
    intent: { op: string; params: Record<string, unknown>; nonce?: string },
  ): Promise<T> {
    const env = signFor(wallet, intent);
    return jsonOrThrow(await request(`${trimUrl(server)}${path}`, jsonPost(env)));
  }

  // Same-nonce retry is the server's replay rule (beacon.server `doc/spec/room-operation.md` §6.2).
  function sendOp(
    server: string,
    wallet: Wallet,
    roomId: string,
    op: string,
    params: Record<string, unknown>,
    nonce: string = ulid(),
  ): Promise<OpResult> {
    return postOp(server, wallet, roomId, { op, params, nonce });
  }

  /** Sign a room op and POST it to the room's ops route, with any extra headers. */
  async function postOp(
    server: string,
    wallet: Wallet,
    room: string,
    intent: { op: string; params: Record<string, unknown>; nonce?: string },
    headers?: Record<string, string>,
  ): Promise<OpResult> {
    const env = signFor(wallet, { ...intent, room });
    const url = `${trimUrl(server)}/rooms/${encodeURIComponent(room)}/ops`;
    return jsonOrThrow(await request(url, jsonPost(env, headers)));
  }

  // Every attempt carries the same ULID nonce, so a server that committed an earlier attempt replays
  // its `OpResult` instead of applying the op again (beacon.server `doc/spec/room-operation.md` §6.2).
  async function sendOpWithRetry(
    server: string,
    wallet: Wallet,
    roomId: string,
    op: string,
    params: Record<string, unknown>,
    retry: number | RetryOptions = {},
  ): Promise<OpResult> {
    const { attempts = 3, delayMs = RETRY_DELAY_MS } =
      typeof retry === "number" ? { attempts: retry } : retry;
    const nonce = ulid();
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(retryDelayMs(i, delayMs));
      try {
        return await sendOp(server, wallet, roomId, op, params, nonce);
      } catch (err) {
        // Only a fault is worth another try. A refusal, `writeLocked` included, is the server's
        // answer: a lock lasts minutes, far past any retry here, so the caller hears of it at once.
        if (!isFault(err)) throw err;
        lastErr = err; // retry with the SAME nonce (idempotent recovery)
      }
    }
    // Every error kept above is a fault, so only `attempts <= 0` reaches the fallback.
    throw lastErr ?? new Error("sendOpWithRetry: exhausted attempts");
  }

  function placeRoom(server: string, wallet: Wallet, params: PlaceParams): Promise<PlaceResult> {
    return postSigned(server, "/rooms", wallet, { op: "place", params });
  }

  function reportScout<C extends ScoutConfig>(
    server: string,
    wallet: Wallet,
    scout: ScoutReportInput<C>,
  ): Promise<ScoutResult> {
    const expiresAt = new Date(now() + (scout.ttlSec ?? 300) * 1000).toISOString();
    return postSigned(server, "/scouts", wallet, {
      op: "report",
      params: {
        unique: scout.unique,
        config: scout.config,
        mintedBy: scout.mintedBy,
        ...(scout.name !== undefined ? { name: scout.name } : {}),
        movement: scout.movement,
        expiresAt,
      },
    });
  }

  function cancelScout(server: string, wallet: Wallet, unique: string): Promise<ScoutResult> {
    return postSigned(server, "/scouts", wallet, { op: "cancel", params: { unique } });
  }

  // `/media` takes a `{env, data}` wrapper rather than a bare envelope: the signed `media.put`
  // envelope attests `{hash, type, size}`, and the bytes ride beside it as base64 (beacon.server
  // `doc/spec/mailbox-and-media.md` §5.3).
  async function putMedia(
    server: string,
    wallet: Wallet,
    media: { hash: string; type: string; size: number; base64: string },
  ): Promise<MediaPutResult> {
    const env = signFor(wallet, {
      op: "media.put",
      params: { hash: media.hash, type: media.type, size: media.size },
    });
    return jsonOrThrow(
      await request(`${trimUrl(server)}/media`, jsonPost({ env, data: media.base64 })),
    );
  }

  async function getDescriptor(server: string): Promise<unknown> {
    return jsonOrRefuse(await request(`${trimUrl(server)}/server/descriptor`));
  }

  async function getOrThrow<T>(server: string, path: string): Promise<T> {
    return parseOrThrow(await request(`${trimUrl(server)}${path}`, { headers: JSON_ACCEPT }));
  }

  async function postSignedOrThrow<T>(
    server: string,
    path: string,
    wallet: Wallet,
    intent: { op: string; params: Record<string, unknown>; nonce?: string },
  ): Promise<T> {
    const env = signFor(wallet, intent);
    return parseOrThrow(await request(`${trimUrl(server)}${path}`, jsonPost(env, JSON_ACCEPT)));
  }

  // Bytes are hashed, never signed: the hash in the signed params is the integrity link.
  async function uploadSignedOrThrow<T>(
    server: string,
    path: string,
    wallet: Wallet,
    intent: { op: string; params: Record<string, unknown> },
    dataBase64: string,
  ): Promise<T> {
    const env = signFor(wallet, intent);
    const body = jsonPost({ env, data: dataBase64 }, JSON_ACCEPT);
    return parseOrThrow(await request(`${trimUrl(server)}${path}`, body));
  }

  async function verifyServer(
    address: string,
    options: VerifyServerOptions = {},
  ): Promise<ServerEntry & { descriptor: ReceivedDescriptor }> {
    const origin = normalizeServerUrl(address);
    // A blank address has no server to ask; fetching "" would ask whatever origin the caller runs on.
    if (origin === null) throw new Error("no server address");
    // Handed over as received; `verifyDescriptor` shape-checks it and signs off on the raw body, so
    // a field a newer server signed still verifies.
    const descriptor: unknown = await getOrThrow(origin, "/server/descriptor");
    if (!verifyDescriptor(descriptor))
      throw new Error("descriptor is malformed or does not verify");
    const found =
      options.keepAddress === true
        ? { origin, descriptor }
        : await canonicalOrigin(origin, descriptor);
    return { ...found, verified: true };
  }

  // `doc/spec/discovery.md` §7. An unreachable or unverifiable server comes back `verified: false`,
  // so the caller can flag it instead of trusting an unsigned coverage claim.
  async function addServer(address: string): Promise<ServerEntry> {
    try {
      return await verifyServer(address);
    } catch {
      return { origin: normalizeServerUrl(address) ?? "", descriptor: null, verified: false };
    }
  }

  /**
   * The origin a verified server is saved under: its own, from the descriptor's `host`, when the
   * player reached it by another name (a domain in front of a hosted server, say) and its own name
   * answers with the same key; the typed one otherwise. Every id the server mints carries its own
   * name, and {@link resolveServerForId} routes an id to the saved origin whose authority matches,
   * so a server saved under an alias would send its own ids elsewhere. A name that does not answer
   * (`localhost:3001` reached over the LAN from a phone) is not adopted: the typed origin stays.
   */
  async function canonicalOrigin(
    origin: string,
    descriptor: ReceivedDescriptor,
  ): Promise<{ origin: string; descriptor: ReceivedDescriptor }> {
    const typed = { origin, descriptor };
    // The router's own rule: an id's host already finds this origin, so nothing to adopt.
    if (knownServerForHost(descriptor.host, [origin]) !== undefined) return typed;
    // A host outside the id host class can be nobody's `@host`, so it names nothing to adopt; and a
    // name the server chose never takes a player from https to http.
    if (!ID_HOST_RE.test(descriptor.host)) return typed;
    const own = originForHost(descriptor.host);
    if (origin.startsWith("https://") && !own.startsWith("https://")) return typed;
    try {
      const again: unknown = await getDescriptor(own);
      if (verifyDescriptor(again) && again.key === descriptor.key)
        return { origin: own, descriptor: again };
    } catch {
      // Not reachable by its own name from here; the typed address is how this client finds it.
    }
    return typed;
  }

  // `/health` is cheap and checks no dependency. The short default timeout makes a stalled ping fail
  // fast instead of waiting out the normal request timeout.
  async function pingServer(server: string, timeoutMs = 5000): Promise<number | null> {
    const start = now();
    try {
      const res = await request(`${trimUrl(server)}/health`, {}, timeoutMs);
      return res.ok ? now() - start : null;
    } catch {
      return null;
    }
  }

  // `rooms` has no default on purpose, so no game's list becomes another's. The wire still takes one
  // `types` list, with `scout` among the room types. The live map socket is not widened by `games`:
  // a socket carries the client's own game for its whole life.
  async function discoverCells(
    server: string,
    cells: readonly string[],
    options: DiscoverOptions,
  ): Promise<DiscoveryResponse> {
    const { rooms, scouts, games } = options;
    if (rooms?.includes(SCOUT_TYPE))
      throw new TypeError('discoverCells: "scout" is not a room type; pass scouts: true');
    if (rooms?.length === 0 && !scouts)
      throw new TypeError("discoverCells: ask for at least one room type or for scouts");
    const q = new URLSearchParams({ cells: cells.join(","), ...gamesParam(games) });
    // An absent `types` is every room and every scout, and an empty one every room and no scout.
    if (rooms !== null) q.set("types", (scouts ? [...rooms, SCOUT_TYPE] : rooms).join(","));
    else if (!scouts) q.set("types", "");
    return jsonOrRefuse(await request(`${trimUrl(server)}/discovery?${q.toString()}`));
  }

  async function resolveRoom(
    server: string,
    id: string,
    games?: readonly string[] | null,
  ): Promise<Room | null> {
    const q = new URLSearchParams(gamesParam(games)).toString();
    const res = await request(
      `${trimUrl(server)}/rooms/${encodeURIComponent(id)}${q === "" ? "" : `?${q}`}`,
    );
    // A caller may delete a saved room on `null`, so only the server's own `unknownRoom` gives it.
    // Handed back as received, so `mintedBy` verifies over the raw room and a field a newer server
    // adds still reads; but a body that is no object at all, a JSON `null` included, is no room.
    return answerOrAbsent(res, "unknownRoom", (room) =>
      typeof room === "object" && room !== null && !Array.isArray(room)
        ? (room as Room)
        : undefined,
    );
  }

  /**
   * The status split shared by the opt-in location reads (`getGeocode`/`getPlaces`/…): each is an
   * unsigned GET to a capability that 404s when disabled. The server's own `unknownRoute` 404 ⇒
   * `null` (capability off, or an unknown place), as `resolveRoom` reads `unknownRoom`. Any other
   * refusal (a `400` for a malformed or too-coarse geohash, a `429`) throws its `ApiError`, and a
   * fault (a 5xx, the `503` upstream-unavailable, a proxy's page) a `ServerError`. A 2xx body is
   * `safeParse`d, and a body that is not JSON or not of the read's shape is a fault too, so `null`
   * never stands for a reply the server did not mean.
   */
  async function readLocation<T>(
    url: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T | null> {
    return answerOrAbsent(await request(url), "unknownRoute", (body) => {
      const parsed = schema.safeParse(body);
      return parsed.success ? parsed.data : undefined;
    });
  }

  async function getGeocode(server: string, geohash: string): Promise<GeocodeResult | null> {
    const q = new URLSearchParams({ geohash });
    return readLocation(`${trimUrl(server)}/geocode?${q.toString()}`, geocodeResultReadSchema);
  }

  // beacon.server `doc/spec/places.md` §5. An unsigned read, so the body is `safeParse`d.
  async function getPlaces(
    server: string,
    cells: string[],
    categories?: PlaceCategory[],
  ): Promise<PlacesQueryResult | null> {
    const q = new URLSearchParams({
      cells: cells.join(","),
      ...(categories && categories.length > 0 ? { categories: categories.join(",") } : {}),
    });
    return readLocation(`${trimUrl(server)}/places?${q.toString()}`, placesQueryResultReadSchema);
  }

  // beacon.server `doc/spec/place-proposals.md` §4.2. The subcategory is a bounded slug rather than a
  // wire enum, so this read is the only way a client knows what to offer.
  async function getPlaceTaxonomy(server: string): Promise<PlaceTaxonomy | null> {
    return readLocation(`${trimUrl(server)}/places/taxonomy`, placeTaxonomyReadSchema);
  }

  // beacon.server `doc/spec/places.md` §5. An unsigned read, so the body is `safeParse`d.
  async function getPlaceDetail(server: string, unique: string): Promise<PlaceDetail | null> {
    return readLocation(
      `${trimUrl(server)}/places/${encodeURIComponent(unique)}`,
      placeDetailReadSchema,
    );
  }

  // beacon.server `doc/spec/place-proposals.md` §5. The first player write to a places server, so the
  // submission is attributed, rate-limited and block-gated like any other signed op.
  function proposePlace(
    server: string,
    wallet: Wallet,
    params: PlaceProposeParams,
    nonce?: string,
  ): Promise<ProposeResult> {
    return postSigned(server, "/places/propose", wallet, {
      op: "places.propose",
      params,
      ...(nonce ? { nonce } : {}),
    });
  }

  // A signed read, scoped by the server to the verified actor, with no way to list anyone else's: a
  // contribution ties a DID to a point in the world, so an open listing would disclose locations.
  // Always sends a `limit`, so a full page is known to be full and `nextCursor` can say so.
  async function fetchMyProposals(
    server: string,
    wallet: Wallet,
    params: PlaceProposalsFetchParams = {},
  ): Promise<MyProposalsResult> {
    const limit = params.limit ?? PROPOSALS_PAGE;
    const result = await postSigned<MyProposalsResult>(server, "/places/proposals/fetch", wallet, {
      op: "places.proposals.fetch",
      params: { ...params, limit },
    });
    const last =
      result.ok && result.proposals?.length === limit ? result.proposals.at(-1) : undefined;
    return last ? { ...result, nextCursor: last.id } : result;
  }

  function sendMail(
    server: string,
    wallet: Wallet,
    to: DidKey,
    body: string,
  ): Promise<MailboxSendResult> {
    return postSigned(server, "/mailbox", wallet, { op: "mailbox.send", params: { to, body } });
  }

  // Read through the read twin, so a player never shows as admitted on a value this build cannot read.
  async function postAccess(
    server: string,
    path: string,
    wallet: Wallet,
    intent: { op: string; params: Record<string, unknown> },
  ): Promise<AccessReply> {
    const res = await request(`${trimUrl(server)}${path}`, jsonPost(signFor(wallet, intent)));
    return answerOrRefusal<AccessReply, AccessReply>(res, (body) => {
      const read = accessResultReadSchema.safeParse(body);
      return read.success ? read.data : undefined;
    });
  }

  function requestAccess(server: string, wallet: Wallet, note?: string): Promise<AccessReply> {
    return postAccess(server, "/access/request", wallet, {
      op: "access.request",
      params: note ? { note } : {}, // an empty note is no note, not a refused request
    });
  }

  function fetchAccess(server: string, wallet: Wallet): Promise<AccessReply> {
    return postAccess(server, "/access/status", wallet, { op: "access.status", params: {} });
  }

  // A fresh nonce every call: the server answers a reused read nonce with 409 instead of replaying a
  // captured inbox read.
  function fetchMail(server: string, wallet: Wallet): Promise<MailboxFetchResult> {
    return postSigned(server, "/mailbox/fetch", wallet, { op: "mailbox.fetch", params: {} });
  }

  function ackMail(server: string, wallet: Wallet, ids: string[]): Promise<MailboxAckResult> {
    return postSigned(server, "/mailbox/ack", wallet, { op: "mailbox.ack", params: { ids } });
  }

  // `doc/spec/mailbox-client.md` §8. Kept beside the REST mailbox ops so every mailbox op name and
  // the fresh-nonce rule live in one place; the socket stays identity-free by taking a thunk.
  function buildMailboxSubscribe(wallet: Wallet): OpEnvelope {
    return signFor(wallet, { op: "mailbox.subscribe", params: {} });
  }

  async function publishProfile(
    server: string,
    profile: ProfileDoc,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await request(`${trimUrl(server)}/profiles`, jsonPost(profile));
    if (res.ok) return { ok: true };
    // The refusal body, or a throw: a fault is never returned as a failed publish.
    const refused = await jsonOrThrow<{ error: string }>(res);
    return { ok: false, error: refused.error };
  }

  async function fetchProfile(server: string, did: string): Promise<ProfileDoc | null> {
    try {
      const res = await request(`${trimUrl(server)}/profiles/${encodeURIComponent(did)}`);
      if (!res.ok) return null; // 404 (not here) or 5xx (transient): try elsewhere
      // Shape-checked, handed back as received for `verifyProfile`, so a field a newer
      // app signed still verifies.
      const body: unknown = await res.json().catch(() => null);
      return conformsTo(profileDocReadSchema, body) ? body : null;
    } catch {
      return null; // network/timeout: best-effort, never throws
    }
  }

  async function fetchBestProfile(
    origins: readonly string[],
    did: string,
  ): Promise<ProfileDoc | null> {
    return bestVerifiedProfile(
      did,
      await Promise.all(origins.map((origin) => fetchProfile(origin, did))),
    );
  }

  // `doc/spec/identity.md` §10.3. The engine checks the block, then revocation, before it loads the
  // room, so a signed `list` on a room that does not exist answers `denied` for a blocked account,
  // `deviceRevoked` for a revoked device and `unknownRoom` for a valid one, with no side effects. The
  // probe declares `code:deviceRevoked` whatever this client declares: every server in the skew
  // window knows the code, so `denied` then means only the block.
  async function probeDevice(server: string, wallet: Wallet): Promise<DeviceProbe> {
    const room = `${ulid()}@probe.invalid`; // valid GlobalId shape, never placed
    // First, so a server that keeps only the first markers of a long declaration still reads it.
    const declared = formatUnderstands(["code:deviceRevoked", ...(config.understands ?? [])]);
    // A fault throws, as from every call: no verdict is ever made up from a server that failed.
    const res: unknown = await postOp(
      server,
      wallet,
      room,
      { op: "list", params: {} },
      { [UNDERSTANDS_HEADER]: declared },
    );
    if ((res as { ok?: unknown } | null)?.ok === true) return { status: "allowed" }; // can't happen
    const code = refusalCode(res);
    if (code === "unknownRoom") return { status: "allowed" };
    if (code === "deviceRevoked") return { status: "revoked" };
    if (code === "denied") return { status: "blocked" };
    // A refusal always carries its code, so only a 2xx body that is neither `ok: true` nor a
    // refusal gets here: no answer from the server, and so a fault. An op answers 200.
    if (code === undefined) throw new ServerError(200);
    return { status: "unknown", code };
  }

  // The methods' reader-facing docs sit on this object, where the type of `BeaconClient` (and so an
  // editor's hover and the SDK reference) picks them up; the functions above keep only notes for
  // maintainers.
  const live = liveChannel({
    connect: config.connect,
    understands: config.understands,
    game: config.game,
  });

  return {
    /**
     * Sign an op without sending it, for a route whose body the client does not build. An example
     * is a binary upload with the envelope in a header.
     *
     * The envelope gets a new nonce unless `intent.nonce` is set, and this client's game slug.
     *
     * @returns The signed envelope.
     */
    sign: signFor,
    /**
     * Sign an op and POST the envelope to `path` on `server`, for a signed route the client has no
     * method for.
     *
     * The game-facing methods such as `placeRoom` and `sendMail` work this way.
     *
     * @returns The reply's JSON body. The server's refusal is returned as its `{ ok: false, error }`
     * body.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    postSigned,
    /**
     * Send a GET to `path` on `server` and return the reply's JSON body.
     *
     * Use the `...OrThrow` methods in an operator console, where a refusal is an error to show.
     *
     * @throws {@link ApiError} for the server's refusal, with its `message` and `code`, and a
     * fault ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or
     * {@link NetworkError}.
     */
    getOrThrow,
    /**
     * Sign an op, POST it to `path` on `server` and return the reply's JSON body.
     *
     * Every operator route takes this shape. {@link postSigned} is the game-facing form, which
     * returns a refusal instead of throwing.
     *
     * @throws {@link ApiError} for the server's refusal, with its `message` and `code`, and a
     * fault ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or
     * {@link NetworkError}.
     */
    postSignedOrThrow,
    /**
     * Sign an op that describes a file and POST the op with the file's bytes to `path` on `server`.
     *
     * The body is `{ env, data }`: the signed envelope, and the bytes as standard base64. The bytes
     * are not signed, so the op's params must carry their hash.
     *
     * @throws {@link ApiError} for the server's refusal, with its `message` and `code`, and a
     * fault ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or
     * {@link NetworkError}.
     */
    uploadSignedOrThrow,
    /**
     * Fetch a server's descriptor and verify its signature, and throw with the reason when the
     * server cannot be added.
     *
     * Use this where you show the player why a server failed. {@link addServer} is the form that
     * never throws, and both save a server the same way. When the descriptor names a host other
     * than the address typed, and the server answers at that host with the same key, the entry uses
     * the server's own host as its origin. A name the server gives never takes an `https` address
     * to `http`.
     *
     * @param address - The address as the player typed it, such as `beacon.example`.
     * @param options - `keepAddress: true` keeps the origin made from `address`, for an operator
     * console that reaches a server by an internal address.
     * @returns The server's entry, with `verified: true`.
     * @throws `Error` when `address` is blank or the descriptor is malformed or does not verify,
     * {@link ApiError} for the server's refusal, and a fault ({@link isFault}): {@link ServerError},
     * {@link RequestTimeoutError} or {@link NetworkError}.
     */
    verifyServer,
    /**
     * Sign an op on a room and send it to `POST /rooms/:id/ops` on `server`.
     *
     * To retry a request that failed, pass the `nonce` of the first attempt. A server that already
     * applied the op then returns the first result instead of applying the op twice.
     * {@link sendOpWithRetry} does this for you.
     *
     * @param roomId - The room's `unique@host` id.
     * @param op - The op name, such as `take` or one your room's policy declares.
     * @param nonce - The op's ULID. Defaults to a new one.
     * @returns The server's result. A refusal such as `full` or `denied` is a result with `ok:
     * false`.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    sendOp,
    /**
     * Send a signed op on a room and retry with the same nonce after a fault, with 3 tries in all
     * by default.
     *
     * A server that applied an earlier attempt returns that attempt's result, so the op is applied
     * once. A fault ({@link isFault}) is retried after a short wait: about 0.5 seconds before the
     * second attempt and 1.5 seconds before the third. A refusal such as `full` or `denied` is an
     * answer and is returned without a retry. A locked server's `writeLocked` is thrown at once,
     * since a lock lasts longer than the retries.
     *
     * @param retry - The number of attempts, or {@link RetryOptions} with `attempts` and `delayMs`,
     * the wait before the second attempt. A test passes `{ delayMs: 0 }` to retry at once.
     * @returns The server's result, as {@link sendOp} returns it.
     * @throws {@link ApiError} with the code `writeLocked` at once, and the last attempt's fault
     * when every attempt fails.
     */
    sendOpWithRetry,
    /**
     * Place a new room on `server` with a signed `place` op.
     *
     * Your game builds `params`: the room's type, its policy and its starting contents. Pick the
     * server with `selectCoveringServer(registry, location)`.
     *
     * @returns The result. On success `id` is the new room's `unique@host` id. On a refusal `error`
     * holds the code, and `fields` names any part of the placement the server does not know.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    placeRoom,
    /**
     * Report a scout's trip to `server`, so players who read that server can see the scout.
     *
     * The server computes the scout's position along the route from `scout.movement`, so a report
     * needs no position updates during the trip. The server forgets the report after `scout.ttlSec`
     * seconds (default 300), so send the same report again before then to keep the scout visible. A
     * Beacon server refuses a TTL over 1 hour by default, with `invalid`. Pick the servers with
     * `scoutReportServers`.
     *
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    reportScout,
    /**
     * Remove a scout's report from `server` before the report expires.
     *
     * @param unique - The scout's `unique`, as in its report.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    cancelScout,
    /**
     * Upload a file such as an image to the media store of `server`. Compute `hash` with
     * `sha256Base64url` from `@beaconsgg/identity`.
     *
     * `hash` is the sha256 of the bytes as base64url without padding, and `size` is the byte count
     * before base64 encoding. The server hashes the bytes again and refuses the upload when either
     * does not match. The server also refuses bytes that carry EXIF or GPS metadata. A file the
     * server already holds is not stored twice: the server answers with its existing `id`, so a
     * retry is safe. Upload to the player's media host from `selectMediaHost`.
     *
     * @returns On success `id` is the file's address, `<hash>@host`, to put in a resource's
     * `media[].uris`. A refusal is returned as `{ ok: false, error }`.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    putMedia,
    /**
     * Fetch a server's descriptor from `GET /server/descriptor`, without checking it.
     *
     * Pass the result to `verifyDescriptor` from `@beaconsgg/identity` before you read any of it.
     * {@link addServer} fetches and verifies in one call.
     *
     * @throws {@link ApiError} for the server's refusal, such as `rateLimited`, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    getDescriptor,
    /**
     * Fetch and verify a server's descriptor, to add the server to the player's list.
     *
     * The method is best-effort and never throws. A server that cannot be reached, or whose
     * descriptor does not verify, comes back with `verified: false` and `descriptor: null`, so you
     * can show it as unverified. A verified server is saved as {@link verifyServer} saves it, under the server's
     * own host when the server answers there with the same key.
     *
     * @param address - The address as the player typed it, such as `beacon.example`. The method
     * turns the address into an origin with {@link normalizeServerUrl}.
     * @returns The entry to pass to the registry in an `add` action.
     */
    addServer,
    /**
     * Measure a server's round trip time in milliseconds with `GET /health`.
     *
     * @param timeoutMs - How long to wait, in milliseconds. Defaults to 5000.
     * @returns The time in milliseconds, or `null` when the server cannot be reached, answers
     * outside the 2xx range or runs out of time. The method is best-effort and never throws.
     */
    pingServer,
    /**
     * List the rooms of the given types and, when asked, the scouts that a server holds in `cells`,
     * with `GET /discovery`.
     *
     * Send the request to each server from `serversForCells` and merge the answers. Use the
     * client's live map channel (`client.subscribeMap`) to keep the result up to date.
     *
     * @param cells - Geohash cells, from `cellsForView` in `@beaconsgg/geo`. A
     * server takes at most 256.
     * @param options - The room types in `rooms`, whether to return `scouts`, and the `games` to
     * read (see {@link DiscoverOptions}).
     * @throws {@link ApiError} with the refusal `code` when the server refuses the query, such as
     * for too many cells or an unknown game, and a fault ({@link isFault}). Before any request the
     * method throws `TypeError` for an invalid slug in `games`, for `"scout"` in `rooms` and for
     * options that ask for nothing.
     */
    discoverCells,
    /**
     * Fetch a room's current state by its id, with `GET /rooms/:id`.
     *
     * The read is filtered by game like {@link discoverCells}. `null` therefore means the room is
     * gone, or that the room is not open to these games. Before you delete a saved room on `null`,
     * ask again with `games` set to `null`.
     *
     * Only the server's own `unknownRoom` refusal gives `null`. A reverse proxy in front of a server
     * answers its own 404 page for a few seconds while the server restarts, and that reply throws a
     * {@link ServerError} with `status` 404, like a server you cannot reach. Never delete anything
     * on a throw.
     *
     * @param id - The room's `unique@host` id.
     * @param games - Defaults to this client's own game. Pass `null` for every game.
     * @returns The room, or `null` when the server answers 404 `unknownRoom`.
     * @throws {@link ApiError} for another refusal, such as `rateLimited`, and a fault
     * ({@link isFault}), such as a proxy's 404 page while the server restarts or a 2xx reply that is
     * not a JSON object.
     */
    resolveRoom,
    /**
     * Look up the place a geohash is in, such as its city and neighborhood. The server must offer
     * the `geocode` capability.
     *
     * Pass the finest geohash you have, since the answer is as precise as the request.
     *
     * @returns The place's labels, source and attribution, or `null` when the server does not offer
     * `geocode` (its 404 `unknownRoute`).
     * @throws {@link ApiError} for another refusal, such as `invalid` or `rateLimited`, and a fault
     * ({@link isFault}), such as a proxy's 404 page while the server restarts or a 2xx reply that is
     * not of the read's shape.
     */
    getGeocode,
    /**
     * List the places in `cells` from a server that offers the `places` capability, optionally only
     * those in `categories`.
     *
     * The server answers from its own dataset, so an area it has no data for gives an empty list.
     *
     * @returns The places, or `null` when the server does not offer `places` (its 404
     * `unknownRoute`).
     * @throws {@link ApiError} for another refusal, such as `invalid` or `rateLimited`, and a fault
     * ({@link isFault}), such as a proxy's 404 page while the server restarts or a 2xx reply that is
     * not of the read's shape.
     */
    getPlaces,
    /**
     * Fetch the place categories and subcategories a server accepts, for a form that proposes a
     * place.
     *
     * A new place needs both a category and a subcategory, and each subcategory belongs to one
     * category, so always read the pair. The list changes only with a server release, so you can
     * cache it for a long time.
     *
     * @returns The categories, or `null` when the server does not offer `places` (its 404
     * `unknownRoute`).
     * @throws {@link ApiError} for another refusal, such as `invalid` or `rateLimited`, and a fault
     * ({@link isFault}), such as a proxy's 404 page while the server restarts or a 2xx reply that is
     * not of the read's shape.
     */
    getPlaceTaxonomy,
    /**
     * Fetch one place's full detail with the fields the list leaves out: `geometry`, the longer
     * description fields and a summary of where the data came from.
     *
     * @param unique - The place's `unique`.
     * @returns The place, or `null` when the server does not offer `places`, does not know the
     * place or has retired it (its 404 `unknownRoute`).
     * @throws {@link ApiError} for another refusal, such as `invalid` or `rateLimited`, and a fault
     * ({@link isFault}), such as a proxy's 404 page while the server restarts or a 2xx reply that is
     * not of the read's shape.
     */
    getPlaceDetail,
    /**
     * Submit a new place or a change to a place for an operator to review.
     *
     * Success means the server recorded a `pending` proposal. Nothing is published until an
     * operator approves it. A refusal is returned as `{ ok: false, error, message }`: `rateLimited`
     * or `tooManyPending` for a limit, `unknownRoute` for a server that takes no proposals, and
     * other codes for a bad field.
     *
     * @param nonce - Pass the same ULID when you retry the same proposal. The server keeps one
     * result per nonce, so a retry after a lost reply does not create a second pending proposal or
     * use up another of the player's pending slots.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    proposePlace,
    /**
     * List the player's own place proposals and what became of them, with a request signed by
     * `wallet`.
     *
     * Each proposal carries its `status`. A decided proposal also names the reviewer, the time and
     * the reason. No player can list anyone else's proposals. The list is newest first, one page at
     * a time.
     *
     * @param params - An optional `status` filter, a `limit` from 1 to 200 (default 50) and a
     * `cursor`: the previous page's `nextCursor`.
     * @returns The page, with `nextCursor` when the page is full.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    fetchMyProposals,
    /**
     * Ask the operator of `server` to let the `wallet` account write there, with an optional note
     * of up to 280 characters.
     *
     * Only a server at the `request` level that lists the `access:members` marker
     * (`enforcesAccess`) takes a request. Publish the player's profile there first (see
     * `AccessRequestParams`). Bound a note with `accessNoteSchema`.
     *
     * @returns The server's access level and the player's `status` afterwards. A `private` server
     * refuses with `denied`, returned as `{ ok: false, error }`.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    requestAccess,
    /**
     * Ask `server` where the `wallet` account stands: `member`, `pending`, `declined` or `none`.
     *
     * Every player is a member of an `open` server. Ask only a server that lists the
     * `access:members` marker (`enforcesAccess`); another refuses with `unknownRoute`.
     *
     * @returns The server's access level and the player's `status`. A refusal is returned as
     * `{ ok: false, error }`.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    fetchAccess,
    /**
     * Send a message to the account `to` through the mailbox on `server`.
     *
     * The server never reads `body`, so encode it in your game's own format. Send to the
     * recipient's mailbox host, as their profile names it. A Beacon server accepts 256 bytes of
     * UTF-8 by default (`BEACON_MAILBOX_MAX_BODY`), and answers `tooLarge` for a longer body. No
     * server accepts more than `MAX_MAILBOX_BODY` bytes. Measure a body with `mailboxBodyBytes`
     * from `@beaconsgg/protocol-types`.
     *
     * @param to - The recipient's account `did:key`.
     * @returns On success `id` is the message's id. A refusal is returned as `{ ok: false, error
     * }`.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    sendMail,
    /**
     * Fetch the messages waiting for the `wallet` account on `server` that have not expired.
     *
     * A message stays until the message expires or you delete it with {@link ackMail}.
     *
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    fetchMail,
    /**
     * Delete delivered messages from the `wallet` account's mailbox on `server`, by id.
     *
     * @param ids - The ids of the messages to delete, at most `MAX_MAILBOX_ACK_IDS` (256).
     * @returns On success `deleted` is the number of messages deleted.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    ackMail,
    /**
     * Sign the subscription for the live mailbox channel.
     *
     * Pass `() => client.buildMailboxSubscribe(wallet)` to `client.subscribeMailbox`, which signs a
     * new subscription on each connect. The envelope carries this client's game slug, so the socket
     * receives only this game's mail.
     */
    buildMailboxSubscribe,
    /**
     * Publish the player's signed profile to `server` with `POST /profiles`.
     *
     * Build and sign the profile with `buildProfile` from `@beaconsgg/identity`.
     *
     * @returns `{ ok: true }`, or `{ ok: false, error }` with the server's refusal code, such as
     * `stale` (409) when the server holds the same or a newer version.
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     * A fault is never returned as a failed publish.
     */
    publishProfile,
    /**
     * Fetch an account's profile from one server with `GET /profiles/:id`, without verifying it.
     *
     * Check the profile with `verifyProfile` from `@beaconsgg/identity` before you show its name or
     * picture. A server cannot forge a signed profile, but it can serve an old one or another
     * account's. {@link fetchBestProfile} asks several servers and verifies.
     *
     * @param did - The account's `did:key`.
     * @returns The profile, or `null` when the server has none, cannot be reached or sends a
     * malformed reply. The method is best-effort and never throws, even for a fault.
     */
    fetchProfile,
    /**
     * Fetch an account's profile from every server in `origins` and return the newest copy that
     * verifies.
     *
     * @param did - The account's `did:key`.
     * @returns The verified profile with the highest `version`, or `null` when no server holds a
     * copy that verifies. The method is best-effort and never throws, even for a fault.
     */
    fetchBestProfile,
    /**
     * Ask `server` whether it still accepts ops from the device in `wallet`, without changing
     * anything.
     *
     * Use this to find out whether the player revoked this device from another device, or the
     * server's operator blocked the account. Ask each server on the player's list, and catch per
     * server: a server that fails gives no verdict.
     *
     * @returns The verdict in `status`: `allowed`, `revoked`, `blocked` or `unknown`. On `unknown`,
     * `code` holds the server's refusal code (see {@link DeviceProbe}).
     * @throws {@link ApiError} with the code `writeLocked` from a locked server, and a fault
     * ({@link isFault}): {@link ServerError}, {@link RequestTimeoutError} or {@link NetworkError}.
     */
    probeDevice,
    /**
     * Open a socket to a room's live channel and call `onDelta` with each change to the room.
     *
     * Apply the changes in `version` order. When a `version` is skipped, read the room again with
     * `client.resolveRoom`. `onReconnect` runs after each reconnect, but not after the first
     * connect. Read the room again there too, since a change made while the socket was down may
     * have no later change to reveal the gap.
     *
     * @param origin - The origin of the server that holds the room.
     * @param roomId - The room's `unique@host` id.
     * @returns A handle for this subscription: `disconnect()` ends it, and `connected` is `true`
     * while its socket is connected. Only those two members are promised. A later release may share
     * one socket between the subscriptions to a server, and `disconnect()` then still ends only this
     * one.
     * @throws `Error` when the client was created without `connect`.
     */
    subscribeRoom: live.subscribeRoom,
    /**
     * Open a socket to a server's live map channel and call `onMap` with each change to the rooms
     * and scouts in the watched cells.
     *
     * Open one socket for each server that covers the view. `cellsToWatch` returns the cells to
     * watch, from `liveCellsForView` in `@beaconsgg/geo`. The socket sends the cells again after
     * each reconnect. After a pan or zoom, send the new cells with `pushCells`. When
     * `liveCellsForView` reports `capped`, return `[]` and poll discovery instead with
     * `pollDiscovery`.
     *
     * Apply each change with `applyMapDelta`. `onReconnect` runs after each reconnect, but not
     * after the first connect. Read discovery again there, since changes made while the socket was
     * down are not sent again.
     *
     * @returns The socket. Call `disconnect()` on it to stop.
     * @throws `Error` when the client was created without `connect`.
     */
    subscribeMap: live.subscribeMap,
    /**
     * Open a socket to the player's mailbox host and call `onMail` with each message as it arrives.
     *
     * Pass `() => client.buildMailboxSubscribe(wallet)` as `buildSubscribe`: the socket signs a new
     * subscription on each connect, so only the account owner receives the mail. Only mail sent
     * while the socket is connected arrives here. `onReconnect` runs after each reconnect, but not
     * after the first connect: call `client.fetchMail` there to catch up.
     *
     * @param host - The origin of the player's mailbox host, from `selectMailboxHost`.
     * @returns A handle for this subscription: `disconnect()` ends it, and `connected` is `true`
     * while its socket is connected. Only those two members are promised. A later release may share
     * one socket between the subscriptions to a server, and `disconnect()` then still ends only this
     * one.
     * @throws `Error` when the client was created without `connect`.
     */
    subscribeMailbox: live.subscribeMailbox,
  };
}

/**
 * The type of the client that {@link createClient} returns: the methods that sign ops, read servers
 * and open live channels.
 *
 * Every call except a best-effort one throws a fault and never returns it, so whatever such a call
 * returns is the server's own answer. The best-effort calls are `fetchProfile`, `fetchBestProfile`,
 * `pingServer` and `addServer`. A fault is a 5xx, a reply the server did not send (such as a proxy's
 * page), a timeout or a lost connection, and {@link isFault} is `true` for its error. A refusal is
 * the server's own `{ ok: false, error }`: a call returns it where its result has a place for it,
 * and throws it as an {@link ApiError} everywhere else ({@link isRefusal}). A locked server's
 * `writeLocked` answers no single request, so every call throws it.
 */
export type BeaconClient = ReturnType<typeof createClient>;

/**
 * The wait before retry `n` of `sendOpWithRetry` (1 for the second attempt): about `first` ms,
 * then three times longer for each retry after it, up to 10 times `first` (5 s by default). Each wait is jittered by up to a quarter
 * either way, so the clients a server fault hit together do not all retry at the same moment.
 */
function retryDelayMs(n: number, first: number): number {
  return Math.min(first * 3 ** (n - 1), first * 10) * (0.75 + Math.random() * 0.5);
}

/** The wait before the second attempt of `sendOpWithRetry` when the caller gives none. */
const RETRY_DELAY_MS = 500;

/** The `types` entry that asks discovery for scouts. */
const SCOUT_TYPE = "scout";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The `limit` `fetchMyProposals` sends when the caller gives none: 50, the server's own default. */
const PROPOSALS_PAGE = 50;

/** Asks for JSON back: sent by the `...OrThrow` calls, for a strict caller reading the reply. */
const JSON_ACCEPT = { accept: "application/json" };

/** A JSON POST of `body`, with any extra headers. */
function jsonPost(body: unknown, headers: Record<string, string> = {}): WireRequest {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
