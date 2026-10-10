import { createHash } from "node:crypto";
import type { Tool, ToolContext, ToolResolver } from "@k2b/nessi";
import { z } from "zod";
import { resolveCapabilityActionWording, resolveCapabilityOperationTitle } from "../_internal/capabilities";
import {
  CAPABILITY_APPROVAL_REASON_FIELD,
  CAPABILITY_APPROVAL_REASON_MAX_CHARS,
  type CapabilityActionWording,
  capabilityActionSubject,
  capabilityApprovalReason,
  capabilityApprovalReasonLabel,
} from "../_internal/capability-sentences";
import { HELP_READ_MAX_CHARS, HELP_SEARCH_MAX_LIMIT, readHelpArticle } from "../_internal/help-catalog";
import {
  type CapabilityActionManifest,
  type CapabilityActionReview,
  type CapabilityQueryManifest,
  CloudResourceRefSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestActor } from "../server";
import type { HelpReader, HelpReaderFactory } from "../services/help";
import { type MandatePolicyV1, mandatePolicyCanPermitCapability } from "../services/mandates/policy";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { DEFAULT_LOCALE } from "../shared/locale";
import { recordRejectedAiCapability } from "./capability-execution";
import { CODE_SOURCE_TOOLS } from "./code-source-contracts";
import { createCodeSourceTool } from "./code-source-tools";
import { CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES } from "./default-tools";
import { type AiToolPreparationContext, defineAiTool, type PreparedAiTools, prepareAiTools } from "./tools";
import type { AiConversationService, AiRuntimeTool, AiToolPresentation } from "./types";

export type AiCapabilityKind = "query" | "action";

export type AiCapabilityCatalogItem = {
  /** Stable public identity used by Skills, discovery, loading, and persistence. */
  name: string;
  /** Provider-safe function name used only for model tool definitions and calls. */
  providerName: string;
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
  /**
   * What people see in tool rows and approvals, in the locale the catalog was built for. The model keeps
   * the base `title`, `description`, and schemas: they are prompt text, and stable prompts do not change
   * with the reader's language.
   */
  display: { appName: string; title: string };
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

/**
 * Why `load_tools` could not make a requested name callable:
 * - `unknown`: no tool has this exact name;
 * - `not_offered_in_turn`: the tool exists, but this turn's client or task does not provide it;
 * - `not_allowed`: the conversation's fixed tool scope or task grants exclude it;
 * - `app_offline`: the app operation is not in the live registry now.
 */
export const AI_TOOL_UNAVAILABLE_REASONS = ["unknown", "not_offered_in_turn", "not_allowed", "app_offline"] as const;
export type AiToolUnavailableReason = (typeof AI_TOOL_UNAVAILABLE_REASONS)[number];

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

/** Stable qualified identity shared by capability consumers outside provider transports. */
export const aiCapabilityId = (appId: string, localId: string): string => `${appId}.${localId}`;

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

/**
 * Build one deterministic, immutable view of the current live registry. `locale` selects the human
 * presentation in `display`; model-facing fields always stay in the app's base presentation.
 */
export const buildAiCapabilityCatalog = (apps: CapabilityRegistryEntry[], locale?: string): AiCapabilityCatalogEntry[] => {
  const entries = [...apps]
    .sort(
      (left, right) =>
        left.appId.localeCompare(right.appId) ||
        left.manifest.manifestHash.localeCompare(right.manifest.manifestHash) ||
        left.appName.localeCompare(right.appName) ||
        left.endpoint.localeCompare(right.endpoint),
    )
    .flatMap((app) => {
      const appName = locale
        ? resolveAppIdentityPresentation({ name: app.appName, description: app.appDescription, presentation: app.appPresentation }, locale)
            .name
        : app.appName;
      return [
        ...app.manifest.actions.map((operation) => ({ app, appName, operation, kind: "action" as const })),
        ...app.manifest.queries.map((operation) => ({ app, appName, operation, kind: "query" as const })),
      ];
    })
    .map(
      ({ app, appName, operation, kind }): AiCapabilityCatalogEntry => ({
        name: aiCapabilityId(app.appId, operation.localId),
        providerName: aiCapabilityToolName(app.appId, kind, operation.localId),
        appId: app.appId,
        appName: app.appName,
        appDescription: app.appDescription,
        kind,
        title: operation.title,
        description: operation.description,
        app,
        operation,
        display: {
          appName,
          title: locale
            ? resolveCapabilityOperationTitle(operation, kind === "action" ? "actions" : "queries", app.presentation, locale)
            : operation.title,
        },
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
    locale: z.string(),
    documentId: z.string(),
    title: z.string(),
    description: z.string().optional(),
  })
  .strict();

const AiHelpDocumentSchema = AiHelpCatalogItemSchema.extend({
  markdown: z.string().max(HELP_READ_MAX_CHARS),
  truncated: z.boolean(),
}).strict();

/** Search and read published Help without loading one tool per article. */
export const createAiHelpTools = (reader: HelpReader): AiRuntimeTool[] => {
  const search = defineAiTool({
    name: "search_help",
    description:
      "Search installed Cloud app Help when product behavior, settings, workflows, permissions, or app errors are unclear. Use concise product terms in the request language and scope appId when known. Returns compact document ids for read_help; skip this tool for straightforward live-data requests.",
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
    documents: await reader.search({ query, appId, limit: boundedLimit(limit, DEFAULT_SEARCH_LIMIT, HELP_SEARCH_MAX_LIMIT) }),
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
  }).server(async ({ appId, documentId, query }) => {
    const document = await reader.read({ appId, documentId });
    return { document: document ? readHelpArticle(document, query) : null };
  });

  return [search, read];
};

/** `null` when the registry could not be read. */
const resolveCapabilityRegistry = async (
  listRegistry: () => Promise<CapabilityRegistryEntry[]>,
  onError?: (error: unknown) => void,
): Promise<CapabilityRegistryEntry[] | null> => {
  try {
    return await listRegistry();
  } catch (error) {
    onError?.(error);
    return null;
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

/** How people read calls of one loaded Action in the turn's locale; derived from the live catalog only. */
export const aiCapabilityActionWording = (entry: AiCapabilityCatalogEntry, locale: string | undefined): CapabilityActionWording =>
  resolveCapabilityActionWording(entry.operation as CapabilityActionManifest, entry.app.presentation, locale ?? DEFAULT_LOCALE);

/**
 * An Action that waits for approval lets the model say why it wants it. The field exists only for the model:
 * Cloud removes it before review, authorization, and execution. An app field of the same name wins.
 */
const offersApprovalReason = (entry: AiCapabilityCatalogEntry): boolean => {
  if (entry.kind !== "action" || (entry.operation as CapabilityActionManifest).approval === "none") return false;
  const properties = entry.operation.inputSchema.properties;
  return Boolean(properties && typeof properties === "object" && !Object.hasOwn(properties, CAPABILITY_APPROVAL_REASON_FIELD));
};

const withApprovalReason = (schema: Record<string, unknown>): Record<string, unknown> => ({
  ...schema,
  properties: {
    ...(schema.properties as Record<string, unknown>),
    [CAPABILITY_APPROVAL_REASON_FIELD]: {
      type: "string",
      maxLength: CAPABILITY_APPROVAL_REASON_MAX_CHARS,
      description:
        "Optional: one short sentence in the user's language on why this call is needed now. Shown as your reason beside the approval; never put Action input here.",
    },
  },
});

const withoutApprovalReason = (entry: AiCapabilityCatalogEntry, args: unknown): unknown => {
  if (!offersApprovalReason(entry) || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const { [CAPABILITY_APPROVAL_REASON_FIELD]: _reason, ...appArgs } = args as Record<string, unknown>;
  return appArgs;
};

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

/** `call` is the name to call the tool by; app operations get a provider-safe name. */
const LoadedToolSchema = z.object({ name: z.string(), call: z.string() }).strict();

export const createAiToolMetaTools = (input: {
  apps: readonly CapabilityRegistryEntry[];
  catalog: readonly AiToolCatalogEntry[];
  eagerNames: ReadonlySet<string>;
  conversationId: string;
  store: ToolStateStore;
  maxLoadedTools?: number;
  unavailableLoadedNames?: readonly string[];
  /** Whether this turn offers app operations, offers none, or its fixed scope or task grants exclude all of them. */
  appOperations?: "not_offered" | "not_allowed" | "offered";
  /** Why a requested name that is not in `catalog` cannot be loaded; defaults to `unknown`. */
  unavailableReason?: (name: string) => AiToolUnavailableReason;
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
      : input.appOperations === "not_offered"
        ? " App operations are not offered in this turn."
        : input.appOperations === "not_allowed"
          ? " This chat's tool scope or task grants allow no app operations. Do not search for app operations in this turn; continue with the available tools or tell the user which grant is missing."
          : " No Cloud app publishes operations right now. Do not search for app operations again in this turn; tell the user which app is not reachable instead of claiming a permanent product limitation.";
  const unavailableLoadedNames = input.unavailableLoadedNames ?? [];
  const unavailableLoadedNotice =
    unavailableLoadedNames.length > 0
      ? ` Previously loaded tools that are not available now: ${unavailableLoadedNames.slice(-MAX_UNAVAILABLE_LOADED_NAMES).join(", ")}${
          unavailableLoadedNames.length > MAX_UNAVAILABLE_LOADED_NAMES
            ? `, and ${unavailableLoadedNames.length - MAX_UNAVAILABLE_LOADED_NAMES} more`
            : ""
        }. Do not search for them again in this turn; continue without them or tell the user what is missing.`
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
      "Load stable capability ids such as mail.conversation.list, or exact built-in names returned by search_tools, as ordinary tools for the next model turn. Skills may name capability ids directly, so load them without searching first. Call each loaded tool by the `call` name returned for it. `unavailable` gives a reason per name: unknown means no tool has this exact name, so look it up once with search_tools instead of guessing; not_offered_in_turn means this client or task does not provide the tool; not_allowed means this chat's fixed tool scope or task grants exclude it; app_offline means its app is not reachable now. For the last three, do not search or load the name again in this turn.",
    inputSchema: z.object({ names: z.array(z.string().trim().min(1)).min(1).max(25) }).strict(),
    outputSchema: z
      .object({
        loaded: z.array(LoadedToolSchema),
        alreadyLoaded: z.array(LoadedToolSchema),
        unavailable: z.array(z.object({ name: z.string(), reason: z.enum(AI_TOOL_UNAVAILABLE_REASONS) }).strict()),
        evicted: z.array(z.string()),
        titles: z.record(z.string(), z.string()),
      })
      .strict(),
    approval: "never",
  }).server(async ({ names }) => {
    const catalogByName = new Map(input.catalog.map((entry) => [entry.name, entry]));
    // A provider name the model saw in an earlier call loads its operation, too.
    const byProviderName = new Map(input.catalog.flatMap((entry) => (entry.capability ? [[entry.capability.providerName, entry]] : [])));
    const requested = [...new Set(names)];
    const found = requested.flatMap((name) => {
      const entry = catalogByName.get(name) ?? byProviderName.get(name);
      return entry ? [entry.name] : [];
    });
    const eager = [...new Set(found.filter((name) => input.eagerNames.has(name)))];
    const valid = [...new Set(found.filter((name) => !input.eagerNames.has(name)))];
    const unavailable = requested
      .filter((name) => !catalogByName.has(name) && !byProviderName.has(name))
      .map((name) => ({ name, reason: input.unavailableReason?.(name) ?? ("unknown" as const) }));
    const updated = await input.store.loadTools({
      conversationId: input.conversationId,
      names: valid,
      maxLoadedTools: input.maxLoadedTools,
    });
    const callable = (name: string) => ({ name, call: catalogByName.get(name)?.capability?.providerName ?? name });
    const alreadyLoaded = [...new Set([...eager, ...updated.alreadyLoaded])];
    const titles = Object.fromEntries(
      [...new Set([...updated.loaded, ...alreadyLoaded, ...updated.evicted])].flatMap((name) => {
        const entry = catalogByName.get(name);
        return entry ? [[name, entry.title]] : [];
      }),
    );
    return {
      loaded: updated.loaded.map(callable),
      alreadyLoaded: alreadyLoaded.map(callable),
      unavailable,
      evicted: updated.evicted,
      titles,
    };
  });

  return [search, load, listApps];
};

export const createLoadedAiCapabilityTools = (input: {
  catalog: readonly AiCapabilityCatalogEntry[];
  loadedNames: readonly string[];
  actor: RequestActor;
  /** Locale of the turn; the approval text a person reads is worded in it. */
  locale?: string;
  review?: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<CapabilityActionReview | null>;
  authorizeBackground?: (entry: AiCapabilityCatalogEntry, args: unknown) => Promise<void>;
  onReview?: (callId: string, review: CapabilityActionReview) => void;
  execute: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<unknown>;
}): AiRuntimeTool[] => {
  const byName = new Map(input.catalog.map((entry) => [entry.name, entry]));
  return input.loadedNames.flatMap((name) => {
    const entry = byName.get(name);
    if (!entry) return [];
    return [
      defineAiTool({
        name: entry.providerName,
        canonicalName: entry.name,
        description: `${entry.title}. ${entry.description} Never retry ACTION_OUTCOME_UNKNOWN. Do not retry unchanged after INTERNAL or INVALID_APP_RESPONSE; report the provider error.`,
        inputSchema: aiCapabilityInputSchema(
          offersApprovalReason(entry) ? withApprovalReason(entry.operation.inputSchema) : entry.operation.inputSchema,
        ),
        outputSchema: z.unknown(),
        // Capability Actions request a custom approval after their optional
        // live review has resolved. The review may supply an app-owned scope.
        approval: "never",
      }).server(async (modelArgs, context) => {
        const args = withoutApprovalReason(entry, modelArgs);
        await input.authorizeBackground?.(entry, args);
        if (!input.authorizeBackground && entry.kind === "action" && (entry.operation as CapabilityActionManifest).approval !== "none") {
          const review = (await input.review?.(entry, args, context)) ?? null;
          if (review && context.callId) input.onReview?.(context.callId, review);
          // Text-only readers such as the CLI read what the chat shows: the app and its sentence, then the model's labelled reason.
          const locale = input.locale ?? DEFAULT_LOCALE;
          const reason = offersApprovalReason(entry) ? capabilityApprovalReason(modelArgs) : null;
          const subject = capabilityActionSubject(aiCapabilityActionWording(entry, locale), args, { locale, timeZone: context.timeZone });
          const message = [
            `${entry.display.appName}: ${subject}`,
            ...(reason ? [`${capabilityApprovalReasonLabel(locale)}: ${reason}`] : []),
          ].join("\n");
          if (!(await context.requestApproval(message))) {
            if (input.actor.kind === "user") {
              await recordRejectedAiCapability({ entry, actor: input.actor, args }).catch(() => undefined);
            }
            throw new Error("Capability Action was rejected by the user.");
          }
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
    if (ref.type === "assistant.artifact") {
      const tool = createCodeSourceTool("code_read");
      if (tool.location !== "server") throw new Error("Code reader must execute on the server.");
      return tool.run(CODE_SOURCE_TOOLS.code_read.input.parse({ id: ref.id }), context);
    }
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
/** Background discovery belongs to one run, never the interactive conversation. */
export const createRunToolStore = (initialNames: readonly string[]): Pick<AiConversationService, "getLoadedTools" | "loadTools"> => {
  let current = [...new Set(initialNames)];
  return {
    getLoadedTools: async () => [...current],
    loadTools: async ({ names, maxLoadedTools }) => {
      const requested = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
      const alreadyLoaded = requested.filter((name) => current.includes(name));
      const added = requested.filter((name) => !current.includes(name));
      const combined = [...current, ...added];
      const limit = Math.floor(maxLoadedTools ?? 0);
      const evicted = limit > 0 ? combined.slice(0, Math.max(0, combined.length - limit)) : [];
      current = combined.slice(evicted.length);
      return { loaded: added.filter((name) => current.includes(name)), alreadyLoaded, evicted };
    },
  };
};

export const createAiToolResolver =
  (input: {
    conversationId: string;
    actor: RequestActor;
    staticTools: AiRuntimeTool[];
    allowedTools?: readonly string[] | null;
    /** Undefined for interactive runs; null fails closed when a background mandate cannot be loaded. */
    mandatePolicy?: MandatePolicyV1 | null;
    /** Built-in tools that exist but that this turn does not offer, such as client tools its client did not declare or tools outside `allowedTools`. */
    unofferedTools?: readonly string[];
    runtimeContext?: Omit<AiToolPreparationContext, "actor" | "conversationId">;
    store: Pick<AiConversationService, "getLoadedTools" | "loadTools">;
    listRegistry?: () => Promise<CapabilityRegistryEntry[]>;
    onCapabilityRegistryError?: (error: unknown) => void;
    help?: HelpReaderFactory;
    locale?: string;
    maxLoadedTools?: number;
    execute?: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<unknown>;
    review?: (entry: AiCapabilityCatalogEntry, args: unknown, context: ToolContext) => Promise<CapabilityActionReview | null>;
    authorizeBackground?: (entry: AiCapabilityCatalogEntry, args: unknown) => Promise<void>;
    onReview?: (callId: string, review: CapabilityActionReview) => void;
    onPrepared?: (snapshot: {
      prepared: PreparedAiTools;
      presentations: Map<string, AiToolPresentation>;
      rememberableApprovals: AiRememberableCapabilityApprovals;
    }) => void;
  }): ToolResolver =>
  async (): Promise<Tool[]> => {
    const [liveRegistry, persistedLoadedNames] = await Promise.all([
      input.listRegistry ? resolveCapabilityRegistry(input.listRegistry, input.onCapabilityRegistryError) : [],
      input.store.getLoadedTools({ conversationId: input.conversationId }),
    ]);
    const registry = liveRegistry ?? [];
    const configuredLimit = Math.floor(input.maxLoadedTools ?? 0);
    const loadedNames = configuredLimit > 0 ? persistedLoadedNames.slice(-configuredLimit) : persistedLoadedNames;
    if (loadedNames.length !== persistedLoadedNames.length) {
      await input.store.loadTools({
        conversationId: input.conversationId,
        names: [],
        maxLoadedTools: configuredLimit,
      });
    }
    const allowed = input.allowedTools == null ? null : new Set(input.allowedTools);
    const fullCapabilityCatalog = buildAiCapabilityCatalog(registry, input.locale);
    const mandateAllows = (entry: AiCapabilityCatalogEntry) =>
      input.mandatePolicy === undefined ||
      (input.mandatePolicy !== null &&
        mandatePolicyCanPermitCapability(input.mandatePolicy, {
          appId: entry.appId,
          capabilityId: entry.operation.localId,
          kind: entry.kind,
          approval: entry.kind === "action" && "approval" in entry.operation ? entry.operation.approval : undefined,
        }));
    const mandateExcluded = new Set(
      fullCapabilityCatalog.filter((entry) => !mandateAllows(entry)).flatMap((entry) => [entry.name, entry.providerName]),
    );
    const capabilityCatalog = fullCapabilityCatalog.filter((entry) => (!allowed || allowed.has(entry.name)) && mandateAllows(entry));
    // The turn's actor decides which apps' Help exists for the model, like every other Help surface.
    const helpTools = input.help ? createAiHelpTools(input.help(input.locale ?? "en", input.actor)) : [];
    const resourceTool =
      input.execute && (capabilityCatalog.length > 0 || input.staticTools.some((tool) => tool.def.name === "code_read"))
        ? createAiResourceReaderTool({ apps: registry, catalog: capabilityCatalog, execute: input.execute })
        : null;
    const allBuiltIns = [...input.staticTools, ...helpTools, ...(resourceTool ? [resourceTool] : [])];
    const builtIns = allBuiltIns.filter((tool) => !allowed || allowed.has(tool.def.name));
    const catalog = buildAiToolCatalog(builtIns, capabilityCatalog);
    const catalogNames = new Set(catalog.map((entry) => entry.name));
    const unavailableLoadedNames = loadedNames.filter((name) => !catalogNames.has(name));
    const outOfScope = new Set([
      ...allBuiltIns.map((tool) => tool.def.name),
      ...fullCapabilityCatalog.flatMap((entry) => [entry.name, entry.providerName]),
      ...(input.unofferedTools ?? []),
    ]);
    const unoffered = new Set(input.unofferedTools);
    // A model may name a loaded operation by the provider name it called it by; app IDs contain no dot.
    const loadedByProviderName = new Map(
      persistedLoadedNames.flatMap((id) => {
        const dot = id.indexOf(".");
        if (dot < 1) return [];
        return (["query", "action"] as const).map((kind) => [aiCapabilityToolName(id.slice(0, dot), kind, id.slice(dot + 1)), id] as const);
      }),
    );
    // App operation IDs always contain a dot; built-in names never do.
    const unavailableReason = (requested: string): AiToolUnavailableReason => {
      const name = loadedByProviderName.get(requested) ?? requested;
      if (mandateExcluded.has(name)) return "not_allowed";
      if (allowed && outOfScope.has(name) && !allowed.has(name)) return "not_allowed";
      if (unoffered.has(name)) return "not_offered_in_turn";
      if (!name.includes(".")) return "unknown";
      if (!input.listRegistry) return "not_offered_in_turn";
      return liveRegistry === null || persistedLoadedNames.includes(name) ? "app_offline" : "unknown";
    };
    // Independent of which apps are live: the fixed scope or task grants name no app operation at all.
    const scopeExcludesAppOperations =
      input.mandatePolicy === null ||
      (input.mandatePolicy?.grants !== undefined && !input.mandatePolicy.grants.some((grant) => "appId" in grant)) ||
      (allowed !== null && ![...allowed].some((name) => name.includes(".")));
    const eagerNames = new Set(builtIns.map((tool) => tool.def.name).filter((name) => !CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has(name)));
    const activeBuiltIns = builtIns.filter((tool) => eagerNames.has(tool.def.name) || loadedNames.includes(tool.def.name));
    const runtimeTools = [
      ...createAiToolMetaTools({
        apps:
          allowed || input.mandatePolicy !== undefined
            ? registry.filter((app) => capabilityCatalog.some((entry) => entry.appId === app.appId))
            : registry,
        catalog,
        eagerNames,
        conversationId: input.conversationId,
        store: input.store,
        maxLoadedTools: input.maxLoadedTools,
        unavailableLoadedNames,
        appOperations: !input.listRegistry ? "not_offered" : scopeExcludesAppOperations ? "not_allowed" : "offered",
        unavailableReason,
      }),
      ...activeBuiltIns,
      ...(input.execute
        ? createLoadedAiCapabilityTools({
            catalog: capabilityCatalog,
            loadedNames,
            actor: input.actor,
            locale: input.locale,
            review: input.review,
            onReview: input.onReview,
            authorizeBackground: input.authorizeBackground,
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
      const wording = entry.kind === "action" ? aiCapabilityActionWording(entry, input.locale) : null;
      presentations.set(entry.providerName, {
        kind: "capability",
        appId: entry.appId,
        appName: entry.display.appName,
        appIcon: entry.app.appIcon,
        appAccent: entry.app.appAccent,
        title: entry.display.title,
        capabilityKind: entry.kind,
        ...(wording?.sentences ? { sentences: wording.sentences } : {}),
        ...(wording?.fields?.length ? { fields: [...wording.fields] } : {}),
        ...(offersApprovalReason(entry) ? { approvalReason: true as const } : {}),
      });
      // Rememberable scopes are resolved by the owning app for each concrete
      // call and attached when its live review completes.
    }
    input.onPrepared?.({ prepared, presentations, rememberableApprovals });
    return prepared.tools;
  };
