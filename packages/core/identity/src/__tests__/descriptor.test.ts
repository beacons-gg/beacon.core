import { readAccessLevel, type ServerAccessLevel } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import { createAccount, signDescriptor, verifyDescriptor } from "../index";

describe("server descriptor (sign / verify)", () => {
  const body = (key: string) => ({
    host: "localhost:3017",
    key,
    coverage: [""],
    name: "Test Server",
    version: "0.0.1",
    startedAt: "2026-06-30T00:00:00Z",
    accessLevel: "open" as const,
    updated: "2026-06-30T00:00:00Z",
  });

  it("signs a descriptor the verifier accepts", () => {
    const account = createAccount();
    expect(verifyDescriptor(signDescriptor(account, body(account.did)))).toBe(true);
  });

  it("rejects a tampered body (the signature no longer matches)", () => {
    const account = createAccount();
    const desc = signDescriptor(account, body(account.did));
    expect(verifyDescriptor({ ...desc, coverage: ["evil"] })).toBe(false);
  });

  it("accepts a field this build does not know when the server signed it", () => {
    // A newer server's descriptor. The signature covers the whole body, unknown field included, so
    // the field stays under the signature it checked; what this build cannot read it ignores.
    const account = createAccount();
    const newer = signDescriptor(account, { ...body(account.did), region: "eu" } as never);
    const raw: unknown = JSON.parse(JSON.stringify(newer));
    expect(verifyDescriptor(raw)).toBe(true);
    if (verifyDescriptor(raw)) expect(raw.host).toBe("localhost:3017"); // narrowed, and untouched
  });

  it("accepts an access level this build does not know, which reads as private", () => {
    // A fourth level used to fail the shape check, and the server became unaddable.
    const account = createAccount();
    const newer = signDescriptor(account, {
      ...body(account.did),
      accessLevel: "friends",
    } as never);
    const raw: unknown = JSON.parse(JSON.stringify(newer));
    expect(verifyDescriptor(raw)).toBe(true);
    // The signed body as received, still verifiable; `readAccessLevel` is what this build acts on.
    // The type says so too: the narrowed level is any string, not the enum.
    if (verifyDescriptor(raw)) {
      // @ts-expect-error: a received level is not a `ServerAccessLevel` until `readAccessLevel` reads it
      expect<ServerAccessLevel>(raw.accessLevel).toBe("friends");
      expect<ServerAccessLevel>(readAccessLevel(raw.accessLevel)).toBe("private");
    }
    // Still signed: the level is covered like every other field.
    expect(verifyDescriptor({ ...newer, accessLevel: "open" })).toBe(false);
  });

  it("rejects a field added after signing, exactly like any other tamper", () => {
    const account = createAccount();
    const desc = signDescriptor(account, body(account.did));
    expect(verifyDescriptor({ ...desc, region: "eu" })).toBe(false);
  });

  it("refuses a value canonical JSON has no form for, never a throw", () => {
    // A newer-field slot the read schema lets through, holding a `1e400` that parses to Infinity.
    const account = createAccount();
    const desc = signDescriptor(account, { ...body(account.did), region: 1 } as never);
    const raw: unknown = JSON.parse(JSON.stringify(desc).replace('"region":1', '"region":1e400'));
    expect(verifyDescriptor(raw)).toBe(false);
  });

  it("rejects a body that does not conform, before any crypto", () => {
    const account = createAccount();
    const { host: _host, ...missingHost } = signDescriptor(account, body(account.did));
    expect(verifyDescriptor(missingHost)).toBe(false);
    expect(verifyDescriptor(null)).toBe(false);
    expect(verifyDescriptor("not a descriptor")).toBe(false);
  });

  it("rejects a proof whose key isn't the server's own key", () => {
    const account = createAccount();
    const other = createAccount();
    const desc = signDescriptor(account, body(account.did));
    expect(verifyDescriptor({ ...desc, proof: { ...desc.proof, key: other.did } })).toBe(false);
  });
});
