/**
 * The REST transport under every client call: a timed `fetch`, the split of a reply into an answer,
 * a refusal or a fault, and the errors a caller can catch. `fetch` is injected (see
 * {@link WireFetch}), so nothing here names a platform.
 */
import { formatUnderstands, UNDERSTANDS_HEADER } from "@beaconsgg/protocol-types";

/**
 * The request the SDK hands to your `fetch`. These fields are a subset of `RequestInit`, so any
 * platform `fetch` accepts them.
 */
export interface WireRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * The parts of a response the SDK reads. These fields are a subset of `Response`, so the reply of
 * any platform `fetch` satisfies the type.
 *
 * `headers` and `text` let the SDK read the body of a reply outside 2xx under a size and time limit,
 * such as `writeLocked` from a locked server. A test double may leave them out. The SDK then reads
 * that body with `json()` and no limit.
 */
export interface WireResponse {
  readonly ok: boolean;
  readonly status: number;
  /** The reply's headers. The SDK reads `content-type`, `content-length` and `retry-after`. */
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  /** The reply's body as text. The SDK reads it only for a short JSON body outside the 2xx range. */
  text?(): Promise<string>;
}

/**
 * The `fetch` function the client calls for every REST request, passed as `ClientConfig.fetch`.
 *
 * The global `fetch` of React Native and of a browser both fit this type. So does a test double
 * that answers `{ok, status, json}`, with `headers` and `text` when it stands for a platform reply.
 */
export type WireFetch = (url: string, init: WireRequest) => Promise<WireResponse>;

/**
 * Remove trailing slashes from a server origin, so that appending a path such as `/rooms` gives one
 * slash.
 *
 * @returns `url` without any trailing `/`.
 */
export function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The server's code for a refusal: the `error` of an `{ok: false, error}` body, the shape every
 * Beacon refusal takes. Anything else, such as a proxy's page or a framework's
 * `{statusCode, error: "Not Found"}`, carries no code.
 */
export function refusalCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { ok, error } = body as { ok?: unknown; error?: unknown };
  return ok === false && typeof error === "string" ? error : undefined;
}

/**
 * The error thrown for a refusal: the server's own `{ ok: false, error }` answer to a request. A
 * {@link ServerError}, the subclass, is thrown for a fault instead. Tell the two apart with
 * {@link isRefusal} and {@link isFault}.
 *
 * Most game-facing calls return a refusal in their result (`ok: false`, or `null` for a room that
 * is gone) and throw an `ApiError` only where the result has no place for one: `discoverCells`,
 * `resolveRoom` and the location reads for a refusal other than "not there", the `...OrThrow`
 * methods, `verifyServer` and {@link parseOrThrow} for every refusal. A locked server's
 * `writeLocked` throws an `ApiError` from every call, with `retryAfterSec`.
 *
 * `code` is the `error` of the reply's `{ ok: false, error }` body, such as `gameNotAdmitted` or
 * `writeLocked`. Switch on `code`. `message` is the body's `message`, or `HTTP <status>` when the
 * body has none, and is prose for a person.
 *
 * The type of `code` is `string` rather than an `ErrorCode` from `@beaconsgg/protocol-types`,
 * because a capability or a newer server can send a code this build does not list.
 *
 * @example
 * ```ts
 * try {
 *   await client.postSignedOrThrow(server, path, wallet, intent);
 * } catch (err) {
 *   if (isRefusal(err) && err.code === "gameNotAdmitted") offerAnotherServer();
 *   else throw err;
 * }
 * ```
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** The reply's `Retry-After` in seconds, or `undefined` when the reply had none. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The error thrown for a server fault: a 5xx reply, or any reply outside 2xx that is not the Beacon
 * server's own `{ ok: false, error }` refusal, such as a reverse proxy's page.
 *
 * A reverse proxy in front of a server answers its own 404 page for a few seconds while the server
 * restarts. That reply throws a `ServerError` with `status` 404, because the room or route is not
 * known to be gone. Only the server's own `{ ok: false, error }` 404 means "not here".
 *
 * {@link isFault} is `true` for a `ServerError`, a {@link RequestTimeoutError} and a
 * {@link NetworkError}. Each is worth trying again later: `sendOpWithRetry` retries a fault with the
 * same nonce, and the server replays any result it already committed. `ServerError` extends
 * {@link ApiError} so that an `ApiError` catch still catches it, but {@link isRefusal} is `false`
 * for it.
 *
 * `code` is the `error` of the reply's body when the body has one, such as from a 5xx. The SDK reads
 * a 5xx or 404 body only when the body is JSON of at most 4 KiB that arrives within 2 seconds.
 * `message` is always `server error <status>`.
 *
 * @example
 * ```ts
 * try {
 *   await client.sendOpWithRetry(server, wallet, roomId, "take", params);
 * } catch (err) {
 *   if (isFault(err)) showOffline();
 *   else if (isRefusal(err) && err.code === "writeLocked") showLocked(err.retryAfterSec);
 *   else throw err;
 * }
 * ```
 */
export class ServerError extends ApiError {
  constructor(status: number, code?: string, retryAfterSec?: number) {
    super(status, `server error ${status}`, code, retryAfterSec);
    this.name = "ServerError";
  }
}

/**
 * The error thrown when a request fails before any reply arrives, such as on a lost connection or a
 * name that does not resolve. The platform's own error is the `cause`.
 *
 * A `NetworkError` is a fault ({@link isFault}). A request your own `signal` aborted throws the
 * platform's error unchanged.
 */
export class NetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`request to ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "NetworkError";
  }
}

/**
 * Return `true` when `err` is a refusal: an {@link ApiError} with the server's own `code`, and not
 * a {@link ServerError}.
 *
 * A refusal is the server's answer, such as `rateLimited`, `gameNotAdmitted` or `writeLocked`.
 * Show it, or act on its `code`. Retrying at once gets the same answer.
 */
export function isRefusal(err: unknown): err is ApiError & { code: string } {
  return err instanceof ApiError && !(err instanceof ServerError) && err.code !== undefined;
}

/**
 * Return `true` when `err` is a fault: a {@link ServerError}, a {@link RequestTimeoutError} or a
 * {@link NetworkError}.
 *
 * A fault means the server failed or could not be reached, so the request says nothing about the
 * room, the player or the route. Try again later or another server, and never delete anything on a
 * fault. Every error a request throws is either a fault or a refusal ({@link isRefusal}), except
 * the platform's own error when your `signal` aborts the request.
 */
export function isFault(err: unknown): err is ServerError | RequestTimeoutError | NetworkError {
  return (
    err instanceof ServerError || err instanceof RequestTimeoutError || err instanceof NetworkError
  );
}

/**
 * The largest error body the SDK reads: 4 KiB. A declared `Content-Length` is checked in bytes
 * before the read, and the text in characters after it.
 */
const ERROR_BODY_MAX = 4096;
/**
 * The largest body of any other 4xx the SDK reads: 64 KiB, room for a long validation message. Such
 * a body is still read only when it is JSON and within the time limit.
 */
const REFUSAL_BODY_MAX = 65_536;
/** How long the SDK waits for an error body once the headers have arrived, in milliseconds. */
const ERROR_BODY_TIMEOUT_MS = 2000;

/**
 * Each response's way to abort its request, kept by {@link timedFetch} so a body read that runs
 * out of time can release the connection. Keyed weakly, so a response read to the end is forgotten.
 */
const aborters = new WeakMap<object, () => void>();

/**
 * The parsed body of a reply outside 2xx, read under limits: only a JSON reply, at most
 * {@link ERROR_BODY_MAX} bytes, within {@link ERROR_BODY_TIMEOUT_MS}. The request's own timeout
 * ended when the headers arrived, so without these a stalled or huge error body would hang or bloat
 * the call that is about to throw. A body with no declared length is read whole within the time
 * limit before its length is checked. With no request timeout ({@link timedFetch} given `null`)
 * there is no request to abort, so a body that runs out of time is left unread rather than
 * released.
 *
 * @returns The body, or `undefined` when the reply is not read: not JSON, too long, too slow,
 * unparseable, or from a `fetch` whose response has no `headers` or `text`.
 */
async function readErrorBody(res: WireResponse, max: number): Promise<unknown> {
  const { headers } = res;
  if (headers === undefined || res.text === undefined) return undefined;
  const type = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const abort = aborters.get(res);
  if (!/^application\/([\w.-]+\+)?json$/.test(type)) {
    abort?.();
    return undefined;
  }
  if (Number(headers.get("content-length") ?? 0) > max) {
    abort?.();
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      abort?.();
      resolve(undefined);
    }, ERROR_BODY_TIMEOUT_MS);
  });
  try {
    const text = await Promise.race([res.text().catch(() => undefined), timeout]);
    if (text === undefined || text.length > max) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A reply's `Retry-After` in whole seconds, or `undefined` when the header is absent or a date. */
function retryAfterSec(res: WireResponse): number | undefined {
  const value = res.headers?.get("retry-after")?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** The code a locked server answers every write with, as a 503 with `Retry-After`. */
const WRITE_LOCKED = "writeLocked";

/**
 * The error for a reply outside 2xx, from its body already read, and the one place the SDK tells a
 * refusal from a fault. A refusal is the Beacon server's own `{ok: false, error}` body on a 4xx, or
 * a lock's `writeLocked` 503: an {@link ApiError} with the body's `message` and `code`. Anything
 * else is a fault, a {@link ServerError}: a 5xx, and any reply without that body, such as a
 * proxy's 404 page while the server restarts or a CDN's own 403.
 *
 * Every refusal a Beacon route makes carries `{ok, error}` (beacon.server `http-status.ts`), so a
 * 4xx without one came from something in front of the route: a proxy, a CDN, or the server's own
 * body parser (a 413) and unmatched-route handler (a 404), which send no Beacon body yet.
 */
function replyError(res: WireResponse, body: unknown): ApiError {
  const code = refusalCode(body);
  const retry = retryAfterSec(res);
  if (code === undefined || (res.status >= 500 && code !== WRITE_LOCKED))
    return new ServerError(res.status, code, retry);
  const { message } = body as { message?: unknown };
  const text = typeof message === "string" ? message : `HTTP ${res.status}`;
  return new ApiError(res.status, text, code, retry);
}

/** Read the body of a reply outside 2xx and make its error (see {@link replyError}). */
async function errorOf(res: WireResponse): Promise<ApiError> {
  return replyError(res, await refusalBody(res));
}

/**
 * The body of a reply outside 2xx. A 5xx or 404 body is read under the limits of
 * {@link readErrorBody}, since either may come from a proxy rather than the server. Any other body
 * is read with `json()`, as is a 5xx or 404 from a `fetch` whose response has no `headers` or
 * `text`. A body that is not JSON reads as `undefined`.
 */
function refusalBody(res: WireResponse): Promise<unknown> {
  if (res.headers === undefined || res.text === undefined) return res.json().catch(() => undefined);
  const proxyLike = res.status >= 500 || res.status === 404;
  return readErrorBody(res, proxyLike ? ERROR_BODY_MAX : REFUSAL_BODY_MAX);
}

/**
 * The JSON body of a 2xx reply. A body that does not parse or does not arrive, such as a captive
 * portal's page or a connection lost mid-body, is no answer from the server, so it throws a fault: a
 * {@link ServerError} with the reply's status.
 */
export async function okBody(res: WireResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ServerError(res.status);
  }
}

/**
 * Read a response's JSON body, and throw when the status is outside the 2xx range.
 *
 * Use this to read a route the client has no method for, in the same strict way as the `...OrThrow`
 * methods. A body that is not JSON reads as `undefined` and does not throw by itself. The body of a
 * 5xx or 404 is read only when it is JSON of at most 4 KiB that arrives within 2 seconds.
 *
 * @throws {@link ApiError} for the server's refusal, with its `message` and `code`, and
 * {@link ServerError} for a fault: a 5xx, or a reply outside 2xx without the server's `{ ok: false,
 * error }` body.
 */
export async function parseOrThrow<T>(res: WireResponse): Promise<T> {
  if (!res.ok) throw await errorOf(res);
  return (await res.json().catch(() => undefined)) as T;
}

/**
 * Make a `.catch` handler that turns a 404 {@link ApiError} into `fallback` and rethrows every
 * other error.
 *
 * Use the handler on a read where absence is an answer: a profile never published to this server,
 * or a route an older server does not have. A real failure still throws and never becomes the
 * fallback.
 *
 * A reverse proxy in front of a server answers a 404 page of its own while the server restarts.
 * That reply throws a {@link ServerError}, which is an `ApiError`, so it becomes the fallback too.
 * Don't use the handler where the fallback deletes something. Check {@link isRefusal} and the
 * refusal's `code`, such as `unknownRoom`, instead.
 *
 * @example
 * ```ts
 * const path = `/profiles/${encodeURIComponent(did)}`;
 * const profile = await client.getOrThrow<ProfileDoc>(server, path).catch(on404(null));
 * ```
 */
export function on404<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (err instanceof ApiError && err.status === 404) return fallback;
    throw err;
  };
}

/** One refusal from a 400 reply, attached to the field it is about. {@link fieldIssues} returns these. */
export interface FieldIssue {
  /** The top-level field the refusal is about: the first element of the zod issue path. */
  key: string;
  /**
   * The rest of the issue path joined with `.`, such as `2.name` for the `name` of a list's third
   * element. The string is empty when the refusal is about `key` itself.
   */
  path: string;
  /** The server's message for this field, in English. */
  message: string;
}

/**
 * Split a 400 {@link ApiError} into one message per field, to show each message beside its form
 * field.
 *
 * A body refused only for fields the server does not know answers a sentence and a `fields` list,
 * so this returns `undefined` for that refusal too.
 *
 * Every signed route refuses a bad body with `badRequest(zodError.message)`, and a `ZodError`'s
 * message is its issue array as JSON. That is why the same decode works for every route.
 *
 * @returns The field issues, or `undefined` when `err` is not a 400 `ApiError` with a list of zod
 * issues as its message. Show `err.message` in that case.
 */
export function fieldIssues(err: unknown): FieldIssue[] | undefined {
  if (!(err instanceof ApiError) || err.status !== 400) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.message);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const issues: FieldIssue[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const { path, message } = raw as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || path.length === 0 || typeof message !== "string") return undefined;
    issues.push({ key: String(path[0]), path: path.slice(1).join("."), message });
  }
  return issues;
}

/**
 * The game-facing decoder for a call whose result carries a refusal (`{ok, error}`): a 2xx body or
 * the server's refusal body is returned, and a fault throws a {@link ServerError}. A lock's
 * `writeLocked` throws its {@link ApiError}, from every call, since it answers no one request.
 */
export async function jsonOrThrow<T>(res: WireResponse): Promise<T> {
  if (res.ok) return (await okBody(res)) as T;
  const body = await refusalBody(res);
  const err = replyError(res, body);
  if (isRefusal(err) && err.code !== WRITE_LOCKED) return body as T;
  throw err;
}

/**
 * The decoder for a read whose result has no place for a refusal, such as discovery: a 2xx body is
 * returned, and anything else throws its {@link ApiError} or {@link ServerError}.
 */
export async function jsonOrRefuse<T>(res: WireResponse): Promise<T> {
  if (!res.ok) throw await errorOf(res);
  return (await okBody(res)) as T;
}

/**
 * For a reply outside 2xx to a read where "not there" is an answer: `null` when the reply is the
 * server's own 404 refusal with `code`, such as `unknownRoom`, and a throw otherwise. A caller may
 * delete something on `null`, so a proxy's 404 page throws a {@link ServerError}, and a 404 with
 * another code throws its refusal.
 */
export async function absentOrThrow(res: WireResponse, code: string): Promise<null> {
  const err = await errorOf(res);
  if (res.status === 404 && err.code === code && isRefusal(err)) return null;
  throw err;
}

/**
 * The decoder for a read where "not there" is an answer, such as `resolveRoom`: the 2xx body as
 * `read` takes it, or `null` for the server's own 404 refusal with `code` ({@link absentOrThrow}).
 * `read` returns `undefined` for a body of the wrong shape, which is no answer from the server and
 * so a fault, as a body that is not JSON is ({@link okBody}). `null` therefore means only that
 * refusal, never a reply the server did not mean.
 */
export async function answerOrAbsent<T>(
  res: WireResponse,
  code: string,
  read: (body: unknown) => T | undefined,
): Promise<T | null> {
  if (!res.ok) return absentOrThrow(res, code);
  const answer = read(await okBody(res));
  if (answer === undefined) throw new ServerError(res.status);
  return answer;
}

/**
 * The decoder for a call whose result carries a refusal and whose answer has a read schema: the 2xx
 * body as `read` takes it, or the server's refusal body ({@link jsonOrThrow}). `read` returns
 * `undefined` for a body of the wrong shape, which is no answer from the server and so a fault.
 */
export async function answerOrRefusal<T, R>(
  res: WireResponse,
  read: (body: unknown) => T | undefined,
): Promise<T | R> {
  if (!res.ok) return jsonOrThrow<R>(res);
  const answer = read(await okBody(res));
  if (answer === undefined) throw new ServerError(res.status);
  return answer;
}

/**
 * The default timeout of each REST request, in milliseconds: 15000 (15 seconds).
 *
 * Set `ClientConfig.timeoutMs` to change it for a client. A request that runs out of time throws a
 * {@link RequestTimeoutError}.
 *
 * React Native's `fetch` has no timeout of its own, so without this a stalled mobile connection
 * would hang a call forever, and `sendOpWithRetry` could never retry it.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The error thrown when a request gets no response headers within its timeout
 * ({@link REQUEST_TIMEOUT_MS} by default).
 *
 * The server may or may not have applied the op. `sendOpWithRetry` retries it with the same nonce,
 * and the server replays any result it already committed instead of applying the op twice
 * (beacon.server `doc/spec/room-operation.md` §6.2).
 */
export class RequestTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "RequestTimeoutError";
  }
}

/** What {@link timedFetch} is built from. */
export interface TransportConfig {
  fetch: WireFetch;
  /** The default timeout, or `null` for none; a call may pass its own. */
  timeoutMs: number | null;
  /**
   * The codes this build reads, declared on every write. Absent sends no header at all, which
   * is not the same as an empty declaration: see `ClientConfig.understands`.
   */
  understands: readonly string[] | undefined;
}

/**
 * `fetch` with an `AbortController` timeout so a hung connection **rejects** instead of hanging
 * forever. A timeout is normalized to a typed {@link RequestTimeoutError}, and any other failure to
 * get a reply to a {@link NetworkError}, so {@link isFault} covers both. Every REST call in the SDK
 * goes through this, reads included.
 *
 * **Scope:** the timer is cleared once `fetch` resolves (response headers received), so it bounds
 * the connect + response-header phase, the dominant mobile-stall case (a connection that never
 * completes). A body that stalls *after* headers arrive is read by the caller (`res.json()`) and is
 * **not** bounded here, except an error body, which {@link readErrorBody} bounds with the abort this
 * keeps for each response.
 *
 * A caller-supplied `init.signal` is **linked** to the internal controller (not silently dropped),
 * so external cancellation still works. Only our own timeout maps to {@link RequestTimeoutError};
 * an external abort rethrows as-is, and is neither a fault nor a refusal.
 */
export function timedFetch(
  config: TransportConfig,
): (url: string, init?: WireRequest, timeoutMs?: number | null) => Promise<WireResponse> {
  const declared =
    config.understands === undefined ? undefined : formatUnderstands(config.understands);
  // Called as a plain function, never as `config.fetch(...)`: a browser's native `fetch` throws
  // "Illegal invocation" when its `this` is anything but the global object.
  const send = config.fetch;
  return async (url, init = {}, timeoutMs = config.timeoutMs) => {
    // A write declares the codes this build reads, so a server sends a newer code only to a
    // client with a sentence for it. Writes only: in a browser a custom header on a GET would cost a
    // CORS preflight. A GET read's 404 therefore always comes back as `unknownRoute`, which the
    // reads treat as absent, even where a server could name the missing place or file.
    const write = init.method !== undefined && init.method.toUpperCase() !== "GET";
    // A declaration the caller set itself wins, for a request that has to read one code whatever
    // this build declares (`probeDevice`).
    const sent: WireRequest =
      write && declared !== undefined
        ? { ...init, headers: { [UNDERSTANDS_HEADER]: declared, ...init.headers } }
        : init;
    // No timeout: the request as given, for a caller that bounds its own waiting (an operator at a
    // desk can see a spinner and reload; `Infinity` is no substitute, `setTimeout` clamps it to 1 ms).
    // A failure with no reply is a fault, unless the caller's own signal aborted the request.
    const failed = (err: unknown): never => {
      throw init.signal?.aborted === true ? err : new NetworkError(url, err);
    };
    if (timeoutMs === null) {
      try {
        return await send(url, sent);
      } catch (err) {
        return failed(err);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Link any caller-supplied signal (none today) so external cancellation isn't lost.
    const external = init.signal;
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const res = await send(url, { ...sent, signal: controller.signal });
      if (!res.ok) aborters.set(res, () => controller.abort());
      return res;
    } catch (err) {
      // Distinguish OUR timeout from a caller-driven abort: only the former is a RequestTimeoutError.
      if (controller.signal.aborted && external?.aborted !== true)
        throw new RequestTimeoutError(url, timeoutMs);
      return failed(err);
    } finally {
      clearTimeout(timer);
    }
  };
}
