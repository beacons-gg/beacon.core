/**
 * Game-scoped content (`doc/spec/discovery.md` §3.2 and beacon.server `doc/spec/room-operation.md`
 * §8.2): a room belongs to the game that placed it, and its policy opens ops to other games one op
 * at a time.
 */
import { describe, expect, it } from "vitest";
import {
  ANY_GAME,
  errorCodeSchema,
  MAX_RULE_GAMES,
  discoveryQuerySchema,
  discoveryResponseSchema,
  gameMayApply,
  roomSummarySchema,
  opRuleSchema,
  roomSchema,
  type Policy,
} from "../index";
import { CODE_FALLBACKS, roomGames, roomOpenToGame } from "../server";

const policy: Policy = {
  ops: {
    list: { role: "public", games: [ANY_GAME] },
    add: { role: "public", games: ["game-b"] },
    take: { role: "public" },
  },
};
const room = { game: "game-a", policy };

describe("opRuleSchema.games", () => {
  it("takes slugs, or the any-game entry on its own", () => {
    expect(opRuleSchema.safeParse({ role: "public", games: ["game-b", "c/2"] }).success).toBe(true);
    expect(opRuleSchema.safeParse({ role: "public", games: [ANY_GAME] }).success).toBe(true);
  });

  it("refuses the any-game entry beside slugs, which would mean the same thing twice", () => {
    expect(opRuleSchema.safeParse({ role: "public", games: [ANY_GAME, "game-b"] }).success).toBe(
      false,
    );
  });

  it("refuses an empty list, a malformed slug, a repeat and an unbounded list", () => {
    expect(opRuleSchema.safeParse({ role: "public", games: [] }).success).toBe(false);
    expect(opRuleSchema.safeParse({ role: "public", games: ["b", "b"] }).success).toBe(false);
    expect(opRuleSchema.safeParse({ role: "public", games: ["Game B"] }).success).toBe(false);
    const many = Array.from({ length: MAX_RULE_GAMES + 1 }, (_, i) => `g${i}`);
    expect(opRuleSchema.safeParse({ role: "public", games: many }).success).toBe(false);
  });
});

describe("gameMayApply", () => {
  it("lets the owning game apply every op, listed or not", () => {
    for (const op of ["list", "add", "take", "claim"]) {
      expect(gameMayApply(room, op, "game-a")).toBe(true);
    }
  });

  it("lets another game apply only the ops opened to it or to every game", () => {
    expect(gameMayApply(room, "list", "game-c")).toBe(true); // any game
    expect(gameMayApply(room, "add", "game-b")).toBe(true); // named
    expect(gameMayApply(room, "add", "game-c")).toBe(false);
    expect(gameMayApply(room, "take", "game-b")).toBe(false); // owner only
  });

  it("lets no game act without a slug", () => {
    expect(gameMayApply(room, "list", undefined)).toBe(false);
  });

  it("lets nobody act on a room that predates the slug, unless it opens an op", () => {
    expect(gameMayApply({ policy: { ops: { take: { role: "public" } } } }, "take", "game-a")).toBe(
      false,
    );
    expect(gameMayApply({ policy }, "list", "game-a")).toBe(true);
  });

  it("finds no rule under an Object.prototype name", () => {
    expect(gameMayApply(room, "toString", "game-b")).toBe(false);
  });
});

describe("roomOpenToGame", () => {
  it("is true for the owning game and for any game the room opens an op to", () => {
    expect(roomOpenToGame(room, "game-a")).toBe(true);
    expect(roomOpenToGame(room, "game-c")).toBe(true); // `list` is open to every game
    expect(
      roomOpenToGame({ game: "game-a", policy: { ops: { add: policy.ops["add"]! } } }, "game-b"),
    ).toBe(true);
  });

  it("is false for a game the room opens nothing to", () => {
    const closed = { game: "game-a", policy: { ops: { take: { role: "public" as const } } } };
    expect(roomOpenToGame(closed, "game-b")).toBe(false);
  });
});

describe("roomGames", () => {
  it("lists the room's own game and every game an op names, once each", () => {
    const ops = {
      add: { role: "public" as const, games: ["game-b"] },
      take: { role: "public" as const, games: ["game-b", "game-c"] },
    };
    expect(roomGames({ game: "game-a", policy: { ops } })).toEqual(["game-a", "game-b", "game-c"]);
  });

  it("is every game when one op is open to all, and nobody for a room with no game that opens nothing", () => {
    expect(roomGames(room)).toEqual([ANY_GAME]);
    expect(roomGames({ policy: { ops: { take: { role: "public" } } } })).toEqual([]);
  });

  it("agrees with roomOpenToGame for every game", () => {
    const rooms = [
      room,
      { game: "game-a", policy: { ops: { add: policy.ops["add"]! } } },
      { policy },
    ];
    for (const r of rooms) {
      const games = roomGames(r);
      for (const game of ["game-a", "game-b", "game-c"]) {
        expect(games.includes(ANY_GAME) || games.includes(game)).toBe(roomOpenToGame(r, game));
      }
    }
  });
});

describe("the game on the wire", () => {
  const base = {
    id: "01JC0000000000000000000000@example.test",
    type: "jar",
    location: { lat: 1, lng: 2 },
  };

  it("carries a room's game, and reads a room from before the slug", () => {
    const placed = {
      ...base,
      version: 0,
      state: {},
      policy,
      placedBy: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    };
    expect(roomSchema.parse({ ...placed, game: "game-a" }).game).toBe("game-a");
    expect(roomSchema.parse(placed).game).toBeUndefined();
    expect(roomSchema.safeParse({ ...placed, game: "Game A" }).success).toBe(false);
  });

  it("carries a summary's game, so a client can tell its rooms from rooms opened to it", () => {
    expect(roomSummarySchema.parse({ ...base, game: "game-a" }).game).toBe("game-a");
  });

  it("filters discovery by slug", () => {
    expect(discoveryQuerySchema.parse({ cells: ["9q8yy"], games: ["game-a"] }).games).toEqual([
      "game-a",
    ]);
    expect(discoveryQuerySchema.safeParse({ cells: ["9q8yy"], games: ["*"] }).success).toBe(false);
    expect(discoveryQuerySchema.safeParse({ cells: ["9q8yy"], games: [] }).success).toBe(false);
  });

  it("bounds the query as a server does", () => {
    const cells = (n: number) => Array.from({ length: n }, () => "9q8yy");
    const ok = (query: object) => discoveryQuerySchema.safeParse(query).success;
    expect(ok({ cells: cells(256) })).toBe(true);
    expect(ok({ cells: cells(257) })).toBe(false);
    expect(ok({ cells: [] })).toBe(false);
    expect(ok({ cells: ["9q8y%"] })).toBe(false);
    expect(ok({ cells: ["9Q8YY"] })).toBe(false);
    expect(ok({ cells: ["9q8yy"], types: [] })).toBe(true);
    expect(ok({ cells: ["9q8yy"], types: Array.from({ length: 16 }, () => "bag") })).toBe(true);
    expect(ok({ cells: ["9q8yy"], types: Array.from({ length: 17 }, () => "bag") })).toBe(false);
    expect(ok({ cells: ["9q8yy"], types: [""] })).toBe(false);
    expect(ok({ cells: ["9q8yy"], types: ["x".repeat(33)] })).toBe(false);
    const games = (n: number) => Array.from({ length: n }, (_, i) => `game-${i}`);
    expect(ok({ cells: ["9q8yy"], games: games(16) })).toBe(true);
    expect(ok({ cells: ["9q8yy"], games: games(17) })).toBe(false);
  });

  it("has no paging: limit and cursor are gone from the query and the reply", () => {
    const query = discoveryQuerySchema.parse({ cells: ["9q8yy"], limit: 10, cursor: "c" });
    expect(query).toEqual({ cells: ["9q8yy"] });
    const reply = { coveredBy: "srv", rooms: [], scouts: [] };
    expect(discoveryResponseSchema.parse({ ...reply, cursor: "c" })).toEqual(reply);
  });

  it("falls a refusal back to the room's own refusal, never the whole server's", () => {
    // `gameNotAdmitted` tells a client to stop writing to the server; this is one room and one op.
    expect(CODE_FALLBACKS.gameNotAccepted).toBe("denied");
  });

  it("names the server's game refusal gameNotAdmitted, with no alias for the old name", () => {
    expect(errorCodeSchema.safeParse("gameNotAdmitted").success).toBe(true);
    expect(errorCodeSchema.safeParse("appDenied").success).toBe(false);
  });
});
