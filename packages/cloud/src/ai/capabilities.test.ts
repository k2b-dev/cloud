import { describe, expect, test } from "bun:test";
import { nessi, type ProviderRequest, type StoreEntry } from "@k2b/nessi";
import type { Provider } from "@k2b/nessi/ai";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { type CapabilityActionReview, CapabilityActionReviewSchema, defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry, HelpRegistryEntry } from "../contracts/registry";
import {
  aiCapabilityInputSchema,
  aiCapabilityToolName,
  buildAiCapabilityAppCatalog,
  buildAiCapabilityCatalog,
  buildAiToolCatalog,
  createAiHelpTools,
  createAiResourceReaderTool,
  createAiToolMetaTools,
  createAiToolResolver,
  createLoadedAiCapabilityTools,
  listAiCapabilityApps,
  reduceAiCapabilityInputSchema,
  searchAiTools,
} from "./capabilities";
import { createConfiguredDefaultCloudAiTools } from "./default-tools";
import { prepareAiTools } from "./tools";

describe("capability action review details", () => {
  test("validates semantic date formats without changing ordinary text", () => {
    expect(
      CapabilityActionReviewSchema.parse({
        message: "Schedule the event.",
        details: [
          { label: "Day", value: "2026-08-20", format: "date" },
          { label: "Local day", value: "2026-08-20T00:00:00+02:00", format: "date" },
          { label: "Starts", value: "2026-08-20T09:00:00+02:00", format: "date-time" },
          { label: "Window", value: "After approval" },
        ],
      }).details,
    ).toEqual([
      { label: "Day", value: "2026-08-20", format: "date" },
      { label: "Local day", value: "2026-08-20T00:00:00+02:00", format: "date" },
      { label: "Starts", value: "2026-08-20T09:00:00+02:00", format: "date-time" },
      { label: "Window", value: "After approval" },
    ]);
    expect(
      CapabilityActionReviewSchema.safeParse({
        message: "Schedule the event.",
        details: [{ label: "Starts", value: "tomorrow morning", format: "date-time" }],
      }).success,
    ).toBeFalse();
  });
});

const capabilityApp = (
  appId: string,
  appName = appId,
  query = { title: "List items", description: "List the items this user can read." },
  appDescription = "",
): CapabilityRegistryEntry => {
  const compiled = compileCapabilities(
    appId,
    defineCapabilities({
      protocolVersion: 1,
      types: { item: { title: "Item", description: "One item." } },
      queries: {
        list: {
          title: query.title,
          description: query.description,
          input: z
            .object({
              query: z.string().min(2).max(80).describe("Optional title text.").optional(),
              status: z.enum(["open", "done"]).describe("Optional status filter.").optional(),
            })
            .strict(),
          data: z.array(z.object({ id: z.string() }).strict()),
          openWorld: false,
          run: async () => ok({ data: [] }),
        },
      },
      actions: {
        create: {
          title: "Create item",
          description: "Create an item in an accessible collection.",
          input: z.object({ title: z.string().min(1).max(120).describe("Item title.") }).strict(),
          data: z.object({ id: z.string() }).strict(),
          destructive: false,
          openWorld: false,
          idempotency: "none",
          approval: "rememberable",
          review: async ({ title }) => ok({ message: `Create ${title}.`, approvalScope: "collection:default" }),
          run: async () => ok({ data: { id: "created" } }),
        },
      },
    }),
  );
  return {
    appId,
    appName,
    appIcon: "ti ti-box",
    appAccent: "#0f766e",
    appDescription,
    endpoint: `http://${appId}:3000/api/_internal/capabilities/v1`,
    manifest: compiled.manifest,
  };
};

const actor = {
  kind: "user" as const,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "ai-user",
    provider: "local" as const,
    profile: "user" as const,
    displayName: "AI User",
    mail: "ai@example.test",
    givenname: "AI",
    sn: "User",
    roles: ["user" as const],
    accountExpires: null,
    avatarHash: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  },
};

describe("AI capability catalog", () => {
  test("resolves a structured ref to its canonical reader and invokes it with only id", async () => {
    const compiled = compileCapabilities(
      "contacts",
      defineCapabilities({
        protocolVersion: 1,
        types: { contact: { title: "Contact", description: "One contact.", reader: "contact.read" } },
        queries: {
          "contact.read": {
            title: "Read contact",
            description: "Read one contact.",
            input: z.object({ id: z.string().describe("Stable contact id.") }).strict(),
            data: z.object({ id: z.string() }).strict(),
            openWorld: false,
            run: async ({ id }) => ok({ data: { id } }),
          },
        },
      }),
    );
    const app: CapabilityRegistryEntry = {
      appId: "contacts",
      appName: "Contacts",
      appIcon: "ti ti-address-book",
      appAccent: "#000000",
      appDescription: "Contacts",
      endpoint: "http://contacts/api/_internal/capabilities/v1",
      manifest: compiled.manifest,
    };
    const catalog = buildAiCapabilityCatalog([app]);
    let invocation: unknown;
    const prepared = prepareAiTools({
      tools: [
        createAiResourceReaderTool({
          apps: [app],
          catalog,
          execute: async (entry, args) => {
            invocation = { localId: entry.operation.localId, args };
            return { data: { id: "contact-1" } };
          },
        }),
      ],
      actor,
      conversationId: "conversation-1",
    });
    const tool = prepared.tools[0];
    if (!tool || tool.kind !== "server") throw new Error("resource reader missing");
    await tool.execute(
      { type: "contacts.contact", id: "contact-1" },
      { signal: AbortSignal.timeout(1_000), requestApproval: async () => true, requestClientTool: async <T>() => undefined as T },
    );
    expect(invocation).toEqual({ localId: "contact.read", args: { id: "contact-1" } });
  });

  test("rejects unknown and non-readable resource Types before execution", async () => {
    const app = capabilityApp("contacts");
    let executions = 0;
    const prepared = prepareAiTools({
      tools: [
        createAiResourceReaderTool({
          apps: [app],
          catalog: buildAiCapabilityCatalog([app]),
          execute: async () => {
            executions += 1;
            return {};
          },
        }),
      ],
      actor,
      conversationId: "conversation-1",
    });
    const tool = prepared.tools[0];
    if (!tool || tool.kind !== "server") throw new Error("resource reader missing");
    const context = {
      signal: AbortSignal.timeout(1_000),
      requestApproval: async () => true,
      requestClientTool: async <T>() => undefined as T,
    };

    await expect(tool.execute({ type: "missing.item", id: "item-1" }, context)).rejects.toThrow("unknown or has no reader");
    await expect(tool.execute({ type: "contacts.item", id: "item-1" }, context)).rejects.toThrow("unknown or has no reader");
    expect(executions).toBe(0);
  });

  test("searches and reads registered Help without per-document tools", async () => {
    const help: HelpRegistryEntry = {
      appId: "grids",
      appName: "Grids",
      appIcon: "ti ti-table",
      manifestHash: "hash",
      documents: [
        {
          id: "grids-gql",
          title: "GQL reference",
          description: "Query Grids data.",
          order: 10,
          markdown: "# GQL\n\nUse `from table Books` to query records.",
          searchText: "preindexed query language",
        },
      ],
    };
    const prepared = prepareAiTools({ tools: createAiHelpTools([help]), actor, conversationId: "conversation-1" });
    expect(prepared.tools.map((tool) => tool.def.name)).toEqual(["search_help", "read_help"]);
    const search = prepared.tools[0];
    const read = prepared.tools[1];
    if (!search || search.kind !== "server" || !read || read.kind !== "server") throw new Error("Help tools missing");
    const context = {
      signal: AbortSignal.timeout(1_000),
      requestApproval: async () => true,
      requestClientTool: async <T>() => undefined as T,
    };
    expect(await search.execute({ query: "GQL preindexed", appId: "grids" }, context)).toEqual({
      documents: [
        {
          appId: "grids",
          appName: "Grids",
          kind: "help",
          locale: "en",
          documentId: "grids-gql",
          title: "GQL reference",
          description: "Query Grids data.",
        },
      ],
    });
    expect(await read.execute({ appId: "grids", documentId: "grids-gql", query: "GQL preindexed" }, context)).toMatchObject({
      document: { kind: "help", markdown: expect.stringContaining("from table Books"), truncated: false },
    });
  });

  test("resolves AI Help for the turn locale without exposing message keys", async () => {
    const help: HelpRegistryEntry = {
      appId: "grids",
      appName: "Grids",
      appIcon: "ti ti-table",
      manifestHash: "localized",
      baseLocale: "en",
      documents: [{ id: "start", title: "Start", order: 10, markdown: "# Start\n\nEnglish help." }],
      documentsByLocale: {
        de: [{ id: "start", title: "Starten", order: 10, markdown: "# Starten\n\nDeutsche Hilfe." }],
      },
    };
    const [search] = prepareAiTools({ tools: createAiHelpTools([help], "de-CH"), actor, conversationId: "localized" }).tools;
    if (!search || search.kind !== "server") throw new Error("Help search missing");
    const result = await search.execute(
      { query: "Deutsche Hilfe" },
      { signal: AbortSignal.timeout(1_000), requestApproval: async () => true, requestClientTool: async <T>() => undefined as T },
    );
    expect(result).toMatchObject({ documents: [{ locale: "de", title: "Starten" }] });
  });

  test("ranks non-contiguous Help terms and bounds long reads to relevant sections", async () => {
    const help: HelpRegistryEntry = {
      appId: "contacts",
      appName: "Contacts",
      appIcon: "ti ti-address-book",
      manifestHash: "hash",
      documents: [
        {
          id: "contacts-start",
          title: "Start",
          description: "General contact overview and permissions.",
          order: 10,
          markdown: "# Start\n\nOpen Contacts to browse records.",
        },
        {
          id: "contacts-permissions",
          title: "Permissions",
          description: "Share contact books safely.",
          order: 20,
          markdown: `# Permissions\n\n## Background\n\n${"Background details. ".repeat(700)}\n\n## Member permissions\n\nEditors can update contacts. Viewers can only read them.`,
        },
      ],
    };
    const prepared = prepareAiTools({ tools: createAiHelpTools([help]), actor, conversationId: "conversation-1" });
    const search = prepared.tools[0];
    const read = prepared.tools[1];
    if (!search || search.kind !== "server" || !read || read.kind !== "server") throw new Error("Help tools missing");
    const context = {
      signal: AbortSignal.timeout(1_000),
      requestApproval: async () => true,
      requestClientTool: async <T>() => undefined as T,
    };

    const result = z
      .object({ documents: z.array(z.object({ documentId: z.string(), title: z.string() }).passthrough()) })
      .parse(await search.execute({ query: "contact permissions", appId: "contacts" }, context));
    expect(result.documents[0]).toMatchObject({ documentId: "contacts-permissions", title: "Permissions" });

    const article = z
      .object({
        document: z.object({ documentId: z.string(), markdown: z.string(), truncated: z.boolean() }).passthrough().nullable(),
      })
      .parse(await read.execute({ appId: "contacts", documentId: "contacts-permissions", query: "member permissions" }, context));
    expect(article.document).toMatchObject({
      documentId: "contacts-permissions",
      truncated: true,
    });
    if (!article.document) throw new Error("Help article missing");
    expect(article.document.markdown).toContain("Editors can update contacts");
    expect(article.document.markdown.length).toBeLessThanOrEqual(7_000);
    expect(article.document.markdown).not.toContain("Background details");
  });

  test("keeps Help isolated and retries the live registry after a failure", async () => {
    const failures: unknown[] = [];
    let attempts = 0;
    const help: HelpRegistryEntry = {
      appId: "contacts",
      appName: "Contacts",
      appIcon: "ti ti-address-book",
      manifestHash: "hash",
      documents: [
        {
          id: "contacts-start",
          title: "Find contacts",
          order: 10,
          markdown: "# Contacts\n\nSearch for a contact and open the result.",
        },
      ],
    };
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: [],
      store: {
        getLoadedTools: async () => [],
        loadTools: async ({ names }) => ({ loaded: names, alreadyLoaded: [], evicted: [] }),
      },
      listHelpRegistry: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("registry unavailable");
        return [help];
      },
      onHelpRegistryError: (error) => failures.push(error),
    });

    const unavailable = await resolver();
    expect(unavailable.map((tool) => tool.def.name)).toEqual(["search_tools", "load_tools", "list_apps", "search_help", "read_help"]);
    const recovered = await resolver();
    const search = recovered.find((tool) => tool.def.name === "search_help");
    if (!search || search.kind !== "server") throw new Error("search_help missing");
    const result = await search.execute(
      { query: "open the result", appId: "contacts" },
      {
        signal: AbortSignal.timeout(1_000),
        requestApproval: async () => true,
        requestClientTool: async <T>() => undefined as T,
      },
    );

    expect(result).toMatchObject({ documents: [{ appId: "contacts", documentId: "contacts-start" }] });
    expect(attempts).toBe(2);
    expect(failures).toHaveLength(1);
  });

  test("uses readable provider-safe names without dot or underscore collisions", () => {
    expect(aiCapabilityToolName("contacts", "query", "contact.list")).toBe("contacts__query__contact_dot_list");
    expect(aiCapabilityToolName("contacts", "query", "contact_list")).toBe("contacts__query__contact__list");
    expect(aiCapabilityToolName("custom/app", "query", "list items")).toBe("custom_u2f_app__query__list_u20_items");
    const longName = aiCapabilityToolName("contacts", "query", `contact.${"nested-".repeat(20)}list`);
    expect(longName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(longName).toHaveLength(64);
  });

  test("searches deterministic compact entries with an optional app filter", () => {
    const first = capabilityApp("contacts", "Contacts");
    const second = capabilityApp("spaces", "Spaces");
    const catalog = buildAiCapabilityCatalog([second, first, first]);

    expect(catalog.map((entry) => entry.name)).toEqual(["contacts.create", "contacts.list", "spaces.create", "spaces.list"]);
    const result = searchAiTools(buildAiToolCatalog([], catalog), { query: "create", appId: "spaces" });
    expect(result.tools).toEqual([expect.objectContaining({ name: "spaces.create", title: "Create item" })]);
    expect(JSON.stringify(result)).not.toContain("inputSchema");
    expect(JSON.stringify(result)).not.toContain("appIcon");
  });

  test("builds and pages a deterministic live app directory", () => {
    const apps = buildAiCapabilityAppCatalog([
      capabilityApp("spaces", "Spaces", undefined, "Team spaces and kanban boards."),
      capabilityApp("contacts", "Contacts", undefined, "Address books and people."),
      capabilityApp("contacts", "Duplicate", undefined, "Ignored duplicate."),
    ]);

    expect(apps).toEqual([
      { appId: "contacts", appName: "Contacts", description: "Address books and people." },
      { appId: "spaces", appName: "Spaces", description: "Team spaces and kanban boards." },
    ]);
    expect(listAiCapabilityApps(apps, { limit: 1 })).toEqual({
      apps: [{ appId: "contacts", appName: "Contacts", description: "Address books and people." }],
      page: { hasMore: true, nextCursor: "contacts" },
    });
    expect(listAiCapabilityApps(apps, { cursor: "contacts" }).apps).toEqual([
      { appId: "spaces", appName: "Spaces", description: "Team spaces and kanban boards." },
    ]);
  });

  test("bounds the live app directory in provider tool context", () => {
    const apps = Array.from({ length: 25 }, (_, index) =>
      capabilityApp(`app-${index}`, `App ${index} ${"long-name ".repeat(20)}`, undefined, `Description ${index}`),
    );
    const capabilityCatalog = buildAiCapabilityCatalog(apps);
    const tools = createAiToolMetaTools({
      apps,
      catalog: buildAiToolCatalog([], capabilityCatalog),
      eagerNames: new Set(),
      conversationId: "conversation-1",
      store: {
        loadTools: async ({ names }) => ({ loaded: names, alreadyLoaded: [], evicted: [] }),
      },
    });
    const description = tools.find((tool) => tool.def.name === "search_tools")?.def.description ?? "";

    expect(description).toContain("Live capability apps:");
    expect(description).toContain("more");
    expect(description.length).toBeLessThan(3_000);
  });

  test("lists apps as an id-to-description map", async () => {
    const app = capabilityApp("mail", "Mail", undefined, "Read, search, organize, draft, and send email.");
    const tools = createAiToolMetaTools({
      apps: [app],
      catalog: buildAiToolCatalog([], buildAiCapabilityCatalog([app])),
      eagerNames: new Set(),
      conversationId: "conversation-1",
      store: { loadTools: async ({ names }) => ({ loaded: names, alreadyLoaded: [], evicted: [] }) },
    });
    const prepared = prepareAiTools({ tools, actor, conversationId: "conversation-1" });
    const list = prepared.tools.find((tool) => tool.def.name === "list_apps");
    if (!list || list.kind !== "server") throw new Error("list_apps missing");
    await expect(
      list.execute(
        {},
        { signal: AbortSignal.timeout(1_000), requestApproval: async () => true, requestClientTool: async <T>() => undefined as T },
      ),
    ).resolves.toEqual({ apps: { mail: "Read, search, organize, draft, and send email." } });
  });

  test("keeps only the eager baseline loaded and discovers deferred built-ins", async () => {
    const allBuiltIns = await createConfiguredDefaultCloudAiTools({ firecrawlApiKey: "" });
    let loaded: string[] = [];
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: allBuiltIns,
      store: {
        getLoadedTools: async () => [...loaded],
        loadTools: async ({ names }) => {
          loaded = [...new Set([...loaded, ...names])];
          return { loaded: names, alreadyLoaded: [], evicted: [] };
        },
      },
      listHelpRegistry: async () => [],
    });

    const first = await resolver();
    expect(first.map((tool) => tool.def.name)).toEqual([
      "search_tools",
      "load_tools",
      "list_apps",
      "read_file",
      "fetch_file",
      "view_image",
      "search_help",
      "read_help",
    ]);
    const search = first.find((tool) => tool.def.name === "search_tools");
    if (!search || search.kind !== "server") throw new Error("search_tools missing");
    const found = z
      .object({ tools: z.array(z.object({ name: z.string(), kind: z.string() }).passthrough()) })
      .parse(
        await search.execute(
          { query: "edit a long markdown email" },
          { signal: AbortSignal.timeout(1_000), requestApproval: async () => true, requestClientTool: async <T>() => undefined as T },
        ),
      );
    expect(found.tools).toContainEqual(expect.objectContaining({ name: "text_editor", kind: "builtin" }));

    const load = first.find((tool) => tool.def.name === "load_tools");
    if (!load || load.kind !== "server") throw new Error("load_tools missing");
    await load.execute(
      { names: ["text_editor"] },
      { signal: AbortSignal.timeout(1_000), requestApproval: async () => true, requestClientTool: async <T>() => undefined as T },
    );
    expect((await resolver()).map((tool) => tool.def.name)).toContain("text_editor");
  });

  test("keeps configured web search and extraction eager together", async () => {
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: await createConfiguredDefaultCloudAiTools({ firecrawlApiKey: "test-key" }),
      store: {
        getLoadedTools: async () => [],
        loadTools: async ({ names }) => ({ loaded: names, alreadyLoaded: [], evicted: [] }),
      },
    });

    const names = (await resolver()).map((tool) => tool.def.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_extract");
  });

  test("ranks natural-language task terms without requiring one contiguous phrase", () => {
    const mail = capabilityApp("mail", "Mail", {
      title: "List conversations",
      description: "List bounded conversations and emails for a mailbox, inbox, folder, work view, or unread state.",
    });
    const contacts = capabilityApp("contacts", "Contacts");
    const catalog = buildAiToolCatalog([], buildAiCapabilityCatalog([contacts, mail]));

    expect(searchAiTools(catalog, { query: "unread emails inbox" }).tools[0]).toMatchObject({
      name: "mail.list",
      appId: "mail",
      title: "List conversations",
    });
    expect(searchAiTools(catalog, { query: "read email messages", appId: "mail" }).tools).toEqual([
      expect.objectContaining({ name: "mail.list" }),
    ]);
    expect(searchAiTools(catalog, { query: "read", appId: "mail" }).tools).toEqual([]);
    expect(searchAiTools(catalog, { query: "missing phrase" }).tools).toEqual([]);
    expect(searchAiTools(catalog, { query: "create items", appId: "contacts" }).tools).toContainEqual(
      expect.objectContaining({ name: "contacts.create" }),
    );
  });

  test("does not let a scoped app description make every operation match", () => {
    const mail = capabilityApp(
      "mail",
      "Mail",
      { title: "Search mail", description: "Search email messages across accessible mailboxes." },
      "Read, search, and organize email messages and mailboxes.",
    );
    const tools = searchAiTools(buildAiToolCatalog([], buildAiCapabilityCatalog([mail])), {
      query: "search email messages",
      appId: "mail",
    }).tools;

    expect(tools.map((tool) => tool.name)).toEqual(["mail.list"]);
  });

  test("searches and returns the owning app description", () => {
    const catalog = buildAiToolCatalog(
      [],
      buildAiCapabilityCatalog([
        capabilityApp(
          "mail",
          "Mail",
          { title: "Browse records", description: "Return accessible records." },
          "Read and organize email communication, mailboxes, and inboxes.",
        ),
      ]),
    );

    expect(searchAiTools(catalog, { query: "email communication" }).tools).toContainEqual(
      expect.objectContaining({
        appId: "mail",
        name: "mail.list",
      }),
    );
  });

  test("preserves actionable input constraints and round-trips through Zod", () => {
    const source = capabilityApp("contacts").manifest.queries[0]!.inputSchema;
    source.properties = {
      ...(source.properties as Record<string, unknown>),
      options: { const: { exact: true }, description: "Fixed options." },
    };
    const reduced = reduceAiCapabilityInputSchema(source);
    const serialized = JSON.stringify(reduced);
    expect(serialized).toContain("minLength");
    expect(serialized).toContain("maxLength");
    expect(serialized).toContain("Optional title text.");
    expect(serialized).toContain('"enum":["open","done"]');
    expect(reduced).toHaveProperty("properties.options.const", { exact: true });

    const schema = aiCapabilityInputSchema(source);
    expect(schema.safeParse({ status: "open" }).success).toBe(true);
    expect(schema.safeParse({ status: "invalid" }).success).toBe(false);
    expect(z.toJSONSchema(schema)).toHaveProperty("properties.query.minLength", 2);
  });

  test("loads exact live names and exposes loaded app operations as ordinary tools", async () => {
    const catalog = buildAiCapabilityCatalog([capabilityApp("contacts", "Contacts")]);
    const updates: Array<{ names: string[]; maxLoadedTools?: number }> = [];
    const tools = createAiToolMetaTools({
      apps: [capabilityApp("contacts", "Contacts")],
      catalog: buildAiToolCatalog([], catalog),
      eagerNames: new Set(),
      conversationId: "conversation-1",
      maxLoadedTools: 2,
      store: {
        loadTools: async ({ names, maxLoadedTools }) => {
          updates.push({ names, maxLoadedTools });
          return { loaded: names, alreadyLoaded: [], evicted: [] };
        },
      },
    });
    const prepared = prepareAiTools({ tools, actor, conversationId: "conversation-1" });
    const load = prepared.tools.find((tool) => tool.def.name === "load_tools");
    expect(load?.kind).toBe("server");
    if (!load || load.kind !== "server") throw new Error("load_tools missing");
    const result = await load.execute(
      { names: ["contacts.list", "contacts__query__list"] },
      { signal: AbortSignal.timeout(1_000), requestApproval: async () => true, requestClientTool: async <T>() => undefined as T },
    );
    expect(result).toEqual({
      loaded: ["contacts.list"],
      alreadyLoaded: [],
      missing: ["contacts__query__list"],
      evicted: [],
      titles: { "contacts.list": "List items" },
    });
    expect(updates).toEqual([{ names: ["contacts.list"], maxLoadedTools: 2 }]);

    let called = "";
    const loaded = createLoadedAiCapabilityTools({
      catalog,
      loadedNames: ["contacts.list", "removed.list"],
      execute: async (entry) => {
        called = entry.name;
        return { data: [] };
      },
    });
    const loadedPrepared = prepareAiTools({ tools: loaded, actor, conversationId: "conversation-1" });
    expect(loadedPrepared.tools.map((tool) => tool.def.name)).toEqual(["contacts__query__list"]);
    expect(loadedPrepared.canonicalNames.get("contacts__query__list")).toBe("contacts.list");
    expect(loadedPrepared.approvalPolicies.get("contacts__query__list")).toBe("never");
    const tool = loadedPrepared.tools[0];
    if (!tool || tool.kind !== "server") throw new Error("loaded tool missing");
    expect(
      await tool.execute(
        {},
        { signal: AbortSignal.timeout(1_000), requestApproval: async () => true, requestClientTool: async <T>() => undefined as T },
      ),
    ).toEqual({
      data: [],
    });
    expect(called).toBe("contacts.list");

    const approvalMessages: string[] = [];
    const actionReviews: Array<{ callId: string; review: CapabilityActionReview }> = [];
    let actionExecutions = 0;
    const actionPrepared = prepareAiTools({
      tools: createLoadedAiCapabilityTools({
        catalog,
        loadedNames: ["contacts.create"],
        review: async () => ({
          message: "Create a contact.",
          approvalScope: "book:default",
          details: [
            { label: "Name", value: "Ada" },
            { label: "Notes", value: "Long notes", display: "block" },
          ],
          links: [{ rel: "open", href: "/app/contacts" }],
        }),
        onReview: (callId, review) => actionReviews.push({ callId, review }),
        execute: async () => {
          actionExecutions += 1;
          return { data: { id: "created" } };
        },
      }),
      actor,
      conversationId: "conversation-1",
    });
    expect(actionPrepared.approvalPolicies.get("contacts__action__create")).toBe("never");
    const action = actionPrepared.tools[0];
    if (!action || action.kind !== "server") throw new Error("loaded Action missing");
    await action.execute(
      { title: "Ada" },
      {
        callId: "call-create",
        signal: AbortSignal.timeout(1_000),
        requestApproval: async (message) => {
          approvalMessages.push(message);
          return true;
        },
        requestClientTool: async <T>() => undefined as T,
      },
    );
    expect(approvalMessages).toEqual(["Create a contact."]);
    expect(actionReviews).toEqual([
      {
        callId: "call-create",
        review: {
          message: "Create a contact.",
          approvalScope: "book:default",
          details: [
            { label: "Name", value: "Ada" },
            { label: "Notes", value: "Long notes", display: "block" },
          ],
          links: [{ rel: "open", href: "/app/contacts" }],
        },
      },
    ]);
    expect(actionExecutions).toBe(1);

    await expect(
      action.execute(
        { title: "Rejected" },
        {
          callId: "call-rejected",
          signal: AbortSignal.timeout(1_000),
          requestApproval: async () => false,
          requestClientTool: async <T>() => undefined as T,
        },
      ),
    ).rejects.toThrow("rejected by the user");
    expect(actionExecutions).toBe(1);
  });

  test("resolves a fresh immutable registry and loaded-tool snapshot for every provider turn", async () => {
    const contacts = capabilityApp("contacts", "Contacts");
    const spaces = capabilityApp("spaces", "Spaces");
    let registry = [contacts];
    let loaded = ["contacts.list"];
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: [],
      store: {
        getLoadedTools: async () => [...loaded],
        loadTools: async ({ names }) => {
          loaded = [...new Set([...loaded, ...names])];
          return { loaded: names, alreadyLoaded: [], evicted: [] };
        },
      },
      listRegistry: async () => [...registry],
      execute: async () => ({ data: [] }),
    });

    const first = await resolver();
    expect(first.map((tool) => tool.def.name)).toEqual(["search_tools", "load_tools", "list_apps", "contacts__query__list"]);
    expect(first.find((tool) => tool.def.name === "search_tools")?.def.description).not.toContain(
      "Previously loaded tools currently absent",
    );

    loaded.push("spaces.create");
    registry = [spaces];
    expect(first.map((tool) => tool.def.name)).toContain("contacts__query__list");
    const second = await resolver();
    expect(second.map((tool) => tool.def.name)).toEqual(["search_tools", "load_tools", "list_apps", "spaces__action__create"]);
    const searchDescription = second.find((tool) => tool.def.name === "search_tools")?.def.description;
    expect(searchDescription).toContain("Previously loaded tools currently absent from the live catalog: contacts.list");
    expect(searchDescription).toContain("Treat them as temporarily unavailable");
    expect(searchDescription).not.toContain("spaces.create");
  });

  test("snapshots presentation and remembered-approval scope for a loaded capability", async () => {
    let presentation: unknown;
    let approvalScope: string | undefined;
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: [],
      store: {
        getLoadedTools: async () => ["contacts.create"],
        loadTools: async ({ names }) => ({ loaded: names, alreadyLoaded: [], evicted: [] }),
      },
      listRegistry: async () => [capabilityApp("contacts", "Contacts")],
      execute: async () => ({ data: [] }),
      onPrepared: ({ presentations, rememberableApprovals }) => {
        presentation = presentations.get("contacts__action__create");
        approvalScope = rememberableApprovals.get("contacts__action__create");
      },
    });

    await resolver();
    expect(presentation).toMatchObject({
      kind: "capability",
      appId: "contacts",
      appAccent: "#0f766e",
    });
    expect(approvalScope).toBeUndefined();
  });

  test("keeps tool discovery available when the Help registry fails", async () => {
    const failures: unknown[] = [];
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: [],
      store: {
        getLoadedTools: async () => [],
        loadTools: async ({ names }) => ({ loaded: names, alreadyLoaded: [], evicted: [] }),
      },
      listRegistry: async () => [capabilityApp("contacts", "Contacts")],
      listHelpRegistry: async () => {
        throw new Error("registry unavailable");
      },
      onHelpRegistryError: (error) => failures.push(error),
      execute: async () => ({ data: [] }),
    });

    expect((await resolver()).map((tool) => tool.def.name)).toEqual([
      "search_tools",
      "load_tools",
      "list_apps",
      "search_help",
      "read_help",
    ]);
    expect(failures).toHaveLength(1);
  });

  test("keeps static tools available when the Capability registry fails", async () => {
    const failures: unknown[] = [];
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: [],
      store: {
        getLoadedTools: async () => [],
        loadTools: async ({ names }) => ({ loaded: names, alreadyLoaded: [], evicted: [] }),
      },
      listRegistry: async () => {
        throw new Error("registry unavailable");
      },
      onCapabilityRegistryError: (error) => failures.push(error),
      execute: async () => ({ data: [] }),
    });

    const unavailable = await resolver();
    expect(unavailable.map((tool) => tool.def.name)).toEqual(["search_tools", "load_tools", "list_apps"]);
    expect(unavailable.find((tool) => tool.def.name === "search_tools")?.def.description).toContain(
      "No live capability apps are visible in this provider turn",
    );
    expect(failures).toHaveLength(1);
  });

  test("persists automatic cleanup when a profile limit is reduced", async () => {
    let loaded = ["first", "contacts.list", "contacts.create"];
    const updates: Array<{ names: string[]; maxLoadedTools?: number }> = [];
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: [],
      maxLoadedTools: 2,
      store: {
        getLoadedTools: async () => [...loaded],
        loadTools: async ({ names, maxLoadedTools }) => {
          updates.push({ names, maxLoadedTools });
          loaded = loaded.slice(-(maxLoadedTools ?? loaded.length));
          return { loaded: names, alreadyLoaded: [], evicted: ["first"] };
        },
      },
      listRegistry: async () => [capabilityApp("contacts", "Contacts")],
      execute: async () => ({ data: [] }),
    });

    const tools = await resolver();
    expect(updates).toEqual([{ names: [], maxLoadedTools: 2 }]);
    expect(tools.map((tool) => tool.def.name)).toContain("contacts__query__list");
    expect(tools.map((tool) => tool.def.name)).toContain("contacts__action__create");
  });

  test("lets a small scripted model discover an app, load, and call without seeing every capability schema", async () => {
    const entries: StoreEntry[] = [];
    const requests: ProviderRequest[] = [];
    let loaded: string[] = [];
    let executed = "";
    const resolver = createAiToolResolver({
      conversationId: "conversation-1",
      actor,
      staticTools: [],
      store: {
        getLoadedTools: async () => [...loaded],
        loadTools: async ({ names }) => {
          loaded = [...new Set([...loaded, ...names])];
          return { loaded: names, alreadyLoaded: [], evicted: [] };
        },
      },
      listRegistry: async () => [capabilityApp("contacts", "Contacts")],
      execute: async (entry) => {
        executed = entry.name;
        return { data: [] };
      },
    });
    const calls = [
      { id: "apps-1", name: "list_apps", args: {} },
      { id: "search-1", name: "search_tools", args: { query: "list contacts", appId: "contacts" } },
      { id: "load-1", name: "load_tools", args: { names: ["contacts.list"] } },
      { id: "query-1", name: "contacts__query__list", args: {} },
    ];
    let providerTurn = 0;
    const provider: Provider = {
      name: "small-scripted-model",
      family: "openai-compatible",
      model: "small-scripted-model",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async *stream(request) {
        requests.push(request);
        const call = calls[providerTurn++];
        if (call) {
          yield { type: "block_start", blockId: call.id, index: 0, kind: "tool_call", callId: call.id, name: call.name };
          yield {
            type: "block_end",
            blockId: call.id,
            index: 0,
            block: { type: "tool_call", id: call.id, name: call.name, args: call.args },
          };
          yield { type: "usage", usage: { input: 20, output: 5, total: 25 }, finishReason: "tool_use" };
          return;
        }
        yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
        yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
        yield { type: "usage", usage: { input: 20, output: 2, total: 22 }, finishReason: "stop" };
      },
      async complete() {
        throw new Error("complete should not be used");
      },
    };
    const store = {
      load: async () => entries,
      append: async (message: StoreEntry["message"]) => {
        entries.push({ seq: entries.length + 1, kind: "message", message });
      },
    };

    for await (const _event of nessi({ input: "Find my contacts", provider, systemPrompt: "test", tools: resolver, store, maxTurns: 6 })) {
      // drain
    }

    expect((requests[0]?.tools ?? []).map((tool) => tool.name)).toEqual(["search_tools", "load_tools", "list_apps"]);
    expect(requests[0]?.tools?.find((tool) => tool.name === "search_tools")?.description).toContain(
      "Live capability apps: contacts (Contacts)",
    );
    expect((requests[2]?.tools ?? []).map((tool) => tool.name)).not.toContain("contacts__query__list");
    expect((requests[3]?.tools ?? []).map((tool) => tool.name)).toContain("contacts__query__list");
    expect(JSON.stringify(requests[0]?.tools)).not.toContain("schemaHash");
    expect(JSON.stringify(requests[0]?.tools)).not.toContain("Optional title text.");
    expect(executed).toBe("contacts.list");
  });
});
