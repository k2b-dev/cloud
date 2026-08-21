import { describe, expect, test } from "bun:test";
import { fail, ok } from "@k2b/stdlib";
import { z } from "zod";
import {
  CAPABILITY_ERROR_STATUSES,
  CAPABILITY_MAX_RESULT_BYTES,
  CapabilityPageSchema,
  CapabilitySemanticLinkSchema,
  cloudResourceRefAppId,
  defineCapabilities,
  resolveCapabilityResourceReader,
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
} from "../contracts/capabilities";
import {
  capabilityHash,
  capabilityManifestEvolutionIssues,
  compileCapabilities,
  invokeCompiledCapability,
  parseCapabilityManifest,
  reviewCompiledCapability,
  serializeCapabilityProviderResult,
} from "./capabilities";

const context = {
  actor: {
    kind: "user" as const,
    user: { id: "user-1", roles: ["user"] } as any,
  },
  accessSubject: { type: "user" as const, userId: "user-1" },
  user: { id: "user-1", roles: ["user"] } as any,
  signal: new AbortController().signal,
};

const example = () =>
  defineCapabilities({
    protocolVersion: 1,
    types: {
      item: { title: "Item", description: "One test item.", reader: "get" },
    },
    queries: {
      get: {
        title: "Get item",
        description: "Loads one item by its stable id.",
        input: z.object({ id: z.string().max(100).describe("Stable item id.") }).strict(),
        data: z.object({ id: z.string(), name: z.string() }).strict(),
        openWorld: false,
        run: async (input) =>
          ok({
            data: { id: input.id, name: "Example" },
            refs: [{ type: "example.item", id: input.id }],
          }),
      },
    },
    actions: {
      rename: {
        title: "Rename item",
        description: "Renames one item.",
        input: z
          .object({
            id: z.string().max(100).describe("Stable item id."),
            name: z.string().max(120).describe("New item name."),
          })
          .strict(),
        data: z.object({ id: z.string(), name: z.string() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        approval: "rememberable",
        review: async (input) =>
          ok({
            message: "This item will be renamed.",
            details: [{ label: "New name", value: input.name }],
            links: [{ rel: "open", href: `/app/example/${input.id}` }],
            approvalScope: `item:${input.id}`,
          }),
        run: async (input) => ok({ data: input, refs: [{ type: "example.item", id: input.id }] }),
      },
    },
  });

describe("capability v1 compilation", () => {
  test("rejects app ids that cannot be projected to stable qualified and MCP ids", () => {
    expect(() => compileCapabilities("example_app", example())).toThrow();
  });

  test("builds deterministic namespaced manifests and schemas", () => {
    const first = compileCapabilities("example", example());
    const second = compileCapabilities("example", example());
    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest.types[0]?.localId).toBe("item");
    expect(first.manifest.types[0]?.reader).toBe("get");
    expect(first.manifest.queries[0]?.localId).toBe("get");
    expect(first.manifest.queries[0]?.openWorld).toBe(false);
    expect(first.manifest.queries[0]?.dataSchema).toBeDefined();
    expect(first.manifest.actions[0]?.approval).toBe("rememberable");
    expect(first.manifest.actions[0]?.review).toBe(true);
    expect(first.manifest.manifestHash).toHaveLength(64);
  });

  test("requires resource readers to be canonical Queries", () => {
    const definitions = (reader: string, input: z.ZodType) =>
      defineCapabilities({
        protocolVersion: 1,
        types: { item: { title: "Item", description: "One item.", reader } },
        queries: {
          read: {
            title: "Read item",
            description: "Reads one item.",
            input,
            data: z.object({ id: z.string() }).strict(),
            openWorld: false,
            run: async () => ok({ data: { id: "one" } }),
          },
        },
      });

    expect(() => compileCapabilities("example", definitions("missing", z.object({ id: z.string().describe("Id.") }).strict()))).toThrow(
      "must name an existing Query",
    );
    expect(() => compileCapabilities("example", definitions("read", z.object({ key: z.string().describe("Key.") }).strict()))).toThrow(
      "must require a string id field",
    );
    expect(() =>
      compileCapabilities(
        "example",
        definitions("read", z.object({ id: z.string().describe("Id."), scope: z.string().describe("Scope.") }).strict()),
      ),
    ).toThrow("cannot require fields other than id");
    expect(() =>
      compileCapabilities("example", definitions("read", z.object({ id: z.string().describe("Id.").optional() }).strict())),
    ).toThrow("must require a string id field");
    expect(() => compileCapabilities("example", definitions("read", z.object({ id: z.number().describe("Id.") }).strict()))).toThrow(
      "must require a string id field",
    );
    expect(() =>
      compileCapabilities(
        "example",
        definitions("read", z.object({ id: z.string().describe("Id."), cursor: z.string().describe("Cursor.").optional() }).strict()),
      ),
    ).not.toThrow();
  });

  test("resolves the current reader from a qualified resource reference", () => {
    const manifest = compileCapabilities("example", example()).manifest;
    expect(resolveCapabilityResourceReader(manifest, { type: "example.item", id: "one" })?.localId).toBe("get");
    expect(resolveCapabilityResourceReader(manifest, { type: "other.item", id: "one" })).toBeNull();
    expect(resolveCapabilityResourceReader(manifest, { type: "example.unknown", id: "one" })).toBeNull();
    const withoutReader = { ...manifest, types: [{ ...manifest.types[0]!, reader: undefined }] };
    expect(resolveCapabilityResourceReader(withoutReader, { type: "example.item", id: "one" })).toBeNull();
    expect(cloudResourceRefAppId({ type: "example.item", id: "one" })).toBe("example");
  });

  test("treats adding a reader as additive and changing it as breaking", () => {
    const current = example();
    const withoutReader = compileCapabilities(
      "example",
      defineCapabilities({ ...current, types: { item: { title: "Item", description: "One test item." } } }),
    ).manifest;
    const withReader = compileCapabilities("example", current).manifest;
    expect(capabilityManifestEvolutionIssues(withoutReader, withReader)).toEqual([]);
    expect(capabilityManifestEvolutionIssues(withReader, withoutReader)).toContain("Type item reader changed");
    const replacement = structuredClone(withReader);
    replacement.types[0]!.reader = "other.read";
    expect(capabilityManifestEvolutionIssues(withReader, replacement)).toContain("Type item reader changed");
  });

  test("requires a closed-world review before approval can be remembered", () => {
    const action = {
      title: "Update item",
      description: "Updates one item.",
      input: z.object({ id: z.string().describe("Stable item id.") }).strict(),
      data: z.object({}).strict(),
      destructive: true,
      idempotency: "none" as const,
      approval: "rememberable" as const,
      run: async () => ok({ data: {} }),
    };

    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          actions: { update: { ...action, openWorld: false } },
        }),
      ),
    ).toThrow("must provide a review");

    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          actions: {
            update: {
              ...action,
              openWorld: true,
              review: async () => ok({ message: "This item will be updated." }),
            },
          },
        }),
      ),
    ).toThrow("cannot remember approval for an open-world effect");
  });

  test("requires one globally unique local id across all capability kinds", () => {
    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          types: { item: { title: "Item", description: "One item." } },
          queries: {
            item: {
              title: "Get item",
              description: "Loads one item.",
              input: z.object({}).strict(),
              data: z.object({}).strict(),
              openWorld: false,
              run: async () => ok({ data: {} }),
            },
          },
        }),
      ),
    ).toThrow("declared more than once across Types, Queries, and Actions");
  });

  test("requires a cursor exactly when another page exists", () => {
    expect(CapabilityPageSchema.safeParse({ hasMore: true, nextCursor: "next" }).success).toBe(true);
    expect(CapabilityPageSchema.safeParse({ hasMore: false }).success).toBe(true);
    expect(CapabilityPageSchema.safeParse({ hasMore: true }).success).toBe(false);
    expect(CapabilityPageSchema.safeParse({ hasMore: false, nextCursor: "next" }).success).toBe(false);
  });

  test("rejects open inputs and undocumented fields", () => {
    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          queries: {
            bad: {
              title: "Bad",
              description: "Open input.",
              input: z.looseObject({ value: z.string().describe("Value.") }),
              data: z.string(),
              openWorld: false,
              run: async () => ok({ data: "" }),
            },
          },
        }),
      ),
    ).toThrow("must reject unknown properties");

    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          queries: {
            bad: {
              title: "Bad",
              description: "Undocumented input.",
              input: z.object({ value: z.string() }).strict(),
              data: z.string(),
              openWorld: false,
              run: async () => ok({ data: "" }),
            },
          },
        }),
      ),
    ).toThrow("needs a concise Zod description");

    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          actions: {
            bad: {
              title: "Bad",
              description: "Collides with a transport field.",
              input: z.object({ idempotencyKey: z.string().describe("Collision.") }).strict(),
              data: z.object({}).strict(),
              destructive: false,
              openWorld: false,
              idempotency: "required",
              run: async () => ok({ data: {} }),
            },
          },
        }),
      ),
    ).toThrow('input field "idempotencyKey" is reserved');
  });

  test("projects the caller side of input normalization", () => {
    const compiled = compileCapabilities(
      "example",
      defineCapabilities({
        protocolVersion: 1,
        queries: {
          normalize: {
            title: "Normalize",
            description: "Normalizes caller input before execution.",
            input: z
              .object({
                value: z
                  .string()
                  .describe("Value to normalize.")
                  .transform((value) => value.trim()),
              })
              .strict(),
            data: z.string(),
            openWorld: false,
            run: async ({ value }) => ok({ data: value }),
          },
        },
      }),
    );
    expect(z.fromJSONSchema(compiled.manifest.queries[0]!.inputSchema).parse({ value: " value " })).toEqual({
      value: " value ",
    });
  });

  test("publishes defaulted inputs as optional and applies defaults in Core", () => {
    const definitions = defineCapabilities({
      protocolVersion: 1,
      queries: {
        list: {
          title: "List items",
          description: "Lists items with a bounded default.",
          input: z.object({ limit: z.number().int().min(1).max(100).default(25).describe("Maximum number of items.") }).strict(),
          data: z.array(z.string()).max(100),
          openWorld: false,
          run: async ({ limit }) => ok({ data: [String(limit)] }),
        },
      },
    });
    const compiled = compileCapabilities("example", definitions);
    const query = compiled.manifest.queries[0]!;
    expect(query.inputSchema.required).toBeUndefined();
    const reconstructed = z.fromJSONSchema(query.inputSchema);
    expect(reconstructed.parse({})).toEqual({ limit: 25 });
  });

  test("requires descriptions on nested input properties", () => {
    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          queries: {
            bad: {
              title: "Bad",
              description: "Contains an undocumented nested field.",
              input: z
                .object({
                  filter: z.object({ value: z.string() }).strict().describe("Filter values."),
                })
                .strict(),
              data: z.object({}).strict(),
              openWorld: false,
              run: async () => ok({ data: {} }),
            },
          },
        }),
      ),
    ).toThrow("input.filter.value needs a concise Zod description");
  });

  test("allows multiple Universal Search queries per app", () => {
    const searchQuery = {
      title: "Search items",
      description: "Finds items for the global search surface.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "item", title: "Items", description: "Search test items." }],
      },
      run: async () => ok({ data: [] }),
    };
    const compiled = compileCapabilities(
      "example",
      defineCapabilities({
        protocolVersion: 1,
        queries: {
          first: searchQuery,
          second: {
            ...searchQuery,
            universalSearch: {
              tags: [
                {
                  tag: "other",
                  title: "Other",
                  description: "Search other items.",
                },
              ],
            },
          },
        },
      }),
    );
    expect(compiled.manifest.queries.filter((query) => query.universalSearch).map((query) => query.localId)).toEqual(["first", "second"]);

    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          queries: {
            first: searchQuery,
            local_only: {
              ...searchQuery,
              universalSearch: undefined,
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  test("requires the canonical Universal Search schemas", () => {
    expect(() =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          queries: {
            search: {
              title: "Search items",
              description: "Find items.",
              input: z.object({ query: z.string().describe("Search text.") }).strict(),
              data: UniversalSearchDataSchema,
              openWorld: false,
              universalSearch: { tags: [{ tag: "item", title: "Items", description: "Show items." }] },
              run: async () => ok({ data: [] }),
            },
          },
        }),
      ),
    ).toThrow("must use UniversalSearchInputSchema");
  });

  test("allows opaque foreign refs and rejects undeclared refs owned by the provider", async () => {
    const compiled = compileCapabilities(
      "example",
      defineCapabilities({
        protocolVersion: 1,
        types: { item: { title: "Item", description: "One test item." } },
        queries: {
          list: {
            title: "List items",
            description: "Lists navigable item cards.",
            input: z.object({}).strict(),
            data: UniversalSearchDataSchema,
            openWorld: false,
            run: async () =>
              ok({
                data: [
                  {
                    ref: { type: "other.item", id: "one" },
                    title: "One",
                    links: [{ rel: "open", href: "/app/example/one" }],
                  },
                ],
              }),
          },
        },
      }),
    );
    const query = compiled.manifest.queries[0]!;
    const foreign = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "list",
      input: {},
      expectedSchemaHash: query.schemaHash,
      context,
    });

    expect(foreign).toMatchObject({
      ok: true,
      data: { data: [{ ref: { type: "other.item", id: "one" } }] },
    });

    compiled.queries.get("list")!.definition.run = async () =>
      ok({
        data: [
          {
            ref: { type: "example.missing", id: "one" },
            title: "One",
            links: [{ rel: "open", href: "/app/example/one" }],
          },
        ],
      });
    const local = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "list",
      input: {},
      expectedSchemaHash: query.schemaHash,
      context,
    });
    expect(local).toMatchObject({
      ok: false,
      error: { code: "INVALID_APP_RESPONSE", message: "Capability returned undeclared resource type example.missing", status: 500 },
    });
  });

  test("requires every Universal Search result to provide an open link", async () => {
    const compiled = compileCapabilities(
      "example",
      defineCapabilities({
        protocolVersion: 1,
        types: { item: { title: "Item", description: "One item." } },
        queries: {
          search: {
            title: "Search items",
            description: "Finds items.",
            input: UniversalSearchInputSchema,
            data: UniversalSearchDataSchema,
            openWorld: false,
            universalSearch: { tags: [{ tag: "item", title: "Items", description: "Search items." }] },
            run: async () =>
              ok({
                data: [
                  {
                    ref: { type: "example.item", id: "one" },
                    title: "One",
                    links: [{ rel: "preview", href: "/app/example/one/preview" }],
                  },
                ],
              }),
          },
        },
      }),
    );
    const query = compiled.manifest.queries[0]!;
    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "search",
      input: { query: "one", tags: ["item"], limit: 10 },
      expectedSchemaHash: query.schemaHash,
      context,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_APP_RESPONSE", message: "Universal Search results must include an open link", status: 500 },
    });
  });

  test("rejects manifests that are too large for the bounded live registry", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, z.string().describe(`Documented field ${index}. ${"x".repeat(100)}`)]),
    );
    const queries = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `query_${index}`,
        {
          title: `Query ${index}`,
          description: `A deliberately large public query ${index}.`,
          input: z.object(fields).strict(),
          data: z.object({ id: z.string() }).strict(),
          openWorld: false,
          run: async () => ok({ data: { id: "one" } }),
        },
      ]),
    );

    expect(() => compileCapabilities("example", defineCapabilities({ protocolVersion: 1, queries }))).toThrow(
      "manifest exceeds the 262144-byte",
    );
  });

  test("revalidates untrusted manifests and their integrity hashes", () => {
    const manifest = compileCapabilities("example", example()).manifest;
    expect(parseCapabilityManifest(structuredClone(manifest), "example")).toEqual(manifest);
    expect(() => parseCapabilityManifest(structuredClone(manifest), "other")).toThrow("manifest appId must be other");

    const tampered = structuredClone(manifest);
    tampered.queries[0]!.dataSchema = { type: "string" };
    expect(() => parseCapabilityManifest(tampered, "example")).toThrow("schemaHash does not match");

    const collision = structuredClone(manifest);
    collision.queries[0]!.localId = collision.types[0]!.localId;
    expect(() => parseCapabilityManifest(collision, "example")).toThrow("declared more than once");

    const missingReader = structuredClone(manifest);
    missingReader.types[0]!.reader = "missing";
    const { manifestHash: _manifestHash, ...manifestBase } = missingReader;
    missingReader.manifestHash = capabilityHash(manifestBase);
    expect(() => parseCapabilityManifest(missingReader, "example")).toThrow("must name an existing Query");
  });

  test("allows additive same-id evolution and reports breaking changes", () => {
    const manifest = (input: z.ZodType, data: z.ZodType, openWorld = false) =>
      compileCapabilities(
        "example",
        defineCapabilities({
          protocolVersion: 1,
          queries: {
            get: {
              title: "Get item",
              description: "Loads one item.",
              input,
              data,
              openWorld,
              run: async () => ok({ data: {} }),
            },
          },
        }),
      ).manifest;
    const previous = manifest(z.object({ id: z.string().describe("Stable item id.") }).strict(), z.object({ id: z.string() }).strict());
    const additive = manifest(
      z
        .object({
          id: z.string().describe("Stable item id."),
          locale: z.string().describe("Optional locale.").optional(),
        })
        .strict(),
      z.object({ id: z.string(), label: z.string().optional() }).strict(),
    );
    expect(capabilityManifestEvolutionIssues(previous, additive)).toEqual([]);

    const previousArrayItem = manifest(
      z.object({ id: z.string().describe("Stable item id.") }).strict(),
      z.array(z.object({ id: z.string() }).strict()),
    );
    const additiveArrayItem = manifest(
      z.object({ id: z.string().describe("Stable item id.") }).strict(),
      z.array(z.object({ id: z.string(), label: z.string().optional() }).strict()),
    );
    expect(capabilityManifestEvolutionIssues(previousArrayItem, additiveArrayItem)).toEqual([]);

    const previousUnion = manifest(
      z.object({ id: z.string().describe("Stable item id.") }).strict(),
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("first"), id: z.string() }).strict(),
        z.object({ kind: z.literal("second"), id: z.string() }).strict(),
      ]),
    );
    const additiveUnion = manifest(
      z.object({ id: z.string().describe("Stable item id.") }).strict(),
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("first"), id: z.string(), label: z.string().optional() }).strict(),
        z.object({ kind: z.literal("second"), id: z.string() }).strict(),
      ]),
    );
    expect(capabilityManifestEvolutionIssues(previousUnion, additiveUnion)).toEqual([]);

    const clarified = manifest(
      z.object({ id: z.string().describe("A clearer stable item identifier.") }).strict(),
      z.object({ id: z.string().describe("The stable item identifier.") }).strict(),
    );
    expect(capabilityManifestEvolutionIssues(previous, clarified)).toEqual([]);

    const breaking = manifest(
      z
        .object({
          id: z.string().describe("Stable item id."),
          locale: z.string().describe("Required locale."),
        })
        .strict(),
      z.object({ label: z.string() }).strict(),
      true,
    );
    expect(capabilityManifestEvolutionIssues(previous, breaking)).toEqual(
      expect.arrayContaining(["Query get openWorld changed", "Query get input.locale became required", "Query get data.id was removed"]),
    );
  });

  test("returns structured validation, schema, idempotency, and handler failures", async () => {
    const compiled = compileCapabilities("example", example());
    const query = compiled.manifest.queries[0]!;
    const action = compiled.manifest.actions[0]!;

    const stale = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: "0".repeat(64),
      context,
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "SCHEMA_MISMATCH", status: 409 },
    });

    const invalid = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: {},
      expectedSchemaHash: query.schemaHash,
      context,
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED", status: 400 },
    });

    const missingKey = await invokeCompiledCapability({
      compiled,
      kind: "action",
      localId: "rename",
      input: { id: "one", name: "Two" },
      expectedSchemaHash: action.schemaHash,
      context,
    });
    expect(missingKey).toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 },
    });

    const queryWithKey = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: query.schemaHash,
      context: { ...context, idempotencyKey: "not-valid-for-queries" },
    });
    expect(queryWithKey).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_NOT_ALLOWED", status: 400 } });

    const deniedDefinitions = {
      ...example(),
      queries: {
        ...example().queries,
        get: {
          ...example().queries!.get!,
          run: async () => fail({ code: "FORBIDDEN", message: "No access", status: 403 }),
        },
      },
    };
    const denied = compileCapabilities("example", deniedDefinitions);
    const deniedResult = await invokeCompiledCapability({
      compiled: denied,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: denied.manifest.queries[0]!.schemaHash,
      context,
    });
    expect(deniedResult).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", status: 403 },
    });
  });

  test("resolves and validates an Action review without requiring idempotency", async () => {
    const compiled = compileCapabilities("example", example());
    const action = compiled.manifest.actions[0]!;
    const reviewed = await reviewCompiledCapability({
      compiled,
      localId: "rename",
      input: { id: "one", name: "Two" },
      expectedSchemaHash: action.schemaHash,
      context,
    });

    expect(reviewed).toEqual({
      ok: true,
      data: {
        message: "This item will be renamed.",
        details: [{ label: "New name", value: "Two" }],
        links: [{ rel: "open", href: "/app/example/one" }],
        approvalScope: "item:one",
      },
    });

    expect(
      await reviewCompiledCapability({
        compiled,
        localId: "rename",
        input: { id: "one" },
        expectedSchemaHash: action.schemaHash,
        context,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", status: 400 } });
  });

  test("fails closed when an advertised review returns an invalid shape", async () => {
    const definitions = example();
    const compiled = compileCapabilities("example", {
      ...definitions,
      actions: {
        ...definitions.actions,
        rename: {
          ...definitions.actions!.rename!,
          review: async () => ok({ message: "", details: [] }),
        },
      },
    });
    const action = compiled.manifest.actions[0]!;

    expect(
      await reviewCompiledCapability({
        compiled,
        localId: "rename",
        input: { id: "one", name: "Two" },
        expectedSchemaHash: action.schemaHash,
        context,
      }),
    ).toEqual({
      ok: false,
      error: { code: "INVALID_APP_RESPONSE", message: "Capability review returned an invalid result", status: 500 },
    });
  });

  test("fails closed when a rememberable review omits its app-owned scope", async () => {
    const definitions = example();
    const compiled = compileCapabilities("example", {
      ...definitions,
      actions: {
        ...definitions.actions,
        rename: {
          ...definitions.actions!.rename!,
          review: async () => ok({ message: "Rename this item." }),
        },
      },
    });
    const action = compiled.manifest.actions[0]!;

    expect(
      await reviewCompiledCapability({
        compiled,
        localId: "rename",
        input: { id: "one", name: "Two" },
        expectedSchemaHash: action.schemaHash,
        context,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE", status: 500 } });
  });

  test("rejects malformed provider review failures", async () => {
    const definitions = example();
    const compiled = compileCapabilities("example", {
      ...definitions,
      actions: {
        ...definitions.actions,
        rename: {
          ...definitions.actions!.rename!,
          review: async () => ({ ok: false, error: {} }) as never,
        },
      },
    });
    const action = compiled.manifest.actions[0]!;
    const reviewed = await reviewCompiledCapability({
      compiled,
      localId: "rename",
      input: { id: "one", name: "Two" },
      expectedSchemaHash: action.schemaHash,
      context,
    });
    expect(reviewed).toEqual({
      ok: false,
      error: { code: "INVALID_APP_RESPONSE", message: "Capability review returned an invalid error", status: 500 },
    });
  });

  test("reports unexpected handler failures without changing the public error", async () => {
    const base = example();
    const definitions = {
      ...base,
      queries: {
        ...base.queries,
        get: {
          ...base.queries!.get!,
          run: async () => {
            throw new Error("database password must stay private");
          },
        },
      },
    };
    const compiled = compileCapabilities("example", definitions);
    const errors: unknown[] = [];
    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
      context,
      onUnexpectedError: (error) => errors.push(error),
    });
    expect(errors).toHaveLength(1);
    expect(result).toEqual({ ok: false, error: { code: "INTERNAL", message: "Capability execution failed", status: 500 } });
    expect(JSON.stringify(result)).not.toContain("password");
  });

  test("reports invalid provider results internally without exposing schema details", async () => {
    const base = example();
    const definitions = {
      ...base,
      queries: {
        ...base.queries,
        get: {
          ...base.queries!.get!,
          run: async () => ok({ data: { id: "one", name: "Example", privateToken: "must-not-leak" } }),
        },
      },
    };
    const compiled = compileCapabilities("example", definitions);
    const errors: unknown[] = [];
    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
      context,
      onUnexpectedError: (error) => errors.push(error),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toContain('"path":["data"]');
    expect((errors[0] as Error).message).toContain("privateToken");
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_APP_RESPONSE", message: "Capability returned an invalid result", status: 500 },
    });
    expect(JSON.stringify(result)).not.toContain("privateToken");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  test("accepts one bounded provider-authored result summary", async () => {
    const base = example();
    const compiled = compileCapabilities("example", {
      ...base,
      queries: {
        ...base.queries,
        get: {
          ...base.queries!.get!,
          run: async () => ok({ data: { id: "one", name: "Example" }, summary: "Loaded Example" }),
        },
      },
    });
    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
      context,
    });

    expect(result).toMatchObject({ ok: true, data: { summary: "Loaded Example" } });
  });

  test("accepts optional presentation on result references", async () => {
    const base = example();
    const compiled = compileCapabilities("example", {
      ...base,
      queries: {
        ...base.queries,
        get: {
          ...base.queries!.get!,
          run: async () =>
            ok({
              data: { id: "one", name: "Example" },
              refs: [
                {
                  type: "example.item",
                  id: "one",
                  title: "Example",
                  preview: "Current inventory item",
                  icon: "ti ti-package",
                },
              ],
            }),
        },
      },
    });

    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
      context,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        data: { id: "one", name: "Example" },
        refs: [
          {
            type: "example.item",
            id: "one",
            title: "Example",
            preview: "Current inventory item",
            icon: "ti ti-package",
          },
        ],
      },
    });
  });

  test("rejects empty or oversized result summaries", async () => {
    for (const summary of ["", "x".repeat(501)]) {
      const base = example();
      const compiled = compileCapabilities("example", {
        ...base,
        queries: {
          ...base.queries,
          get: {
            ...base.queries!.get!,
            run: async () => ok({ data: { id: "one", name: "Example" }, summary }),
          },
        },
      });
      const result = await invokeCompiledCapability({
        compiled,
        kind: "query",
        localId: "get",
        input: { id: "one" },
        expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
        context,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE" } });
    }
  });

  test("rejects malformed provider failure results", async () => {
    const base = example();
    const compiled = compileCapabilities("example", {
      ...base,
      queries: {
        ...base.queries,
        get: {
          ...base.queries!.get!,
          run: async () => ({ ok: false, error: {} }) as never,
        },
      },
    });
    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
      context,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "INVALID_APP_RESPONSE", message: "Capability returned an invalid error", status: 500 },
    });
  });

  test("preserves every declared provider error status", async () => {
    for (const status of CAPABILITY_ERROR_STATUSES) {
      const base = example();
      const compiled = compileCapabilities("example", {
        ...base,
        queries: {
          ...base.queries,
          get: {
            ...base.queries!.get!,
            run: async () => ({ ok: false, error: { code: "PROVIDER_ERROR", message: "Provider failed", status } }),
          },
        },
      });
      const result = await invokeCompiledCapability({
        compiled,
        kind: "query",
        localId: "get",
        input: { id: "one" },
        expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
        context,
      });
      expect(result).toEqual({ ok: false, error: { code: "PROVIDER_ERROR", message: "Provider failed", status } });
    }
  });

  test("serializes provider results once within the byte bound", () => {
    const oversized = serializeCapabilityProviderResult({
      ok: true,
      data: { data: { value: "x".repeat(CAPABILITY_MAX_RESULT_BYTES) } },
    });
    expect(oversized.status).toBe(500);
    expect(JSON.parse(oversized.body)).toMatchObject({ code: "RESPONSE_TOO_LARGE", details: { retrySafe: false } });
    expect(new TextEncoder().encode(oversized.body).byteLength).toBeLessThanOrEqual(CAPABILITY_MAX_RESULT_BYTES);

    const action = serializeCapabilityProviderResult(
      { ok: true, data: { data: { value: "x".repeat(CAPABILITY_MAX_RESULT_BYTES) } } },
      { nonIdempotentAction: true },
    );
    expect(action.status).toBe(502);
    expect(JSON.parse(action.body)).toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN", details: { retrySafe: false } });

    const invalidAction = serializeCapabilityProviderResult(
      { ok: false, error: { code: "INVALID_APP_RESPONSE", message: "Invalid result", status: 500 } },
      { nonIdempotentAction: true },
    );
    expect(invalidAction.status).toBe(502);
    expect(JSON.parse(invalidAction.body)).toMatchObject({ code: "ACTION_OUTCOME_UNKNOWN", details: { retrySafe: false } });
  });

  test("rejects undeclared refs returned by a handler", async () => {
    const base = example();
    const definitions = {
      ...base,
      queries: {
        ...base.queries,
        get: {
          ...base.queries!.get!,
          run: async (input: { id: string }) =>
            ok({
              data: { id: input.id, name: "Example" },
              refs: [{ type: "example.other", id: input.id }],
            }),
        },
      },
    };
    const compiled = compileCapabilities("example", definitions);
    const result = await invokeCompiledCapability({
      compiled,
      kind: "query",
      localId: "get",
      input: { id: "one" },
      expectedSchemaHash: compiled.manifest.queries[0]!.schemaHash,
      context,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_APP_RESPONSE", status: 500 },
    });
  });
});

test("semantic links cannot escape the Cloud origin through backslashes", () => {
  expect(CapabilitySemanticLinkSchema.safeParse({ rel: "open", href: "/app/demo" }).success).toBe(true);
  expect(CapabilitySemanticLinkSchema.safeParse({ rel: "open", href: "/\\\\evil.example/path" }).success).toBe(false);
});
