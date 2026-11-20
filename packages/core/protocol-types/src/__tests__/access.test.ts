import { describe, expect, it } from "vitest";
import {
  ACCESS_MARKER,
  accessEntrySchema,
  accessRequestParamsSchema,
  accessResultReadSchema,
  accessResultSchema,
  adminAccessDidParamsSchema,
  adminAccessFetchResultReadSchema,
  adminStatusCountsSchema,
  enforcesAccess,
  serviceCapabilities,
} from "../index";
import { CODE_FALLBACKS, codeFor, parseUnderstands } from "../server";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("access", () => {
  it("a server enforces its level only when it lists the marker, which is not a service", () => {
    expect(enforcesAccess(undefined)).toBe(false);
    expect(enforcesAccess(["mailbox"])).toBe(false);
    expect(enforcesAccess(["mailbox", ACCESS_MARKER])).toBe(true);
    expect(serviceCapabilities(["mailbox", ACCESS_MARKER])).toEqual(["mailbox"]);
  });

  it("a request takes an optional note of up to 280 characters and nothing else", () => {
    expect(accessRequestParamsSchema.safeParse({}).success).toBe(true);
    expect(accessRequestParamsSchema.safeParse({ note: "x".repeat(280) }).success).toBe(true);
    expect(accessRequestParamsSchema.safeParse({ note: "x".repeat(281) }).success).toBe(false);
    expect(accessRequestParamsSchema.safeParse({ note: "" }).success).toBe(false);
    expect(accessRequestParamsSchema.safeParse({ note: "hi", extra: 1 }).success).toBe(false);
  });

  it("a player never reads as admitted on a value this build does not know", () => {
    const reply = { ok: true, accessLevel: "friends", status: "invited", extra: 1 };
    expect(accessResultReadSchema.parse(reply)).toEqual({
      ok: true,
      accessLevel: "private",
      status: "none",
    });
    // The strict shape a server sends still refuses the unknown key.
    expect(accessResultSchema.safeParse(reply).success).toBe(false);
    expect(
      accessResultSchema.parse({ ok: true, accessLevel: "request", status: "pending" }),
    ).toEqual({ ok: true, accessLevel: "request", status: "pending" });
  });

  it("an entry has no `none` status, and the admin list reads with unknown fields dropped", () => {
    expect(accessEntrySchema.safeParse({ did: DID, status: "none" }).success).toBe(false);
    const entry = { did: DID, status: "pending", note: "hi", requestedAt: "2026-11-15T00:00:00Z" };
    expect(
      adminAccessFetchResultReadSchema.parse({ ok: true, entries: [{ ...entry, later: true }] }),
    ).toEqual({ ok: true, entries: [entry] });
  });

  it("an admin op takes a DID and an optional reason", () => {
    expect(adminAccessDidParamsSchema.safeParse({ did: DID }).success).toBe(true);
    expect(adminAccessDidParamsSchema.safeParse({ did: DID, reason: "friend" }).success).toBe(true);
    expect(adminAccessDidParamsSchema.safeParse({ did: "nope" }).success).toBe(false);
  });

  it("the pending count is optional, for a server too old to take requests", () => {
    const counts = {
      rooms: 0,
      profiles: 0,
      places: 0,
      placesRetired: 0,
      conflictsPending: 0,
      snapshots: 0,
      mediaObjects: 0,
      mediaBytes: 0,
      mediaUnreviewed: 0,
    };
    expect(adminStatusCountsSchema.safeParse(counts).success).toBe(true);
    expect(adminStatusCountsSchema.safeParse({ ...counts, accessPending: 2 }).success).toBe(true);
  });

  it("notMember reaches only a client that declares it, and is denied to any other", () => {
    expect(CODE_FALLBACKS.notMember).toBe("denied");
    expect(codeFor("notMember", parseUnderstands("code:notMember"))).toBe("notMember");
    expect(codeFor("notMember", parseUnderstands(""))).toBe("denied");
  });
});
