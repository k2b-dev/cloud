import { expect, test } from "bun:test";
import { z } from "zod";
import { currentLibrary, futureLibrary } from "../../test/future-capability-manifest";
import { CapabilityCatalogSchema, CapabilityManifestSchema, resolveCapabilityResourceReader } from "./capabilities";

const catalogPage = (manifest: unknown) => ({
  protocolVersion: 2,
  generatedAt: "2027-01-01T00:00:00Z",
  apps: [{ appId: "library", appName: "Library", appIcon: "ti ti-books", appDescription: "Books", appAccent: "#0f766e", manifest }],
  page: { hasMore: true, nextCursor: "c2", total: 40 },
});

test("a manifest without newer fields reads unchanged", () => {
  expect(CapabilityManifestSchema.parse(structuredClone(currentLibrary.manifest))).toEqual(currentLibrary.manifest);
});

test("a catalog page from a newer release keeps every entry this release can read", () => {
  const future = futureLibrary().manifest;
  const page = CapabilityCatalogSchema.parse(catalogPage(future));
  expect(page).not.toHaveProperty("generatedAt");
  expect(page.page).toEqual({ hasMore: true, nextCursor: "c2" });
  expect(page.apps[0]).not.toHaveProperty("appAccent");

  const manifest = page.apps[0]!.manifest;
  expect(manifest).not.toHaveProperty("fileProvider");
  expect(manifest).not.toHaveProperty("events");
  expect(manifest.manifestHash).toBe(future.manifestHash);
  // Readable entries stay exactly as sent.
  expect(manifest.queries.map((query) => query.localId)).toEqual(["book.read"]);
  expect(manifest.actions.map((action) => action.localId)).toEqual(["book.rename"]);
  expect(manifest.commands).toEqual(currentLibrary.manifest.commands);
  expect(resolveCapabilityResourceReader(manifest, { type: "library.book", id: "b1" })?.localId).toBe("book.read");
});

test("an entry with a newer field or value is left out, never weakened, and its dependents follow it", () => {
  const manifest = CapabilityManifestSchema.parse(futureLibrary().manifest);
  // `book.archive` asks for an approval this release does not know. Reading it without approval would widen access.
  expect(manifest.actions.find((action) => action.localId === "book.archive")).toBeUndefined();
  // `shelf` carries an unknown field; the Universal Search Query scoped to it goes with it.
  expect(manifest.types.map((type) => type.localId)).toEqual(["author", "book"]);
  expect(manifest.queries.find((query) => query.localId === "book.search")).toBeUndefined();
  // `author.read` carries an unknown field; its type stays but can no longer be read.
  expect(manifest.types.find((type) => type.localId === "author")).not.toHaveProperty("reader");
  expect(resolveCapabilityResourceReader(manifest, { type: "library.author", id: "a1" })).toBeNull();
});

test("tolerance stops at the protocol version and at invalid known fields", () => {
  const future = futureLibrary().manifest;
  expect(CapabilityManifestSchema.safeParse({ ...future, protocolVersion: 3 }).success).toBeFalse();
  expect(CapabilityManifestSchema.safeParse({ ...future, appId: "Library" }).success).toBeFalse();
  expect(CapabilityManifestSchema.safeParse({ ...future, queries: "book.read" }).success).toBeFalse();
  expect(
    CapabilityManifestSchema.safeParse({ ...future, queries: Array.from({ length: 201 }, () => future.queries[0]) }).success,
  ).toBeFalse();
});

test("the documented catalog response stays the shape this release produces", () => {
  expect(z.toJSONSchema(CapabilityCatalogSchema, { io: "output" })).toMatchObject({
    properties: {
      apps: {
        items: {
          properties: {
            manifest: { required: ["protocolVersion", "appId", "manifestHash", "types", "queries", "actions", "commands"] },
          },
        },
      },
    },
  });
});
