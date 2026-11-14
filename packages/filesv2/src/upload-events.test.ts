import { expect, test } from "bun:test";
import { appEventFixture, createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { filesEvents, uploadEventScope } from "./app-events";
import { filesCapabilities } from "./capabilities";
import { entryRefId, stableEntryRefId } from "./resource-ref";

const baseId = "cloud:users:11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";

test("Files declares reference-only file arrivals with its public entry reader for subject and place", () => {
  const harness = createAppEventTestHarness("filesv2", filesCapabilities);
  for (const localId of ["entry.created", "entry.replaced"]) {
    expect(harness.manifest.events ?? []).toContainEqual(
      expect.objectContaining({ localId, version: 1, subject: "entry", place: "entry" }),
    );
  }
  expect(filesCapabilities.types.entry.reader).toBe("entry.read");
});

test("Files envelopes accept stable and path refs and reject names or content in data", () => {
  createAppEventTestHarness("filesv2", filesCapabilities);
  for (const localId of ["entry.created", "entry.replaced"] as const) {
    for (const stable of [false, true]) {
      const subject = (stable ? stableEntryRefId(baseId, fileId) : entryRefId(baseId, "inbox/invoice.pdf"))!;
      const place = (stable ? stableEntryRefId(baseId, folderId) : entryRefId(baseId, "inbox"))!;
      const event = appEventFixture(filesCapabilities, localId, { subject, place, data: {} });
      expect(event).toMatchObject({
        type: `filesv2.${localId}`,
        subject: { type: "filesv2.entry", id: subject },
        place: { type: "filesv2.entry", id: place },
        data: {},
      });
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(512);
      expect(() => filesEvents[localId].schema.parse({ name: "invoice.pdf" })).toThrow();
    }
  }
});

test("upload scope uses the same stable folder ref as the entry reader", async () => {
  const scope = await uploadEventScope(
    { id: baseId, stableIds: true },
    {
      id: folderId,
      root: "cloud",
      path: "users/alice/inbox",
      directory: true,
      size: 0,
      modified: "2026-01-01T00:00:00.000Z",
      uid: 1000,
      gid: 1000,
      mode: "0700",
    },
    "inbox/invoice.pdf",
  );
  expect(scope.place).toBe(stableEntryRefId(baseId, folderId)!);
  expect(scope).toMatchObject({ baseId, stableIds: true });
});

test("the largest path refs remain within the platform envelope budget", () => {
  createAppEventTestHarness("filesv2", filesCapabilities);
  const event = appEventFixture(filesCapabilities, "entry.replaced", { subject: "x".repeat(512), place: "y".repeat(512), data: {} });
  expect(Buffer.byteLength(JSON.stringify(event))).toBe(1260);
});

test("a storage root uses its readable empty-path ref even when Filegate gives it a stable ID", async () => {
  const scope = await uploadEventScope(
    { id: baseId, stableIds: true },
    {
      id: folderId,
      root: "cloud",
      path: "users/alice",
      directory: true,
      size: 0,
      modified: "2026-01-01T00:00:00.000Z",
      uid: 1000,
      gid: 1000,
      mode: "0700",
    },
    "invoice.pdf",
  );
  expect(scope.place).toBe(entryRefId(baseId, "")!);
});
