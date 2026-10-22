import { type ClientRequest, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import {
  type NetworkLookup,
  NetworkTargetBlockedError,
  type PublicNetworkAddress,
  pinnedNetworkLookup,
  resolveAllowedNetworkAddresses,
} from "@k2b/cloud/services/network-security";
import { type NetworkAllowlist, networkAddressFamily, normalizeNetworkHostname } from "@k2b/cloud/shared";
import { baseScrapeAllowlist, scrapeTargetBlocked } from "./scrape-target";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MESSAGE = "Metrics scrape timed out after 15 seconds";
type RequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type MetricsHttpDeps = {
  allowlist?: NetworkAllowlist;
  readAllowlist?: () => Promise<NetworkAllowlist>;
  lookup?: NetworkLookup;
  request?: RequestFactory;
};
type HopResponse = { status: number; location?: string; body: string };

class MetricsHttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 = 500,
  ) {
    super(message);
  }
}

const requestHop = (
  url: URL,
  addresses: PublicNetworkAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
  deps: MetricsHttpDeps,
): Promise<HopResponse> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: HopResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (response) resolve(response);
    };
    const factory = deps.request ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
    const request = factory(
      {
        protocol: url.protocol,
        hostname: normalizeNetworkHostname(url.hostname),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        servername: networkAddressFamily(url.hostname) ? undefined : normalizeNetworkHostname(url.hostname),
        lookup: pinnedNetworkLookup(addresses),
        agent: false,
      } satisfies RequestOptions & { servername?: string },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status < 200 || status >= 300) {
          finish(undefined, { status, location, body: "" });
          response.destroy();
          request.destroy();
          return;
        }
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding.toLowerCase() !== "identity") {
          finish(new MetricsHttpError("Metrics endpoint returned an unsupported content encoding", 400));
          response.destroy();
          request.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new MetricsHttpError("Metrics endpoint response exceeds 10 MB", 400));
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.once("end", () => finish(undefined, { status, body: Buffer.concat(chunks, size).toString("utf8") }));
        response.once("error", () => finish(new Error("connection failed")));
        response.once("aborted", () => finish(new Error("connection failed")));
      },
    );
    const abort = () => {
      finish(new MetricsHttpError(TIMEOUT_MESSAGE));
      request.destroy();
    };
    request.once("error", () => finish(new Error("connection failed")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else request.end();
  });

/** One deadline and a fresh validation/pinned connection for every redirect. */
export const requestMetrics = async (
  rawUrl: string,
  authorization?: string,
  timeoutMs = 15_000,
  deps: MetricsHttpDeps = {},
): Promise<Result<string>> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new MetricsHttpError(TIMEOUT_MESSAGE));
      controller.abort();
    }, timeoutMs);
  });
  let blockedHost = "";
  try {
    const original = new URL(rawUrl);
    const basic =
      original.username || original.password
        ? `Basic ${Buffer.from(`${decodeURIComponent(original.username)}:${decodeURIComponent(original.password)}`).toString("base64")}`
        : undefined;
    const credential = authorization || basic;
    let url = original;
    for (let hops = 0; ; hops++) {
      if (controller.signal.aborted) throw new MetricsHttpError(TIMEOUT_MESSAGE);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new MetricsHttpError("Metrics endpoint must use HTTP or HTTPS", 400);
      url.username = "";
      url.password = "";
      blockedHost = url.hostname;
      const allowlist = await Promise.race([
        deps.readAllowlist ? deps.readAllowlist() : Promise.resolve(deps.allowlist ?? (await baseScrapeAllowlist())),
        deadline,
      ]);
      let addresses: PublicNetworkAddress[];
      try {
        addresses = await Promise.race([
          resolveAllowedNetworkAddresses(url.hostname, allowlist, deps.lookup, Number(url.port || (url.protocol === "https:" ? 443 : 80))),
          deadline,
        ]);
      } catch (error) {
        if (error instanceof NetworkTargetBlockedError || error instanceof MetricsHttpError) throw error;
        throw new MetricsHttpError("Metrics endpoint host could not be resolved");
      }
      const headers: Record<string, string> = { "User-Agent": "Pulse/1.0 metrics scraper", "Accept-Encoding": "identity" };
      if (credential && url.origin === original.origin) headers.Authorization = credential;
      const response = await Promise.race([requestHop(url, addresses, headers, controller.signal, deps), deadline]);
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
        if (hops >= 3) throw new MetricsHttpError("Metrics endpoint exceeded the 3 redirect limit", 400);
        url = new URL(response.location, url);
        continue;
      }
      if (response.status < 200 || response.status >= 300) return fail(err.internal(`Metrics endpoint returned HTTP ${response.status}`));
      return ok(response.body);
    }
  } catch (error) {
    if (error instanceof NetworkTargetBlockedError) return fail(scrapeTargetBlocked(blockedHost));
    if (error instanceof MetricsHttpError) return fail(error.status === 400 ? err.badInput(error.message) : err.internal(error.message));
    return fail(err.internal("Metrics endpoint connection failed"));
  } finally {
    clearTimeout(timer);
  }
};
