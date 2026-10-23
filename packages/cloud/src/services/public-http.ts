import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions, request } from "node:https";
import { resolvePublicNetworkAddresses } from "./network-security";
import { awaitNetworkOperation, readNetworkResponse } from "./network-transport";

export type PublicHttpInput = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  maxBytes: number;
  signal: AbortSignal;
};

/** One public HTTPS request, pinned to a validated address. Never redirects or retries.
 * Callers own credential authorization, request budgets and response disclosure. */
export async function requestPublicHttps(
  input: PublicHttpInput,
  dependencies: {
    resolve: typeof resolvePublicNetworkAddresses;
    request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  } = { resolve: resolvePublicNetworkAddresses, request },
) {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) throw new Error("INVALID_BYTE_LIMIT");
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("HTTPS_REQUIRED");
  input.signal.throwIfAborted();
  let addresses: Awaited<ReturnType<typeof resolvePublicNetworkAddresses>>;
  try {
    addresses = await awaitNetworkOperation(dependencies.resolve(url.hostname), input.signal);
  } catch (error) {
    if (input.signal.aborted) throw new Error("HTTP_CANCELLED");
    throw error;
  }
  input.signal.throwIfAborted();
  const target = addresses[0]!;
  try {
    return await readNetworkResponse<{ status: number; headers: Record<string, string>; body: Uint8Array }>({
      request: dependencies.request,
      signal: input.signal,
      body: input.body,
      options: {
        hostname: target.address,
        family: target.family,
        port: url.port || 443,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        rejectUnauthorized: true,
        path: url.pathname + url.search,
        method: input.method,
        headers: { ...input.headers, host: url.host, "accept-encoding": "identity" },
      },
      read: (incoming, finish, fail) => {
        const status = incoming.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "retry-after", "etag", "last-modified"]) {
          const value = incoming.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        // A redirect never receives a second request or exposes a Location token.
        if (status >= 300 && status < 400 && status !== 304) {
          finish({ status, headers, body: new Uint8Array() });
          return;
        }
        if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
          fail(new Error("HTTP_FAILED"));
          return;
        }
        if (Number(incoming.headers["content-length"]) > input.maxBytes) {
          fail(new Error("HTTP_TOO_LARGE"));
          return;
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          if (incoming.destroyed) return;
          bytes += chunk.byteLength;
          if (bytes > input.maxBytes) {
            fail(new Error("HTTP_TOO_LARGE"));
          } else chunks.push(chunk);
        });
        incoming.on("end", () => finish({ status, headers, body: Buffer.concat(chunks, bytes) }));
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "HTTP_TOO_LARGE") throw error;
    // Never expose errors containing injected headers.
    throw new Error("HTTP_FAILED");
  }
}
