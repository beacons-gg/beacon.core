/**
 * hex.ts: the stored form of a key seed.
 */
import { describe, expect, it } from "vitest";
import { fromHex, toHex } from "../hex";

describe("hex", () => {
  it("round-trips bytes", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    expect(toHex(bytes)).toBe("00017f80ff");
    expect(fromHex("00017F80ff")).toEqual(bytes);
  });

  it("refuses an odd length or a non-hex character instead of producing zeroed bytes", () => {
    expect(() => fromHex("abc")).toThrow("invalid hex");
    expect(() => fromHex("zz")).toThrow("invalid hex");
  });
});
