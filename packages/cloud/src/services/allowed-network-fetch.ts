import { type ClientRequest, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { type NetworkAllowlist, networkAddressFamily, normalizeNetworkHostname } from "../shared/network-address";
import { type NetworkLookup, pinnedNetworkLookup, resolveAllowedNetworkAddresses } from "./network-security";

type RequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
type AllowedNetworkFetchDeps = {
  lookup?: NetworkLookup;
  resolve?: typeof resolveAllowedNetworkAddresses;
  request?: RequestFactory;
};

/**
 * Fetch-compatible HTTP transport for operator-allowlisted targets. Resolves and
 * pins every request, without proxies, retries, decompression or its own timeout.
 * Never follows redirects: `redirect: "error"` rejects any 3xx; otherwise returns
 * that response unchanged. The caller owns deadlines and response consumption.
 */
export const createAllowedNetworkFetch =
  (allowlist: NetworkAllowlist, deps: AllowedNetworkFetchDeps = {}) =>
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Network target must use HTTP or HTTPS");
    if (url.username || url.password) throw new TypeError("Network target must not include user information");
    const signal = request.signal;
    signal.throwIfAborted();
    const addresses = await new Promise<Awaited<ReturnType<typeof resolveAllowedNetworkAddresses>>>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      (deps.resolve ?? resolveAllowedNetworkAddresses)(url.hostname, allowlist, deps.lookup)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    // A body of known size goes out with Content-Length; only a caller's stream (in init or an input Request) is chunked.
    const streamed = init?.body != null ? init.body instanceof ReadableStream : input instanceof Request && input.body !== null;
    const payload = request.body && !streamed ? new Uint8Array(await request.arrayBuffer()) : undefined;
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const headers = new Headers(request.headers);
      headers.set("host", url.host);
      headers.set("accept-encoding", "identity");
      if (payload) headers.set("content-length", String(payload.byteLength));
      let response: IncomingMessage | undefined;
      let upload: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cleanup = () => signal.removeEventListener("abort", abort);
      const fail = (error: Error) => {
        reject(error);
        bodyController?.error(error);
        bodyController = undefined;
        response?.destroy();
        void upload?.cancel(error).catch(() => {});
        outgoing.destroy(error);
        cleanup();
      };
      const abort = () => fail(signal.reason);
      const outgoing = (deps.request ?? (url.protocol === "https:" ? httpsRequest : httpRequest))(
        {
          protocol: url.protocol,
          hostname: normalizeNetworkHostname(url.hostname),
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: Object.fromEntries(headers),
          servername: url.protocol === "https:" && !networkAddressFamily(url.hostname) ? normalizeNetworkHostname(url.hostname) : undefined,
          lookup: pinnedNetworkLookup(addresses),
          agent: false,
        } satisfies RequestOptions & { servername?: string },
        (incoming) => {
          response = incoming;
          incoming.once("close", cleanup);
          incoming.once("error", (error) => {
            reject(error);
            bodyController?.error(error);
            bodyController = undefined;
          });
          const status = incoming.statusCode ?? 0;
          if (request.redirect === "error" && status >= 300 && status < 400) {
            fail(new TypeError(`Network target returned HTTP ${status} redirect`));
            return;
          }
          const encoding = incoming.headers["content-encoding"];
          if (encoding && encoding.trim().toLowerCase() !== "identity") {
            fail(new TypeError("Network target returned an unsupported content encoding"));
            return;
          }
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2)
            responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
          const empty = request.method === "HEAD" || [204, 205, 304].includes(status);
          const iterator = incoming[Symbol.asyncIterator]();
          const body = empty
            ? null
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  bodyController = controller;
                },
                async pull(controller) {
                  try {
                    const chunk = await iterator.next();
                    if (!bodyController) return;
                    if (chunk.done) {
                      bodyController = undefined;
                      controller.close();
                      cleanup();
                    } else controller.enqueue(new Uint8Array(chunk.value));
                  } catch (error) {
                    if (bodyController) {
                      bodyController = undefined;
                      controller.error(error);
                    }
                    outgoing.destroy();
                    cleanup();
                  }
                },
                cancel() {
                  bodyController = undefined;
                  incoming.destroy();
                  outgoing.destroy();
                  cleanup();
                },
              });
          try {
            resolve(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
            if (empty) incoming.resume();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
      outgoing.once("close", () => {
        void upload?.cancel().catch(() => {});
      });
      outgoing.once("error", (error) => {
        reject(error);
        bodyController?.error(error);
        bodyController = undefined;
        response?.destroy();
        cleanup();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      if (payload) {
        outgoing.end(payload);
        return;
      }
      void (async () => {
        const reader = request.body?.getReader();
        upload = reader;
        try {
          if (reader) {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (outgoing.destroyed) break;
              if (!outgoing.write(chunk.value))
                await new Promise<void>((resolve, reject) => {
                  const closed = () => {
                    clear();
                    reject(new Error("Request closed"));
                  };
                  const drained = () => {
                    clear();
                    resolve();
                  };
                  const clear = () => {
                    outgoing.off("close", closed);
                    outgoing.off("drain", drained);
                  };
                  outgoing.once("drain", drained);
                  outgoing.once("close", closed);
                });
            }
          }
          outgoing.end();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        } finally {
          await reader?.cancel().catch(() => {});
        }
      })();
    });
  };
