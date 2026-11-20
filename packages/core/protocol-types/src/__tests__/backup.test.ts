import { describe, expect, it } from "vitest";
import {
  adminBackupStartParamsSchema,
  backupManifestReadSchema,
  backupManifestSchema,
  backupRunSchema,
  backupS3TargetSchema,
  httpUrlSchema,
} from "../index";

const target = {
  region: "auto",
  bucket: "backups",
  prefix: "servers/old-host",
  accessKeyId: "key",
  secretAccessKey: "secret",
  forcePathStyle: false,
};

const manifest = {
  format: 1,
  createdAt: "2026-11-08T00:00:00.000Z",
  host: "play.example.com",
  did: "did:key:z6MkServer",
  schemaVersion: 26,
  serverVersion: "1.2.3",
  locked: true,
  identity: true,
  tables: [{ name: "rooms", columns: ["id", "data"], rows: 2, bytes: 40, file: "db/1/rooms.copy" }],
  media: { count: 1, bytes: 9, missing: 0 },
};

describe("the S3 target", () => {
  it("takes a prefix of relative segments, with or without a trailing slash", () => {
    for (const prefix of ["a", "a/b", "2026-11-08_old.host"]) {
      expect(backupS3TargetSchema.safeParse({ ...target, prefix }).success).toBe(true);
    }
  });

  it.each(["", "/a", "a/", "a//b", "../a", "a/../b", "a/.", "a b"])(
    "refuses the prefix %j",
    (prefix) => {
      expect(backupS3TargetSchema.safeParse({ ...target, prefix }).success).toBe(false);
    },
  );

  it("is optional about the endpoint, and takes only a URL there", () => {
    expect(
      backupS3TargetSchema.safeParse({ ...target, endpoint: "https://s3.example.com" }).success,
    ).toBe(true);
    expect(backupS3TargetSchema.safeParse({ ...target, endpoint: "s3.example.com" }).success).toBe(
      false,
    );
  });

  it.each(["https://key:secret@s3.example.com", "https://s3.example.com/?token=a"])(
    "refuses a credential in the endpoint: %s",
    (endpoint) => {
      expect(backupS3TargetSchema.safeParse({ ...target, endpoint }).success).toBe(false);
    },
  );

  it.each([{ bucket: "a/b" }, { bucket: "" }, { region: "x.evil#" }])("refuses %j", (bad) => {
    expect(backupS3TargetSchema.safeParse({ ...target, ...bad }).success).toBe(false);
  });
});

describe("httpUrlSchema", () => {
  it("refuses what is not a URL, without throwing", () => {
    expect(httpUrlSchema(100).safeParse("not a url").success).toBe(false);
  });
});

describe("a backup run", () => {
  const run = {
    id: "01JZ0000000000000000000000",
    kind: "backup",
    status: "running",
    requestedBy: "did:key:z6MkAdmin",
    target: { region: "auto", bucket: "backups", prefix: "a" },
    createdAt: "2026-11-08T00:00:00.000Z",
  };

  it("parses without credentials", () => {
    expect(backupRunSchema.safeParse(run).success).toBe(true);
  });

  it.each(["accessKeyId", "secretAccessKey"])("cannot carry %s", (field) => {
    const withSecret = { ...run, target: { ...run.target, [field]: "x" } };
    expect(backupRunSchema.safeParse(withSecret).success).toBe(false);
  });
});

describe("the manifest", () => {
  it("parses", () => {
    expect(backupManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("reads a later format, so a server can refuse it in words", () => {
    const later = { ...manifest, format: 2 };
    expect(backupManifestReadSchema.safeParse(later).success).toBe(true);
  });

  it.each([
    { name: 'rooms"; drop table x; --' },
    { columns: ["id; drop"] },
    { file: "../other/db/1/rooms.copy" },
  ])("refuses a hostile table entry %j", (bad) => {
    const tables = [{ ...manifest.tables[0], ...bad }];
    expect(backupManifestReadSchema.safeParse({ ...manifest, tables }).success).toBe(false);
  });

  it("reads past a field added later", () => {
    expect(backupManifestReadSchema.safeParse({ ...manifest, addedLater: 1 }).success).toBe(true);
  });
});

describe("start params", () => {
  it("must say whether the key goes in", () => {
    expect(adminBackupStartParamsSchema.safeParse({ target }).success).toBe(false);
    expect(adminBackupStartParamsSchema.safeParse({ target, includeIdentity: false }).success).toBe(
      true,
    );
  });
});
