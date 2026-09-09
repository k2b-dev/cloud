import { arg, type CloudCliContext, command, defineCliCommands, flag } from "@k2b/cloud/cli";
import {
  type ApiOperation,
  extractOperations,
  filterOperations,
  findOperation,
  operationJson,
  operationRow,
  parseOpenApiDocument,
  renderOperation,
  searchOperations,
} from "./openapi";
import type { ApiDocSource } from "./sources";

type SourceListResponse = { items: ApiDocSource[] };
type SourceFailure = { app: string; error: string };
type ExternalFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const FETCH_TIMEOUT_MS = 15_000;

const responseError = async (response: Response): Promise<Error> => {
  const body = (await response.text().catch(() => "")).trim();
  return new Error(`${response.status} ${body || response.statusText}`.trim());
};

const sourceUrl = (ctx: CloudCliContext, source: ApiDocSource): URL => {
  try {
    return new URL(source.url, ctx.options.server);
  } catch {
    throw new Error(`API Docs source "${source.id}" has an invalid URL.`);
  }
};

export const fetchOpenApiText = async (
  ctx: CloudCliContext,
  source: ApiDocSource,
  externalFetch: ExternalFetch = fetch,
): Promise<string> => {
  const url = sourceUrl(ctx, source);
  const cloudOrigin = new URL(ctx.options.server).origin;
  const sameOrigin = url.origin === cloudOrigin;
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = sameOrigin
    ? await ctx.fetch(source.url.startsWith("/") ? source.url : url.href, { headers: { Accept: "application/json" }, signal })
    : await externalFetch(url, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw await responseError(response);
  return response.text();
};

export const fetchOpenApiDocument = async (
  ctx: CloudCliContext,
  source: ApiDocSource,
): Promise<ReturnType<typeof parseOpenApiDocument>> => {
  const text = await fetchOpenApiText(ctx, source);
  try {
    return parseOpenApiDocument(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(`Invalid OpenAPI document for "${source.id}": ${(error as Error).message}`);
  }
};

export const loadOperationsFromSources = async (
  sources: readonly ApiDocSource[],
  load: (source: ApiDocSource) => Promise<ApiOperation[]>,
): Promise<{ operations: ApiOperation[]; errors: SourceFailure[] }> => {
  const settled = await Promise.allSettled(sources.map(load));
  const operations: ApiOperation[] = [];
  const errors: SourceFailure[] = [];
  settled.forEach((result, index) => {
    const source = sources[index]!;
    if (result.status === "fulfilled") operations.push(...result.value);
    else errors.push({ app: source.id, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
  return { operations, errors };
};

const listSources = async (ctx: CloudCliContext): Promise<ApiDocSource[]> => {
  const response = await ctx.fetch("/api/api-docs/sources", { headers: { Accept: "application/json" } });
  const payload = await ctx.readJson<SourceListResponse>(response);
  return payload.items;
};

const resolveSource = (sources: readonly ApiDocSource[], reference: string): ApiDocSource => {
  const normalized = reference.trim().toLowerCase();
  const byId = sources.filter((source) => source.id.toLowerCase() === normalized);
  if (byId.length === 1) return byId[0]!;
  const byName = sources.filter((source) => source.name.toLowerCase() === normalized);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new Error(`API Docs source "${reference}" is ambiguous. Use an app id.`);
  throw new Error(`API Docs source "${reference}" was not found. Run \`cld api-docs list\`.`);
};

const loadSourceOperations = async (ctx: CloudCliContext, source: ApiDocSource): Promise<ApiOperation[]> =>
  extractOperations(source, await fetchOpenApiDocument(ctx, source));

const operationColumns = [
  { key: "app", label: "APP" },
  { key: "method", label: "METHOD" },
  { key: "path", label: "PATH" },
  { key: "operationId", label: "OPERATION" },
  { key: "summary", label: "SUMMARY" },
  { key: "security", label: "SECURITY" },
] as const;

const printOperations = (
  ctx: CloudCliContext,
  operations: readonly ApiOperation[],
  metadata: { total?: number; errors?: SourceFailure[] } = {},
) => {
  const items = operations.map(operationJson);
  const total = metadata.total ?? operations.length;
  const errors = metadata.errors ?? [];
  if (ctx.options.output === "json") {
    ctx.json({ items, total, errors });
    return;
  }
  if (ctx.options.output === "jsonl") {
    items.forEach((item) => ctx.jsonLine(item));
    return;
  }
  ctx.table(operations.map(operationRow), [...operationColumns]);
  if (operations.length < total) ctx.error(`Showing ${operations.length} of ${total} matching operations.`);
  errors.forEach((failure) => ctx.error(`Warning: ${failure.app}: ${failure.error}`));
};

const validateMethod = (method: string): string => {
  const normalized = method.trim().toUpperCase();
  if (!["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"].includes(normalized)) {
    throw new Error(`Unsupported HTTP method "${method}".`);
  }
  return normalized;
};

const limitFlag = flag.int({ default: 50, min: 1, max: 500, description: "Maximum number of matching operations" });

export default defineCliCommands({
  name: "api-docs",
  summary: "Inspect the live OpenAPI documentation published by Cloud apps.",
  commands: [
    command("list", {
      summary: "List apps that publish OpenAPI documentation",
      flags: {
        search: flag.string({ description: "Filter by app id, name, or description" }),
      },
      examples: ["cld api-docs list", "cld api-docs list --search grids --json"],
      async run({ ctx, flags }) {
        const query = flags.search?.trim().toLowerCase();
        const sources = (await listSources(ctx)).filter(
          (source) => !query || `${source.id} ${source.name} ${source.description}`.toLowerCase().includes(query),
        );
        if (ctx.options.output === "json") ctx.json({ items: sources, total: sources.length });
        else if (ctx.options.output === "jsonl") sources.forEach((source) => ctx.jsonLine(source));
        else
          ctx.table(sources, [
            { key: "id", label: "APP" },
            { key: "name", label: "NAME" },
            { key: "description", label: "DESCRIPTION" },
            { key: "url", label: "SPEC" },
          ]);
      },
    }),
    command("operations", {
      summary: "List operations published by one app",
      args: { app: arg.required({ description: "App id or exact name" }) },
      flags: {
        method: flag.string({ description: "Filter by HTTP method" }),
        tag: flag.string({ description: "Filter by exact OpenAPI tag" }),
      },
      examples: ["cld api-docs operations grids", 'cld api-docs operations grids --tag "Grids:Record" --method POST --json'],
      async run({ ctx, args, flags }) {
        const source = resolveSource(await listSources(ctx), args.app);
        const operations = filterOperations(await loadSourceOperations(ctx, source), {
          method: flags.method ? validateMethod(flags.method) : undefined,
          tag: flags.tag,
        });
        printOperations(ctx, operations);
      },
    }),
    command("search", {
      summary: "Search operation metadata and schemas across app specs",
      args: { query: arg.required({ description: "Free-text search query" }) },
      flags: {
        app: flag.string({ description: "Search only one app id or exact name" }),
        method: flag.string({ description: "Filter by HTTP method" }),
        tag: flag.string({ description: "Filter by exact OpenAPI tag" }),
        limit: limitFlag,
      },
      examples: ['cld api-docs search "create record"', 'cld api-docs search "optimistic lock" --app grids --json'],
      async run({ ctx, args, flags }) {
        const sources = await listSources(ctx);
        const selected = flags.app ? [resolveSource(sources, flags.app)] : sources;
        const loaded = await loadOperationsFromSources(selected, async (source) => loadSourceOperations(ctx, source));
        if (flags.app && loaded.errors.length > 0) throw new Error(loaded.errors[0]!.error);
        const matches = searchOperations(
          filterOperations(loaded.operations, {
            method: flags.method ? validateMethod(flags.method) : undefined,
            tag: flags.tag,
          }),
          args.query,
        );
        printOperations(ctx, matches.slice(0, flags.limit), { total: matches.length, errors: loaded.errors });
      },
    }),
    command("show", {
      summary: "Show one operation with parameters, schemas, and responses",
      args: {
        app: arg.required({ description: "App id or exact name" }),
        method: arg.required({ description: "HTTP method" }),
        path: arg.required({ description: "Raw or effective OpenAPI path" }),
      },
      examples: ["cld api-docs show grids POST /api/grids/records/by-table/{tableId}", "cld api-docs show grids GET /records/{id} --json"],
      async run({ ctx, args }) {
        const source = resolveSource(await listSources(ctx), args.app);
        const operation = findOperation(await loadSourceOperations(ctx, source), validateMethod(args.method), args.path);
        if (ctx.options.output === "json") ctx.json(operationJson(operation));
        else if (ctx.options.output === "jsonl") ctx.jsonLine(operationJson(operation));
        else ctx.print(renderOperation(operation));
      },
    }),
    command("spec", {
      summary: "Print one app's raw OpenAPI JSON document",
      args: { app: arg.required({ description: "App id or exact name" }) },
      examples: ["cld api-docs spec grids > grids.openapi.json"],
      async run({ ctx, args }) {
        const source = resolveSource(await listSources(ctx), args.app);
        const text = await fetchOpenApiText(ctx, source);
        try {
          parseOpenApiDocument(JSON.parse(text) as unknown);
        } catch (error) {
          throw new Error(`Invalid OpenAPI document for "${source.id}": ${(error as Error).message}`);
        }
        await ctx.write(text.endsWith("\n") ? text : `${text}\n`);
      },
    }),
  ],
});
