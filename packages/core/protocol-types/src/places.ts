import { z } from "zod";
import { absentOnRead, readVariant, rowsDroppedOnRead } from "./read";
import {
  didKeySchema,
  geohashCellSchema,
  isoTimestampSchema,
  latLngSchema,
  ulidSchema,
  httpUrlSchema,
} from "./primitives";
import { mediaCreditSchema, mediaSchema } from "./mediaEntry";

// Places wire shapes (the server's places spec, beacon.server `doc/spec/places.md`). The `places`
// capability serves a server's own curated place dataset. Three inputs populate the dataset: an
// Atlas volume import, approved player contributions, and the operator's own edits and lists
// (beacon.server `apps/atlas/doc/spec/beacon-integration.md` §6). The server merges them per field
// and always answers from its own store, with no proxied or third-party call. Reads are public and
// unsigned (`GET /places?cells=&categories=` and `GET /places/:unique`). The operator ops are signed
// `OpEnvelope`s (`places.atlas.import`, `places.snapshots.fetch` and the rest below).
//
// An image on a place is a content-addressed media entry the server ingested (a thumb and a full
// WebP, with its license `credit`), fetchable from the public media route.

/**
 * Validates a {@link PlaceCategory}: one of the 14 category names.
 *
 * Games code against these categories, never against a source's raw tags, which stay on the
 * server's source record. Adding a category is wire-compatible: a list read drops a place whose
 * category this version does not know (beacon.server `doc/spec/places.md` §1).
 */
export const placeCategorySchema = z.enum([
  "park",
  "nature",
  "landmark",
  "history",
  "culture",
  "entertainment",
  "music",
  "community",
  "wildlife",
  "sports",
  "sweets",
  "shopping",
  "transport",
  "surveillance",
]);
/**
 * A place's category, such as `"park"`, `"landmark"` or `"wildlife"`: the vocabulary you filter
 * `GET /places` by.
 *
 * A newer server may add categories. Show an unknown category by its name or skip it.
 */
export type PlaceCategory = z.infer<typeof placeCategorySchema>;

/**
 * Validates a {@link PlaceSubcategory}: a lowercase snake_case slug of 1 to 32 characters that
 * starts with a letter.
 *
 * The vocabulary is a bounded slug rather than a second enum. The curated list lives in the
 * server's taxonomy as the one source of truth, and growing it is a tag-map edit and a re-snapshot
 * with no wire change. When a game needs to query by subcategory, this becomes an enum with a
 * `subcategories=` filter.
 */
export const placeSubcategorySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "a short snake_case subcategory slug");
/**
 * The optional finer grouping under a place's category, such as `water` or `mountain` under
 * `nature`.
 *
 * A subcategory means something only together with its category: `water` exists under both `nature`
 * and `transport`. Read the server's list with `GET /places/taxonomy`. Show a slug you don't know
 * by its name or ignore it.
 */
export type PlaceSubcategory = z.infer<typeof placeSubcategorySchema>;

/**
 * Validates a {@link GeoPosition}: exactly two numbers, a longitude from -180 to 180 and then a
 * latitude from -90 to 90.
 *
 * The bounds come from {@link latLngSchema} (beacon.server `doc/spec/places.md` §4).
 */
export const geoPositionSchema = z.tuple([latLngSchema.shape.lng, latLngSchema.shape.lat]);
/**
 * A GeoJSON position, `[lng, lat]`: longitude first, the reverse of the `{ lat, lng }` objects the
 * rest of the wire uses.
 *
 * A position has no altitude. A ring that crosses the antimeridian wraps at 180 degrees, such as
 * `179.5` followed by `-179.5`, and never uses a longitude above 180.
 */
export type GeoPosition = z.infer<typeof geoPositionSchema>;

// Size caps on geometry from operator imports and connectors, which are still untrusted input. They
// bound the accepted shape. The server's request body limit bounds the parse itself.

/** The most positions one ring of a place's polygon may hold: 4096. */
export const MAX_RING_POSITIONS = 4096;
/** The most rings one polygon of a place may hold: 16, the outline and up to 15 holes. */
export const MAX_POLYGON_RINGS = 16;
/** The most polygons one `MultiPolygon` place geometry may hold: 64. */
export const MAX_MULTIPOLYGON_POLYGONS = 64;

/** A GeoJSON linear ring: at least 4 positions, explicitly closed (first equals last), size-capped. */
const linearRingSchema = z
  .array(geoPositionSchema)
  .min(4)
  .max(MAX_RING_POSITIONS)
  .refine((ring) => {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return (
      first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
    );
  }, "ring must be closed (first position must equal the last)");

/** One polygon's rings: ring 0 = exterior, the rest holes (shared by both geometry variants). */
const polygonRingsSchema = z.array(linearRingSchema).min(1).max(MAX_POLYGON_RINGS);

/**
 * Validates a {@link PlaceGeometry}: each ring is closed and holds 4 to {@link MAX_RING_POSITIONS}
 * positions, each polygon holds 1 to {@link MAX_POLYGON_RINGS} rings, and a `MultiPolygon` holds 1
 * to {@link MAX_MULTIPOLYGON_POLYGONS} polygons.
 */
export const placeGeometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: polygonRingsSchema }).strict(),
  z
    .object({
      type: z.literal("MultiPolygon"),
      coordinates: z.array(polygonRingsSchema).min(1).max(MAX_MULTIPOLYGON_POLYGONS),
    })
    .strict(),
]);
/**
 * A place's area as a GeoJSON geometry: a `Polygon` or a `MultiPolygon`, never a Feature.
 *
 * In each polygon the first ring is the outline and any further rings are holes. Only places with a
 * meaningful area, such as a park or a plaza, carry one. Every place has a representative `point`
 * either way. To test whether a player stands inside, use `containsPoint` from `@beaconsgg/geo`,
 * the same function the server runs (beacon.server `doc/spec/places.md` §9).
 */
export type PlaceGeometry = z.infer<typeof placeGeometrySchema>;

// ── the read wire (public, unsigned; beacon.server `doc/spec/places.md` §5) ──────────────────────

/** Validates a {@link PlaceSummary}, refusing unknown fields. */
export const placeSummarySchema = z
  .object({
    unique: ulidSchema,
    category: placeCategorySchema,
    subcategory: placeSubcategorySchema.optional(),
    name: z.string().optional(),
    point: latLngSchema, // representative point (markers, distance sort)
    hasGeometry: z.boolean(),
    hasDescription: z.boolean(), // detail-only text, projected to a flag (like hasGeometry) for the list
    media: z.array(mediaSchema).optional(), // ingested thumb+full WebP, with per-image credit
    updatedAt: isoTimestampSchema,
  })
  .strict();
/**
 * One place in a `GET /places` reply: its id, category, name, representative point and photos.
 *
 * A summary leaves out the polygon and the description, which can each run to tens of KB.
 * `hasGeometry` and `hasDescription` say whether `GET /places/:unique` has them, so you can rank
 * places by how much they carry without fetching each one. `unique` is the place's permanent id,
 * addressable as `unique@host`, and an export and import keep it. `updatedAt` is an ISO 8601 UTC
 * timestamp.
 */
export type PlaceSummary = z.infer<typeof placeSummarySchema>;

/**
 * The longest place description, in characters: 500. Every producer truncates to this number, so
 * this constant is the one place it is defined.
 */
export const MAX_PLACE_DESCRIPTION_LEN = 500;

/**
 * Validates a place description: 1 to {@link MAX_PLACE_DESCRIPTION_LEN} characters of free text.
 *
 * The text comes from a source's `description` tag or is written by the dataset builder, such as
 * the details of an automatic license plate reader.
 */
export const placeDescriptionSchema = z.string().min(1).max(MAX_PLACE_DESCRIPTION_LEN);

/**
 * Validates the credit for a place's description: the same shape as a photo's credit
 * (`MediaCredit`), with the license, the author and two links.
 *
 * A description carries a credit when its source has terms to show, such as a Wikipedia summary
 * under CC BY-SA 4.0. Show the credit wherever you show the description. Most descriptions have
 * none: an OpenStreetMap `description` tag falls under the source's `attribution` line instead.
 *
 * The credit travels with the text instead of depending on whether a client renders the `wikipedia`
 * link. Images made the same choice, and "who wrote this and under what terms" doesn't change
 * between a photo and a paragraph.
 */
export const placeDescriptionCreditSchema = mediaCreditSchema;
// Caps on a place's short text fields. They are named constants because more than one producer
// spends them, and one producer is Atlas's volume publisher, whose output can't change once anyone
// has fetched it. The same reasoning as `MAX_PLACE_DESCRIPTION_LEN`: a cap copied into a producer
// stops matching the schema it was copied from.

/** The longest website or Wikipedia link a place may carry, in characters: 300. */
export const MAX_PLACE_URL_LEN = 300;
/** The longest name in a place's `altNames`, in characters: 256. */
export const MAX_PLACE_NAME_LEN = 256;
/** The most "also known as" names a place may carry: 8. */
export const MAX_PLACE_ALT_NAMES = 8;

/**
 * Validates a place's website link: an `http` or `https` URL of at most {@link MAX_PLACE_URL_LEN}
 * characters.
 *
 * The link comes from a source's `website`, `contact:website` or `url` tag, with the scheme added
 * on ingest when the tag had none.
 */
export const placeWebsiteSchema = httpUrlSchema(MAX_PLACE_URL_LEN);
/**
 * Validates a place's English Wikipedia article link: an `http` or `https` URL of at most
 * {@link MAX_PLACE_URL_LEN} characters.
 */
export const placeWikipediaSchema = httpUrlSchema(MAX_PLACE_URL_LEN);
/**
 * Validates a place's "also known as" names: 1 to {@link MAX_PLACE_ALT_NAMES} names, each 1 to
 * {@link MAX_PLACE_NAME_LEN} characters.
 *
 * The names come from a source's `alt_name`, `short_name`, `official_name` and `old_name` tags,
 * without duplicates.
 */
export const placeAltNamesSchema = z
  .array(z.string().min(1).max(MAX_PLACE_NAME_LEN))
  .min(1)
  .max(MAX_PLACE_ALT_NAMES);

/** Validates a {@link PlaceDetail}, refusing unknown fields. */
export const placeDetailSchema = placeSummarySchema
  .extend({
    geometry: absentOnRead(placeGeometrySchema.optional()),
    description: placeDescriptionSchema.optional(),
    descriptionCredit: placeDescriptionCreditSchema.optional(),
    website: placeWebsiteSchema.optional(),
    wikipedia: placeWikipediaSchema.optional(),
    altNames: placeAltNamesSchema.optional(),
    /** Where the data came from: each source's name and its license line. */
    sources: z.array(z.object({ source: z.string(), attribution: z.string().optional() }).strict()),
    /**
     * The players whose approved contribution to this place asked to be credited (beacon.server
     * `doc/spec/place-proposals.md` §3.2 and §4.1). DIDs, not names: display names live on
     * profiles, which a client already resolves.
     *
     * Present only when the request asks for it with `?contributors=1`. That opt-in is the point:
     * this schema is `.strict()`, so an unconditional new key would fail the parse of every app
     * already in players' hands. A client that doesn't ask never sees the field, which let the
     * server ship it ahead of the release that reads it. Opt-in is the general way to grow a strict
     * read response.
     */
    contributors: z.array(didKeySchema).optional(),
  })
  .strict();
/**
 * One place as `GET /places/:unique` returns it: the summary fields plus the area geometry, the
 * description, the links and where the data came from.
 *
 * `geometry`, `description`, `website`, `wikipedia` and `altNames` are present when the place has
 * them. Show `descriptionCredit` with the description and each `sources[].attribution` line with
 * the place. `contributors` lists the players who asked to be credited for an approved
 * contribution, by `did:key`, and is present only when you request it with `?contributors=1`.
 */
export type PlaceDetail = z.infer<typeof placeDetailSchema>;
/**
 * {@link PlaceDetail} as a client reads it: the checks of `placeDetailSchema`, with unknown fields
 * dropped instead of refused. A `geometry` this version cannot read is treated as absent.
 */
export const placeDetailReadSchema = readVariant(placeDetailSchema);

/** Validates a {@link PlacesQueryResult}, refusing unknown fields. */
export const placesQueryResultSchema = z
  .object({
    places: rowsDroppedOnRead(z.array(placeSummarySchema)),
    /** Dataset credits for the sources these places came from. Each photo's own credit is in `media`. */
    attribution: z.array(z.string()),
    /** `true` when the page is full and more places exist. */
    truncated: z.boolean(),
    /**
     * The cursor for the next page: the `unique` of the last place on this page, present exactly
     * when `truncated` is `true`. Send the same query again with `?cursor=<cursor>` to fetch the
     * next page, and stop when the reply has no cursor. A client that reads one page can ignore the
     * field. The name matches the discovery reply's next-page cursor (beacon.server
     * `doc/spec/places.md` §5).
     */
    cursor: ulidSchema.optional(),
  })
  .strict();
/**
 * The reply to `GET /places?cells=&categories=`: one page of places in the asked cells, the dataset
 * credits to show, and a cursor when more places exist.
 *
 * Show the `attribution` lines wherever you show the places. When `truncated` is `true`, fetch the
 * next page with `?cursor=<cursor>` and the same `cells` and `categories`.
 */
export type PlacesQueryResult = z.infer<typeof placesQueryResultSchema>;
/**
 * {@link PlacesQueryResult} as a client reads it: the checks of `placesQueryResultSchema`, with
 * unknown fields dropped instead of refused. A place this version cannot read, such as one in a
 * newer category, is left out of `places`.
 */
export const placesQueryResultReadSchema = readVariant(placesQueryResultSchema);

// ── snapshots (admin-triggered population, beacon.server `doc/spec/places.md` §6) ────────────────

/**
 * Validates a {@link GeoBBox}: latitudes from -90 to 90, longitudes from -180 to 180, and no other
 * fields.
 */
export const geoBBoxSchema = z
  .object({
    minLat: z.number().min(-90).max(90),
    minLng: z.number().min(-180).max(180),
    maxLat: z.number().min(-90).max(90),
    maxLng: z.number().min(-180).max(180),
  })
  .strict();
/**
 * A latitude and longitude bounding box, in degrees. A box that crosses the antimeridian has
 * `minLng` greater than `maxLng`.
 */
export type GeoBBox = z.infer<typeof geoBBoxSchema>;

/** Validates {@link PlaceAtlasImportOptions}, refusing unknown fields. */
export const placeAtlasImportOptionsSchema = z
  .object({
    /**
     * Skip places of exactly these types. A pair without `subcategory` names the places of that
     * category that have none. Pairs, not a list of subcategories, because the same subcategory
     * can sit under two categories and an operator may want one and not the other. A category
     * skipped whole belongs in `categories` instead, which also scopes retirement.
     */
    skipTypes: z
      .array(
        z
          .object({ category: placeCategorySchema, subcategory: placeSubcategorySchema.optional() })
          .strict(),
      )
      .min(1)
      .max(256)
      .optional(),
    /** Skip places the volume holds no photo for. */
    requirePhotos: z.boolean().optional(),
    /** Skip places with no name. */
    requireName: z.boolean().optional(),
    /** Skip places with no description. */
    requireDescription: z.boolean().optional(),
    /**
     * `false` imports the places without downloading their photo files. Photos a place already
     * holds from an earlier import are kept. Default `true`.
     */
    importPhotos: z.boolean().optional(),
    /**
     * `false` skips the retirement sweep, so places that are gone from this version stay live.
     * Default `true`: a newer version removes what its publisher removed.
     */
    retireMissing: z.boolean().optional(),
    /**
     * `true` retires this volume's records for places `requirePhotos`, `requireName` or
     * `requireDescription` exclude, instead of leaving them untouched: the clean-up for an earlier,
     * wider import. Type choices (`categories`, `skipTypes`) never retire here; that is
     * `retireUnselectedTypes`. Scoped to the requested
     * area by each place's own point (inside a `cells` prefix and the `boundary`), never by the
     * whole volume cell an area overlaps. A place another source still holds (an admin edit, a
     * contribution) keeps living on that source. Independent of `retireMissing`. Default `false`.
     */
    retireFiltered: z.boolean().optional(),
    /**
     * `true` retires this volume's records for place types the import leaves out: a category not in
     * the import's `categories`, or a type in `skipTypes`. The clean-up for an earlier import that
     * took a type this one does not. Held to the requested area by each place's own point, as
     * `retireFiltered` is. A place another source still holds (an admin edit, a contribution) keeps
     * living on that source. Independent of `retireMissing`. Default `false`.
     */
    retireUnselectedTypes: z.boolean().optional(),
  })
  .strict();
/**
 * How an Atlas import narrows what it takes beyond area and category: types to skip, places to skip
 * for missing photos, names or descriptions, and what to retire.
 *
 * A filter leaves what it excludes untouched: a place it skips is neither created, updated nor
 * retired. Tightening a filter on a re-import therefore never deletes what an earlier, wider import
 * brought in, unless `retireFiltered` or `retireUnselectedTypes` asks for that. Leaving out the
 * options, or sending `{}`, imports everything.
 */
export type PlaceAtlasImportOptions = z.infer<typeof placeAtlasImportOptionsSchema>;

/** Validates {@link PlaceSnapshotParams}, refusing unknown fields. */
export const placeSnapshotParamsSchema = z
  .object({
    source: z.string().min(1).max(64), // source id, e.g. "atlas:us-west" / "list:downtown"
    boundary: z.union([geoBBoxSchema, placeGeometrySchema]),
    categories: z.array(placeCategorySchema).max(16).optional(),
    /** An Atlas run's filters and options, recorded so the run says what it was asked to do. */
    options: placeAtlasImportOptionsSchema.optional(),
  })
  .strict();
/**
 * The scope a place import run recorded: the source it wrote, the area, the categories and any
 * Atlas options.
 *
 * You don't send this shape as an op. The `places.atlas.import`, `places.import` and
 * `places.source.retire` ops each start a run and record their scope this way, and a
 * {@link PlaceSnapshot} carries it as `params`. `boundary` is the area that retirement was limited
 * to, and `categories` limits which places the run touched.
 */
export type PlaceSnapshotParams = z.infer<typeof placeSnapshotParamsSchema>;

/** Validates {@link PlaceSnapshotStats}: every count is a whole number of zero or more. */
export const placeSnapshotStatsSchema = z
  .object({
    chunksDone: z.number().int().nonnegative(),
    chunksTotal: z.number().int().nonnegative(),
    fetched: z.number().int().nonnegative(), // elements the connector returned
    created: z.number().int().nonnegative(), // new canonical places
    updated: z.number().int().nonnegative(), // existing places re-committed (data changed)
    unchanged: z.number().int().nonnegative(), // refresh no-ops (identical source data, skipped)
    skipped: z.number().int().nonnegative(), // unmappable elements (no category/point)
    retired: z.number().int().nonnegative(), // in-scope sources gone on this re-run
    conflicts: z.number().int().nonnegative(), // admin-held field collisions logged
    imagesIngested: z.number().int().nonnegative(),
    filtered: z.number().int().nonnegative().optional(), // left untouched by an import's options
    // Photos not imported because the server's media storage is full (`mediaLimitBytes`); a re-run
    // once there is room fetches only these, since photos already held cost no download.
    imagesStorageFull: z.number().int().nonnegative().optional(),
    retiredFiltered: z.number().int().nonnegative().optional(), // of `retired`: excluded by the options, retired by `retireFiltered`
    retiredUnselected: z.number().int().nonnegative().optional(), // of `retired`: a type left out, retired by `retireUnselectedTypes`
  })
  .strict();
/**
 * The progress and result counts of a place import run, saved after every chunk.
 *
 * Poll `places.snapshots.fetch` to watch `chunksDone` approach `chunksTotal`. `fetched` counts the
 * source elements returned, and `skipped` the ones that could not become places (no category or
 * point). `created`, `updated`, `unchanged` and `retired` count places. `conflicts` counts field
 * collisions with values an admin holds, so one place can add several. `imagesStorageFull` counts
 * photos left out because the server's media storage was full; a re-run once there is room fetches
 * only those.
 */
export type PlaceSnapshotStats = z.infer<typeof placeSnapshotStatsSchema>;

/** Validates a {@link PlaceSnapshot}, refusing unknown fields. */
export const placeSnapshotSchema = z
  .object({
    id: ulidSchema,
    source: z.string(),
    params: placeSnapshotParamsSchema,
    requestedBy: didKeySchema, // the admin who triggered it (allowlisted, signature-verified)
    status: z.enum(["queued", "running", "done", "failed"]),
    stats: placeSnapshotStatsSchema.optional(),
    error: z.string().optional(),
    createdAt: isoTimestampSchema,
    startedAt: isoTimestampSchema.optional(),
    finishedAt: isoTimestampSchema.optional(),
  })
  .strict();
/**
 * One place import run: what it was asked to do, who asked, its status and its counts.
 *
 * A run moves from `queued` to `running` and ends `done` or `failed`, with the reason in `error`. A
 * canceled run ends `failed` too. The record stays as the audit trail and is the unit a re-run
 * repeats. Timestamps are ISO 8601 UTC.
 */
export type PlaceSnapshot = z.infer<typeof placeSnapshotSchema>;
/**
 * {@link PlaceSnapshot} as a client reads it: the checks of `placeSnapshotSchema`, with unknown
 * fields dropped instead of refused.
 */
export const placeSnapshotReadSchema = readVariant(placeSnapshotSchema);

/** Validates {@link PlaceSnapshotsFetchParams}: an optional ULID `id`. */
export const placeSnapshotsFetchParamsSchema = z.object({ id: ulidSchema.optional() }).strict();
/**
 * The params of a `places.snapshots.fetch` op: the `id` of one run, or nothing for the recent runs.
 */
export type PlaceSnapshotsFetchParams = z.infer<typeof placeSnapshotsFetchParamsSchema>;

// ── Atlas volume import (beacon.server `apps/atlas/doc/spec/beacon-integration.md`) ──────────────
// A volume is a signed static artifact and the transport is untrusted by design, so a server can take
// one from an operator-supplied URL (fetched once, during the run) or an uploaded archive (staged,
// imported, deleted). Trust is the publisher did: shown to the operator before import, pinned per
// volume on first import, and a later version signed by anyone else is refused. Nothing here is
// deploy-time configuration. Which volumes a dataset trusts is a runtime decision, per dataset, by
// the same allowlisted operator who signs every other admin op.

/**
 * A directory under the server's mounted volumes dir (`BEACON_ATLAS_VOLUMES_DIR`), read as the
 * volume tree verbatim: the fast local alternative when fetching a hosted volume tile by tile is
 * too slow. `.` names the mounted dir itself. Confined server-side; never an arbitrary path.
 */
const atlasPathSchema = z.string().min(1).max(512);

/** The three ways an op can name a volume: spelled once, shared by inspect and import. */
// An `http` or `https` URL only: `z.string().url()` alone also takes `javascript:` and `data:`,
// which name no volume a server can read and which a console may render as a link.
const atlasTargetFields = {
  url: httpUrlSchema(2048).optional(),
  staged: ulidSchema.optional(),
  path: atlasPathSchema.optional(),
};
const oneAtlasTarget = (p: {
  url?: string | undefined;
  staged?: string | undefined;
  path?: string | undefined;
}): boolean => [p.url, p.staged, p.path].filter((v) => v !== undefined).length === 1;
const ONE_ATLAS_TARGET = { message: "exactly one of url, staged or path" };

/**
 * Validates {@link PlaceAtlasInspectParams}: exactly one of `url` (an `http` or `https` URL of at
 * most 2048 characters), `staged` (a ULID) or `path` (1 to 512 characters).
 */
export const placeAtlasInspectParamsSchema = z
  .object(atlasTargetFields)
  .strict()
  .refine(oneAtlasTarget, ONE_ATLAS_TARGET);
/**
 * The params of a `places.atlas.inspect` op: the volume to read, named by exactly one of `url`,
 * `staged` or `path`.
 *
 * The server reads the volume's manifest and answers with a {@link PlaceAtlasPreview} for the
 * operator to confirm before anything is imported. `url` names a hosted volume or one of its
 * versions (`<base>/<volume>/<version>`). `staged` is the id of an uploaded archive. `path` names a
 * directory under the server's mounted volumes directory (`BEACON_ATLAS_VOLUMES_DIR`), where `.` is
 * that directory itself.
 */
export type PlaceAtlasInspectParams = z.infer<typeof placeAtlasInspectParamsSchema>;

/**
 * Validates {@link PlaceAtlasUploadParams}: a `hash` of 1 to 128 characters and a `size` from 1
 * byte to 8 GiB.
 */
export const placeAtlasUploadParamsSchema = z
  .object({
    /** The sha256 of the archive as base64url without padding. */
    hash: z.string().min(1).max(128),
    size: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024 * 1024),
  })
  .strict();
/**
 * The params of a `places.atlas.upload` op: the sha256 `hash` and the `size` in bytes of a volume
 * archive whose bytes travel as the raw request body.
 *
 * The server hashes the body while it streams and refuses a mismatch. Uploading the bytes raw
 * instead of as base64 keeps an archive of several gigabytes out of a JSON body. The hash is the
 * same integrity link the media upload uses.
 */
export type PlaceAtlasUploadParams = z.infer<typeof placeAtlasUploadParamsSchema>;

/**
 * Validates a geohash prefix in an import or survey scope: 1 to 12 geohash characters.
 *
 * The prefixes are the vocabulary of a server descriptor's `coverage` (`doc/spec/discovery.md`
 * §3.2), with the same rule as a cell. The empty string is refused: in `coverage`, `[""]` means
 * everywhere, and an import says that by leaving out the filter.
 */
export const geohashPrefixSchema = geohashCellSchema;

/**
 * Validates {@link PlaceAtlasImportParams}: exactly one volume target, a `publisher` `did:key`, up
 * to 64 `cells` prefixes and up to 16 `categories`.
 */
export const placeAtlasImportParamsSchema = z
  .object({
    ...atlasTargetFields,
    publisher: didKeySchema,
    boundary: z.union([geoBBoxSchema, placeGeometrySchema]).optional(),
    /**
     * Import only the volume cells that intersect these prefixes. The value is usually the server
     * descriptor's own `coverage` list, to import what this server covers. A prefix finer than the
     * volume's cell precision selects the cell that contains it. With `boundary` too, a place must
     * be inside both.
     */
    cells: z.array(geohashPrefixSchema).min(1).max(64).optional(),
    categories: z.array(placeCategorySchema).max(16).optional(),
    options: placeAtlasImportOptionsSchema.optional(),
  })
  .strict()
  .refine(oneAtlasTarget, ONE_ATLAS_TARGET);
/**
 * The params of a `places.atlas.import` op: the volume, the publisher the operator confirmed, and
 * optionally an area, categories and {@link PlaceAtlasImportOptions}.
 *
 * The import runs once, in the background, as source `atlas:<volume>`. `publisher` must equal the
 * manifest's publisher, the `did:key` the operator saw on the inspect preview, so a replay against
 * a swapped volume fails. Without `boundary` or `cells` the whole volume is imported. Importing a
 * newer version of the same volume is the upgrade path: a per-field merge takes the changes and
 * places that vanished in scope are retired.
 */
export type PlaceAtlasImportParams = z.infer<typeof placeAtlasImportParamsSchema>;

/** Validates {@link PlaceAtlasSurveyParams}: exactly one volume target and up to 64 `cells` prefixes. */
export const placeAtlasSurveyParamsSchema = z
  .object({
    ...atlasTargetFields,
    cells: z.array(geohashPrefixSchema).min(1).max(64).optional(),
  })
  .strict()
  .refine(oneAtlasTarget, ONE_ATLAS_TARGET);
/**
 * The params of a `places.atlas.survey` op: the volume, and the `cells` prefixes to count, before
 * importing them.
 *
 * The volume's index counts places only per cell, so the server reads every tile in scope as a
 * background job. Send the op again with the same params until the {@link PlaceAtlasSurvey} reports
 * `done` or `failed`. `cells` is the same field as on the import, so a survey and the import it
 * informs agree on the area.
 */
export type PlaceAtlasSurveyParams = z.infer<typeof placeAtlasSurveyParamsSchema>;

/** Validates a {@link PlaceAtlasSurveyVariant}, refusing unknown fields. */
export const placeAtlasSurveyVariantSchema = z
  .object({
    hasPhotos: z.boolean(),
    hasName: z.boolean(),
    hasDescription: z.boolean(),
    places: z.number().int().nonnegative(),
    /** Photo files (a thumb and a full count as two), the unit `mediaBytes` is estimated in. */
    photoFiles: z.number().int().nonnegative(),
  })
  .strict();
/**
 * The count of places in one survey bucket that share the same three yes or no facts: whether they
 * have photos, a name and a description.
 *
 * A survey lists only the combinations that occur. Sum the variants an import's options keep to get
 * the exact number of places that import would take.
 */
export type PlaceAtlasSurveyVariant = z.infer<typeof placeAtlasSurveyVariantSchema>;

/** Validates a {@link PlaceAtlasSurveyBucket}, refusing unknown fields. */
export const placeAtlasSurveyBucketSchema = z
  .object({
    /** The volume's own spelling, which may be a category this server does not know. */
    category: z.string(),
    subcategory: z.string().optional(),
    /** `false` when this server cannot import the category (a newer taxonomy); those places are dropped. */
    supported: z.boolean(),
    variants: z.array(placeAtlasSurveyVariantSchema),
  })
  .strict();
/**
 * The places of one category and subcategory pair in a surveyed area, split into
 * {@link PlaceAtlasSurveyVariant}s.
 *
 * The names are the volume's own and may be a category this server does not know. Then `supported`
 * is `false` and an import drops those places.
 */
export type PlaceAtlasSurveyBucket = z.infer<typeof placeAtlasSurveyBucketSchema>;

/** Validates a {@link PlaceAtlasSurveyResult}, refusing unknown fields. */
export const placeAtlasSurveyResultSchema = z
  .object({
    cells: z.number().int().nonnegative(),
    places: z.number().int().nonnegative(),
    /** Bytes of tile JSON in the area: what an import downloads before any photo. */
    tileBytes: z.number().int().nonnegative(),
    /** Photo files in the area, and their estimated size at the volume's average file size. */
    photoFiles: z.number().int().nonnegative(),
    mediaBytesEstimate: z.number().int().nonnegative(),
    buckets: z.array(placeAtlasSurveyBucketSchema),
    /** Places each data source contributed to, by `sources[].id` from the preview. */
    sources: z.array(z.object({ id: z.string(), places: z.number().int().nonnegative() }).strict()),
  })
  .strict();
/**
 * What a finished Atlas survey counted: cells, places, the bytes an import would download, and the
 * places per type and per data source.
 *
 * `tileBytes` is the size of the place data. `mediaBytesEstimate` estimates the photo downloads
 * from the volume's average file size. Each bucket splits one place type by the import filters.
 */
export type PlaceAtlasSurveyResult = z.infer<typeof placeAtlasSurveyResultSchema>;

/** Validates a {@link PlaceAtlasSurvey}, refusing unknown fields. */
export const placeAtlasSurveySchema = z
  .object({
    status: z.enum(["running", "done", "failed"]),
    tilesDone: z.number().int().nonnegative(),
    tilesTotal: z.number().int().nonnegative(),
    error: z.string().optional(),
    result: placeAtlasSurveyResultSchema.optional(),
  })
  .strict();
/**
 * The reply to a `places.atlas.survey` op: the survey's status, its progress in tiles and, once
 * `done`, its {@link PlaceAtlasSurveyResult}.
 *
 * Send the op again with the same params until `status` is `done` or `failed`. A failed survey
 * carries the reason in `error`.
 */
export type PlaceAtlasSurvey = z.infer<typeof placeAtlasSurveySchema>;
/**
 * {@link PlaceAtlasSurvey} as a client reads it: the checks of `placeAtlasSurveySchema`, with
 * unknown fields dropped instead of refused.
 */
export const placeAtlasSurveyReadSchema = readVariant(placeAtlasSurveySchema);

/** Validates {@link PlaceAtlasUnpinParams}: a `volume` name of 1 to 64 characters. */
export const placeAtlasUnpinParamsSchema = z.object({ volume: z.string().min(1).max(64) }).strict();
/**
 * The params of a `places.atlas.unpin` op: the `volume` whose pinned publisher the server forgets,
 * so the next import may pin a new key.
 *
 * Unpinning is its own op instead of an override flag on import. A key rotation strands every
 * volume the old key signed, and a decision like that should not ride along with an import.
 */
export type PlaceAtlasUnpinParams = z.infer<typeof placeAtlasUnpinParamsSchema>;

/** Validates {@link PlaceAtlasPinsFetchParams}: an empty object. */
export const placeAtlasPinsFetchParamsSchema = z.object({}).strict();
/**
 * The params of a `places.atlas.pins.fetch` op: none. The server answers with every
 * {@link PlaceAtlasPin} it holds.
 *
 * Listing the pins is the audit half of trust on first use. Revoking a leaked key starts from
 * seeing what the server trusts.
 */
export type PlaceAtlasPinsFetchParams = z.infer<typeof placeAtlasPinsFetchParamsSchema>;

/** Validates a {@link PlaceAtlasPin}, refusing unknown fields. */
export const placeAtlasPinSchema = z
  .object({
    volume: z.string(),
    publisher: didKeySchema,
    pinnedAt: isoTimestampSchema,
    pinnedBy: didKeySchema,
  })
  .strict();
/**
 * One Atlas volume pinned to its publisher: the volume name, the publisher's `did:key`, and which
 * operator confirmed the pin and when (`pinnedBy`, `pinnedAt`).
 *
 * The first import of a volume pins its publisher. The server refuses a later version signed by any
 * other key until an operator unpins the volume.
 */
export type PlaceAtlasPin = z.infer<typeof placeAtlasPinSchema>;
/**
 * {@link PlaceAtlasPin} as a client reads it: the checks of `placeAtlasPinSchema`, with unknown
 * fields dropped instead of refused.
 */
export const placeAtlasPinReadSchema = readVariant(placeAtlasPinSchema);

/** Validates a {@link PlaceAtlasPreview}, refusing unknown fields. */
export const placeAtlasPreviewSchema = z
  .object({
    volume: z.string(),
    version: z.string(),
    places: z.number().int().nonnegative(),
    cells: z.number().int().nonnegative(),
    publisher: didKeySchema,
    media: z.number().int().nonnegative(),
    mediaBytes: z.number().int().nonnegative(),
    /**
     * `new` when the volume has no pin yet (the first import pins it), `pinned` when the publisher
     * matches the pin, and `mismatch` when it does not. Refuse to import on a `mismatch`.
     */
    pin: z.enum(["new", "pinned", "mismatch"]),
    /** The pinned `did:key` when it differs: what the operator must unpin to proceed. */
    pinnedPublisher: didKeySchema.optional(),
    // Everything below is optional so an older server's preview still reads.
    /**
     * The version URL a hosted volume resolved to. An inspect may name the volume's root, which
     * follows `latest.json`; importing this URL imports exactly the version previewed.
     */
    // http(s) only, but no length cap: a server's resolved URL, such as a presigned one, may run
    // longer than the 2048 characters a request's `url` takes.
    versionUrl: httpUrlSchema(null).optional(),
    revision: z.number().int().nonnegative().optional(),
    createdAt: isoTimestampSchema.optional(),
    bounds: geoBBoxSchema.optional(),
    /** The geohash prefixes the volume holds places in. */
    coverage: z.array(z.string()).optional(),
    cellPrecision: z.number().int().positive().optional(),
    /** Bytes of tile JSON in the whole volume. */
    tileBytes: z.number().int().nonnegative().optional(),
    /** Cells that also publish polygon outlines (not imported yet). */
    geometryCells: z.number().int().nonnegative().optional(),
    /** Places this version lists as removed since an earlier one. */
    retired: z.number().int().nonnegative().optional(),
    /** The place types the volume uses, in its own spelling. */
    categories: z.array(z.string()).optional(),
    subcategories: z.array(z.string()).optional(),
    /** The data sources the volume was built from, with the terms a server must show. */
    sources: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            attribution: z.string(),
            license: z.string(),
            licenseUrl: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /** The upstream files the build read, as the publisher recorded them. */
    inputs: z.array(z.object({ source: z.string(), artifact: z.string() }).strict()).optional(),
  })
  .strict();
/**
 * The reply to a `places.atlas.inspect` op: the volume's name, version, size and publisher, and how
 * the publisher compares to the server's pin.
 *
 * Show the operator `publisher` and `pin` before an import. On `mismatch`, `pinnedPublisher` is the
 * key the server trusts instead. The fields after `pinnedPublisher` are optional, so a preview from
 * an older server still reads. They describe the volume further: its bounds, coverage, place types,
 * data sources and the terms each source requires.
 */
export type PlaceAtlasPreview = z.infer<typeof placeAtlasPreviewSchema>;
/**
 * {@link PlaceAtlasPreview} as a client reads it: the checks of `placeAtlasPreviewSchema`, with
 * unknown fields dropped instead of refused.
 */
export const placeAtlasPreviewReadSchema = readVariant(placeAtlasPreviewSchema);

/** Validates {@link PlaceSnapshotCancelParams}: a ULID `id`. */
export const placeSnapshotCancelParamsSchema = z.object({ id: ulidSchema }).strict();
/**
 * The params of a `places.snapshot.cancel` op: the `id` of the import run to stop.
 *
 * A running run stops at its next chunk boundary. A run left behind by a server restart is closed
 * at once. Either way the run ends `failed`, with the reason in its `error`.
 */
export type PlaceSnapshotCancelParams = z.infer<typeof placeSnapshotCancelParamsSchema>;

/** Validates {@link PlaceSourceRetireParams}: a `source` id of 1 to 64 characters. */
export const placeSourceRetireParamsSchema = z
  .object({ source: z.string().min(1).max(64) })
  .strict();
/**
 * The params of a `places.source.retire` op: a `source` that is no longer an input, whose records
 * the server marks gone in a background run.
 *
 * Each affected place is merged again from its other sources or retired. The op exists for what a
 * removed connector left behind, such as `osm`. The server refuses the live inputs (`admin`,
 * `contrib`, `list:*` and `atlas:*`), which each have their own way to remove places (beacon.server
 * `apps/atlas/doc/spec/beacon-integration.md` §6).
 */
export type PlaceSourceRetireParams = z.infer<typeof placeSourceRetireParamsSchema>;

// ── export / import (beacon.server `doc/spec/places.md` §7) ──────────────────────────────────────
// A GeoJSON FeatureCollection is the interchange file format (set up, move, or share lists across
// servers), never the read-API envelope. `unique` survives the move (the GlobalId
// discipline: permanent `unique`, changing `@host`), so re-importing an updated list updates in
// place, and two servers sharing a list agree on place identity. An imported file lands as a
// `list:<name>` source through the same upsert/merge/conflict pipeline as every connector.

/**
 * The most places one export or import file may hold: 2000, sized to the server's JSON body limit.
 */
export const MAX_PLACE_FEATURES = 2000;

/**
 * The most media entries one place may carry: 8, which is 4 photos of a thumb and a full each.
 *
 * Export files, operator edits and player proposals all share this cap.
 */
export const MAX_PLACE_MEDIA = 8;

/**
 * The size of the square a place photo's `thumb` is scaled to fit, in pixels: 256.
 *
 * A thumb's longer side is at most this many pixels. {@link PLACE_FULL_PX} is the same for the full
 * variant.
 *
 * These numbers live here, in the tier safe for React Native and browsers, because three producers
 * spend them and only one of them can link a native image encoder: Cartographer's media crawl (via
 * `@beaconsgg/image-encode`/sharp), the admin console's browser canvas encoder, and a signed
 * volume's `mediaProfile`. The last one is why a copy is worse here than elsewhere: a published
 * manifest advertises the sizes it encoded at, and the volume format (beacon.server
 * `apps/atlas/doc/spec/volume-format.md` §10) makes those bytes unchangeable, so a producer that
 * drifted from the number it advertised could not be corrected in place.
 *
 * The browser encoder's quality is not here: sharp counts from 0 to 100 and canvas from 0 to 1, so
 * there is no shared number, and each producer keeps its own quality setting.
 */
export const PLACE_THUMB_PX = 256;
/**
 * The size of the square a place photo's `full` variant is scaled to fit, in pixels: 1024. See
 * {@link PLACE_THUMB_PX} for why the sizes are shared.
 */
export const PLACE_FULL_PX = 1024;

/**
 * The MIME type of every place photo, `"image/webp"`: what each producer encodes to, and what a
 * consumer of published place media may expect the bytes to be.
 */
export const PLACE_MEDIA_TYPE = "image/webp";

/**
 * Validates a GeoJSON `Point` geometry: `{ type: "Point", coordinates: [lng, lat] }`, in GeoJSON's
 * longitude-first order.
 */
export const pointGeometrySchema = z
  .object({ type: z.literal("Point"), coordinates: geoPositionSchema })
  .strict();

/**
 * Validates a {@link ContribLicense}: `"CC0-1.0"` or `"CC-BY-4.0"`.
 *
 * The grant exists because a contribution may travel: an operator can share approved contributions
 * with the open Atlas dataset, which republishes them as static files anyone may mirror. Every
 * other corpus Atlas publishes states terms per item (Commons `extmetadata`, federal authorship,
 * KartaView's corpus grant), and a volume that carried a field it could not state terms for would
 * be the one publishing mistake that cannot be fixed afterwards: a version's bytes never change
 * (beacon.server `apps/atlas/doc/spec/beacon-integration.md` §9).
 *
 * The values are SPDX ids, and only two. A free-text license is one nobody downstream can act on.
 * There is no share-alike option: a volume is redistributed by parties who never saw this form, and
 * a copyleft obligation they cannot discharge is worse for the contributor than the weaker grant.
 */
export const contribLicenseSchema = z.enum(["CC0-1.0", "CC-BY-4.0"]);
/**
 * The license a player grants on a place contribution, covering its text and its photos:
 * `"CC0-1.0"` or `"CC-BY-4.0"`, as SPDX ids.
 *
 * Offer CC BY only when the player also asks to be credited. An uncredited submission must be CC0,
 * and the server refuses any other. See {@link CONTRIB_LICENSE_TERMS} for the label and link to
 * show.
 */
export type ContribLicense = z.infer<typeof contribLicenseSchema>;

/**
 * The display label and license URL for each {@link ContribLicense}, such as `"CC BY 4.0"` and its
 * Creative Commons page. Use them in a credit line or a license picker.
 */
export const CONTRIB_LICENSE_TERMS: Readonly<
  Record<ContribLicense, { readonly label: string; readonly url: string }>
> = {
  "CC0-1.0": { label: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  "CC-BY-4.0": { label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
};

/** Validates a {@link PlaceContribBlock}, refusing unknown fields. */
export const placeContribBlockSchema = z
  .object({
    id: z.string().min(3).max(256),
    upstream: z.array(z.string().min(1)).max(16).optional(),
    license: contribLicenseSchema,
    contributors: z.array(didKeySchema).max(64).optional(),
  })
  .strict();
/**
 * The `contrib` block on a place in a `beacon-contrib/1` file: what a dataset builder needs to take
 * in approved player contributions.
 *
 * The block answers questions the plain place Feature cannot (beacon.server
 * `apps/atlas/doc/spec/beacon-integration.md` §9 and `apps/atlas/doc/spec/place-identity.md` §7):
 *
 * - `id` is `<host>/<place unique>`, and an ingesting dataset keeps it forever. The id lets the
 *   originating server recognize its own contribution coming home instead of creating a second
 *   copy. The id also lets the builder tell "an independent source agrees" from "this is what I
 *   published last month"; a dataset that counted its own output as corroboration would be
 *   measuring itself.
 * - `upstream` lists the place's other live source keys. An improvement has to join the place it
 *   improves, and without these keys the builder would stage it as a new place beside it.
 * - `license` covers the feature as a whole: the most restrictive grant among the contributions
 *   that fed it. Fields with a credit slot (`descriptionCredit`, each photo's `credit`) carry their
 *   own exact terms, and this license covers the rest.
 * - `contributors` holds only the `did:key`s of players who asked to be named. A contributor who
 *   chose otherwise appears nowhere in the file.
 */
export type PlaceContribBlock = z.infer<typeof placeContribBlockSchema>;

/** Validates a {@link PlaceFeature}, refusing unknown fields at both levels. */
export const placeFeatureSchema = z
  .object({
    type: z.literal("Feature"),
    geometry: z.union([placeGeometrySchema, pointGeometrySchema]),
    properties: z
      .object({
        unique: ulidSchema,
        category: placeCategorySchema,
        subcategory: placeSubcategorySchema.optional(),
        name: z.string().optional(),
        description: placeDescriptionSchema.optional(),
        descriptionCredit: placeDescriptionCreditSchema.optional(),
        website: placeWebsiteSchema.optional(),
        wikipedia: placeWikipediaSchema.optional(),
        altNames: placeAltNamesSchema.optional(),
        point: latLngSchema,
        media: z.array(mediaSchema).max(MAX_PLACE_MEDIA).optional(),
        /** Where the exporter's data came from: each source's name and its license line. */
        sources: z
          .array(z.object({ source: z.string(), attribution: z.string().optional() }).strict())
          .optional(),
        /** Present only in a `beacon-contrib/1` file. See {@link PlaceContribBlock}. */
        contrib: placeContribBlockSchema.optional(),
        updatedAt: isoTimestampSchema.optional(),
      })
      .strict(),
  })
  .strict();
/**
 * One place in an export file, as a GeoJSON Feature.
 *
 * `geometry` is the place's area when it has one, and otherwise a `Point` at its representative
 * point. `properties.point` always holds the `{ lat, lng }` point, so a reader that skips the
 * geometry has no coordinate order to get wrong. Each `media` entry keeps its `hash` and its
 * `<hash>@host` addresses, so an importer can fetch the bytes from the exporting server's public
 * media route and check them by re-hashing. Photo credits travel with the entries.
 */
export type PlaceFeature = z.infer<typeof placeFeatureSchema>;

/**
 * Validates a {@link PlaceExport}: a FeatureCollection with a `beacon` block and at most
 * {@link MAX_PLACE_FEATURES} features.
 */
export const placeExportSchema = z
  .object({
    type: z.literal("FeatureCollection"),
    beacon: z
      .object({
        /**
         * The versioned properties profile, which also says which kind of file this is.
         *
         * `beacon-places/1` is the merged dataset, importable as a `list:` source.
         * `beacon-contrib/1` is the contribution round-trip's payload: only the `contrib` source's
         * own fields, each feature carrying a {@link PlaceContribBlock}. One schema serves both
         * because the shape is the same and a second parser would be a second place for the two to
         * drift. The files are not interchangeable, and `places.import` refuses the second.
         */
        profile: z.enum(["beacon-places/1", "beacon-contrib/1"]),
        host: z.string().optional(), // the exporting server (media-origin fallback)
        exportedAt: isoTimestampSchema.optional(),
        /** Dataset credit travels with the file (a list derived from OSM is an ODbL derivative). */
        attribution: z.array(z.string()).optional(),
        truncated: z.boolean().optional(), // the export cap was hit: never silent
      })
      .strict(),
    features: z.array(placeFeatureSchema).max(MAX_PLACE_FEATURES),
  })
  .strict();
/**
 * A place export file: a GeoJSON FeatureCollection of {@link PlaceFeature}s with a `beacon` block
 * that says which kind of file it is.
 *
 * `beacon.profile` is `beacon-places/1` for a dataset export, which `places.import` accepts as a
 * list, or `beacon-contrib/1` for a contribution export, which it refuses. Keep the `attribution`
 * lines with the file. `truncated` is `true` when the export stopped at {@link MAX_PLACE_FEATURES}.
 */
export type PlaceExport = z.infer<typeof placeExportSchema>;
/**
 * {@link PlaceExport} as a client reads it: the checks of `placeExportSchema`, with unknown fields
 * dropped instead of refused.
 */
export const placeExportReadSchema = readVariant(placeExportSchema);

/** Validates {@link PlaceExportParams}: an optional `boundary`, a bounding box or a polygon. */
export const placeExportParamsSchema = z
  .object({ boundary: z.union([geoBBoxSchema, placeGeometrySchema]).optional() })
  .strict();
/**
 * The params of a `places.export` op: an optional `boundary`, a {@link GeoBBox} or a
 * {@link PlaceGeometry}. Without one the server exports the whole dataset.
 */
export type PlaceExportParams = z.infer<typeof placeExportParamsSchema>;

/**
 * Validates a place list name: 1 to 32 lowercase letters, digits and hyphens, starting with a
 * letter or a digit. An imported list's places are kept under the source `list:<name>`.
 */
export const placeListNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "a short kebab-case list name");

/**
 * Validates {@link PlaceImportParams}: a list name and a `beacon-places/1` export file.
 * A `beacon-contrib/1` file is refused.
 */
export const placeImportParamsSchema = z
  .object({ name: placeListNameSchema, collection: placeExportSchema })
  .strict()
  /**
   * A contribution file is not a list. The file's features carry one source's own fields rather
   * than a merged place, so importing one as `list:<name>` would land partial places at a priority
   * above the connectors that described them. The import would also republish, on this server, the
   * words of contributors on another one. The profile check refuses it instead of a convention.
   */
  .refine(
    ({ collection }) => collection.beacon.profile === "beacon-places/1",
    "a beacon-contrib/1 file is a contribution export, not an importable list",
  );
/**
 * The params of a `places.import` op: a list `name` and a `beacon-places/1` export file in
 * `collection`.
 *
 * The file replaces the whole list kept as source `list:<name>`. Places keep their `unique`, so
 * importing an updated file updates them in place. The places go through the same merge and
 * conflict steps as any other source.
 */
export type PlaceImportParams = z.infer<typeof placeImportParamsSchema>;

/** Validates {@link PlaceContribExportParams}: an optional `boundary`, a bounding box or a polygon. */
export const placeContribExportParamsSchema = z
  .object({ boundary: z.union([geoBBoxSchema, placeGeometrySchema]).optional() })
  .strict();
/**
 * The params of a `places.contrib.export` op: an optional `boundary` for the approved player
 * contributions to export as a `beacon-contrib/1` file.
 *
 * The op works only on a server with places on and `BEACON_PLACES_PROPOSALS_EXPORT` set (default
 * off). Sharing contributions is the one path
 * where player data leaves the server for a central party, so it is a deliberate act instead of a
 * default (beacon.server `apps/atlas/doc/spec/beacon-integration.md` §9).
 */
export type PlaceContribExportParams = z.infer<typeof placeContribExportParamsSchema>;

// ── admin edit + conflicts (beacon.server `doc/spec/places.md` §3.1, §6.3) ───────────────────────

/** Validates a {@link PlaceEditableField}: one of the 11 field names a place edit can touch. */
export const placeEditableFieldSchema = z.enum([
  "category",
  "subcategory",
  "name",
  "description",
  "descriptionCredit",
  "website",
  "wikipedia",
  "altNames",
  "point",
  "geometry",
  "media",
]);
/**
 * The name of a place field that an operator can edit, such as `"name"`, `"point"` or `"media"`.
 *
 * The server merges a place's sources field by field. An operator's edit overrides one field at a
 * time, and a conflict names the one field it is about.
 */
export type PlaceEditableField = z.infer<typeof placeEditableFieldSchema>;

/**
 * Validates a {@link PlaceEditSet}: every field is optional, with the same limits as the place
 * itself, and unknown fields are refused.
 */
export const placeEditSetSchema = z
  .object({
    category: placeCategorySchema.optional(),
    subcategory: placeSubcategorySchema.optional(),
    name: z.string().min(1).max(256).optional(),
    description: placeDescriptionSchema.optional(),
    descriptionCredit: placeDescriptionCreditSchema.optional(),
    website: placeWebsiteSchema.optional(),
    wikipedia: placeWikipediaSchema.optional(),
    altNames: placeAltNamesSchema.optional(),
    point: latLngSchema.optional(),
    geometry: placeGeometrySchema.optional(),
    media: z.array(mediaSchema).max(MAX_PLACE_MEDIA).optional(),
  })
  .strict();
/**
 * The place field values an edit, a creation or a proposal sets. A field you leave out is left as
 * it is.
 *
 * `name` is 1 to 256 characters and `media` holds at most {@link MAX_PLACE_MEDIA} entries.
 */
export type PlaceEditSet = z.infer<typeof placeEditSetSchema>;

/**
 * Validates {@link PlaceEditParams}: a place `unique`, and a `set` or a `clear` that names at least
 * one field.
 */
export const placeEditParamsSchema = z
  .object({
    unique: ulidSchema,
    set: placeEditSetSchema.optional(),
    clear: z
      .array(placeEditableFieldSchema)
      .max(placeEditableFieldSchema.options.length)
      .optional(),
  })
  .strict()
  .refine(
    (p) => (p.set !== undefined && Object.keys(p.set).length > 0) || (p.clear?.length ?? 0) > 0,
    "an edit must set and/or clear at least one field",
  );
/**
 * The params of a `places.edit` op: the place's `unique`, the field values to `set` and the fields
 * to `clear`.
 *
 * A field in `set` becomes held by the operator: the operator's value wins every merge and a source
 * that later disagrees raises a {@link PlaceConflict} instead. A field in `clear` drops the
 * override, so the sources' value comes back. Clearing the last override retires the operator's
 * record of the place, and the place loses the protection from being retired automatically
 * (beacon.server `doc/spec/places.md` §3.1).
 */
export type PlaceEditParams = z.infer<typeof placeEditParamsSchema>;

/**
 * Validates {@link PlaceCreateParams}: the fields of a {@link PlaceEditSet}, with `category` and
 * `point` required.
 *
 * Derived from {@link placeEditSetSchema} rather than re-declared, so create and edit can never
 * disagree about the field vocabulary or its bounds: an 11th mergeable field is accepted by both,
 * or neither. `category` and `point` are promoted to **required** because they are what makes a
 * place servable (`canonicalPlace`); everything else stays optional and adjustable later via
 * `places.edit`.
 */
export const placeCreateParamsSchema = placeEditSetSchema.extend({
  category: placeCategorySchema,
  point: latLngSchema,
});
/**
 * The params of a `places.create` op: a new place's fields, of which `category` and `point` are
 * required.
 *
 * The server gives the place a new `unique` and keeps it as an operator record, so the place wins
 * every merge and is never retired automatically, like an edit override. Adjust it later with
 * `places.edit` (beacon.server `doc/spec/place-proposals.md` §7).
 */
export type PlaceCreateParams = z.infer<typeof placeCreateParamsSchema>;

/** Validates a {@link PlaceConflict}, refusing unknown fields. */
export const placeConflictSchema = z
  .object({
    id: ulidSchema,
    placeUnique: ulidSchema,
    field: placeEditableFieldSchema,
    currentValue: z.unknown().optional(), // the admin-held value at conflict time
    incomingValue: z.unknown(), // what the connector brought
    source: z.string(),
    snapshotId: ulidSchema.optional(),
    createdAt: isoTimestampSchema,
    resolvedAt: isoTimestampSchema.optional(),
  })
  .strict();
/**
 * A source value that collided with a field the operator holds, kept for review.
 *
 * `currentValue` is the operator's value at the time and `incomingValue` is what the source
 * brought. `source` and `snapshotId` say where the value came from. `resolvedAt` is set once an
 * operator marks the conflict reviewed with `places.conflicts.resolve`. Timestamps are ISO 8601
 * UTC.
 */
export type PlaceConflict = z.infer<typeof placeConflictSchema>;
/**
 * {@link PlaceConflict} as a client reads it: the checks of `placeConflictSchema`, with unknown
 * fields dropped instead of refused.
 */
export const placeConflictReadSchema = readVariant(placeConflictSchema);

// ── the taxonomy vocabulary (beacon.server `doc/spec/place-proposals.md` §4.2) ───────────────────

/**
 * Validates a {@link PlaceTaxonomy}, refusing unknown fields.
 *
 * {@link placeSubcategorySchema} is a bounded slug rather than an enum, so the vocabulary can grow
 * with a tag-map edit and a re-snapshot and no wire change. That leaves this read as the only way a
 * client learns the slugs.
 */
export const placeTaxonomySchema = z
  .object({
    categories: rowsDroppedOnRead(
      z.array(
        z
          .object({
            category: placeCategorySchema,
            subcategories: z.array(placeSubcategorySchema),
          })
          .strict(),
      ),
    ),
  })
  .strict();
/**
 * The reply to `GET /places/taxonomy`: every category the server uses and the subcategories under
 * each.
 *
 * A player proposing a new place must pick a category and one of its subcategories, so read this
 * list to offer the choices. The server answers with slugs, not display labels. Keep your own table
 * of labels and show an unknown slug as itself. The list changes only with a server release that
 * changes its tag map, so you can cache it for a long time.
 */
export type PlaceTaxonomy = z.infer<typeof placeTaxonomySchema>;
/**
 * {@link PlaceTaxonomy} as a client reads it: the checks of `placeTaxonomySchema`, with unknown
 * fields dropped instead of refused. A category this version does not know is left out.
 */
export const placeTaxonomyReadSchema = readVariant(placeTaxonomySchema);

// ── contributions: player-submitted places (beacon.server `doc/spec/place-proposals.md` §4 to §6) ──

/**
 * Validates a contributor's note to the reviewer: 1 to 500 characters. The note is never published.
 */
export const placeProposalNoteSchema = z.string().min(1).max(500);

/**
 * Validates a proposal for a new place: `kind: "new"`, a category and subcategory, a point, a
 * license, and optionally a name, description, website and up to {@link MAX_PLACE_MEDIA} media
 * entries.
 *
 * The server checks `category` and `subcategory` as a pair against its taxonomy, since a
 * subcategory means something only under its category (beacon.server
 * `doc/spec/place-proposals.md` §4.2).
 */
export const placeProposalNewSchema = z
  .object({
    kind: z.literal("new"),
    category: placeCategorySchema,
    subcategory: placeSubcategorySchema,
    point: latLngSchema,
    name: z.string().min(1).max(256).optional(),
    description: placeDescriptionSchema.optional(),
    website: placeWebsiteSchema.optional(),
    media: z.array(mediaSchema).max(MAX_PLACE_MEDIA).optional(),
    license: contribLicenseSchema,
  })
  .strict();

/**
 * Validates a proposal to improve an existing place: `kind: "existing"`, the place's `unique`, a
 * license, and a name, description, website or media to add.
 *
 * A player can't move, recategorize or reshape a place: `point`, `category`, `subcategory` and
 * `geometry` stay with the operator. A contributor who thinks a place is in the wrong spot says so
 * in the proposal's `note`. Moving someone else's place is a vandalism vector with no legitimate
 * player use.
 */
export const placeProposalImprovementSchema = z
  .object({
    kind: z.literal("existing"),
    unique: ulidSchema,
    name: z.string().min(1).max(256).optional(),
    description: placeDescriptionSchema.optional(),
    website: placeWebsiteSchema.optional(),
    media: z.array(mediaSchema).max(MAX_PLACE_MEDIA).optional(),
    license: contribLicenseSchema,
  })
  .strict();

/**
 * Validates {@link PlaceProposeParams}, refusing an improvement that proposes no field and an
 * uncredited submission whose license is not `"CC0-1.0"`.
 *
 * The "an improvement must propose something" rule lives here, on the whole submission, rather than
 * on the improvement branch.
 */
export const placeProposeParamsSchema = z
  .object({
    target: z.discriminatedUnion("kind", [placeProposalNewSchema, placeProposalImprovementSchema]),
    /** `true` to publish the contributor with the place. Defaults to `false`, which keeps them private. */
    credit: z.boolean().default(false),
    note: placeProposalNoteSchema.optional(),
  })
  .strict()
  .refine(
    ({ target }) =>
      target.kind === "new" ||
      target.name !== undefined ||
      target.description !== undefined ||
      target.website !== undefined ||
      target.media !== undefined,
    "an improvement must propose at least one field",
  )
  /**
   * An uncredited submission can only be CC0. CC BY promises attribution to a named author, and a
   * contributor who chose `credit: false` has asked not to be named, so the two cannot both hold.
   * Publishing under a license whose one condition is impossible to satisfy is worse than
   * publishing under none.
   *
   * Enforced here rather than only in the picker because the client is untrusted, and because this
   * is the invariant that becomes unfixable the moment a volume carries it: a published version's
   * bytes never change (beacon.server `apps/atlas/doc/spec/volume-format.md` §10).
   */
  .refine(
    ({ target, credit }) => credit || target.license === "CC0-1.0",
    "an uncredited submission can only be CC0 — CC BY promises attribution to a named author",
  );
/**
 * The params of a `places.propose` op: a new place or an improvement in `target`, whether to credit
 * the player, and an optional note to the reviewer.
 *
 * Any player's wallet can sign the op. The server records the proposal as `pending` for an operator
 * to review, so nothing is published until an operator approves it. `target.license` is the grant
 * on the text and photos. With `credit: false` the license must be `"CC0-1.0"`.
 */
export type PlaceProposeParams = z.infer<typeof placeProposeParamsSchema>;

/** Validates a {@link PlaceProposal}, refusing unknown fields. */
export const placeProposalSchema = z
  .object({
    id: ulidSchema,
    /** The place being improved. Absent for a proposal of a new place. */
    placeUnique: ulidSchema.optional(),
    proposedBy: didKeySchema,
    credit: z.boolean(),
    /**
     * The grant this submission was made under, which the reviewer sees before approving.
     *
     * Optional here and required on `places.propose`, which is not a contradiction: submitting
     * without a grant is refused, but a row written before the grant existed has none, and a shape
     * that could not represent that would fail to serialize exactly the rows an operator most needs
     * to see. Absent reads as "no grant" everywhere downstream, and such a row never exports.
     */
    license: contribLicenseSchema.optional(),
    /** The proposed values, in the same shape they were submitted. */
    fields: placeEditSetSchema,
    note: placeProposalNoteSchema.optional(),
    status: z.enum(["pending", "approved", "rejected"]),
    reviewedBy: didKeySchema.optional(),
    reviewedAt: isoTimestampSchema.optional(),
    reviewReason: z.string().optional(),
    /** The place an approval landed on. */
    appliedPlace: ulidSchema.optional(),
    createdAt: isoTimestampSchema,
  })
  .strict();
/**
 * One place proposal and its outcome, as its contributor and the reviewing operators see it.
 *
 * `status` is `pending` until an operator decides, then `approved` or `rejected`. A decided
 * proposal names the reviewer, the time and any `reviewReason`. `appliedPlace` is the place an
 * approval landed on. `fields` holds the proposed values as submitted. Timestamps are ISO 8601 UTC.
 */
export type PlaceProposal = z.infer<typeof placeProposalSchema>;
/**
 * {@link PlaceProposal} as a client reads it: the checks of `placeProposalSchema`, with unknown
 * fields dropped instead of refused.
 */
export const placeProposalReadSchema = readVariant(placeProposalSchema);

/**
 * Validates {@link PlaceProposalsFetchParams}: an optional `status`, a ULID `cursor` and a `limit`
 * from 1 to 200.
 */
export const placeProposalsFetchParamsSchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected"]).optional(),
    cursor: ulidSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
/**
 * The params of a `places.proposals.fetch` op: an optional `status` filter, and a `cursor` and
 * `limit` for paging.
 *
 * A player gets only their own proposals and an operator gets the whole queue, from the same op on
 * different routes. Results come newest first, paged by proposal id.
 */
export type PlaceProposalsFetchParams = z.infer<typeof placeProposalsFetchParamsSchema>;

/**
 * Validates {@link PlaceProposalReviewParams}: a proposal `id`, a `decision`, an optional `reason`
 * of 1 to 500 characters and optional `edits`.
 */
export const placeProposalReviewParamsSchema = z
  .object({
    id: ulidSchema,
    decision: z.enum(["approve", "reject"]),
    reason: z.string().min(1).max(500).optional(),
    edits: placeEditSetSchema.optional(),
  })
  .strict();
/**
 * The params of a `places.proposals.review` op: an operator's `approve` or `reject` of one
 * proposal.
 *
 * `edits` amends the submission before it lands, so a nearly right contribution takes one approval
 * and a tweak instead of a rejection and a request. An approval applies the result as a `contrib`
 * source record.
 */
export type PlaceProposalReviewParams = z.infer<typeof placeProposalReviewParamsSchema>;

/**
 * Validates the params of a `places.conflicts.fetch` op: an optional place `unique`. With one the
 * server answers with that place's conflicts, and without one with the recent queue.
 */
export const placeConflictsFetchParamsSchema = z.object({ unique: ulidSchema.optional() }).strict();
/**
 * The params of a `places.conflicts.fetch` op: an optional place `unique`. With one the server
 * answers with that place's conflicts, and without one with the recent queue.
 */
export type PlaceConflictsFetchParams = z.infer<typeof placeConflictsFetchParamsSchema>;

/**
 * Validates the params of a `places.conflicts.resolve` op: 1 to 256 conflict `ids` to mark
 * reviewed.
 */
export const placeConflictsResolveParamsSchema = z
  .object({ ids: z.array(ulidSchema).min(1).max(256) })
  .strict();
/** The params of a `places.conflicts.resolve` op: 1 to 256 conflict `ids` to mark reviewed. */
export type PlaceConflictsResolveParams = z.infer<typeof placeConflictsResolveParamsSchema>;
