import { expect, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { assertResourceView } from "../capabilities/testing";
import {
  CapabilityManifestSchema,
  type CapabilityResourceTypeDefinition,
  CapabilityResourceTypeManifestSchema,
  CloudResourceReaderViewSchema,
  defineCapabilities,
  type ResourcePrincipal,
} from "../contracts/capabilities";
import {
  DiscussionActivityDataSchema,
  DiscussionActivityInputSchema,
  DiscussionContainersDataSchema,
  DiscussionContainersInputSchema,
  discussionsIssues,
} from "../contracts/discussions";
import { typeViewIssues } from "../contracts/resource-types";
import { capabilityHash, compileCapabilities, invokeCompiledCapability } from "./capabilities";
import { resolveLiveCapabilityRegistryEntry } from "./registry";

const idInput = z.object({ id: z.string().min(1).max(512).describe("Resource ID.") }).strict();
const view = { title: "Inventory", permission: "read" as const };
const parent = { ref: { type: "inventory.collection", id: "collection-1" }, title: "Collection" };
const reader = (contained = false) => ({
  title: "Read",
  description: "Read the authorized resource.",
  input: idInput,
  data: z
    .object({
      view: contained ? CloudResourceReaderViewSchema.required({ container: true }) : CloudResourceReaderViewSchema,
      item: z.object({ id: z.string() }),
    })
    .strict(),
  openWorld: false,
  run: async () => ok({ data: { view: { ...view, ...(contained ? { container: parent } : {}) }, item: { id: "item-1" } } }),
});
const definitions = defineCapabilities({
  protocolVersion: 2,
  types: {
    collection: { title: "Collection", description: "An inventory collection.", reader: "collection.read" },
    item: { title: "Item", description: "An inventory item.", reader: "item.read", container: "collection" },
  },
  discussions: { item: "item", containers: "collection.list", activity: "collection.activity" },
  queries: {
    "collection.read": reader(),
    "item.read": reader(true),
    "collection.list": {
      title: "Collections",
      description: "List readable collections.",
      input: DiscussionContainersInputSchema,
      data: DiscussionContainersDataSchema,
      openWorld: false,
      run: async () => ok({ data: { items: [], next: null } }),
    },
    "collection.activity": {
      title: "Activity",
      description: "Read authorized activity.",
      input: DiscussionActivityInputSchema,
      data: DiscussionActivityDataSchema,
      openWorld: false,
      run: async () => ok({ data: [] }),
    },
  },
});
const compiled = compileCapabilities("inventory", definitions);

test("containment rejects unknown, self and multi-type cycles", () => {
  const invalid: Record<string, CapabilityResourceTypeDefinition>[] = [
    { item: { title: "Item", description: "Item.", container: "missing" } },
    { item: { title: "Item", description: "Item.", container: "item" } },
    {
      item: { title: "Item", description: "Item.", container: "collection" },
      collection: { title: "Collection", description: "Collection.", container: "item" },
    },
  ];
  for (const types of invalid) expect(() => compileCapabilities("inventory", { protocolVersion: 2, types })).toThrow(/container/);
});

test("top-level projections keep types and readers usable by older readers", () => {
  expect(compiled.manifest.resourceTypes).toEqual([
    { type: "collection", view: true },
    { type: "item", container: "collection", view: true },
  ]);
  expect(compiled.manifest.types.map((type) => CapabilityResourceTypeManifestSchema.parse(type))).toEqual(compiled.manifest.types);
  const { resourceTypes: _models, discussions: _role, ...older } = compiled.manifest;
  expect(CapabilityManifestSchema.parse(older).types).toEqual(compiled.manifest.types);
  const read = CapabilityManifestSchema.parse({
    ...compiled.manifest,
    queries: compiled.manifest.queries.filter((query) => query.localId !== "collection.activity"),
  });
  expect(read.discussions).toBeUndefined();
  const missing = CapabilityManifestSchema.parse({
    ...compiled.manifest,
    types: compiled.manifest.types.filter((type) => type.localId !== "collection"),
  });
  expect(missing.resourceTypes).toEqual([]);
});

test("view advertisement comes from compatible reader data without a second declaration", () => {
  expect(typeViewIssues(compiled.manifest, "item")).toEqual([]);
  expect(typeViewIssues(compiled.manifest, "collection")).toEqual([]);
  expect(assertResourceView({ data: { view: { ...view, container: parent } } }, parent.ref)).toEqual({ ...view, container: parent });
  expect(() => assertResourceView({ data: { view } }, parent.ref)).toThrow();
  expect(() => assertResourceView({ data: { view: { ...view, permission: "owner" } } })).toThrow();
  expect(() => compileCapabilities("inventory", { ...definitions, queries: { ...definitions.queries, "item.read": reader() } })).toThrow(
    /container/,
  );
  const legacy = compileCapabilities("inventory", {
    protocolVersion: 2,
    types: definitions.types,
    queries: {
      "collection.read": reader(),
      "item.read": { ...reader(), data: z.object({ view: z.object({ title: z.string() }) }).strict() },
    },
  });
  expect(legacy.manifest.resourceTypes?.find((model) => model.type === "item")?.view).toBeUndefined();
  expect(typeViewIssues(legacy.manifest, "item").length).toBeGreaterThan(0);
});

test("discussion role checks item containment, view, exact shared schemas and streams", () => {
  expect(discussionsIssues(compiled.manifest)).toEqual([]);
  expect(discussionsIssues({ ...compiled.manifest, resourceTypes: [] }).length).toBeGreaterThan(0);
  expect(
    discussionsIssues({
      ...compiled.manifest,
      queries: compiled.manifest.queries.map((query) =>
        query.localId === "collection.list" ? { ...query, dataSchema: { type: "string" } } : query,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    discussionsIssues({
      ...compiled.manifest,
      queries: compiled.manifest.queries.map((query) =>
        query.localId === "collection.activity" ? { ...query, stream: { direction: "read", maxBytes: 100 } } : query,
      ),
    }).some((issue) => issue.code === "stream"),
  ).toBe(true);
});

test("generated readability requires expected container and only returns requested principals", async () => {
  const principal: ResourcePrincipal = { type: "service_account", serviceAccountId: "11111111-1111-4111-8111-111111111111" };
  const instance = compileCapabilities("inventory", {
    protocolVersion: 2,
    types: {
      collection: { title: "Collection", description: "Collection." },
      item: {
        title: "Item",
        description: "Item.",
        container: "collection",
        access: {
          readable: async (input) =>
            input.id === "invalid-subset" ? [principal] : input.container?.id === "current" ? input.principals : [],
        },
      },
    },
  });
  const run = (input: unknown) =>
    invokeCompiledCapability({
      compiled: instance,
      kind: "query",
      localId: "item.readable",
      input,
      expectedSchemaHash: instance.queries.get("item.readable")!.manifest.schemaHash,
      context: {
        actor: { kind: "app", appId: "consumer" },
        accessSubject: { type: "none" },
        user: null,
        locale: "en",
        requestId: "readers",
        origin: "app",
        signal: new AbortController().signal,
      },
    });
  expect(await run({ id: "item-1", principals: [principal] })).toMatchObject({ ok: false, error: { status: 400 } });
  expect(await run({ id: "item-1", container: { type: "inventory.collection", id: "previous" }, principals: [principal] })).toMatchObject({
    ok: true,
    data: { data: { readable: [] } },
  });
  expect(await run({ id: "item-1", container: { type: "inventory.collection", id: "current" }, principals: [principal] })).toMatchObject({
    ok: true,
    data: { data: { readable: [principal] } },
  });
  expect(await run({ id: "item-1", container: { type: "foreign.collection", id: "current" }, principals: [principal] })).toMatchObject({
    ok: false,
    error: { status: 400 },
  });
  expect(await run({ id: "invalid-subset", container: { type: "inventory.collection", id: "current" }, principals: [] })).toMatchObject({
    ok: false,
    error: { status: 500 },
  });
  expect(() =>
    compileCapabilities("inventory", {
      protocolVersion: 2,
      types: { item: { title: "Item", description: "Item.", access: { readable: () => [] } } },
      queries: { "item.readable": reader() },
    }),
  ).toThrow(/collides/);
});

test("registry retains valid roles and ignores an incompatible role without losing the provider", () => {
  const app = { id: "inventory", name: "Inventory", icon: "box", description: "Inventory", baseUrl: "http://inventory.test", routes: [] };
  const resolve = (manifest: typeof compiled.manifest) =>
    resolveLiveCapabilityRegistryEntry(
      "capabilities/inventory",
      { appId: "inventory", manifest },
      { ...app, capabilities: { protocolVersion: 2, manifestHash: manifest.manifestHash } },
    );
  expect(resolve(compiled.manifest)?.manifest.discussions).toEqual(definitions.discussions);
  const { manifestHash: _hash, ...base } = compiled.manifest;
  const broken = { ...base, discussions: { item: "item", containers: "collection.read" } };
  const sent = { ...broken, manifestHash: capabilityHash(broken) };
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let read = 0; read < 2; read++) {
      const result = resolve(sent);
      expect(result?.manifest.discussions).toBeUndefined();
      expect(result?.manifest.types).toEqual(compiled.manifest.types);
    }
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});
