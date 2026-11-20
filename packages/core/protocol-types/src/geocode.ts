import { z } from "zod";
import { readVariant } from "./read";
import { geohashCellSchema, isoTimestampSchema } from "./primitives";

// Geocode wire shapes (beacon.server `doc/spec/location-lookups.md` §4). The `geocode` capability
// reverse-geocodes a geohash to a coarse place label (neighborhood, city, state and country). The
// server proxies a geocoding service (Nominatim by default) through its own cache, so the reply is
// server-produced and there is no signed request. Every label field is optional because coverage
// varies: an ocean cell resolves to a country at best, and often to nothing.

/**
 * Validates a {@link GeocodeResult}: `source`, `attribution`, `cachedAt` and `geohash` are
 * required, every label field is optional, and unknown fields are refused.
 */
export const geocodeResultSchema = z
  .object({
    geohash: geohashCellSchema, // the normalized (coarsened) cell key this label is for
    /**
     * The named area inside the city: the neighborhood, suburb, quarter, city district or borough,
     * whichever the provider gives first. This field turns "Near Seattle, WA" into "Near Capitol
     * Hill, Seattle".
     *
     * The server cuts every request to `BEACON_GEOCODE_PRECISION` characters (default 7) and labels
     * that cell. The field is absent when the cell is shorter than 7 characters (cells of about 150
     * m), and when the provider has no neighborhood for the point. A coarser cell's center often
     * sits in a different neighborhood from the point that asked, so the server leaves the field
     * out. Ask with the finest geohash you have: on a server with the default setting, a
     * 9-character geohash gets a neighborhood and a 6-character one does not. `geohash` holds the
     * cell that was answered.
     */
    neighborhood: z.string().optional(),
    city: z.string().optional(), // city | town | village | municipality (first the provider gives)
    state: z.string().optional(), // state | region | province
    country: z.string().optional(), // country display name
    countryCode: z.string().optional(), // ISO-3166-1 alpha-2, upper-cased
    displayName: z.string().optional(), // the provider's full formatted label (convenience)
    source: z.string(), // provider id, e.g. "nominatim"
    attribution: z.string(), // data attribution, e.g. "© OpenStreetMap contributors (ODbL)"
    cachedAt: isoTimestampSchema, // ISO 8601 UTC: when this result was fetched or cached
  })
  .strict();
/**
 * A place label for a geohash cell, as `GET /geocode` answers it: neighborhood, city, state and
 * country, each present only where the provider has a value.
 *
 * `source` names the provider (such as `"nominatim"`) and `attribution` is the credit line you must
 * show with the label. `cachedAt` is when the server fetched the result, as an ISO 8601 UTC
 * timestamp.
 */
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;
/**
 * {@link GeocodeResult} as a client reads it: the checks of `geocodeResultSchema`, with unknown
 * fields dropped instead of refused.
 */
export const geocodeResultReadSchema = readVariant(geocodeResultSchema);
