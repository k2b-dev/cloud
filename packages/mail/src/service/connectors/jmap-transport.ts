import { request } from "node:https";
import { pinnedNetworkLookup } from "@k2b/cloud/services/network-security";
import {
  awaitNetworkOperation,
  type NetworkRequestFactory,
  readNetworkResponse,
  withNetworkDeadline,
} from "@k2b/cloud/services/network-transport";
import { resolvePublicEndpoint } from "./endpoint-policy";

export class JmapTransportError extends Error {
  constructor(readonly code: "JMAP_TRANSPORT" | "JMAP_ABORTED" | "JMAP_TOO_LARGE" | "JMAP_HTTPS_REQUIRED" | "JMAP_BYTE_BUDGET") {
    super(code);
    this.name = "JmapTransportError";
  }
}

export type JmapTransportDependencies = {
  resolveEndpoint?: typeof resolvePublicEndpoint;
  request?: NetworkRequestFactory;
};
export type JmapResponse = { status: number; location?: string; retryAfter?: string; body: string };
export type JmapRequest = {
  url: URL;
  method: "GET" | "POST";
  authorization?: string;
  body?: string;
  maxBytes: number;
  signal: AbortSignal;
};

/** One HTTPS request. Redirects and credential authorization belong to the client. */
export async function requestJmap(input: JmapRequest, deps: JmapTransportDependencies = {}): Promise<JmapResponse> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) throw new JmapTransportError("JMAP_BYTE_BUDGET");
  if (input.url.protocol !== "https:" || input.url.username || input.url.password) throw new JmapTransportError("JMAP_HTTPS_REQUIRED");
  try {
    // Same connection budget as imap-smtp.ts; here it bounds DNS and the complete buffered response too.
    return await withNetworkDeadline(15_000, input.signal, new JmapTransportError("JMAP_TRANSPORT"), async (signal) => {
      const endpoint = await awaitNetworkOperation(
        // resolvePublicEndpoint's existing DNS budget is 5 seconds.
        (deps.resolveEndpoint ?? resolvePublicEndpoint)(
          { host: input.url.hostname, port: Number(input.url.port || 443), tlsMode: "implicit" },
          undefined,
          signal,
        ),
        signal,
      );
      signal.throwIfAborted();
      return readNetworkResponse<JmapResponse>({
        request: deps.request ?? request,
        signal,
        body: input.body === undefined ? undefined : Buffer.from(input.body),
        options: {
          protocol: "https:",
          hostname: endpoint.host,
          servername: endpoint.host,
          port: endpoint.port,
          path: input.url.pathname + input.url.search,
          method: input.method,
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
            ...(input.body === undefined ? {} : { "content-type": "application/json" }),
            ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
          },
          lookup: pinnedNetworkLookup(endpoint.addresses),
          agent: false,
          rejectUnauthorized: true,
        },
        read: (response, finish, fail) => {
          if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
            fail(new JmapTransportError("JMAP_TRANSPORT"));
            return;
          }
          if (Number(response.headers["content-length"]) > input.maxBytes) {
            fail(new JmapTransportError("JMAP_TOO_LARGE"));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (response.destroyed) return;
            bytes += chunk.byteLength;
            if (bytes > input.maxBytes) fail(new JmapTransportError("JMAP_TOO_LARGE"));
            else chunks.push(chunk);
          });
          response.on("end", () =>
            finish({
              status: response.statusCode ?? 0,
              location: response.headers.location,
              retryAfter: response.headers["retry-after"],
              body: Buffer.concat(chunks, bytes).toString("utf8"),
            }),
          );
        },
      });
    });
  } catch (error) {
    if (input.signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
    if (error instanceof JmapTransportError) throw error;
    // Node errors can contain request headers; never retain their message or cause.
    throw new JmapTransportError("JMAP_TRANSPORT");
  }
}
