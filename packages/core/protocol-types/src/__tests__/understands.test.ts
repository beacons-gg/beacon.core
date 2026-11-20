/**
 * Capability markers: what a client declares, and what a server sends it in return.
 */
import { describe, expect, it } from "vitest";
import * as root from "../index";
import { ERROR_CODES, formatUnderstands, serviceCapabilities } from "../index";
import * as server from "../server";
import { CODE_FALLBACKS, NOT_FOUND_FALLBACKS, codeFor, parseUnderstands } from "../server";

describe("the client's declaration", () => {
  it("round-trips a list of markers", () => {
    const header = formatUnderstands(["code:deviceRevoked", "code:clockSkew"]);
    expect([...parseUnderstands(header)]).toEqual(["code:deviceRevoked", "code:clockSkew"]);
  });

  it("reads a repeated header, and tolerates spaces", () => {
    expect([...parseUnderstands(["code:clockSkew", " code:deviceRevoked "])]).toEqual([
      "code:clockSkew",
      "code:deviceRevoked",
    ]);
  });

  it("reads anything malformed as declaring nothing, which is always safe", () => {
    // Untrusted, on every request. Declaring too little only ever costs the caller a fallback.
    expect(parseUnderstands(undefined).size).toBe(0);
    expect(parseUnderstands(42).size).toBe(0);
    expect(parseUnderstands("x".repeat(5000)).size).toBe(0);
    expect([...parseUnderstands("code:clockSkew,not a marker,:empty,CODE:x")]).toEqual([
      "code:clockSkew",
    ]);
  });

  it("keeps a bounded number of markers", () => {
    const many = Array.from({ length: 200 }, (_, i) => `code:c${i}`).join(",");
    expect(parseUnderstands(many).size).toBe(64);
  });
});

describe("what the server sends back", () => {
  const none = parseUnderstands(undefined);

  it("sends a new code only to a client that declared it", () => {
    expect(codeFor("deviceRevoked", parseUnderstands("code:deviceRevoked"))).toBe("deviceRevoked");
    expect(codeFor("deviceRevoked", none)).toBe("denied");
    expect(codeFor("clockSkew", parseUnderstands("code:deviceRevoked"))).toBe("invalid");
  });

  it("sends a baseline code as it is, declared or not", () => {
    expect(codeFor("denied", none)).toBe("denied");
    expect(codeFor("unknownRoute", none)).toBe("unknownRoute");
    expect(codeFor("unknownRoute", none, { status: 404 })).toBe("unknownRoute");
  });

  it("sends a 404 that names a missing thing as unknownRoute, unless the client declared it", () => {
    for (const code of Object.keys(NOT_FOUND_FALLBACKS)) {
      expect(codeFor(code, none, { status: 404 })).toBe("unknownRoute");
      expect(codeFor(code, parseUnderstands(`code:${code}`), { status: 404 })).toBe(code);
      expect(ERROR_CODES).toContain(code);
    }
  });

  it("leaves those codes alone at another status, and without a status as before", () => {
    // `places.propose` has always answered 400 `unknownPlace` and `unknownMedia` to every client.
    expect(codeFor("unknownPlace", none, { status: 400 })).toBe("unknownPlace");
    expect(codeFor("unknownMedia", none)).toBe("unknownMedia");
    // A 404 with a code that has an ordinary fallback still takes it.
    expect(codeFor("deviceRevoked", none, { status: 404 })).toBe("denied");
  });

  it("reads only the table's own entries, never the prototype's", () => {
    expect(codeFor("toString", none)).toBe("toString");
    expect(codeFor("__proto__", none)).toBe("__proto__");
  });

  it("falls back only to baseline codes, so one step is always enough", () => {
    for (const fallback of [
      ...Object.values(CODE_FALLBACKS),
      ...Object.values(NOT_FOUND_FALLBACKS),
    ]) {
      expect(ERROR_CODES).toContain(fallback);
      expect(Object.keys(CODE_FALLBACKS)).not.toContain(fallback);
    }
  });
});

describe("serviceCapabilities keeps markers off the player's list", () => {
  it("drops every namespaced marker, including ones this build has never heard of", () => {
    expect(
      serviceCapabilities(["mailbox", "game:example", "op:unreact", "policy:cooldown"]),
    ).toEqual(["mailbox"]);
  });
});

describe("the server-only helpers", () => {
  const moved = [
    "parseUnderstands",
    "codeFor",
    "CODE_FALLBACKS",
    "NOT_FOUND_FALLBACKS",
    "unknownFields",
    "paramsRefusal",
    "policyFeatures",
    "opMarkers",
    "policyMarkers",
    "ruleMarkers",
    "roomGames",
    "roomOpenToGame",
  ];

  it("come from @beaconsgg/protocol-types/server and not from the root a game imports", () => {
    for (const name of moved) {
      expect(server).toHaveProperty(name);
      expect(root).not.toHaveProperty(name);
    }
    // What a client uses stays in the root.
    for (const name of ["UNDERSTANDS_HEADER", "formatUnderstands", "ERROR_CODES", "acceptsOp"])
      expect(root).toHaveProperty(name);
  });
});
