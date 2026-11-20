import { describe, expect, it } from "vitest";
import {
  MAX_MAILBOX_BODY,
  mailboxBodyBytes,
  mailboxFetchParamsSchema,
  mailboxSendParamsSchema,
} from "../index";

const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("mailboxBodyBytes", () => {
  it("counts UTF-8 bytes, as TextEncoder does", () => {
    for (const body of ["", "hi", "é", "€", "😀", "a😀b€é", "\ud800", "x\udc00y", "\ud83d"]) {
      expect(mailboxBodyBytes(body)).toBe(new TextEncoder().encode(body).length);
    }
  });
});

describe("mailboxSendParamsSchema", () => {
  const send = (body: string) => mailboxSendParamsSchema.safeParse({ to: DID, body }).success;

  it("takes a body of exactly MAX_MAILBOX_BODY bytes", () => {
    expect(send("a".repeat(MAX_MAILBOX_BODY))).toBe(true);
    expect(send("😀".repeat(MAX_MAILBOX_BODY / 4))).toBe(true);
  });

  it("refuses a body over MAX_MAILBOX_BODY bytes, though it has fewer characters", () => {
    expect(send("a".repeat(MAX_MAILBOX_BODY + 1))).toBe(false);
    // 1025 emoji: 2050 UTF-16 units, 4100 bytes.
    expect(send("😀".repeat(MAX_MAILBOX_BODY / 4 + 1))).toBe(false);
    expect(send("é".repeat(MAX_MAILBOX_BODY / 2 + 1))).toBe(false);
  });
});

describe("mailboxFetchParamsSchema", () => {
  it("takes the empty object the SDK sends, and refuses any key", () => {
    expect(mailboxFetchParamsSchema.safeParse({}).success).toBe(true);
    expect(mailboxFetchParamsSchema.safeParse({ since: 1 }).success).toBe(false);
    expect(mailboxFetchParamsSchema.safeParse(null).success).toBe(false);
  });
});
