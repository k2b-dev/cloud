import { isIP } from "node:net";
import { truncateMiddle } from "@k2b/nessi";
import { z } from "zod";
import { coreSettings } from "../services";
import { defineAiTool } from "./tools";

export const AI_FIRECRAWL_API_KEY_SETTING_KEY = "ai.firecrawl_api_key";

const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const FIRECRAWL_SEARCH_LIMIT = 5;
const FIRECRAWL_TIMEOUT_MS = 30_000;
const FIRECRAWL_CACHE_MAX_AGE_MS = 172_800_000;
const WEB_EXTRACT_MAX_CONTENT_CHARS = 1_000_000;
const WEB_SEARCH_HISTORY_SNIPPET_CHARS = 120;
const WEB_EXTRACT_HISTORY_CONTENT_CHARS = 4_000;

type FirecrawlFetch = typeof fetch;

type FirecrawlToolConfig = {
  apiKey?: string | null;
  fetch?: FirecrawlFetch;
};

export const CloudAiWebSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
  })
  .strict();

/** Flat result list — no billing metadata, the model only needs the sources. */
export const CloudAiWebSearchOutputSchema = z.array(
  z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    position: z.number().int(),
  }),
);

export const CloudAiWebExtractInputSchema = z
  .object({
    url: z.string().trim().url().max(2_000),
  })
  .strict();

export const CloudAiWebExtractOutputSchema = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  content: z.string(),
  truncated: z.boolean(),
});

const readFirecrawlApiKey = async (): Promise<string> =>
  String((await coreSettings.get<string>(AI_FIRECRAWL_API_KEY_SETTING_KEY)) ?? "").trim();

export const isCloudAiFirecrawlConfigured = async () => (await readFirecrawlApiKey()).length > 0;

const resolveApiKey = async (apiKey: string | null | undefined) => {
  const resolved = (apiKey ?? (await readFirecrawlApiKey())).trim();
  if (!resolved) throw new Error("Firecrawl API key is not configured.");
  return resolved;
};

const fetchWithTimeout = async (fetcher: FirecrawlFetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const extractErrorMessage = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  return null;
};

const firecrawlPost = async (input: {
  apiKey?: string | null;
  fetch?: FirecrawlFetch;
  path: "/v2/search" | "/v2/scrape";
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<unknown> => {
  const apiKey = await resolveApiKey(input.apiKey);
  const fetcher = input.fetch ?? fetch;
  const response = await fetchWithTimeout(
    fetcher,
    `${FIRECRAWL_BASE_URL}${input.path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
    },
    input.signal,
  );
  const body = await readJson(response);
  if (!response.ok) {
    const message = extractErrorMessage(body) ?? response.statusText;
    throw new Error(`Firecrawl request failed (HTTP ${response.status}): ${message}`);
  }
  return body;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const truncateSnippet = (text: string): string => {
  if (text.length <= WEB_SEARCH_HISTORY_SNIPPET_CHARS) return text;
  return `${text.slice(0, WEB_SEARCH_HISTORY_SNIPPET_CHARS - 3).trimEnd()}...`;
};

const truncate = (text: string, maxChars: number): { text: string; truncated: boolean } => {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars)).trimEnd(), truncated: true };
};

const isPrivateIpv4 = (hostname: string): boolean => {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
};

const isPrivateIpv6 = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("2001:db8:")
  );
};

export const assertPublicHttpUrl = (rawUrl: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("URL must be valid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("URL must use http or https.");

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("URL host is not allowed.");
  }

  const ipKind = isIP(hostname.replace(/^\[|\]$/g, ""));
  if (ipKind === 4 && isPrivateIpv4(hostname)) throw new Error("URL must not point to a private IP address.");
  if (ipKind === 6 && isPrivateIpv6(hostname)) throw new Error("URL must not point to a private IP address.");
  return parsed.toString();
};

export const runCloudAiWebSearch = async (
  input: z.infer<typeof CloudAiWebSearchInputSchema>,
  config: FirecrawlToolConfig & { signal?: AbortSignal } = {},
): Promise<z.infer<typeof CloudAiWebSearchOutputSchema>> => {
  const body = await firecrawlPost({
    apiKey: config.apiKey,
    fetch: config.fetch,
    path: "/v2/search",
    body: {
      query: input.query,
      limit: FIRECRAWL_SEARCH_LIMIT,
      sources: ["web"],
      timeout: FIRECRAWL_TIMEOUT_MS,
      ignoreInvalidURLs: true,
    },
    signal: config.signal,
  });
  if (!isRecord(body) || body.success !== true) {
    throw new Error(extractErrorMessage(body) ?? "Firecrawl search returned an invalid response.");
  }

  const data = isRecord(body.data) ? body.data : {};
  const web = Array.isArray(data.web) ? data.web : [];
  const results = web
    .filter(isRecord)
    .slice(0, FIRECRAWL_SEARCH_LIMIT)
    .map((item, index) => ({
      title: asString(item.title) || asString(isRecord(item.metadata) ? item.metadata.title : undefined) || "Untitled",
      url: asString(item.url) || asString(isRecord(item.metadata) ? (item.metadata.url ?? item.metadata.sourceURL) : undefined),
      snippet: asString(item.description) || asString(item.snippet),
      position: index + 1,
    }))
    .filter((item) => item.url.length > 0);

  return CloudAiWebSearchOutputSchema.parse(results);
};

export const runCloudAiWebExtract = async (
  input: z.infer<typeof CloudAiWebExtractInputSchema>,
  config: FirecrawlToolConfig & { signal?: AbortSignal; maxChars?: number } = {},
): Promise<z.infer<typeof CloudAiWebExtractOutputSchema>> => {
  const url = assertPublicHttpUrl(input.url);
  const body = await firecrawlPost({
    apiKey: config.apiKey,
    fetch: config.fetch,
    path: "/v2/scrape",
    body: {
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      maxAge: FIRECRAWL_CACHE_MAX_AGE_MS,
      timeout: FIRECRAWL_TIMEOUT_MS,
      removeBase64Images: true,
      blockAds: true,
    },
    signal: config.signal,
  });
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
    throw new Error(extractErrorMessage(body) ?? "Firecrawl extract returned an invalid response.");
  }

  const maxChars = config.maxChars ?? WEB_EXTRACT_MAX_CONTENT_CHARS;
  const data = body.data;
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const normalizedUrl = asString(data.url) || asString(metadata.url) || asString(metadata.sourceURL) || url;
  const content = asString(data.markdown);
  const truncated = truncate(content, maxChars);

  return CloudAiWebExtractOutputSchema.parse({
    url: normalizedUrl,
    title: asString(metadata.title) || asString(data.title) || undefined,
    description: asString(metadata.description) || asString(data.description) || undefined,
    content: truncated.text,
    truncated: truncated.truncated,
  });
};

export const createCloudAiWebSearchTool = (config: FirecrawlToolConfig = {}) =>
  defineAiTool({
    name: "web_search",
    description:
      "Search the web for current sources. Input only a plain natural-language query. Search again with a focused query when the first results are incomplete, outdated, or conflicting.",
    inputSchema: CloudAiWebSearchInputSchema,
    outputSchema: CloudAiWebSearchOutputSchema,
    approval: "never",
    timeoutMs: 90_000,
    promptHint:
      "search the web for current facts and sources; use additional focused searches when the evidence is incomplete or conflicting.",
    toHistoricalResult: ({ output }) =>
      output.map((result) => ({
        ...result,
        snippet: truncateSnippet(result.snippet),
      })),
  }).server(async (input, ctx) => runCloudAiWebSearch(input, { ...config, signal: ctx.signal }));

export const createCloudAiWebExtractTool = (config: FirecrawlToolConfig = {}) =>
  defineAiTool({
    name: "web_extract",
    description:
      "Read one web page by URL and return clean Markdown. Inspect the relevant pages needed to support the answer; for research or comparison, prefer primary sources and read more than one useful source when warranted.",
    inputSchema: CloudAiWebExtractInputSchema,
    outputSchema: CloudAiWebExtractOutputSchema,
    approval: "never",
    timeoutMs: 90_000,
    promptHint:
      "read relevant pages found by web_search; for research or comparison, inspect multiple useful sources and prefer primary sources.",
    toHistoricalResult: ({ output }) => {
      const content = truncateMiddle(output.content, WEB_EXTRACT_HISTORY_CONTENT_CHARS);
      return {
        url: output.url,
        title: output.title,
        description: output.description,
        content,
        truncated: output.truncated || content !== output.content,
      };
    },
  }).server(async (input, ctx) => runCloudAiWebExtract(input, { ...config, signal: ctx.signal }));

export type CloudAiWebSearchInput = z.infer<typeof CloudAiWebSearchInputSchema>;
export type CloudAiWebSearchOutput = z.infer<typeof CloudAiWebSearchOutputSchema>;
export type CloudAiWebExtractInput = z.infer<typeof CloudAiWebExtractInputSchema>;
export type CloudAiWebExtractOutput = z.infer<typeof CloudAiWebExtractOutputSchema>;
