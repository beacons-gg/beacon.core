import { z } from "zod";
import { didKeySchema, isoTimestampSchema } from "./primitives";

// Mailbox wire shapes (beacon.server `doc/spec/mailbox-and-media.md` §4). A mailbox is a
// per-recipient notification drop, not a chat log. A signed `OpEnvelope` carries these as its
// `params`, with the `op` naming the verb: `"mailbox.send"`, `"mailbox.fetch"` or `"mailbox.ack"`.
// The envelope signature establishes the actor (`verifyOp`), so "return only my messages" and "block
// this sender" key on a verified DID.
//
// The server treats `body` as an opaque, size-bounded blob and never parses it. The game defines its
// own minimal schema client-side (`doc/spec/mailbox-client.md` §7).

/**
 * The longest message body any server accepts: 4096 bytes of UTF-8. Measure a body with
 * {@link mailboxBodyBytes}.
 *
 * A server also enforces its own limit in the same unit, `BEACON_MAILBOX_MAX_BODY` (default 256),
 * and answers `413` above it. Plan your body format around the server's limit, not this one.
 *
 * This absolute cap bounds the signed envelope whatever the server's setting, so a relay or a peer
 * is never handed a payload of several megabytes.
 */
export const MAX_MAILBOX_BODY = 4096;
/** The most message ids one `mailbox.ack` op may name: 256. */
export const MAX_MAILBOX_ACK_IDS = 256;

/**
 * Count the bytes of `body` in UTF-8, the unit of every mailbox body limit.
 *
 * Use it to check a message against {@link MAX_MAILBOX_BODY} or a server's own limit before you
 * send it. An ASCII character is 1 byte, `é` is 2, `€` is 3 and `😀` is 4. An emoji built from
 * several code points, such as a flag or a family, counts the bytes of each.
 */
export function mailboxBodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

/**
 * Validates {@link MailboxSendParams}: `to` is a `did:key` and `body` is at most
 * {@link MAX_MAILBOX_BODY} bytes of UTF-8.
 */
export const mailboxSendParamsSchema = z
  .object({
    to: didKeySchema, // recipient account did:key
    // Opaque; the server never parses it. The length check bounds the body before it is encoded,
    // since a body never has more UTF-16 units than UTF-8 bytes, and aborts so the bytes are not
    // counted twice over. It also keeps `maxLength` in a generated JSON schema.
    body: z
      .string()
      .max(MAX_MAILBOX_BODY, { abort: true })
      .refine((body) => mailboxBodyBytes(body) <= MAX_MAILBOX_BODY, {
        message: `at most ${MAX_MAILBOX_BODY} bytes of UTF-8`,
      }),
  })
  .strict();
/**
 * The params of a `mailbox.send` op: the recipient's account `did:key` in `to` and the message in
 * `body`.
 *
 * The server stores `body` as given and never parses it, so the game chooses its format. The
 * server's own body limit (`BEACON_MAILBOX_MAX_BODY`, default 256 bytes of UTF-8) is usually lower
 * than {@link MAX_MAILBOX_BODY}.
 */
export type MailboxSendParams = z.infer<typeof mailboxSendParamsSchema>;

/**
 * Validates {@link MailboxAckParams}: up to {@link MAX_MAILBOX_ACK_IDS} ids, each 1 to 64
 * characters.
 */
export const mailboxAckParamsSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).max(MAX_MAILBOX_ACK_IDS),
  })
  .strict();
/**
 * The params of a `mailbox.ack` op: the ids of delivered messages to delete, at most
 * {@link MAX_MAILBOX_ACK_IDS}.
 *
 * Only messages addressed to the signer, in the signer's game, are deleted. Other ids are ignored
 * without an error.
 */
export type MailboxAckParams = z.infer<typeof mailboxAckParamsSchema>;

/** Validates {@link MailboxFetchParams}: an empty object, refusing any key. */
export const mailboxFetchParamsSchema = z.object({}).strict();
/**
 * The params of a `mailbox.fetch` op: an empty object. The signer's account and game choose the
 * messages, so the op takes nothing else.
 */
export type MailboxFetchParams = z.infer<typeof mailboxFetchParamsSchema>;

/** Validates a {@link MailboxMessage}, refusing unknown fields. */
export const mailboxMessageSchema = z
  .object({
    id: z.string(), // server-assigned message id
    from: didKeySchema, // verified sender
    body: z.string(), // opaque payload
    receivedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema, // server-decided TTL
  })
  .strict();
/**
 * One delivered message, as a `mailbox.fetch` reply or a `mail` event on the mailbox live channel
 * carries it.
 *
 * `id` is the server's id for the message, the one `mailbox.ack` takes. `from` is the sender's
 * verified account `did:key`. `receivedAt` and `expiresAt` are ISO 8601 UTC timestamps, and the
 * server chooses how long a message lives. The recipient is the signer who fetched it, so the
 * message carries no `to`.
 */
export type MailboxMessage = z.infer<typeof mailboxMessageSchema>;
