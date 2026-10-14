import { expect, mock } from "bun:test";
import { CAPABILITY_MAX_RESULT_BYTES, type CapabilityExecutionContext, type CapabilityResult } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { requireInfra, testFor } from "../../../scripts/fixtures/test-infra";
import { assertPrivateDatabase } from "../test/private-database";
import type { FileEntry } from "./contracts";
import { resolveEntryRefId } from "./data/references";
import { FilesError } from "./service/errors";

const base = {
  id: "cloud:users:11111111-1111-4111-8111-111111111111",
  name: "Home",
  area: "cloud" as const,
};
const folder = "Ordner ä/".repeat(100).slice(0, -1);
let saved: FileEntry = { name: "Ordner ä", path: folder, directory: true, size: 0, modified: "2026-09-19" };
mock.module("./service", () => ({
  FilesError,
  filesService: {
    mkdir: async () => ({ base, entry: saved }),
    capabilityUpload: async (_actor: unknown, _input: unknown, body: ReadableStream<Uint8Array>) => {
      await body.cancel();
      return { base, entry: saved };
    },
    capabilityUploadStatus: async () => ({ state: "completed", entry: saved }),
    entryById: async (_actor: unknown, id: string) => {
      const ref = await resolveEntryRefId(id);
      if (ref?.baseId !== base.id || ref.path !== saved.path) throw new FilesError("not_found", 404);
      return { base, entry: saved };
    },
  },
}));
const { filesCapabilities } = await import("./capabilities");
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "alice",
  roles: ["user" as const],
  provider: "local" as const,
  profile: "user" as const,
  givenname: "Alice",
  sn: "Example",
  displayName: "Alice",
  mail: "alice@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const context: CapabilityExecutionContext = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  requestId: "test",
  origin: "app",
  signal: new AbortController().signal,
  idempotencyKey: "change-key",
};

testFor("database")("folder and completed upload refs persist long paths for the canonical reader", async () => {
  await requireInfra("database");
  await assertPrivateDatabase();
  await sql`CREATE SCHEMA IF NOT EXISTS filesv2`.simple();
  await sql`CREATE TABLE IF NOT EXISTS filesv2.entry_references(id TEXT PRIMARY KEY, base_id TEXT NOT NULL, path TEXT NOT NULL)`.simple();
  const assertRef = async (result: CapabilityResult<unknown>) => {
    const ref = result.refs?.[0];
    if (!ref) throw new Error("expected persisted entry ref");
    expect(result.refs).toEqual([{ type: "filesv2.entry", id: ref.id, title: saved.name }]);
    expect(ref.id).toMatch(/^p:[a-f0-9]{64}$/);
    expect(await resolveEntryRefId(ref.id)).toEqual({ baseId: base.id, path: saved.path });
    const reader = filesCapabilities.queries["entry.read"];
    const read = await reader.run(reader.input.parse({ id: ref.id }), context);
    if (!read.ok) throw new Error("expected reader success");
    expect(read.data.data).toMatchObject({ name: saved.name, path: saved.path, base });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
  };
  const created = await filesCapabilities.actions["folder.create"].run({ baseId: base.id, path: folder }, context);
  if (!created.ok) throw new Error("expected created folder");
  await assertRef(created.data);

  saved = { name: "Änderungen.csv", path: `${folder}/Änderungen.csv`, directory: false, size: 4, modified: "2026-09-19" };
  for (const actionId of ["content.create", "provider.save"] as const) {
    const offer = {
      id: JSON.stringify({ baseId: base.id, id: "22222222-2222-4222-8222-222222222222" }),
      direction: "write" as const,
      name: saved.name,
      mediaType: "text/csv",
      size: saved.size,
      expiresAt: "2026-09-19T01:00:00Z",
    };
    const stream = filesCapabilities.actions[actionId].stream!;
    const receipt = await stream.write(offer, new Blob(["data"]).stream(), context);
    await assertRef(receipt);
    const status = await stream.status(offer, context);
    if (status.state !== "completed") throw new Error("expected completed upload");
    expect(status.result).toEqual(receipt);
    await assertRef(status.result);
  }
});
