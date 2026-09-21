import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions, request } from "node:https";
import { resolvePublicNetworkAddresses } from "./network-security";

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
  let cancelLookup = () => {};
  const addresses = await Promise.race([
    dependencies.resolve(url.hostname),
    new Promise<never>((_, reject) => {
      cancelLookup = () => reject(new Error("HTTP_CANCELLED"));
      input.signal.addEventListener("abort", cancelLookup, { once: true });
      if (input.signal.aborted) cancelLookup();
    }),
  ]).finally(() => input.signal.removeEventListener("abort", cancelLookup));
  input.signal.throwIfAborted();
  const target = addresses[0]!;
  return new Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>((resolve, reject) => {
    let settled = false;
    const fail = () => finish(undefined);
    const finish = (value?: { status: number; headers: Record<string, string>; body: Uint8Array }) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      if (value) resolve(value);
      else reject(new Error("HTTP_FAILED"));
    };
    const outgoing = dependencies.request(
      {
        hostname: target.address,
        family: target.family,
        port: url.port || 443,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        rejectUnauthorized: true,
        path: url.pathname + url.search,
        method: input.method,
        headers: { ...input.headers, host: url.host, "accept-encoding": "identity" },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "retry-after", "etag", "last-modified"]) {
          const value = incoming.headers[name];
          if (typeof value === "string") headers[name] = value;
        }
        // A redirect never receives a second request or exposes a Location token.
        if (status >= 300 && status < 400 && status !== 304) {
          incoming.destroy();
          finish({ status, headers, body: new Uint8Array() });
          return;
        }
        if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
          incoming.destroy();
          fail();
          return;
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > input.maxBytes) {
            incoming.destroy();
            fail();
          } else chunks.push(chunk);
        });
        incoming.on("end", () => finish({ status, headers, body: Buffer.concat(chunks, bytes) }));
        incoming.on("error", fail);
        incoming.on("aborted", fail);
      },
    );
    const abort = () => {
      outgoing.destroy();
      fail();
    };
    outgoing.on("error", fail); // Never expose errors containing injected headers.
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    else outgoing.end(input.body);
  });
}
