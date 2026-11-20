import { z } from "zod";
import { absentOnRead, readVariant } from "./read";

// Media entries: the `media[]` a room, a place or an item's birth carries. Media is
// content-addressed, so each entry names its bytes by hash (beacon.server
// `doc/spec/mailbox-and-media.md` §5). The upload wire shapes are in `media.ts`. Both shapes are
// strict as a server accepts them, and a client reads them through their read twins.

/** Validates a {@link MediaCredit}: four optional strings and no other fields. */
export const mediaCreditSchema = z
  .object({
    license: z.string().optional(), // e.g. "CC BY-SA 4.0"
    author: z.string().optional(), // e.g. "Jane Doe"
    licenseUrl: z.string().optional(), // link to the license text
    sourceUrl: z.string().optional(), // the source description page (e.g. the Commons file page)
  })
  .strict();
/**
 * The credit for third-party media, such as a Wikimedia Commons photo of a real-world place: the
 * license, the author and links to the license text and the source page.
 *
 * Show a credit line built from these fields wherever you show the image. Licenses such as CC BY
 * and CC BY-SA require you to credit the author and name the license. Every field is optional
 * because a source may expose only some of them. Media a player creates carries no credit.
 */
export type MediaCredit = z.infer<typeof mediaCreditSchema>;

/**
 * Validates a {@link Media} entry: `hash` is non-empty, `uris` holds at least one address, `role`
 * is `"full"` or `"thumb"` when present, and unknown fields are refused.
 *
 * Its read variant, and every read variant that holds media, reads a `role` it doesn't know as
 * absent, so {@link pickMedia} and {@link mediaPairs} treat the entry as a standalone image.
 */
export const mediaSchema = z
  .object({
    type: z.string(), // media kind: "image" | "sound" | ...
    // Resolution/variant of this `type`. An image is stored as two content-addressed blobs: a `thumb`
    // (item cards) and a `full` (full-width detail). Absent means the only asset of its kind (a lone `sound`).
    // A role a newer server adds reads as absent, so the entry shows as a standalone image instead of
    // failing the read of the room or place that carries it.
    role: absentOnRead(z.enum(["full", "thumb"]).optional()),
    // Content id: the sha256 of the bytes (base64url-nopad). A fetching client re-hashes the bytes
    // and rejects a mismatch (beacon.server `doc/spec/mailbox-and-media.md` §5.2), and in an item's
    // birth fields the hash is signed too, so it's tamper-proof there. The hash is the identity;
    // `uris` (below) are only location hints.
    hash: z.string().min(1),
    // One or more content addresses `<hash>@host`: the hosts serving bytes matching `hash`. All entries
    // share the same `hash` (content-addressed); listing several lets the app fan out to fallback servers
    // (a self-hosted server may not keep the bytes). In an item's birth fields the list is signed
    // with the rest of the entry, so it is fixed at mint; on a room or a place it is not signed. The beta
    // writes a single-element array.
    uris: z.array(z.string().min(1)).min(1),
    // Optional attribution for third-party media (an Atlas volume's license-checked photos), absent
    // for first-party media the player mints. Travels with the entry through import re-hosting.
    credit: mediaCreditSchema.optional(),
  })
  .strict();
/**
 * One picture or sound attached to a room, a place or an item: its kind, its content hash and the
 * addresses that serve its bytes.
 *
 * `type` is the kind of media, such as `"image"` or `"sound"`. An image is usually stored twice: a
 * `"thumb"` for cards and a `"full"` for a detail view, as two entries told apart by `role`. An
 * entry with no `role` is the only asset of its kind. `hash` is the sha256 of the bytes as
 * base64url without padding, and is the media's identity. `uris` lists one or more `<hash>@host`
 * addresses that serve those bytes; fetch from any of them and check the hash. `credit` is present
 * on third-party media.
 *
 * Use {@link pickMedia} to choose the image to show and {@link mediaPairs} to group the images into
 * photos.
 */
export type Media = z.infer<typeof mediaSchema>;
/**
 * {@link Media} as a client reads it: the checks of `mediaSchema`, with unknown fields dropped
 * instead of refused.
 */
export const mediaReadSchema = readVariant(mediaSchema);

/**
 * Pick the image to show from a `media[]` list: the first image with the asked `role`, else the
 * first with the other role, else the first image.
 *
 * Returns `undefined` when the list is absent or holds no image. The fallbacks mean an object
 * created before roles existed, or one carrying only one variant, still shows a picture.
 *
 * The rule is shared rather than per-app because both sides choose: the server picks the thumb it
 * puts on a discovery summary (a map marker's picture), and the client picks the one its cards
 * render. Two copies of this rule drift the moment `role` gains a variant, and the symptom would be
 * a marker and a card showing different images of the same object.
 *
 * @param media - The object's `media` list, or `undefined` when it has none.
 * @param role - `"thumb"` for a marker or a card, `"full"` for a detail view.
 */
export function pickMedia(
  media: readonly Media[] | undefined,
  role: "full" | "thumb",
): Media | undefined {
  if (!media) return undefined;
  const images = media.filter((m) => m.type === "image");
  const other = role === "thumb" ? "full" : "thumb";
  return images.find((m) => m.role === role) ?? images.find((m) => m.role === other) ?? images[0];
}

/**
 * Group a `media[]` list into photos: one array per photo, holding a `thumb` and the `full` that
 * directly follows it, or a single image that has no partner.
 *
 * Use this to count the photos an object carries or to show one of several. Use {@link pickMedia}
 * to show an object's main picture. Entries that are not images are left out, and an absent list
 * gives `[]`. An image with no `role` is the only asset of its kind (see {@link Media}), so it
 * forms a photo on its own.
 *
 * Adjacency is the contract, and the only thing joining a pair at either end of the wire. A `full`
 * belongs to the `thumb` it directly follows. There is no group id, and pairing by index would
 * mismatch a mixed array (imported fulls with no role beside an uploaded pair). Every producer
 * writes pairs this way: Cartographer's `tileMedia` and the admin console's uploader. `tileMedia`
 * truncates by pair for the same reason, since publishing a `full` with no `thumb` would split a
 * photo in two.
 *
 * The rule is shared because two packages read it and it must not fork: the admin console's place
 * editor renders and edits by pair, and a game client draws one pair at random when a place carries
 * several. Cartographer doesn't call this, since it produces pairs from a row that already holds
 * both hashes, but it keeps the same invariant.
 */
export function mediaPairs(media: readonly Media[] | undefined): Media[][] {
  const pairs: Media[][] = [];
  for (const m of (media ?? []).filter((x) => x.type === "image")) {
    const last = pairs[pairs.length - 1];
    if (m.role === "full" && last?.length === 1 && last[0]!.role === "thumb") {
      last.push(m);
    } else {
      pairs.push([m]);
    }
  }
  return pairs;
}
