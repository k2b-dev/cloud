import type { ClientRequest, IncomingMessage } from "node:http";
import { type RequestOptions, request } from "node:https";
import { type Readable, Transform } from "node:stream";
import { pinnedNetworkLookup } from "@k2b/cloud/services/network-security";
import {
  awaitNetworkOperation,
  type NetworkRequestFactory,
  readNetworkResponse,
  withNetworkDeadline,
} from "@k2b/cloud/services/network-transport";
import { type ResolvedEndpoint, resolvePublicEndpoint } from "./endpoint-policy";
import { checkJmapHttp, JMAP_JSON_BYTES, JmapHttpError, JmapRateLimitError, JmapRequestError } from "./jmap-http";

export class JmapTransportError extends Error {
  constructor(
    readonly code:
      | "JMAP_TRANSPORT"
      | "JMAP_ABORTED"
      | "JMAP_TOO_LARGE"
      | "JMAP_HTTPS_REQUIRED"
      | "JMAP_BYTE_BUDGET"
      | "JMAP_TIMEOUT"
      | "JMAP_REDIRECT"
      | "JMAP_SOURCE_MISSING",
  ) {
    super(code);
    this.name = "JmapTransportError";
  }
}

export type JmapTransportDependencies = {
  resolveEndpoint?: typeof resolvePublicEndpoint;
  request?: NetworkRequestFactory;
  /** Deterministic download deadline seam; returns its cancellation function. */
  downloadTimer?: (expire: () => void, milliseconds: number) => () => void;
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
  validateRequest(input);
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
        options: requestOptions(input, endpoint),
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
    throw transportError(error, input.signal);
  }
}

function validateRequest(input: JmapRequest): void {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) throw new JmapTransportError("JMAP_BYTE_BUDGET");
  if (input.url.protocol !== "https:" || input.url.username || input.url.password) throw new JmapTransportError("JMAP_HTTPS_REQUIRED");
}

function requestOptions(input: JmapRequest, endpoint: ResolvedEndpoint): RequestOptions {
  return {
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
  };
}

function transportError(error: unknown, signal: AbortSignal): JmapTransportError {
  if (signal.aborted) return new JmapTransportError("JMAP_ABORTED");
  if (error instanceof JmapTransportError) return error;
  // Node and consumer errors may contain headers, URLs or mail data. Retain no cause.
  return new JmapTransportError("JMAP_TRANSPORT");
}

/** Own the connection until the consumer settles; never buffer a successful source. */
export async function consumeJmapDownload<T>(
  input: JmapRequest,
  consume: (source: Readable) => Promise<T>,
  deps: JmapTransportDependencies = {},
): Promise<T> {
  validateRequest(input);
  if (input.signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
  return new Promise<T>((resolve, reject) => {
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let source: Transform | undefined;
    let settled = false;
    let cancelTimer: (() => void) | undefined;
    const connection = new AbortController();
    const schedule =
      deps.downloadTimer ??
      ((expire, milliseconds) => {
        const timer = setTimeout(expire, milliseconds);
        return () => clearTimeout(timer);
      });
    const finish = (result: { value: T } | { error: Error }) => {
      if (settled) return;
      settled = true;
      cancelTimer?.();
      input.signal.removeEventListener("abort", abort);
      connection.abort();
      if (source && !source.destroyed) source.destroy("error" in result ? result.error : undefined);
      if (incoming && !incoming.destroyed) incoming.destroy();
      if (outgoing && !outgoing.destroyed) outgoing.destroy();
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const fail = (error: unknown) => finish({ error: transportError(error, input.signal) });
    const abort = () => fail(new JmapTransportError("JMAP_ABORTED"));
    const deadline = (milliseconds: number) => {
      cancelTimer?.();
      cancelTimer = schedule(() => fail(new JmapTransportError("JMAP_TIMEOUT")), milliseconds);
    };
    // Same idle budget as imap-smtp.ts socketTimeout. Only the caller bounds total duration.
    const idle = () => deadline(60_000);
    input.signal.addEventListener("abort", abort, { once: true });
    deadline(15_000); // Existing IMAP/JMAP connection budget, including DNS (itself bounded to 5 s).
    const read = (response: IncomingMessage) => {
      incoming = response;
      response.on("error", fail);
      response.once("aborted", () => fail(new JmapTransportError("JMAP_TRANSPORT")));
      response.once("close", () => {
        if (!response.complete) fail(new JmapTransportError("JMAP_TRANSPORT"));
      });
      if (settled) {
        response.destroy();
        return;
      }
      idle();
      response.on("data", idle);
      response.once("end", () => cancelTimer?.());
      const status = response.statusCode ?? 0;
      const success = status >= 200 && status < 300;
      const maxBytes = success ? input.maxBytes : JMAP_JSON_BYTES;
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        fail(new JmapTransportError("JMAP_TRANSPORT"));
        return;
      }
      if (Number(response.headers["content-length"]) > maxBytes) {
        fail(new JmapTransportError("JMAP_TOO_LARGE"));
        return;
      }
      let bytes = 0;
      if (!success) {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > maxBytes) fail(new JmapTransportError("JMAP_TOO_LARGE"));
          else chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) return;
          try {
            if (status >= 300 && status < 400) throw new JmapTransportError("JMAP_REDIRECT");
            if (status === 404) throw new JmapTransportError("JMAP_SOURCE_MISSING");
            checkJmapHttp({ status, retryAfter: response.headers["retry-after"], body: Buffer.concat(chunks, bytes).toString("utf8") });
          } catch (error) {
            if (error instanceof JmapHttpError || error instanceof JmapRateLimitError || error instanceof JmapRequestError)
              finish({ error });
            else fail(error);
          }
        });
        return;
      }
      source = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          callback(bytes > maxBytes ? new JmapTransportError("JMAP_TOO_LARGE") : null, chunk);
        },
      });
      source.on("error", fail);
      response.pipe(source);
      // Start synchronously so consumers can install their error listener before data arrives.
      try {
        consume(source).then((value) => finish({ value }), fail);
      } catch (error) {
        fail(error);
      }
    };
    const start = async () => {
      const endpoint = await awaitNetworkOperation(
        (deps.resolveEndpoint ?? resolvePublicEndpoint)(
          { host: input.url.hostname, port: Number(input.url.port || 443), tlsMode: "implicit" },
          undefined,
          connection.signal,
        ),
        connection.signal,
      );
      if (settled) return;
      const options = requestOptions(input, endpoint);
      outgoing = (deps.request ?? request)(
        {
          ...options,
          headers: {
            ...options.headers,
            accept: "message/rfc822",
          },
        },
        read,
      );
      outgoing.on("error", fail);
      if (settled || input.signal.aborted) {
        if (input.signal.aborted) abort();
        if (!outgoing.destroyed) outgoing.destroy();
      } else outgoing.end(input.body);
    };
    void start().catch(fail);
  });
}
