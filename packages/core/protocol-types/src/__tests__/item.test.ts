import { describe, expect, it } from "vitest";
import {
  grantRuleSchema,
  liveEventSchema,
  opaqueItemSchema,
  placeParamsSchema,
  policySchema,
  roomSchema,
} from "../index";

const DID = "did:key:z6MktestKeyabcdefgh";
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const media = [
  { type: "image", role: "full" as const, hash: "h-full", uris: ["h-full@a.example"] },
];

const item = {
  unique: "rw-1",
  birth: {
    class: "ColorSample",
    baseLevels: { hue: 200 },
    foundAt: "9q8yyk8yt",
    description: "teal",
  },
  mintedBy: { id: DID, sig: "sig" },
  state: { levels: { hue: 200 } },
  owner: null,
  match: { class: "ColorSample", levels: { hue: 200 } },
};

describe("opaqueItemSchema — the opaque signed item (item-properties §2.1)", () => {
  it("parses a full item (birth/state opaque, match projection, nullable owner)", () => {
    expect(opaqueItemSchema.safeParse(item).success).toBe(true);
  });

  it("parses a minimal item (only unique + birth; mintedBy/state/owner/match optional)", () => {
    expect(opaqueItemSchema.safeParse({ unique: "rw-2", birth: {} }).success).toBe(true);
  });

  it("keeps birth/state opaque — arbitrary nested game data is allowed", () => {
    const parsed = opaqueItemSchema.safeParse({
      unique: "rw-3",
      birth: { anything: { nested: [1, "two", true] } },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing unique or a non-object birth", () => {
    expect(opaqueItemSchema.safeParse({ birth: {} }).success).toBe(false);
    expect(opaqueItemSchema.safeParse({ unique: "rw-4", birth: "not-an-object" }).success).toBe(
      false,
    );
    expect(opaqueItemSchema.safeParse({ unique: "", birth: {} }).success).toBe(false);
  });

  it("rejects birth carrying the reserved keys `unique` / `minter` (no signature shadowing)", () => {
    expect(opaqueItemSchema.safeParse({ unique: "x", birth: { unique: "y" } }).success).toBe(false);
    expect(
      opaqueItemSchema.safeParse({ unique: "x", birth: { minter: "did:key:z6Mkabc" } }).success,
    ).toBe(false);
    expect(opaqueItemSchema.safeParse({ unique: "x", birth: { class: "ok" } }).success).toBe(true);
  });
});

describe("grantRuleSchema — the reward-handoff rule", () => {
  it("parses a grant rule", () => {
    expect(grantRuleSchema.safeParse({ op: "claim", from: "rewards", count: 1 }).success).toBe(
      true,
    );
  });

  it("rejects a non-positive count", () => {
    expect(grantRuleSchema.safeParse({ op: "claim", from: "rewards", count: 0 }).success).toBe(
      false,
    );
    expect(grantRuleSchema.safeParse({ op: "claim", from: "rewards", count: -1 }).success).toBe(
      false,
    );
  });
});

describe("policySchema — grant + maxContributors additions", () => {
  it("accepts a reward-pool policy carrying grant + maxContributors", () => {
    const parsed = policySchema.safeParse({
      ops: { claim: { role: "contributor", phase: "unlocked" } },
      grant: { op: "claim", from: "rewards", count: 1 },
      maxContributors: 3,
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts a policy with neither (both optional)", () => {
    expect(policySchema.safeParse({ ops: {} }).success).toBe(true);
  });
});

describe("roomSchema — the media header addition", () => {
  it("accepts a room carrying a content-addressed media header", () => {
    const room = {
      id: "cap-1@a.example",
      type: "box",
      version: 1,
      location: { lat: 1, lng: 2 },
      state: { contents: [], rewards: [] },
      policy: { ops: {} },
      placedBy: DID,
      media,
    };
    expect(roomSchema.safeParse(room).success).toBe(true);
  });
});

describe("placeParamsSchema — initialRewards + media", () => {
  it("accepts a place op seeding a reward pool + media header", () => {
    const parsed = placeParamsSchema.safeParse({
      type: "box",
      unique: ULID,
      mintedBy: { id: DID, sig: "sig" },
      location: { lat: 1, lng: 2 },
      policy: { ops: {}, grant: { op: "claim", from: "rewards", count: 1 }, maxContributors: 1 },
      media,
      initialRewards: [item],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("liveEventSchema — the itemGranted delta", () => {
  it("accepts an itemGranted change (unique + by)", () => {
    const parsed = liveEventSchema.safeParse({
      room: "cap-1@a.example",
      version: 5,
      change: { type: "itemGranted", item: "rw-1", by: DID },
    });
    expect(parsed.success).toBe(true);
  });
});
