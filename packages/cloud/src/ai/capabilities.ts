import { createHash } from "node:crypto";
import type { Tool, ToolContext, ToolResolver } from "@k2b/nessi";
import { z } from "zod";
import {
  createHelpCatalog,
  HELP_READ_MAX_CHARS,
  HELP_SEARCH_MAX_LIMIT,
  readHelpCatalog,
  searchHelpCatalog,
} from "../_internal/help-catalog";
import {
  type CapabilityActionManifest,
  type CapabilityActionReview,
  type CapabilityQueryManifest,
  CloudResourceRefSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import type { CapabilityRegistryEntry, HelpRegistryEntry } from "../contracts/registry";
import type { RequestActor } from "../server";
import { CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES } from "./default-tools";
import { type AiToolPreparationContext, defineAiTool, type PreparedAiTools, prepareAiTools } from "./tools";
import type { AiConversationService, AiRuntimeTool, AiToolPresentation } from "./types";

export type AiCapabilityKind = "query" | "action";

export type AiCapabilityCatalogItem = {
  name: string;
  appId: string;
  appName: string;
  appDescription: string;
  kind: AiCapabilityKind;
  title: string;
  description: string;
};

export type AiCapabilityAppCatalogItem = {
  appId: string;
  appName: string;
  description: string;
};

export type AiCapabilityCatalogEntry = AiCapabilityCatalogItem & {
  app: CapabilityRegistryEntry;
  operation: CapabilityQueryManifest | CapabilityActionManifest;
};

export type AiToolKind = "builtin" | AiCapabilityKind;

export type AiToolCatalogItem = {
  name: string;
  title: string;
  description: string;
  kind: AiToolKind;
  appId?: string;
};

type AiToolCatalogEntry = AiToolCatalogItem & {
  searchText: string;
  runtimeTool?: AiRuntimeTool;
  capability?: AiCapabilityCatalogEntry;
};

export type AiRememberableCapabilityApprovals = ReadonlyMap<string, string>;

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_APP_LIST_LIMIT = 20;
const MAX_APP_LIST_LIMIT = 25;
const MAX_APP_DIRECTORY_DESCRIPTION_CHARS = 2_000;
const MAX_UNAVAILABLE_LOADED_NAMES = 10;

const providerSafeSegment = (value: string): string =>
  [...value]
    .map((character) => {
      if (/^[a-zA-Z0-9-]$/.test(character)) return character;
      if (character === "_") return "__";
      if (character === ".") return "_dot_";
      return `_u${character.codePointAt(0)!.toString(16)}_`;
    })
    .join("");

/** Readable, collision-safe name within the strictest common provider limit. */
export const aiCapabilityToolName = (appId: string, kind: AiCapabilityKind, localId: string): string => {
  const full = `${providerSafeSegment(appId)}__${kind}__${providerSafeSegment(localId)}`;
  if (full.length <= 64) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 12);
  return `${full.slice(0, 50)}__${suffix}`;
};

/** Build the compact, deterministic directory of apps in the current live registry. */
export const buildAiCapabilityAppCatalog = (apps: readonly CapabilityRegistryEntry[]): AiCapabilityAppCatalogItem[] => {
  const seen = new Set<string>();
  return [...apps]
    .sort(
      (left, right) =>
        left.appId.localeCompare(right.appId) ||
        left.appName.localeCompare(right.appName) ||
        left.appDescription.localeCompare(right.appDescription) ||
        left.endpoint.localeCompare(right.endpoint),
    )
    .flatMap((app) => {
      if (seen.has(app.appId)) return [];
      seen.add(app.appId);
      return [{ appId: app.appId, appName: app.appName, description: app.appDescription }];
    });
};

/** Build one deterministic, immutable view of the current live registry. */
export const buildAiCapabilityCatalog = (apps: CapabilityRegistryEntry[]): AiCapabilityCatalogEntry[] => {
  const entries = [...apps]
    .sort(
      (left, right) =>
        left.appId.localeCompare(right.appId) ||
        left.manifest.manifestHash.localeCompare(right.manifest.manifestHash) ||
        left.appName.localeCompare(right.appName) ||
        left.endpoint.localeCompare(right.endpoint),
    )
    .flatMap((app) => [
      ...app.manifest.actions.map((operation) => ({ app, operation, kind: "action" as const })),
      ...app.manifest.queries.map((operation) => ({ app, operation, kind: "query" as const })),
    ])
    .map(
      ({ app, operation, kind }): AiCapabilityCatalogEntry => ({
        name: aiCapabilityToolName(app.appId, kind, operation.localId),
        appId: app.appId,
        appName: app.appName,
        appDescription: app.appDescription,
        kind,
        title: operation.title,
        description: operation.description,
        app,
        operation,
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
};

const boundedLimit = (value: number | undefined, fallback: number, maximum: number): number => {
  if (!Number.isInteger(value) || Number(value) <= 0) return fallback;
  return Math.min(Number(value), maximum);
};

export const listAiCapabilityApps = (
  apps: readonly AiCapabilityAppCatalogItem[],
  input: { cursor?: string; limit?: number },
): { apps: AiCapabilityAppCatalogItem[]; page: { hasMore: boolean; nextCursor?: string } } => {
  const start = input.cursor ? apps.findIndex((app) => app.appId > input.cursor!) : 0;
  const offset = start < 0 ? apps.length : start;
  const limit = boundedLimit(input.limit, DEFAULT_APP_LIST_LIMIT, MAX_APP_LIST_LIMIT);
  const page = apps.slice(offset, offset + limit);
  const hasMore = offset + page.length < apps.length;
  return {
    apps: [...page],
    page: {
      hasMore,
      ...(hasMore && page.length > 0 ? { nextCursor: page.at(-1)!.appId } : {}),
    },
  };
};

const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const searchTerms = (value: string): string[] => {
  const terms = normalizeSearchText(value).split(" ").filter(Boolean);
  const meaningful = terms.filter((term) => term.length >= 2);
  return [...new Set(meaningful.length > 0 ? meaningful : terms)];
};

const searchTermForms = (term: string): string[] => {
  const forms = new Set([term]);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) forms.add(term.slice(0, -1));
  if (term.length > 4 && term.endsWith("es")) forms.add(term.slice(0, -2));
  if (term.length > 4 && term.endsWith("ies")) forms.add(`${term.slice(0, -3)}y`);
  return [...forms];
};

const searchWordForms = (value: string): Set<string> => new Set(searchTerms(value).flatMap(searchTermForms));

const includesSearchTerm = (words: ReadonlySet<string>, term: string): boolean => searchTermForms(term).some((form) => words.has(form));

const includesSearchPhrase = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);

const toolTitle = (name: string): string =>
  name
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

export const buildAiToolCatalog = (
  builtIns: readonly AiRuntimeTool[],
  capabilities: readonly AiCapabilityCatalogEntry[],
): AiToolCatalogEntry[] =>
  [
    ...builtIns.map(
      (runtimeTool): AiToolCatalogEntry => ({
        name: runtimeTool.def.name,
        title: toolTitle(runtimeTool.def.name),
        description: runtimeTool.def.description,
        kind: "builtin",
        searchText: "",
        runtimeTool,
      }),
    ),
    ...capabilities.map(
      (capability): AiToolCatalogEntry => ({
        name: capability.name,
        title: capability.title,
        description: capability.description,
        kind: capability.kind,
        appId: capability.appId,
        searchText: `${capability.appName} ${capability.appDescription}`,
        capability,
      }),
    ),
  ].sort((left, right) => left.name.localeCompare(right.name));

export const searchAiTools = (
  catalog: readonly AiToolCatalogEntry[],
  input: { query: string; appId?: string },
): { tools: AiToolCatalogItem[] } => {
  const phrase = normalizeSearchText(input.query);
  const terms = searchTerms(input.query);
  if (!phrase || terms.length === 0) return { tools: [] };
  const matches = catalog
    .filter((entry) => !input.appId || entry.appId === input.appId)
    .flatMap((entry) => {
      const name = normalizeSearchText(entry.name);
      const title = normalizeSearchText(entry.title);
      const identity = `${name} ${title}`;
      const app = normalizeSearchText(`${entry.appId ?? ""} ${entry.searchText}`);
      const description = normalizeSearchText(entry.description);
      const identityWords = searchWordForms(identity);
      const appWords = input.appId ? new Set<string>() : searchWordForms(app);
      const descriptionWords = searchWordForms(description);
      let matchedTerms = 0;
      let score = 0;
      if (name === phrase || title === phrase) score += 100;
      else if (includesSearchPhrase(identity, phrase)) score += 50;
      if (!input.appId && app === phrase) score += 40;
      else if (!input.appId && includesSearchPhrase(app, phrase)) score += 20;
      if (includesSearchPhrase(description, phrase)) score += 15;
      for (const term of terms) {
        const identityMatch = includesSearchTerm(identityWords, term);
        const appMatch = includesSearchTerm(appWords, term);
        const descriptionMatch = includesSearchTerm(descriptionWords, term);
        if (identityMatch || appMatch || descriptionMatch) matchedTerms += 1;
        if (identityMatch) score += 8;
        if (appMatch) score += 6;
        if (descriptionMatch) score += 4;
      }
      return matchedTerms > 0 ? [{ entry, matchedTerms, score }] : [];
    })
    .sort(
      (left, right) =>
        right.matchedTerms - left.matchedTerms || right.score - left.score || left.entry.name.localeCompare(right.entry.name),
    )
    .slice(0, DEFAULT_SEARCH_LIMIT);
  return {
    tools: matches.map(({ entry }) => ({
      name: entry.name,
      title: entry.title,
      description: entry.description,
      kind: entry.kind,
      ...(entry.appId ? { appId: entry.appId } : {}),
    })),
  };
};

const AiHelpCatalogItemSchema = z
  .object({
    appId: z.string(),
    appName: z.string(),
    kind: z.literal("help"),
    documentId: z.string(),
    title: z.string(),
    description: z.string().optional(),
  })
  .strict();

const AiHelpDocumentSchema = AiHelpCatalogItemSchema.extend({
  markdown: z.string().max(HELP_READ_MAX_CHARS),
  truncated: z.boolean(),
}).strict();

/** Search and read the live Help snapshot without loading one tool per article. */
export const createAiHelpTools = (registry: readonly HelpRegistryEntry[]): AiRuntimeTool[] => {
  const documents = createHelpCatalog(registry);

  const search = defineAiTool({
    name: "search_help",
    description:
      "Search installed Cloud app Help when product behavior, settings, workflows, permissions, or app errors are unclear. Use 1-3 concise English product terms and scope appId when known. Returns compact document ids for read_help; skip this tool for straightforward live-data requests.",
    inputSchema: z
      .object({
        query: z.string().trim().min(1).max(200).describe("Product task or concept to find."),
        appId: z.string().trim().min(1).optional().describe("Optional exact Cloud app id."),
        limit: z.number().int().min(1).max(HELP_SEARCH_MAX_LIMIT).optional(),
      })
      .strict(),
    outputSchema: z.object({ documents: z.array(AiHelpCatalogItemSchema).max(HELP_SEARCH_MAX_LIMIT) }).strict(),
    approval: "never",
  }).server(async ({ query, appId, limit }) => ({
    documents: searchHelpCatalog(documents, { query, appId, limit: boundedLimit(limit, DEFAULT_SEARCH_LIMIT, HELP_SEARCH_MAX_LIMIT) }),
  }));

  const read = defineAiTool({
    name: "read_help",
    description:
      "Read the best matching Cloud app Help article returned by search_help. Pass the same concise search terms so long articles return the relevant bounded sections. Product Help guides behavior but never proves live access or action success.",
    inputSchema: z
      .object({
        appId: z.string().trim().min(1).describe("Exact Cloud app id."),
        documentId: z.string().trim().min(1).describe("Exact Help document id."),
        query: z.string().trim().min(1).max(200).optional().describe("The concise terms used to find the article."),
      })
      .strict(),
    outputSchema: z.object({ document: AiHelpDocumentSchema.nullable() }).strict(),
    approval: "never",
  }).server(async ({ appId, documentId, query }) => ({
    document: readHelpCatalog(documents, { appId, documentId, query }),
  }));

  return [search, read];
};

const resolveHelpRegistry = async (
  listRegistry: () => Promise<HelpRegistryEntry[]>,
  onError?: (error: unknown) => void,
): Promise<HelpRegistryEntry[]> => {
  try {
    return await listRegistry();
  } catch (error) {
    onError?.(error);
    return [];
  }
};

const resolveCapabilityRegistry = async (
  listRegistry: () => Promise<CapabilityRegistryEntry[]>,
  onError?: (error: unknown) => void,
): Promise<CapabilityRegistryEntry[]> => {
  try {
    return await listRegistry();
  } catch (error) {
    onError?.(error);
    return [];
  }
};

const SCHEMA_KEYS = new Set([
  "$ref",
  "type",
  "description",
  "format",
  "default",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "properties",
  "required",
  "items",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "nullable",
  "$defs",
  "definitions",
]);

const reduceSchemaValue = (value: unknown, key?: string): unknown => {
  if (key === "const") return structuredClone(value);
  if (Array.isArray(value)) {
    if (key === "required" || key === "enum" || key === "type") return structuredClone(value);
    return value.map((item) => reduceSchemaValue(item));
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (key === "properties" || key === "$defs" || key === "definitions") {
      output[childKey] = reduceSchemaValue(childValue);
      continue;
    }
    if (!SCHEMA_KEYS.has(childKey)) continue;
    output[childKey] = reduceSchemaValue(childValue, childKey);
  }
  return output;
};

/** Keep the provider-useful shape while leaving authoritative validation in the target app. */
export const reduceAiCapabilityInputSchema = (schema: Record<string, unknown>): Record<string, unknown> =>
  reduceSchemaValue(schema) as Record<string, unknown>;

export const aiCapabilityInputSchema = (schema: Record<string, unknown>): z.ZodType =>
  z.fromJSONSchema(reduceAiCapabilityInputSchema(schema));

const ToolCatalogItemSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    kind: z.enum(["builtin", "query", "action"]),
    appId: z.string().optional(),
  })
  .strict();

type ToolStateStore = Pick<AiConversationService, "loadTools">;

export const createAiToolMetaTools = (input: {
  apps: readonly CapabilityRegistryEntry[];
  catalog: readonly AiToolCatalogEntry[];
  eagerNames: ReadonlySet<string>;
  conversationId: string;
  store: ToolStateStore;
  maxLoadedTools?: number;
  unavailableLoadedNames?: readonly string[];
}): AiRuntimeTool[] => {
  const apps = buildAiCapabilityAppCatalog(input.apps);
  const directoryEntries: string[] = [];
  let directoryLength = 0;
  for (const app of apps) {
    const entry = `${app.appId} (${app.appName})`;
    const addedLength = entry.length + (directoryEntries.length > 0 ? 2 : 0);
    if (directoryLength + addedLength > MAX_APP_DIRECTORY_DESCRIPTION_CHARS) break;
    directoryEntries.push(entry);
    directoryLength += addedLength;
  }
  const hiddenAppCount = apps.length - directoryEntries.length;
  const liveAppDirectory =
    directoryEntries.length > 0
      ? ` Live capability apps: ${directoryEntries.join(", ")}${hiddenAppCount > 0 ? `, and ${hiddenAppCount} more` : ""}.`
      : " No live capability apps are visible in this provider turn; retry discovery later instead of claiming a permanent product limitation.";
  const unavailableLoadedNames = input.unavailableLoadedNames ?? [];
  const unavailableLoadedNotice =
    unavailableLoadedNames.length > 0
      ? ` Previously loaded tools currently absent from the live catalog: ${unavailableLoadedNames
          .slice(-MAX_UNAVAILABLE_LOADED_NAMES)
          .join(", ")}${
          unavailableLoadedNames.length > MAX_UNAVAILABLE_LOADED_NAMES
            ? `, and ${unavailableLoadedNames.length - MAX_UNAVAILABLE_LOADED_NAMES} more`
            : ""
        }. Treat them as temporarily unavailable; do not infer a permanent product limitation or search repeatedly.`
      : "";
  const search = defineAiTool({
    name: "search_tools",
    description: `Search available Cloud tools and installed app operations by concise task terms.${liveAppDirectory} When the app is known, set its exact appId on the first attempt. Use list_apps only when the owning app is unclear. This only discovers tools; call load_tools with the exact returned names before using deferred tools.${unavailableLoadedNotice}`,
    inputSchema: z
      .object({
        query: z.string().trim().min(1).max(200).describe("What the tool should do."),
        appId: z.string().trim().min(1).optional().describe("Optional exact Cloud app id."),
      })
      .strict(),
    outputSchema: z.object({ tools: z.array(ToolCatalogItemSchema).max(DEFAULT_SEARCH_LIMIT) }).strict(),
    approval: "never",
  }).server(async (args) => searchAiTools(input.catalog, args));

  const listApps = defineAiTool({
    name: "list_apps",
    description:
      "List live Cloud apps that currently publish AI-accessible operations. Returns exact app ids and concise app descriptions; use an app id to scope search_tools.",
    inputSchema: z
      .object({
        cursor: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(MAX_APP_LIST_LIMIT).optional(),
      })
      .strict(),
    outputSchema: z.object({ apps: z.record(z.string(), z.string()), nextCursor: z.string().optional() }).strict(),
    approval: "never",
  }).server(async (args) => {
    const result = listAiCapabilityApps(apps, args);
    return {
      apps: Object.fromEntries(result.apps.map((app) => [app.appId, app.description])),
      ...(result.page.nextCursor ? { nextCursor: result.page.nextCursor } : {}),
    };
  });

  const load = defineAiTool({
    name: "load_tools",
    description:
      "Load exact names returned by search_tools as ordinary tools for the next model turn. Built-ins named in the system prompt can be loaded directly without searching.",
    inputSchema: z.object({ names: z.array(z.string().trim().min(1)).min(1).max(25) }).strict(),
    outputSchema: z
      .object({
        loaded: z.array(z.string()),
        alreadyLoaded: z.array(z.string()),
        missing: z.array(z.string()),
        evicted: z.array(z.string()),
        titles: z.record(z.string(), z.string()),
      })
      .strict(),
    approval: "never",
  }).server(async ({ names }) => {
    const available = new Set(input.catalog.map((entry) => entry.name));
    const requested = [...new Set(names)];
    const eager = requested.filter((name) => input.eagerNames.has(name));
    const valid = requested.filter((name) => available.has(name) && !input.eagerNames.has(name));
    const missing = requested.filter((name) => !available.has(name));
    const updated = await input.store.loadTools({
      conversationId: input.conversationId,
      names: valid,
      maxLoadedTools: input.maxLoadedTools,
    });
    const alreadyLoaded = [...new Set([...eager, ...updated.alreadyLoaded])];
    const catalogByName = new Map(input.catalog.map((entry) => [entry.name, entry]));
    const titles = Object.fromEntries(
      [...new Set([...updated.loaded, ...alreadyLoaded, ...updated.evicted])].flatMap((name) => {
        const entry = catalogByName.get(name);
        return entry ? [[name, entry.title]] : [];
      }),
    );
    return { ...updated, alreadyLoaded, missing, titles };
  });

  return [search, load, listApps];
};

export const createLoadedAiCapabilityTools = (input: {
  catalog: readonly AiCapabilityCatalogEntry[];
  loadedNames: readonly string[];
  review?: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<CapabilityActionReview | null>;
  onReview?: (callId: string, review: CapabilityActionReview) => void;
  execute: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<unknown>;
}): AiRuntimeTool[] => {
  const byName = new Map(input.catalog.map((entry) => [entry.name, entry]));
  return input.loadedNames.flatMap((name) => {
    const entry = byName.get(name);
    if (!entry) return [];
    return [
      defineAiTool({
        name: entry.name,
        description: `${entry.title}. ${entry.description} Never retry ACTION_OUTCOME_UNKNOWN. Do not retry unchanged after INTERNAL or INVALID_APP_RESPONSE; report the provider error.`,
        inputSchema: aiCapabilityInputSchema(entry.operation.inputSchema),
        outputSchema: z.unknown(),
        // Capability Actions request a custom approval after their optional
        // live review has resolved. The review may supply an app-owned scope.
        approval: "never",
      }).server(async (args, context) => {
        if (entry.kind === "action") {
          const review = (await input.review?.(entry, args, context)) ?? null;
          if (review && context.callId) input.onReview?.(context.callId, review);
          const message =
            review?.message ?? `${entry.appName}: ${entry.title}\nReview the validated arguments below before running this Action.`;
          if (!(await context.requestApproval(message))) throw new Error("Capability Action was rejected by the user.");
        }
        return input.execute(entry, args, context);
      }),
    ];
  });
};

export const createAiResourceReaderTool = (input: {
  apps: readonly CapabilityRegistryEntry[];
  catalog: readonly AiCapabilityCatalogEntry[];
  execute: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<unknown>;
}): AiRuntimeTool =>
  defineAiTool({
    name: "read_cloud_resource",
    description:
      "Read a Cloud resource from its structured reference using the resource type's current canonical reader. Pass refs returned by search, Projects, or other capabilities unchanged; never substitute an id from another resource type.",
    inputSchema: CloudResourceRefSchema,
    outputSchema: z.unknown(),
    approval: "never",
  }).server(async (ref, context) => {
    const appId = cloudResourceRefAppId(ref);
    const app = input.apps.find((candidate) => candidate.appId === appId);
    const reader = app ? resolveCapabilityResourceReader(app.manifest, ref) : null;
    if (!reader) throw new Error(`Cloud resource type ${ref.type} is unknown or has no reader.`);
    const entry = input.catalog.find(
      (candidate) => candidate.appId === appId && candidate.kind === "query" && candidate.operation.localId === reader.localId,
    );
    if (!entry) throw new Error(`Cloud resource reader ${appId}.${reader.localId} is unavailable.`);
    return input.execute(entry, { id: ref.id }, context);
  });

/** Nessi resolver: one registry/load-state snapshot drives discovery, loading, schemas, and execution per model turn. */
export const createAiToolResolver =
  (input: {
    conversationId: string;
    actor: RequestActor;
    staticTools: AiRuntimeTool[];
    runtimeContext?: Omit<AiToolPreparationContext, "actor" | "conversationId">;
    store: Pick<AiConversationService, "getLoadedTools" | "loadTools">;
    listRegistry?: () => Promise<CapabilityRegistryEntry[]>;
    onCapabilityRegistryError?: (error: unknown) => void;
    listHelpRegistry?: () => Promise<HelpRegistryEntry[]>;
    onHelpRegistryError?: (error: unknown) => void;
    maxLoadedTools?: number;
    execute?: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<unknown>;
    review?: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<CapabilityActionReview | null>;
    onReview?: (callId: string, review: CapabilityActionReview) => void;
    onPrepared?: (snapshot: {
      prepared: PreparedAiTools;
      presentations: Map<string, AiToolPresentation>;
      rememberableApprovals: AiRememberableCapabilityApprovals;
    }) => void;
  }): ToolResolver =>
  async (): Promise<Tool[]> => {
    const [registry, persistedLoadedNames, helpRegistry] = await Promise.all([
      input.listRegistry ? resolveCapabilityRegistry(input.listRegistry, input.onCapabilityRegistryError) : [],
      input.store.getLoadedTools({ conversationId: input.conversationId }),
      input.listHelpRegistry ? resolveHelpRegistry(input.listHelpRegistry, input.onHelpRegistryError) : [],
    ]);
    const configuredLimit = Math.floor(input.maxLoadedTools ?? 0);
    const loadedNames = configuredLimit > 0 ? persistedLoadedNames.slice(-configuredLimit) : persistedLoadedNames;
    if (loadedNames.length !== persistedLoadedNames.length) {
      await input.store.loadTools({
        conversationId: input.conversationId,
        names: [],
        maxLoadedTools: configuredLimit,
      });
    }
    const capabilityCatalog = buildAiCapabilityCatalog(registry);
    const helpTools = input.listHelpRegistry ? createAiHelpTools(helpRegistry) : [];
    const resourceTool =
      input.execute && capabilityCatalog.length > 0
        ? createAiResourceReaderTool({ apps: registry, catalog: capabilityCatalog, execute: input.execute })
        : null;
    const builtIns = [...input.staticTools, ...helpTools, ...(resourceTool ? [resourceTool] : [])];
    const catalog = buildAiToolCatalog(builtIns, capabilityCatalog);
    const catalogNames = new Set(catalog.map((entry) => entry.name));
    const unavailableLoadedNames = loadedNames.filter((name) => !catalogNames.has(name));
    const eagerNames = new Set(builtIns.map((tool) => tool.def.name).filter((name) => !CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has(name)));
    const activeBuiltIns = builtIns.filter((tool) => eagerNames.has(tool.def.name) || loadedNames.includes(tool.def.name));
    const runtimeTools = [
      ...createAiToolMetaTools({
        apps: registry,
        catalog,
        eagerNames,
        conversationId: input.conversationId,
        store: input.store,
        maxLoadedTools: input.maxLoadedTools,
        unavailableLoadedNames,
      }),
      ...activeBuiltIns,
      ...(input.execute
        ? createLoadedAiCapabilityTools({
            catalog: capabilityCatalog,
            loadedNames,
            review: input.review,
            onReview: input.onReview,
            execute: input.execute,
          })
        : []),
    ];
    const prepared = prepareAiTools({
      tools: runtimeTools,
      ...input.runtimeContext,
      actor: input.actor,
      conversationId: input.conversationId,
    });
    const catalogByName = new Map(capabilityCatalog.map((entry) => [entry.name, entry]));
    const presentations = new Map<string, AiToolPresentation>();
    const rememberableApprovals = new Map<string, string>();
    for (const name of loadedNames) {
      const entry = catalogByName.get(name);
      if (!entry) continue;
      presentations.set(name, {
        kind: "capability",
        appId: entry.appId,
        appName: entry.appName,
        appIcon: entry.app.appIcon,
        appAccent: entry.app.appAccent,
        title: entry.title,
        capabilityKind: entry.kind,
      });
      // Rememberable scopes are resolved by the owning app for each concrete
      // call and attached when its live review completes.
    }
    input.onPrepared?.({ prepared, presentations, rememberableApprovals });
    return prepared.tools;
  };
