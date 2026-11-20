/**
 * Shapes that had no schema, twin or type: the blocklist reply, the strict room and identity
 * schemas with their read twins, and the conflicts params and service types. The types are checked
 * by compiling this file.
 */
import { describe, expect, it } from "vitest";
import {
  adminBlocklistFetchResultReadSchema,
  adminBlocklistFetchResultSchema,
  identityReadSchema,
  identitySchema,
  placeConflictsFetchParamsSchema,
  placeConflictsResolveParamsSchema,
  roomReadSchema,
  roomSchema,
  serviceSchema,
  type AdminBlocklistFetchResult,
  type PlaceConflictsFetchParams,
  type PlaceConflictsResolveParams,
  type Service,
} from "../index";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("the admin.blocklist.fetch reply", () => {
  const reply: AdminBlocklistFetchResult = {
    ok: true,
    entries: [{ did: DID, reason: "spam", addedBy: "env", addedAt: "2026-11-01T00:00:00.000Z" }],
  };

  it("parses as sent, and refuses an unknown key where the read twin drops it", () => {
    expect(adminBlocklistFetchResultSchema.parse(reply)).toEqual(reply);
    const newer = { ...reply, entries: [{ ...reply.entries[0], expires: "later" }], page: 1 };
    expect(adminBlocklistFetchResultSchema.safeParse(newer).success).toBe(false);
    expect(adminBlocklistFetchResultReadSchema.parse(newer)).toEqual(reply);
  });

  it("is only the success shape", () => {
    expect(adminBlocklistFetchResultSchema.safeParse({ ok: false, entries: [] }).success).toBe(
      false,
    );
  });
});

describe("the read twins of a room and an identity", () => {
  const room = {
    id: `${ULID}@example.test`,
    type: "jar",
    version: 0,
    location: { lat: 1, lng: 2 },
    state: {},
    policy: { ops: { list: { role: "public" } } },
    placedBy: DID,
  };

  it("read a room a newer server sent, with unknown keys at any depth", () => {
    const newer = {
      ...room,
      tags: ["new"],
      policy: { ...room.policy, quorum: 2 },
    };
    expect(roomSchema.safeParse(newer).success).toBe(false); // the policy is strict
    expect(roomReadSchema.parse(newer)).toEqual(room);
  });

  it("refuse an unknown key at the top of a room and an identity in the strict schemas", () => {
    expect(roomSchema.parse(room)).toEqual(room);
    expect(roomSchema.safeParse({ ...room, tags: ["new"] }).success).toBe(false);
    expect(roomSchema.safeParse({ ...room, state: { anything: 1 } }).success).toBe(true);
    const auth = { authorizes: DID, account: DID, issued: "2026-11-01T00:00:00.000Z", sig: "s" };
    const identity = { account: DID, device: DID, auth };
    expect(identitySchema.parse(identity)).toEqual(identity);
    expect(identitySchema.safeParse({ ...identity, label: "phone" }).success).toBe(false);
  });

  it("read an identity with unknown keys, inside its authorization too", () => {
    const auth = { authorizes: DID, account: DID, issued: "2026-11-01T00:00:00.000Z", sig: "s" };
    const identity = { account: DID, device: DID, auth };
    const newer = { ...identity, label: "phone", auth: { ...auth, scope: "all" } };
    expect(identitySchema.safeParse(newer).success).toBe(false); // the authorization is strict
    expect(identityReadSchema.parse(newer)).toEqual(identity);
  });
});

describe("the types that had none", () => {
  it("match their schemas", () => {
    const fetch: PlaceConflictsFetchParams = { unique: ULID };
    const resolve: PlaceConflictsResolveParams = { ids: [ULID] };
    const service: Service = { type: "mailbox", endpoint: "example.test" };
    expect(placeConflictsFetchParamsSchema.parse(fetch)).toEqual(fetch);
    expect(placeConflictsResolveParamsSchema.parse(resolve)).toEqual(resolve);
    expect(serviceSchema.parse(service)).toEqual(service);
  });
});
