import {
  canonicalJson,
  conformsTo,
  serverDescriptorReadSchema,
  type ReceivedDescriptor,
  type ServerDescriptor,
} from "@beaconsgg/protocol-types";
import type { Account } from "./account";
import { signUtf8, verifyUtf8 } from "./crypto";
import { decodeDidKey } from "./did";

// Server descriptor signing and verifying (`doc/spec/discovery.md` §3.2): the server's self-signed
// advertisement of its identity, coverage and operator metadata. Symmetric to profile signing: the
// server signs with its account root, and a client verifies before trusting anything it advertises.

/** A server descriptor without its `proof`: what {@link signDescriptor} signs. */
export type ServerDescriptorBody = Omit<ServerDescriptor, "proof">;

/**
 * Sign a server descriptor with the server's account root, for a server to publish at
 * `GET /server/descriptor`.
 *
 * `body.key` must be `account.did`, or {@link verifyDescriptor} refuses the result.
 */
export function signDescriptor(account: Account, body: ServerDescriptorBody): ServerDescriptor {
  const sig = signUtf8(canonicalJson(body), account.root.privateKey);
  return { ...body, proof: { type: "Ed25519", key: account.did, sig } };
}

/**
 * Return `true` when a received server descriptor is well formed and signed by the server's own
 * `key`. Check a descriptor with this before you trust anything in it.
 *
 * Pass the body exactly as it came from the server, without parsing it first. `true` narrows
 * `descriptor` to `ReceivedDescriptor`, whose `accessLevel` may be a level this version does not
 * know: read it with `readAccessLevel`. Any problem returns `false`, and the function never throws.
 * `client.addServer` calls this for you.
 *
 * The shape check is the read twin of the schema and the signature is checked over the raw body, so
 * a descriptor from a newer server, carrying a field this build does not know, still verifies: the
 * server signed that field along with the rest, and this build leaves it unread. A field added
 * after signing fails like any other tamper. Takes `unknown` so a caller hands over the body
 * exactly as it came off the wire; parsing it first would drop what was signed.
 */
export function verifyDescriptor(descriptor: unknown): descriptor is ReceivedDescriptor {
  if (!conformsTo(serverDescriptorReadSchema, descriptor)) return false;
  const { proof, ...body } = descriptor;
  if (proof.key !== body.key) return false; // a server descriptor is signed by the server's own key

  try {
    return verifyUtf8(canonicalJson(body), proof.sig, decodeDidKey(proof.key));
  } catch {
    return false; // a bad key, or a body with no canonical form
  }
}
