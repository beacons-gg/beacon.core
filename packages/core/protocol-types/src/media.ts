import { z } from "zod";
import { opEnvelopeSchema } from "./op";

// Media upload wire shapes (beacon.server `doc/spec/mailbox-and-media.md` §5). Media is
// content-addressed: a `media[]` entry's `hash` (sha256, base64url without padding; see
// `mediaEntry.ts`) is the identity, and `<hash>@host` is its GlobalId address.
//
// An upload is a signed `OpEnvelope` (op `"media.put"`) whose params attest the content. The server
// re-hashes the received bytes and rejects a mismatch. The server also rejects bytes that carry EXIF
// or GPS metadata instead of rewriting them, since a rewrite would change the hash and break the
// content address (§5.5). The base64 transport of the bytes is a server-side detail outside this
// signed contract.

/**
 * The largest media object any server accepts: 20,000,000 bytes.
 *
 * Each server has its own lower limit, `BEACON_MEDIA_MAX_BYTES` (default 5,242,880 bytes, 5 MiB),
 * and answers `413` `tooLarge` above it. Plan uploads around the server's limit, not this one.
 */
export const MAX_MEDIA_BYTES = 20_000_000;

/**
 * Validates a media content id: the sha256 of the bytes as base64url without padding, 1 to 64
 * characters.
 */
export const mediaHashSchema = z.string().min(1).max(64);

/**
 * Validates {@link MediaPutParams}: `hash` is a media content id, `type` is 1 to 128 characters and
 * `size` is a whole number from 0 to {@link MAX_MEDIA_BYTES}.
 */
export const mediaPutParamsSchema = z
  .object({
    hash: mediaHashSchema, // the content id
    type: z.string().min(1).max(128), // MIME type (checked against the server's allowlist)
    size: z.number().int().nonnegative().max(MAX_MEDIA_BYTES), // must equal the received byte length
  })
  .strict();
/**
 * The params of a `media.put` op: the content hash, MIME type and size in bytes of the upload.
 *
 * The server re-hashes the bytes it receives and refuses the upload when `hash` or `size` does not
 * match them. The server checks `type` against its own list of allowed MIME types and refuses bytes
 * that carry EXIF or GPS metadata.
 */
export type MediaPutParams = z.infer<typeof mediaPutParamsSchema>;

/**
 * Validates a {@link MediaUpload}: a signed op envelope in `env` and a string in `data`, with no
 * other fields.
 */
export const mediaUploadSchema = z.object({ env: opEnvelopeSchema, data: z.string() }).strict();
/**
 * The body of `POST /media`: the signed `media.put` envelope in `env` and the bytes as standard
 * base64 in `data`.
 *
 * The base64 transport sits outside the signed contract. A server could take the bytes another way
 * (multipart, a direct upload) and the envelope would still attest the same `{ hash, type, size }`.
 * The shape is declared here so the server's controller and its OpenAPI document share one
 * definition.
 */
export type MediaUpload = z.infer<typeof mediaUploadSchema>;
