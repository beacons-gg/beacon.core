/**
 * A policy's `claimTtl` is a duration the engine can read: a placement whose claim window it could not
 * read is refused rather than run with no window.
 */
import { describe, expect, it } from "vitest";
import { parseDuration, policySchema, readVariant, type Policy } from "../index";

const policy: Policy = { ops: { claim: { role: "contributor" } }, claimTtl: "7d" };

describe("claimTtl is a duration", () => {
  it.each([
    ["45s", 45],
    ["30m", 1_800],
    ["12h", 43_200],
    ["7d", 604_800],
    ["3650d", 315_360_000], // the transition horizon, 10 years of 365 days
  ])("reads %j as %i seconds", (ttl, seconds) => {
    expect(parseDuration(ttl)).toBe(seconds);
    expect(policySchema.safeParse({ ...policy, claimTtl: ttl }).success).toBe(true);
  });

  it.each([
    "",
    "7",
    "d",
    "7w",
    "1.5h",
    "-1d",
    "7 d",
    " 7d ",
    "7d\n",
    "7D",
    "7days",
    "P7D",
    "0d",
    "3651d",
    "9".repeat(400) + "d",
  ])("refuses %j, so the placement fails instead of running with no claim window", (ttl) => {
    expect(parseDuration(ttl)).toBeUndefined();
    expect(policySchema.safeParse({ ...policy, claimTtl: ttl }).success).toBe(false);
  });

  it("reads a stored value that is not a duration as absent, without failing the read", () => {
    const parsed = readVariant(policySchema).parse({ ...policy, claimTtl: "1w" });
    expect(parsed.claimTtl).toBeUndefined();
  });
});
