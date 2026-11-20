import { CODE_FALLBACKS, NOT_FOUND_FALLBACKS, type ErrorCode } from "./result";

/**
 * Capability markers: how the protocol grows while its two sides release separately.
 *
 * **Markers name additions, never the baseline.** Everything the protocol had when this convention
 * started is implied by every peer, so a server that advertises nothing and a client that declares
 * nothing still understand each other completely. A marker only ever widens that.
 *
 * **Two directions, one per sender:**
 * - A **server** advertises what it ACCEPTS, in its signed descriptor's `capabilities` (the one
 *   descriptor field a new entry cannot break). `op:<name>` for a new op, `policy:<feature>` for a
 *   new policy field or value, `rule:<name>` for a new rule operator, all derived from what the
 *   build runs (`markers.ts`). `access:members` says the server enforces its `accessLevel`
 *   (`access.ts`). A client checks before it sends.
 * - A **client** declares what it READS, in the {@link UNDERSTANDS_HEADER} request header, or a
 *   socket's handshake `auth.understands`. `code:<name>` for a new error code; `result:<field>` is
 *   reserved for a new op-result field. The server sends an addition only to a client that
 *   declared it, and otherwise what that client already handles ({@link codeFor}).
 *
 * The declaration is unsigned, which is fine: it only shapes responses to the caller, so a false
 * one only misleads the client that sent it.
 *
 * There is no `live:` namespace, because the live channel needs none: a room change a client does
 * not know is a gap, and the client re-reads the room over REST.
 */

/**
 * The request header in which a client declares the markers it reads: `beacon-understands`.
 *
 * A marker names a newer addition the client can read, such as `code:clockSkew`.
 * The client sets the header from the `understands` option of `createClient`. The name is lower
 * case, as Node reports it.
 */
export const UNDERSTANDS_HEADER = "beacon-understands";

/** Join markers into the value of the {@link UNDERSTANDS_HEADER} header, separated by commas. */
export function formatUnderstands(markers: readonly string[]): string {
  return markers.join(",");
}

// Untrusted input on every request: bounded before it is split, and each entry shaped like a marker.
const MAX_HEADER_LENGTH = 2048;
const MAX_MARKERS = 64;
const MARKER_RE = /^[a-z]+:[A-Za-z0-9._-]{1,64}$/;

/**
 * Read the markers a caller declared, from a header value or a socket's handshake
 * `auth.understands`.
 *
 * Each entry must look like `<namespace>:<name>`, and other entries are skipped. A value over 2048
 * characters reads as no markers, and so does a value that is neither a string nor an array. Only
 * the first 64 markers are kept.
 *
 * Reading malformed input as no markers is always safe: the caller then gets the baseline it is
 * guaranteed to know.
 */
export function parseUnderstands(raw: unknown): ReadonlySet<string> {
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (typeof value !== "string" || value.length > MAX_HEADER_LENGTH) return new Set();
  const markers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => MARKER_RE.test(entry));
  return new Set(markers.slice(0, MAX_MARKERS));
}

/** Every fallback that applies at 404: the ordinary ones, and the codes that name a missing thing. */
const AT_404: Readonly<Record<string, ErrorCode>> = { ...CODE_FALLBACKS, ...NOT_FOUND_FALLBACKS };

/** The options of {@link codeFor}. */
export interface CodeForOptions {
  /**
   * The HTTP status the refusal goes out with. At 404 a code that names a missing thing falls back
   * to `unknownRoute` (`NOT_FOUND_FALLBACKS`). Without a status those codes pass through unchanged.
   */
  status?: number | undefined;
}

/**
 * Pick the error code to send a caller: `code` itself when the caller can read it, and otherwise
 * the older code from `CODE_FALLBACKS`, or at 404 from `NOT_FOUND_FALLBACKS`.
 *
 * A caller can read a baseline code and any code it declared as `code:<name>`. A code this version
 * does not list passes through unchanged.
 *
 * @param options - `status`, the refusal's HTTP status. Pass it for every refusal, so a 404 that
 * names a missing thing reaches an older client as `unknownRoute`.
 */
export function codeFor(
  code: string,
  understands: ReadonlySet<string>,
  options: CodeForOptions = {},
): string {
  const fallbacks: Record<string, ErrorCode> = options.status === 404 ? AT_404 : CODE_FALLBACKS;
  // An own key only: a plain lookup would read `toString` and friends off the prototype.
  if (!Object.hasOwn(fallbacks, code) || understands.has(`code:${code}`)) return code;
  return fallbacks[code] as ErrorCode;
}
