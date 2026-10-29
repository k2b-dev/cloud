import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { z } from "zod";
import { CloudResourceReaderViewSchema } from "../contracts/capabilities";
import { DiscussionContainersDataSchema, DiscussionContainersInputSchema } from "../contracts/discussions";
import { discussionProviders } from "./discussion-providers";
import { compileCapabilityManifest } from "./testing";

const now = Date.parse("2026-10-29T00:00:00Z");
const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
beforeEach(() => {
  setSystemTime(new Date(now));
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
});
afterEach(() => {
  setSystemTime();
  if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
});
const read = (view: z.ZodType) => ({
  title: "Read",
  description: "Read the resource.",
  input: z.object({ id: z.string().describe("Resource ID.") }).strict(),
  data: z.object({ view }).strict(),
  openWorld: false,
  run: async () => ({ ok: false as const, error: { code: "NOT_FOUND", message: "Missing", status: 404 as const } }),
});
const app = {
  appId: "inventory",
  appName: "Inventory",
  appIcon: "box",
  appDescription: "Inventory",
  manifest: compileCapabilityManifest("inventory", {
    protocolVersion: 2,
    types: {
      collection: { title: "Collection", description: "Collection.", reader: "collection.read" },
      item: { title: "Item", description: "Item.", container: "collection", reader: "item.read", access: { readable: () => [] } },
    },
    discussions: { item: "item", containers: "collection.list" },
    queries: {
      "item.read": read(CloudResourceReaderViewSchema.required({ container: true })),
      "collection.read": read(CloudResourceReaderViewSchema),
      "collection.list": {
        title: "List",
        description: "List containers.",
        input: DiscussionContainersInputSchema,
        data: DiscussionContainersDataSchema,
        openWorld: false,
        run: async () => ({ ok: true, data: { data: { items: [], next: null } } }),
      },
    },
  }),
};
const page = (apps: unknown[], next?: string) =>
  Response.json({ protocolVersion: 2, apps, page: next ? { hasMore: true, nextCursor: next } : { hasMore: false } });
const options = { deadline: now + 60_000 };
test("discovers generic providers from the person catalog while preserving readability availability", async () => {
  const personApp = { ...app, manifest: { ...app.manifest, queries: app.manifest.queries.filter((query) => !query.appOnly) } };
  const providers = await discussionProviders({ cookie: "session=fixture", transport: async () => page([personApp]) }, options);
  expect(providers).toMatchObject([{ itemType: "inventory.item", containerType: "inventory.collection", containers: "collection.list" }]);
  expect(providers[0]!.app.manifest.resourceTypes?.find((model) => model.type === "item")?.readable).toBe(true);
});
test("bounds discovery calls and detects repeated cursors", async () => {
  let calls = 0;
  await expect(discussionProviders({ transport: async () => page([], `cursor-${++calls}`) }, options)).rejects.toThrow(
    "DISCUSSION_CALL_BUDGET",
  );
  expect(calls).toBe(60);
  await expect(discussionProviders({ transport: async () => page([], "same") }, options)).rejects.toThrow("DISCUSSION_CURSOR_LOOP");
});
test("bounds raw response bytes and aborts a stalled transport at cancellation", async () => {
  let calls = 0;
  await expect(
    discussionProviders(
      {
        transport: async () => {
          calls++;
          return Response.json({
            protocolVersion: 2,
            apps: [],
            page: { hasMore: true, nextCursor: `cursor-${calls}` },
            extra: "x".repeat(1_000_000),
          });
        },
      },
      options,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(5);
  const controller = new AbortController();
  const pending = discussionProviders(
    { transport: async () => new Promise<Response>(() => {}) },
    { ...options, signal: controller.signal },
  );
  controller.abort(new Error("fixture cancelled"));
  await expect(pending).rejects.toThrow("fixture cancelled");
});
