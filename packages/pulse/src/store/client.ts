import { createAllowedNetworkFetch } from "@k2b/cloud/services";
import { parseNetworkAllowlist } from "@k2b/cloud/shared";
import { z } from "zod";
import { StorePassword, StoreUrl, StoreUser } from "./validation";

export class StoreQueryError extends Error {
  constructor(kind: "unreachable");
  constructor(kind: "clickhouse", code: number, message?: string);
  constructor(
    readonly kind: "unreachable" | "clickhouse",
    readonly code?: number,
    readonly clickhouseMessage?: string,
  ) {
    super(kind === "clickhouse" ? `ClickHouse error ${code}` : "ClickHouse is unreachable");
  }
}
export class StoreResponseTooLarge extends StoreQueryError {
  constructor() {
    super("unreachable");
  }
}
export type QueryOptions = {
  url: string;
  user: string;
  password: string;
  query: string;
  params?: Record<string, string | number>;
  settings?: Record<string, string | number>;
  signal?: AbortSignal;
  timeoutMs: number;
  format?: "JSON" | "TabSeparated" | "JSONCompact";
  database?: string;
  queryId?: string;
  /** Response body cap; the default fits service queries. Read users' answers are bounded by their profile. */
  maxResponseBytes?: number;
  transport?: (input: string, init: RequestInit) => Promise<Response>;
};
const MAX_RESPONSE_BYTES = 1024 * 1024;
// ClickHouse defaults http_max_uri_size to 1 MiB. Reserve half for intermediaries
// and overhead. 32 String bindings of 2 KiB each need at most 384 KiB after
// ClickHouse Escaped encoding and URL encoding (a backslash becomes 6 bytes).
export const CLICKHOUSE_MAX_URL_BYTES = 512 * 1024;
// Encoded UUID + Int64 pair: (36 + 2*3 quotes + 3 comma) + (20 digits/sign + 3 comma) = 68 bytes.
// 2,000 pairs need <=136,000 bytes, leaving >387 KiB for the origin, brackets, keys and scalar settings.
export const CLICKHOUSE_UUID_CHUNK_SIZE = 2_000;

// By Pulse's design, the Cloud admin owns internal targets: the saved or submitted
// host is the allowlist entry, with no env vars. Remote responses are never echoed.
export const storeAllowlist = (url: URL) => parseNetworkAllowlist([url.hostname]);

export const clickhouseResponse = async (options: QueryOptions): Promise<{ text: string; headers: Headers }> => {
  // Validation errors never carry their input values.
  if (
    !StoreUrl.safeParse(options.url).success ||
    !StoreUser.safeParse(options.user).success ||
    !StorePassword.safeParse(options.password).success
  )
    throw new StoreQueryError("unreachable");
  const url = new URL(options.url);
  url.pathname = "/";
  url.searchParams.set("default_format", options.format ?? "JSON");
  if (options.database) url.searchParams.set("database", options.database);
  if (options.queryId) url.searchParams.set("query_id", options.queryId);
  for (const [name, value] of Object.entries(options.params ?? {})) url.searchParams.set(`param_${name}`, String(value));
  for (const [name, value] of Object.entries(options.settings ?? {})) url.searchParams.set(name, String(value));
  if (new TextEncoder().encode(url.href).byteLength > CLICKHOUSE_MAX_URL_BYTES)
    throw new RangeError(`ClickHouse request URL exceeds the ${CLICKHOUSE_MAX_URL_BYTES}-byte budget; chunk query parameters`);
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs)]);
  try {
    const transport = options.transport ?? createAllowedNetworkFetch(storeAllowlist(url));
    const response = await transport(url.href, {
      method: "POST",
      body: options.query,
      redirect: "error",
      signal,
      headers: { Authorization: `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${options.user}:${options.password}`)))}` },
    });
    const hasClickhouseHeader = [...response.headers.keys()].some((name) => name.toLowerCase().startsWith("x-clickhouse-"));
    const exception = response.headers.get("X-ClickHouse-Exception-Code");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      if (reader)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > (options.maxResponseBytes ?? MAX_RESPONSE_BYTES)) throw new StoreResponseTooLarge();
          chunks.push(value);
        }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    if (!hasClickhouseHeader) throw new StoreQueryError("unreachable");
    if (!length) {
      if (exception && /^\d+$/.test(exception) && Number(exception) !== 0) throw new StoreQueryError("clickhouse", Number(exception));
      if (!response.ok) throw new StoreQueryError("unreachable");
      return { text: "", headers: response.headers };
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    if (exception && /^\d+$/.test(exception) && Number(exception) !== 0) {
      const code = Number(exception);
      if (!Number.isSafeInteger(code)) throw new StoreQueryError("unreachable");
      throw new StoreQueryError("clickhouse", code, text);
    }
    if (!response.ok) throw new StoreQueryError("unreachable");
    // Streaming ClickHouse errors can follow an already-started JSON document
    // with HTTP 200 and no Exception-Code header. Only a line outside a valid
    // JSON answer is diagnostic; user string values must never become errors.
    if (options.format !== "TabSeparated") {
      try {
        JSON.parse(text);
      } catch {
        const late = /(?:^|\n)Code: (\d+)\. DB::Exception:/.exec(text);
        if (late) throw new StoreQueryError("clickhouse", Number(late[1]), text.slice(late.index));
      }
    }
    return { text, headers: response.headers };
  } catch (error) {
    if (error instanceof StoreQueryError) throw error;
    // No causes: fetch and parse errors can include endpoints, SQL, or response bodies.
    throw new StoreQueryError("unreachable");
  }
};

export const clickhouseQuery = async (options: QueryOptions): Promise<Record<string, unknown>[]> => {
  const { text } = await clickhouseResponse(options);
  if (!text) return [];
  if (options.format === "TabSeparated")
    return text
      .trimEnd()
      .split("\n")
      .map((line) => ({ value: line }));
  try {
    const parsed = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).safeParse(JSON.parse(text));
    if (!parsed.success) throw new StoreQueryError("unreachable");
    return parsed.data.data;
  } catch {
    throw new StoreQueryError("unreachable");
  }
};
