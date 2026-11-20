import { describe, expect, it } from "vitest";
import {
  adminMediaListParamsSchema,
  adminMediaListSchema,
  adminMediaReviewParamsSchema,
  canonicalJson,
  didKeySchema,
  formatGlobalId,
  gameSlugSchema,
  globalIdSchema,
  levelsSchema,
  mapDeltaSchema,
  MAX_GAME_SLUG_LEN,
  MAX_PROFILE_BYTES,
  MAX_SCOUT_CONFIG_BYTES,
  MAX_SCOUT_SPEED_KMH,
  mediaPairs,
  mediaSchema,
  movementSchema,
  MAX_REACTION_KIND_LEN,
  MAX_REACTION_TARGET_LEN,
  opEnvelopeSchema,
  opRuleSchema,
  parseGlobalId,
  placeParamsSchema,
  reactParamsSchema,
  profileBytes,
  profileDocSchema,
  scoutConfigFits,
  scoutConfigSchema,
  scoutReportParamsSchema,
  scoutReportSchema,
  serverDescriptorSchema,
  originForHost,
  serverForHost,
  admittedGames,
  serviceCapabilities,
  type Media,
  type OpEnvelope,
} from "../index";

describe("mediaPairs — the [thumb, full] grouping every media view/edit builds on", () => {
  const entry = (role: "thumb" | "full" | undefined, hash: string): Media => ({
    type: "image",
    ...(role ? { role } : {}),
    hash,
    uris: [`${hash}@h.example.com`],
  });

  it("pairs each thumb with the full that follows it; a lone thumb stands alone", () => {
    const t1 = entry("thumb", "t1");
    const f1 = entry("full", "f1");
    const t2 = entry("thumb", "t2");
    expect(mediaPairs([t1, f1, t2])).toEqual([[t1, f1], [t2]]);
  });

  it("role-absent images are sole/full assets — each its own pair; non-images drop", () => {
    const solo = entry(undefined, "x");
    const sound: Media = { type: "sound", hash: "s", uris: ["s@h.example.com"] };
    expect(mediaPairs([solo, sound])).toEqual([[solo]]);
    expect(mediaPairs(undefined)).toEqual([]);
  });

  it("pairs by ADJACENCY, not parallel index — mixed arrays stay associated", () => {
    // Imported role-absent fulls followed by an uploaded pair: each full stands alone and the
    // upload keeps its own thumb+full — parallel-index pairing would mis-attach the new thumb
    // to the first stray full.
    const f1 = entry(undefined, "f1");
    const f2 = entry(undefined, "f2");
    const t = entry("thumb", "t");
    const f = entry("full", "f");
    expect(mediaPairs([f1, f2, t, f])).toEqual([[f1], [f2], [t, f]]);
  });

  it("counts photos, not entries — what a client's random draw ranges over", () => {
    const media = [
      entry("thumb", "t1"),
      entry("full", "f1"),
      entry("thumb", "t2"),
      entry("full", "f2"),
    ];
    expect(mediaPairs(media)).toHaveLength(2); // 4 entries, 2 photos
  });
});

describe("canonicalJson (JCS)", () => {
  it("sorts object keys regardless of insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("preserves integers exactly and array order", () => {
    expect(canonicalJson({ n: [3, 1, 2], big: 9007199254740991 })).toBe(
      '{"big":9007199254740991,"n":[3,1,2]}',
    );
  });

  it("throws on undefined input", () => {
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe("GlobalId", () => {
  it("round-trips parse <-> format", () => {
    const id = "01J8XR4M0N@beacon.example";
    const parsed = parseGlobalId(id);
    expect(parsed).toEqual({ unique: "01J8XR4M0N", host: "beacon.example" });
    expect(formatGlobalId(parsed)).toBe(id);
  });

  it("accepts a host with a port", () => {
    expect(parseGlobalId("u1@localhost:3000")).toEqual({ unique: "u1", host: "localhost:3000" });
    expect(globalIdSchema.safeParse("u1@localhost:3000").success).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(() => parseGlobalId("noat")).toThrow();
    expect(() => parseGlobalId("@host")).toThrow();
    expect(() => parseGlobalId("unique@")).toThrow();
    expect(() => parseGlobalId("a@b@c")).toThrow();
    expect(globalIdSchema.safeParse("noat").success).toBe(false);
  });
});

describe("serverForHost", () => {
  it("matches on the exact host, not a substring (no mis-routing)", () => {
    const servers = ["http://xa.com.evil:9", "http://a.com"];
    expect(serverForHost("a.com", servers)).toBe("http://a.com");
  });

  it("includes the port in the host comparison", () => {
    expect(serverForHost("localhost:3017", ["http://localhost:3017"])).toBe(
      "http://localhost:3017",
    );
    // a different port is a different host -> fall back, don't route to :3017
    expect(serverForHost("localhost:3018", ["http://localhost:3017"])).toBe(
      "http://localhost:3018",
    );
  });

  it("falls back to https for a public host it does not know", () => {
    expect(serverForHost("other.example:9", [])).toBe("https://other.example:9");
    expect(serverForHost("beacon.example", ["http://a.com"])).toBe("https://beacon.example");
  });

  it("takes the scheme from the rule, never from a host that carries one", () => {
    expect(serverForHost("http://evil.example", [])).toBe("https://http://evil.example");
    expect(originForHost("http://evil.example")).toBe("http://evil.example"); // a typed URL is kept
  });

  it("keeps http for a local or private host it does not know", () => {
    for (const host of ["localhost:3018", "pi.local", "127.0.0.1:3000", "10.0.0.2", "192.168.1.5"])
      expect(serverForHost(host, [])).toBe(`http://${host}`);
  });
});

describe("placeParamsSchema", () => {
  const base = {
    type: "box",
    unique: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    mintedBy: { id: "did:key:z6MkRoot", sig: "sig" },
    location: { lat: 47.61, lng: -122.34 },
    policy: { ops: {} },
  };
  it("accepts a valid place params object", () => {
    expect(placeParamsSchema.safeParse(base).success).toBe(true);
  });
  it("rejects a missing/invalid policy or location", () => {
    expect(placeParamsSchema.safeParse({ ...base, policy: undefined }).success).toBe(false);
    expect(placeParamsSchema.safeParse({ ...base, location: { lat: 47.61 } }).success).toBe(false);
  });
  it("requires a ULID `unique` (the room's id — no `@`/host smuggled into formatGlobalId)", () => {
    const { unique: _u, ...noUnique } = base;
    expect(placeParamsSchema.safeParse(noUnique).success).toBe(false);
    expect(placeParamsSchema.safeParse({ ...base, unique: "not-a-ulid" }).success).toBe(false);
    expect(placeParamsSchema.safeParse({ ...base, unique: "u1@evil.example" }).success).toBe(false);
  });
  it("refuses an unknown param, rather than dropping it silently", () => {
    // Unsigned, so this never failed provenance: it was dropped, and the room came back missing
    // whatever the param asked for. The params that grow are the ones that SEED a room.
    expect(placeParamsSchema.safeParse({ ...base, region: "eu" }).success).toBe(false);
  });
  it("requires a well-formed `mintedBy` (room provenance)", () => {
    const { mintedBy: _m, ...noMintedBy } = base;
    expect(placeParamsSchema.safeParse(noMintedBy).success).toBe(false);
    expect(
      placeParamsSchema.safeParse({ ...base, mintedBy: { id: "did:key:z6MkRoot" } }).success,
    ).toBe(false); // missing sig
    expect(placeParamsSchema.safeParse({ ...base, mintedBy: "nope" }).success).toBe(false);
  });
});

const validAuth = {
  authorizes: "did:key:z6MkDevice",
  account: "did:key:z6MkRoot",
  issued: "2026-06-26T00:00:00Z",
  sig: "ZmFrZS1zaWc",
};

describe("opEnvelopeSchema", () => {
  const base: OpEnvelope = {
    op: "take",
    room: "u1@beacon.example",
    actor: "did:key:z6MkRoot",
    device: "did:key:z6MkDevice",
    auth: validAuth,
    nonce: "01J8XR4M0NQ9Z6T2W3K4Y5B7CD",
    issuedAt: "2026-06-26T00:00:00Z",
    params: { item: "itemUnique" },
    sig: "ZmFrZS1zaWc",
  };

  it("parses a valid envelope", () => {
    expect(opEnvelopeSchema.safeParse(base).success).toBe(true);
  });

  it("allows omitting `room` (spawn-claim / scout-report)", () => {
    const { room: _room, ...withoutRoom } = base;
    expect(opEnvelopeSchema.safeParse(withoutRoom).success).toBe(true);
  });

  it("rejects a bad did:key actor", () => {
    expect(opEnvelopeSchema.safeParse({ ...base, actor: "not-a-did" }).success).toBe(false);
  });

  it("rejects a non-ULID nonce", () => {
    expect(opEnvelopeSchema.safeParse({ ...base, nonce: "short" }).success).toBe(false);
  });

  it("is strict — rejects unknown top-level keys (they would be signed silently)", () => {
    expect(opEnvelopeSchema.safeParse({ ...base, surprise: 1 }).success).toBe(false);
  });

  it("accepts an optional `game` slug, and an envelope without one", () => {
    expect(opEnvelopeSchema.safeParse({ ...base, game: "example" }).success).toBe(true);
    expect(opEnvelopeSchema.safeParse(base).success).toBe(true); // absence = unknown, not invalid
  });

  it("rejects a malformed `game` slug rather than passing it through", () => {
    expect(opEnvelopeSchema.safeParse({ ...base, game: "Example" }).success).toBe(false);
    expect(opEnvelopeSchema.safeParse({ ...base, game: "" }).success).toBe(false);
  });
});

describe("serviceCapabilities — operator opt-ins, minus the protocol markers", () => {
  it("drops the markers and keeps the services", () => {
    expect(serviceCapabilities(["mailbox", "media", "game:example"])).toEqual(["mailbox", "media"]);
  });

  it("reports no services for a server advertising only markers", () => {
    expect(serviceCapabilities(["game:example"])).toEqual([]);
    expect(serviceCapabilities(undefined)).toEqual([]);
  });

  it("does not mistake a service whose name merely starts with `game` for a marker", () => {
    expect(serviceCapabilities(["games-list", "game:example"])).toEqual(["games-list"]);
  });
});

describe("admittedGames — what a server says it is for", () => {
  it("reads the slugs off the markers", () => {
    expect(admittedGames(["game:example", "mailbox", "game:other/2"])).toEqual([
      "example",
      "other/2",
    ]);
  });

  it("is empty for a server open to every game", () => {
    expect(admittedGames(["mailbox"])).toEqual([]);
    expect(admittedGames(undefined)).toEqual([]);
  });
});

describe("gameSlugSchema (opaque, bounded, self-attested)", () => {
  it("accepts a plain slug and a build-granular one", () => {
    expect(gameSlugSchema.safeParse("example").success).toBe(true);
    // `/` is legal precisely so an operator who wants build granularity can have it. The protocol
    // has no opinion on whether a slug names a game, a publisher or a build.
    expect(gameSlugSchema.safeParse("example/1").success).toBe(true);
    expect(gameSlugSchema.safeParse("north-ctrl.example_2").success).toBe(true);
  });

  it("rejects the characters that would break a carrier it rides", () => {
    expect(gameSlugSchema.safeParse("a,b").success).toBe(false); // BEACON_GAMES is csv
    expect(gameSlugSchema.safeParse("a:b").success).toBe(false); // the `game:<slug>` marker splits on this
    expect(gameSlugSchema.safeParse("a b").success).toBe(false); // whitespace survives nothing well
  });

  it("is bounded, and must start alphanumeric", () => {
    expect(gameSlugSchema.safeParse("a".repeat(MAX_GAME_SLUG_LEN)).success).toBe(true);
    expect(gameSlugSchema.safeParse("a".repeat(MAX_GAME_SLUG_LEN + 1)).success).toBe(false);
    expect(gameSlugSchema.safeParse("-example").success).toBe(false);
    expect(gameSlugSchema.safeParse("/example").success).toBe(false);
  });
});

describe("hardened primitives", () => {
  it("did:key is length-bounded (rejects a multi-KB string)", () => {
    expect(didKeySchema.safeParse(`did:key:z${"1".repeat(200)}`).success).toBe(false);
    expect(didKeySchema.safeParse("did:key:z6MkRoot").success).toBe(true);
  });

  it("levels reject unsafe-magnitude integers", () => {
    expect(levelsSchema.safeParse({ a: 5, b: -3 }).success).toBe(true);
    expect(levelsSchema.safeParse({ a: Number.MAX_SAFE_INTEGER + 2 }).success).toBe(false);
  });
});

describe("mediaSchema credit (attribution for ingested third-party media)", () => {
  const base = { type: "image", role: "full" as const, hash: "h", uris: ["h@host"] };

  it("parses media without a credit (first-party media)", () => {
    expect(mediaSchema.safeParse(base).success).toBe(true);
  });

  it("parses media with a full CC credit block", () => {
    const parsed = mediaSchema.safeParse({
      ...base,
      credit: {
        license: "CC BY-SA 4.0",
        author: "Jane Doe",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.credit?.license).toBe("CC BY-SA 4.0");
  });

  it("allows a partial credit (a source may expose only some fields)", () => {
    expect(mediaSchema.safeParse({ ...base, credit: { license: "CC0 1.0" } }).success).toBe(true);
  });
});

describe("scout wire schemas (signed/relayed; config opaque)", () => {
  const movement = {
    lastKnownLocation: { lat: 47.6, lng: -122.3 },
    locationTimestamp: "2026-06-29T00:00:00Z",
    destination: { lat: 47.7, lng: -122.2 },
    speedKmh: 45,
  };
  const config = {
    type: "relay",
    label: "Relay Scout",
    speedTier: 2,
    rangeMi: 400,
    slots: 2,
  };
  const mintedBy = { id: "did:key:z6MkServer", sig: "sig" };

  it("accepts a well-formed movement", () => {
    expect(movementSchema.safeParse(movement).success).toBe(true);
  });

  it("rejects Infinity / over-ceiling / extra-key speed (it rides inside a signed report)", () => {
    expect(movementSchema.safeParse({ ...movement, speedKmh: Infinity }).success).toBe(false);
    expect(
      movementSchema.safeParse({ ...movement, speedKmh: MAX_SCOUT_SPEED_KMH + 1 }).success,
    ).toBe(false);
    expect(movementSchema.safeParse({ ...movement, surprise: 1 }).success).toBe(false);
  });

  it("refuses the old miles-per-hour `speed` rather than reading it as another unit", () => {
    const { speedKmh, ...rest } = movement;
    expect(movementSchema.safeParse({ ...rest, speed: speedKmh }).success).toBe(false);
  });

  it("scoutConfigSchema is any JSON object: the platform reads no field of a game's config", () => {
    expect(scoutConfigSchema.safeParse(config).success).toBe(true);
    // Another game's config, and values a game's own schema might refuse, all ride through.
    expect(scoutConfigSchema.safeParse({ kind: "drone", range: 4.5, tags: ["a"] }).success).toBe(
      true,
    );
    expect(scoutConfigSchema.safeParse({ ...config, slots: 7, surprise: 1 }).success).toBe(true);
    expect(scoutConfigSchema.safeParse({}).success).toBe(true);
    // Still an object: not an array, a string or null.
    expect(scoutConfigSchema.safeParse(["a"]).success).toBe(false);
    expect(scoutConfigSchema.safeParse("survey").success).toBe(false);
    expect(scoutConfigSchema.safeParse(null).success).toBe(false);
  });

  it("scoutConfigFits counts the UTF-8 bytes of canonical JSON, and refuses what it cannot measure", () => {
    // `{"k":"…"}` is 8 bytes of framing around the value.
    expect(scoutConfigFits({ k: "x".repeat(MAX_SCOUT_CONFIG_BYTES - 8) })).toBe(true);
    expect(scoutConfigFits({ k: "x".repeat(MAX_SCOUT_CONFIG_BYTES - 7) })).toBe(false);
    // Bytes, not characters: "é" is 2 bytes, so this is under the cap in characters and over it in bytes.
    expect(scoutConfigFits({ k: "é".repeat(MAX_SCOUT_CONFIG_BYTES / 2) })).toBe(false);
    // `1e400` parses to Infinity, which canonical JSON cannot express: refused, not thrown.
    expect(scoutConfigFits(JSON.parse('{"k":1e400}'))).toBe(false);
    expect(scoutConfigFits({ k: 1n })).toBe(false);
  });

  it("scoutReportSchema is strict, carries an opaque signed config, and requires mintedBy", () => {
    const report = {
      unique: "s1",
      owner: "did:key:z6MkServer",
      config,
      mintedBy,
      movement,
      reportedAt: "2026-06-29T00:00:00Z",
      expiresAt: "2026-06-29T00:05:00Z",
    };
    expect(scoutReportSchema.safeParse(report).success).toBe(true);
    expect(scoutReportSchema.safeParse({ ...report, config: { kind: "drone" } }).success).toBe(
      true,
    );
    const { mintedBy: _m, ...noMinted } = report;
    expect(scoutReportSchema.safeParse(noMinted).success).toBe(false);
    expect(scoutReportSchema.safeParse({ ...report, surprise: 1 }).success).toBe(false);
    // The envelope's signed game slug rides along when there was one, bounded like the envelope's.
    expect(scoutReportSchema.safeParse({ ...report, game: "example" }).success).toBe(true);
    expect(scoutReportSchema.safeParse({ ...report, game: "a:b" }).success).toBe(false);
    // `derivedStats` left the wire: no server returned it and no client sent it.
    expect(scoutReportSchema.safeParse({ ...report, derivedStats: { speed: 1 } }).success).toBe(
      false,
    );
  });

  it("scoutReportParamsSchema bounds the config where a scout enters a server", () => {
    const params = { unique: "s1", config, mintedBy, movement, expiresAt: "2026-06-29T00:05:00Z" };
    expect(scoutReportParamsSchema.safeParse(params).success).toBe(true);
    expect(
      scoutReportParamsSchema.safeParse({ ...params, config: { kind: "drone" } }).success,
    ).toBe(true);
    const big = { k: "x".repeat(MAX_SCOUT_CONFIG_BYTES) };
    expect(scoutReportParamsSchema.safeParse({ ...params, config: big }).success).toBe(false);
    // Refused, never thrown: a throw inside a refinement escapes `safeParse` as a 500.
    const infinite = JSON.parse('{"k":1e400}');
    expect(scoutReportParamsSchema.safeParse({ ...params, config: infinite }).success).toBe(false);
    expect(scoutReportParamsSchema.safeParse({ ...params, derivedStats: {} }).success).toBe(false);
  });
});

describe("profileDocSchema (monotonic + strict)", () => {
  const profile = {
    id: "did:key:z6MkRoot",
    version: 3,
    displayName: "Alice",
    devices: [
      {
        key: "did:key:z6MkDevice",
        auth: { issued: "2026-06-29T00:00:00Z", sig: "ZmFrZQ" },
      },
    ],
    updated: "2026-06-29T00:00:00Z",
    proof: { type: "Ed25519", key: "did:key:z6MkRoot", sig: "ZmFrZQ" },
  };

  it("parses a versioned profile", () => {
    expect(profileDocSchema.safeParse(profile).success).toBe(true);
  });

  it("requires `version` and rejects unknown top-level keys", () => {
    const { version: _v, ...noVersion } = profile;
    expect(profileDocSchema.safeParse(noVersion).success).toBe(false);
    expect(profileDocSchema.safeParse({ ...profile, surprise: 1 }).success).toBe(false);
  });
});

describe("profileBytes: what the profile size cap counts", () => {
  it("is the UTF-8 length of the canonical JSON, whatever the key order, and counts bytes, not characters", () => {
    const doc = { version: 1, id: "did:key:z6MkRoot", displayName: "Zoë" };
    const reordered = { displayName: "Zoë", id: "did:key:z6MkRoot", version: 1 };
    expect(profileBytes(doc)).toBe(Buffer.byteLength(canonicalJson(doc), "utf8"));
    expect(profileBytes(reordered)).toBe(profileBytes(doc));
    expect(profileBytes(doc)).toBe(canonicalJson(doc).length + 1); // ë is two bytes
    expect(MAX_PROFILE_BYTES).toBe(65_536);
  });

  it("is Infinity for a value nested too deep to canonicalize, so a size check fails closed", () => {
    const deep: unknown = JSON.parse("[".repeat(20_000) + "]".repeat(20_000));
    expect(profileBytes({ id: "did:key:z6MkRoot", deep })).toBe(Infinity);
    // Any other failure is a bug to surface, not a size.
    expect(() => profileBytes({ id: "did:key:z6MkRoot", n: 1n })).toThrow(TypeError);
  });
});

describe("mapDeltaSchema (live map channel)", () => {
  const roomDelta = {
    cell: "c23nb6",
    kind: "room",
    room: { id: "u1@beacon.example", type: "box", location: { lat: 47.6, lng: -122.3 } },
  };

  it("parses room upsert and roomGone", () => {
    expect(mapDeltaSchema.safeParse(roomDelta).success).toBe(true);
    expect(
      mapDeltaSchema.safeParse({ cell: "c23nb6", kind: "roomGone", id: "u1@beacon.example" })
        .success,
    ).toBe(true);
  });

  it("parses scout upsert and scoutGone", () => {
    const scout = {
      cell: "c23nb6",
      kind: "scout",
      scout: {
        id: "s1",
        owner: { id: "did:key:z6MkServer" },
        config: {
          type: "relay",
          label: "Relay Scout",
          speedTier: 2,
          rangeMi: 400,
          slots: 2,
        },
        mintedBy: { id: "did:key:z6MkServer", sig: "sig" },
        movement: {
          lastKnownLocation: { lat: 47.6, lng: -122.3 },
          locationTimestamp: "2026-06-29T00:00:00Z",
          speedKmh: 12,
        },
        expiresAt: "2026-06-29T00:05:00Z",
      },
    };
    expect(mapDeltaSchema.safeParse(scout).success).toBe(true);
    expect(mapDeltaSchema.safeParse({ cell: "c23nb6", kind: "scoutGone", id: "s1" }).success).toBe(
      true,
    );
  });

  it("rejects a bad cell, an unknown kind, and extra keys", () => {
    expect(mapDeltaSchema.safeParse({ ...roomDelta, cell: "AIO!" }).success).toBe(false); // not geohash
    expect(mapDeltaSchema.safeParse({ ...roomDelta, kind: "wat" }).success).toBe(false);
    expect(mapDeltaSchema.safeParse({ ...roomDelta, surprise: 1 }).success).toBe(false);
  });
});

describe("serverDescriptorSchema", () => {
  const base = {
    host: "beacon.example",
    key: "did:key:z6MkServer",
    coverage: ["9q5", "9q4c"],
    name: "Beacon Example",
    description: "A test server for the playtest.",
    contact: "admin@beacon.example",
    version: "0.0.1",
    startedAt: "2026-06-26T00:00:00Z",
    accessLevel: "open",
    updated: "2026-06-26T00:00:00Z",
    proof: { type: "Ed25519", key: "did:key:z6MkServer", sig: "ZmFrZQ" },
  };

  it("parses a signed descriptor (name/description/contact optional)", () => {
    expect(serverDescriptorSchema.safeParse(base).success).toBe(true);
    const { description, contact, name, ...required } = base;
    expect(serverDescriptorSchema.safeParse(required).success).toBe(true);
  });

  it("rejects an unknown access level and removed keys (strict)", () => {
    expect(serverDescriptorSchema.safeParse({ ...base, accessLevel: "vip" }).success).toBe(false);
    // `endpoints` was removed in the descriptor overhaul — `.strict()` rejects it.
    expect(serverDescriptorSchema.safeParse({ ...base, endpoints: {} }).success).toBe(false);
  });

  it("accepts an optional capabilities list (mailbox / media advertisement)", () => {
    // Re-added for the mailbox/media capabilities (beacon.server `doc/spec/mailbox-and-media.md` §3.1): optional, so a
    // descriptor without it still parses, and a listed capability is accepted.
    expect(
      serverDescriptorSchema.safeParse({ ...base, capabilities: ["mailbox", "media"] }).success,
    ).toBe(true);
    expect(serverDescriptorSchema.safeParse(base).success).toBe(true); // absent is fine
  });
});

describe("admin media wire schemas (beacon.server admin-api §3)", () => {
  const owner = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

  it("adminMediaListParams: all fields optional, strict, bounded, filter enum", () => {
    expect(adminMediaListParamsSchema.safeParse({}).success).toBe(true); // an empty query is valid
    expect(
      adminMediaListParamsSchema.safeParse({
        cursor: "abc",
        limit: 50,
        owner,
        type: "image/png",
        reviewed: "unreviewed",
      }).success,
    ).toBe(true);
    expect(adminMediaListParamsSchema.safeParse({ limit: 0 }).success).toBe(false); // min 1
    expect(adminMediaListParamsSchema.safeParse({ limit: 101 }).success).toBe(false); // max 100
    expect(adminMediaListParamsSchema.safeParse({ reviewed: "maybe" }).success).toBe(false); // enum
    expect(adminMediaListParamsSchema.safeParse({ extra: 1 }).success).toBe(false); // strict
  });

  it("adminMediaList result round-trips a page + optional cursor", () => {
    const page = {
      items: [
        {
          hash: "h1",
          type: "image/png",
          size: 10,
          owner,
          uploadedAt: "2026-07-01T00:00:00.000Z",
          lastAccessAt: null,
          reviewedAt: null,
          reviewedBy: null,
        },
      ],
      nextCursor: "cursor-token",
    };
    const parsed = adminMediaListSchema.parse(page);
    expect(parsed).toEqual(page);
    // nextCursor is optional (last page omits it).
    expect(adminMediaListSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it("adminMediaReviewParams: hash + boolean required, reason optional, strict", () => {
    expect(adminMediaReviewParamsSchema.safeParse({ hash: "h1", reviewed: true }).success).toBe(
      true,
    );
    expect(
      adminMediaReviewParamsSchema.safeParse({ hash: "h1", reviewed: false, reason: "spam" })
        .success,
    ).toBe(true);
    expect(adminMediaReviewParamsSchema.safeParse({ hash: "h1" }).success).toBe(false); // reviewed required
    expect(adminMediaReviewParamsSchema.safeParse({ hash: "h1", reviewed: "yes" }).success).toBe(
      false,
    ); // boolean only
  });
});

describe("the reaction wire (beacon.server room-operation §9.6)", () => {
  const target = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  it("reactParams: both fields required, both bounded, nothing else carried", () => {
    expect(reactParamsSchema.safeParse({ target, kind: "love" }).success).toBe(true);
    expect(reactParamsSchema.safeParse({ target }).success).toBe(false); // kind required
    expect(reactParamsSchema.safeParse({ kind: "love" }).success).toBe(false); // target required
    expect(reactParamsSchema.safeParse({ target, kind: "" }).success).toBe(false);
    expect(reactParamsSchema.safeParse({ target: "", kind: "love" }).success).toBe(false);
  });

  it("bounds `target` and `kind` at their stated maxima, which the ledger's size math rests on", () => {
    // MAX_OP_LEDGER (@beaconsgg/policy-engine) prices a full ledger against exactly these two numbers,
    // so a room's worst-case blob is only as honest as the bounds here.
    const at = (n: number) => "t".repeat(n);
    expect(
      reactParamsSchema.safeParse({ target: at(MAX_REACTION_TARGET_LEN), kind: "love" }).success,
    ).toBe(true);
    expect(
      reactParamsSchema.safeParse({ target: at(MAX_REACTION_TARGET_LEN + 1), kind: "love" })
        .success,
    ).toBe(false);
    expect(reactParamsSchema.safeParse({ target, kind: at(MAX_REACTION_KIND_LEN) }).success).toBe(
      true,
    );
    expect(
      reactParamsSchema.safeParse({ target, kind: at(MAX_REACTION_KIND_LEN + 1) }).success,
    ).toBe(false);
    // A did:key target is the longest thing the engine can resolve, and it fits with room to spare.
    expect(MAX_REACTION_TARGET_LEN).toBeGreaterThan(73);
  });

  it("opRule.max is optional and POSITIVE: `0` is not a way to say `no reactions here`", () => {
    expect(opRuleSchema.safeParse({ role: "contributor" }).success).toBe(true);
    expect(opRuleSchema.safeParse({ role: "contributor", max: 100 }).success).toBe(true);
    // `0` would place a room whose every react is refused `full` with a message that is not true.
    // Omitting `ops.react` already says "no reactions here", and answers `denied` accurately.
    expect(opRuleSchema.safeParse({ role: "contributor", max: 0 }).success).toBe(false);
    expect(opRuleSchema.safeParse({ role: "contributor", max: -1 }).success).toBe(false);
    expect(opRuleSchema.safeParse({ role: "contributor", max: 1.5 }).success).toBe(false);
  });
});
