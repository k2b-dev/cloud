import { createAllowedNetworkFetch } from "@k2b/cloud/services";
import { parseNetworkAllowlist } from "@k2b/cloud/shared";
import { z } from "zod";
import { StorePassword, StoreUrl, StoreUser } from "./validation";

export class StoreQueryError extends Error {
  constructor(kind: "unreachable");
  constructor(kind: "clickhouse", code: number);
  constructor(
    readonly kind: "unreachable" | "clickhouse",
    readonly code?: number,
  ) {
    super(kind === "clickhouse" ? `ClickHouse error ${code}` : "ClickHouse is unreachable");
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
  format?: "JSON" | "TabSeparated";
  transport?: (input: string, init: RequestInit) => Promise<Response>;
};
const MAX_RESPONSE_BYTES = 1024 * 1024;

// By Pulse's design, the Cloud admin owns internal targets: the saved or submitted
// host is the allowlist entry, with no env vars. Remote responses are never echoed.
export const storeAllowlist = (url: URL) => parseNetworkAllowlist([url.hostname]);

export const clickhouseQuery = async (options: QueryOptions): Promise<Record<string, unknown>[]> => {
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
  for (const [name, value] of Object.entries(options.params ?? {})) url.searchParams.set(`param_${name}`, String(value));
  for (const [name, value] of Object.entries(options.settings ?? {})) url.searchParams.set(name, String(value));
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
          if (length > MAX_RESPONSE_BYTES) throw new StoreQueryError("unreachable");
          chunks.push(value);
        }
    } finally {
      await reader?.cancel().catch(() => {});
    }
    if (!hasClickhouseHeader) throw new StoreQueryError("unreachable");
    if (exception && /^\d+$/.test(exception) && Number(exception) !== 0) {
      const code = Number(exception);
      if (!Number.isSafeInteger(code)) throw new StoreQueryError("unreachable");
      throw new StoreQueryError("clickhouse", code);
    }
    if (!response.ok) throw new StoreQueryError("unreachable");
    if (!length) return [];
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    if (options.format === "TabSeparated")
      return text
        .trimEnd()
        .split("\n")
        .map((line) => ({ value: line }));
    const body: unknown = JSON.parse(text);
    const parsed = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).safeParse(body);
    if (!parsed.success) throw new StoreQueryError("unreachable");
    return parsed.data.data;
  } catch (error) {
    if (error instanceof StoreQueryError) throw error;
    // No causes: fetch and parse errors can include endpoints, SQL, or response bodies.
    throw new StoreQueryError("unreachable");
  }
};
