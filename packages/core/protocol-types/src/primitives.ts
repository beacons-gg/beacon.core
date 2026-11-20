import { z } from "zod";

/** Validates an {@link IsoTimestamp}: an ISO 8601 date and time with `Z` or a numeric offset. */
export const isoTimestampSchema = z.string().datetime({ offset: true });
/**
 * An ISO 8601 timestamp string with `Z` or a numeric offset, such as `"2026-06-26T00:00:00Z"`.
 * A timestamp without a zone is refused.
 */
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

/**
 * The pattern a {@link DidKey} matches: `did:key:z` followed by 6 to 64 base58btc characters.
 *
 * Use it to check a value without zod. An Ed25519 `did:key` has 46 to 47 characters after the `z`.
 *
 * The length bound refuses a multi-megabyte input before anything tries to decode it.
 */
export const DID_KEY_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{6,64}$/;
/** Validates a {@link DidKey} against {@link DID_KEY_RE}. */
export const didKeySchema = z
  .string()
  .regex(DID_KEY_RE, "expected a did:key (multibase base58btc)");
/**
 * A `did:key` identifier: an Ed25519 public key written as a self-certifying id.
 *
 * Accounts, devices and servers are all named by one. The key is multibase base58btc, so the part
 * after `did:key:` starts with `z`.
 *
 * Spec: `doc/spec/identity.md` §2.1.
 */
export type DidKey = z.infer<typeof didKeySchema>;

/** The pattern a {@link Ulid} matches: 26 characters of Crockford base32, in either case. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
/** Validates a {@link Ulid} against {@link ULID_RE}. */
export const ulidSchema = z.string().regex(ULID_RE, "expected a ULID");
/**
 * A ULID: a 26-character, time-ordered id in Crockford base32, which leaves out I, L, O and U.
 *
 * Op nonces and backup run ids are ULIDs.
 */
export type Ulid = z.infer<typeof ulidSchema>;

/**
 * Validates a {@link LatLng}: both coordinates in range, and no other keys.
 *
 * Strict, like every shape a server accepts: a key this build does not know is refused by name
 * rather than dropped. Server output that carries one is read through a `*ReadSchema` twin, which
 * drops it instead.
 */
export const latLngSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();
/** A geographic point in decimal degrees: `lat` from -90 to 90 and `lng` from -180 to 180. */
export type LatLng = z.infer<typeof latLngSchema>;

/**
 * The pattern a geohash cell matches: 1 to 12 lowercase characters of the geohash alphabet.
 *
 * The alphabet is the digits and the lowercase letters without `a`, `i`, `l` and `o`. Use it to
 * check a value without zod.
 *
 * The regex is exported beside the schema the way `DID_KEY_RE` and `ULID_RE` above are, for the
 * same reason: a caller that needs the matcher without zod. `@beaconsgg/geo`'s `isGeohash` is that
 * caller, because asking whether a string is a geohash is a geometry question and should not
 * require parsing a payload to answer. Anything anywhere that wants a second opinion on the
 * alphabet or the length takes it from here, so there is nothing for a second spelling to drift
 * from.
 */
export const GEOHASH_RE = /^[0-9b-hjkmnp-z]{1,12}$/;

/** Validates a {@link GeohashCell} against {@link GEOHASH_RE}. */
export const geohashCellSchema = z.string().regex(GEOHASH_RE);
/**
 * A geohash cell: 1 to 12 lowercase characters, where a longer hash names a smaller cell.
 *
 * The `cells` query parameter of discovery and places reads takes a list of these, and the live map
 * channel keys its rooms by them (`cell:<hash>`).
 */
export type GeohashCell = z.infer<typeof geohashCellSchema>;

/**
 * Validates a {@link Signature}: any non-empty string.
 *
 * The schema checks only the shape. `@beaconsgg/identity` verifies the signature itself.
 */
export const signatureSchema = z.string().min(1);
/** An Ed25519 signature as the wire carries it: a base64url string without padding. */
export type Signature = z.infer<typeof signatureSchema>;

/**
 * The longest display name the wire accepts: 64 UTF-16 code units, as JavaScript's
 * `String.prototype.length` counts them.
 *
 * Your game's UI can cap names much shorter. This is the hard limit a server enforces.
 *
 * A display name is mutable and unsigned, but it rides on signed, relayed envelopes (a placed room,
 * a scout report), so it gets a length bound like every other relayed string: a relay or peer can't
 * inflate an unsigned field into an amplification payload (`doc/spec/identity.md` §3; the bounded
 * `movement.speedKmh` and `didKey` neighbors follow the same rule).
 */
export const MAX_DISPLAY_NAME_LEN = 64;
/** Validates a {@link DisplayName}: at most {@link MAX_DISPLAY_NAME_LEN} UTF-16 code units. */
export const displayNameSchema = z.string().max(MAX_DISPLAY_NAME_LEN);
/**
 * A name a player gives something, such as a custom item name: a string of at most
 * {@link MAX_DISPLAY_NAME_LEN} UTF-16 code units.
 */
export type DisplayName = z.infer<typeof displayNameSchema>;

/** The longest game slug the wire accepts: 64 characters. */
export const MAX_GAME_SLUG_LEN = 64;
const GAME_SLUG_RE = /^[a-z0-9][a-z0-9._/-]*$/;
/**
 * Validates a {@link GameSlug}: 1 to 64 characters that start with a lowercase letter or a digit.
 *
 * After the first character a slug may also hold `.`, `_`, `/` and `-`. A slug never contains a
 * comma, a colon, whitespace or an uppercase letter.
 *
 * The charset leaves out `,` because operator lists are comma-separated, and `:` because a server
 * advertises its admitted slugs as `game:<slug>` capability markers. Whitespace is out too, so a
 * slug survives every carrier it passes through.
 */
export const gameSlugSchema = z
  .string()
  .min(1)
  .max(MAX_GAME_SLUG_LEN)
  .regex(GAME_SLUG_RE, "expected a lowercase game slug");
/**
 * A game's slug, such as `my-game`: the label a client attaches to every op it signs so a server
 * can tell games apart.
 *
 * Set your game's slug once with `createClient({ game })` in `@beaconsgg/client-sdk`. An operator
 * lists the slugs their server admits, and the server refuses a game write that names any other
 * slug, or no slug. A slug may
 * name a game, a publisher or a build (`/` is allowed, so `my-game/1` works): what an operator
 * lists decides which.
 *
 * The slug is self-attested. The envelope's signature proves only that the value was not changed in
 * flight, because the signer is the player's own device key and a modified build holds one too. Use
 * a slug to keep games apart and never as a defense against cheating.
 *
 * Opaque on purpose: no enum, and nothing in the core packages names a game, so the platform tier
 * never becomes game-aware. Spec: `doc/spec/discovery.md` §3.2.
 */
export type GameSlug = z.infer<typeof gameSlugSchema>;

/**
 * Validates {@link Levels}: string keys mapped to safe integers.
 *
 * Integers only, bounded by `Number.MAX_SAFE_INTEGER` either way (`.safe()`), and no division
 * (`doc/spec/item-properties.md` §4.4). The magnitude bound keeps values trivial to canonicalize
 * and exact across JavaScript, Go and C# arithmetic with `+`, `-` and `*`.
 */
export const levelsSchema = z.record(z.string(), z.number().int().safe());
/**
 * A numeric property map, such as an item's stats: each key maps to a whole number between
 * `Number.MIN_SAFE_INTEGER` and `Number.MAX_SAFE_INTEGER`.
 */
export type Levels = z.infer<typeof levelsSchema>;

/** Validates {@link Tags}: string keys mapped to lists of strings. */
export const tagsSchema = z.record(z.string(), z.array(z.string()));
/**
 * A categorical property map: each key maps to a list of string values.
 *
 * Spec: `doc/spec/item-properties.md` §2.
 */
export type Tags = z.infer<typeof tagsSchema>;

/**
 * The pattern a {@link GlobalId} matches: `unique@host` with a single `@`.
 *
 * `unique` holds letters, digits, `_` and `-`. `host` holds letters, digits, `.`, `:` and `-`.
 */
export const GLOBAL_ID_RE = /^[A-Za-z0-9_-]+@[A-Za-z0-9.:-]+$/;
/** Validates a {@link GlobalId} against {@link GLOBAL_ID_RE}. */
export const globalIdSchema = z.string().regex(GLOBAL_ID_RE, "expected `unique@host`");
/**
 * The shareable address of a room or another object on a server, written `unique@host`.
 *
 * `unique` is permanent: two ids with the same `unique` name the same object. `host` is the
 * `host[:port]` of the server serving the object. Find the server to call with
 * {@link serverForHost}.
 *
 * Spec: `doc/spec/discovery.md` §2.
 */
export type GlobalId = z.infer<typeof globalIdSchema>;

/** A {@link GlobalId} split into its two parts by {@link parseGlobalId}. */
export interface ParsedGlobalId {
  /** The permanent part before the `@`. */
  unique: string;
  /** The `host[:port]` after the `@`. */
  host: string;
}

/**
 * Split a `unique@host` id into its `unique` and `host` parts.
 *
 * Only the `@` is checked. Use {@link globalIdSchema} to check the characters as well.
 *
 * @throws Error when `id` has no `@`, more than one, or nothing on either side of it.
 */
export function parseGlobalId(id: string): ParsedGlobalId {
  const at = id.indexOf("@");
  if (at <= 0 || at !== id.lastIndexOf("@") || at === id.length - 1) {
    throw new Error(`Invalid GlobalId: ${JSON.stringify(id)}`);
  }
  return { unique: id.slice(0, at), host: id.slice(at + 1) };
}

/** Join a `unique` and a `host` into a `unique@host` id. Neither part is checked. */
export function formatGlobalId(parts: ParsedGlobalId): GlobalId {
  return `${parts.unique}@${parts.host}`;
}

/** The `host[:port]` authority of a URL string, or `undefined` if it doesn't look like one. */
function authorityOf(url: string): string | undefined {
  // scheme://authority[/path|?query|#frag]: the authority is host[:port] (no userinfo for our
  // server URLs). Parsed by regex rather than `new URL` so this stays RN-pure (no global needed).
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/.exec(url)?.[1];
}

/**
 * Find the server URL in `servers` whose `host[:port]` is exactly `host`, or `undefined` when none
 * is.
 *
 * `host` is the part of a {@link GlobalId} after the `@`. Use this function to tell an id served by
 * one of your servers from an id served elsewhere. {@link serverForHost} adds a fallback for the
 * second case.
 *
 * Matches on the exact authority (not a substring) so `a.com` can't be routed to a `xa.com.evil`
 * entry. This is the whole of that rule, so a caller that needs to tell "one of ours" from
 * "somewhere else" asks here rather than re-deriving the match.
 */
export function knownServerForHost(host: string, servers: readonly string[]): string | undefined {
  return servers.find((s) => authorityOf(s) === host);
}

/**
 * Pick the server URL to call for the `host` of a {@link GlobalId}: the matching entry of
 * `servers`, or the origin {@link originForHost} gives `host` when none matches.
 *
 * The match is the exact one {@link knownServerForHost} makes. The fallback follows the one scheme
 * rule: `https` for a public host, and `http` for `localhost`, a `.local` name or a private
 * address. Add a server to `servers` to call it with another scheme.
 */
export function serverForHost(host: string, servers: readonly string[]): string {
  // The scheme comes from the rule, never from `host`: an id's host that carries a scheme of its own
  // (`h@http://…`) must not pick the URL a client fetches.
  return knownServerForHost(host, servers) ?? `${schemeForHost(host)}://${host}`;
}

/**
 * Turn a scheme-less `host[:port]` into an origin to fetch: `https` for a public host, and `http`
 * for a local one.
 *
 * A local host is `localhost`, a `.local` name, or an IPv4 address in `127.0.0.0/8`, `10.0.0.0/8`,
 * `172.16.0.0/12` or `192.168.0.0/16`. A value that already has a scheme keeps it. Trailing
 * slashes are removed either way. Mailbox endpoints and media `<hash>@host` addresses are
 * scheme-less, so read them through this function.
 *
 * This is the platform's one scheme-on-read rule. The client (mailbox origins) and the server
 * (cross-server media transfer) both resolve through it, so they never disagree about an address.
 * Local hosts get `http` so two-device and two-server testing on a LAN works.
 */
export function originForHost(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed; // already a full URL: honor it
  return `${schemeForHost(trimmed)}://${trimmed}`;
}

/** `http` for a local or private `host[:port]` (see {@link originForHost}), `https` otherwise. */
function schemeForHost(authority: string): "http" | "https" {
  const host = authority.split(":")[0] ?? authority;
  const isLocal =
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return isLocal ? "http" : "https";
}

/** Whether `value` is an http(s) URL; what `new URL` cannot read is not one. */
function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Build a schema for an `http` or `https` URL of at most `max` characters.
 *
 * Use it for any URL a player may open or a server redirects to, such as a place's links or a
 * server's `mediaCdnUrl`, `publicUrl` and `geocodeEndpoint`. `z.string().url()` alone accepts
 * anything `new URL()` parses, `javascript:` and `data:` URLs included.
 *
 * @param max - The longest URL accepted, in characters. Pass `null` for no cap, as for a URL a
 * server resolved, such as a presigned one.
 */
export const httpUrlSchema = (max: number | null) =>
  (max === null ? z.string().url() : z.string().url().max(max)).refine(isHttpUrl, {
    message: "must be an http(s) URL",
  });
