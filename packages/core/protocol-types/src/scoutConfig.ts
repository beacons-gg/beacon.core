import { z } from "zod";
import { canonicalJson } from "./jcs";

/**
 * Scout **type config**: the game-defined object a scout is minted with. The config is baked at
 * mint, becomes part of the scout's immutable identity (`signScoutProvenance` over
 * `{unique, config}`), and rides in every report and summary.
 *
 * **Opaque to the platform.** The server carries it, checks the signature over it and relays it,
 * and never reads a field of it: movement is relayed as reported and never checked against caps
 * (radical trust, `doc/spec/identity.md` §3). What a config holds is the game's business. Each game
 * parses its own client-side, in its own package, and skips a scout whose config it does not
 * recognize.
 */

/**
 * The largest scout config a `report` accepts: 2048 bytes, counted as {@link scoutConfigFits}
 * counts them.
 *
 * A config of a type id and a handful of caps is about 120 bytes. The limit leaves a game room for
 * a type id, a label and a few dozen caps.
 */
export const MAX_SCOUT_CONFIG_BYTES = 2048;

/**
 * The fastest speed a scout may report: 16100 kilometers per hour, the bound on a movement's
 * `speedKmh`.
 *
 * The value sits slightly above 10,000 mph (16,093 km/h), the ceiling while speeds were in miles
 * per hour, so no speed that was in range becomes out of range by converting it.
 */
export const MAX_SCOUT_SPEED_KMH = 16_100;

/**
 * Validates a {@link ScoutConfig}: any JSON object. Reads accept any size, and a `report` also
 * checks {@link scoutConfigFits}.
 */
export const scoutConfigSchema = z.record(z.string(), z.unknown());
/**
 * Your game's config for a scout: any JSON object, signed into the scout's identity when the scout
 * is minted.
 *
 * The platform never reads a config. Parse it in your game, and skip a scout whose config your game
 * does not recognize. A reported config must fit in {@link MAX_SCOUT_CONFIG_BYTES}.
 */
export type ScoutConfig = z.infer<typeof scoutConfigSchema>;

/**
 * Return `true` when a scout config fits in {@link MAX_SCOUT_CONFIG_BYTES}, counted as the UTF-8
 * bytes of its canonical JSON.
 *
 * Canonical JSON is the form the signature covers. Returns `false` for a value canonical JSON
 * cannot express, such as `Infinity`.
 *
 * A server holds every relayed scout in memory, so a `report` is the one place the limit is
 * enforced, and a reader takes what a server sends. A `1e400` parses to `Infinity`, which is
 * refused instead of failing the request. The native length is checked first: that length equals
 * the canonical form's length in UTF-16 units, which is never more than its UTF-8 bytes, so an
 * oversized body is refused without canonicalizing it.
 */
export function scoutConfigFits(config: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(config);
  } catch {
    return false;
  }
  if (json === undefined || json.length > MAX_SCOUT_CONFIG_BYTES) return false;
  try {
    return new TextEncoder().encode(canonicalJson(config)).length <= MAX_SCOUT_CONFIG_BYTES;
  } catch {
    return false;
  }
}
