import { type ClientRequest, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  type NetworkLookup,
  NetworkTargetBlockedError,
  type PublicNetworkAddress,
  pinnedNetworkLookup,
  resolvePublicNetworkAddresses,
} from "@k2b/cloud/services/network-security";
import { isUnsafeNetworkAddress, networkAddressFamily, normalizeNetworkHostname } from "@k2b/cloud/shared";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { workflowServiceText } from "./workflow-service-messages";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

type RequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

type WorkflowHttpClientDeps = {
  lookup?: NetworkLookup;
  request?: RequestFactory;
};

type WorkflowHttpRequestInput = {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  idempotencyKey?: string;
  body?: string;
  timeoutMs?: number;
  locale?: string;
};

type WorkflowHttpResponse = {
  status: number;
  ok: boolean;
  body: string;
  host: string;
};

type ResolvedTarget = {
  url: URL;
  addresses: PublicNetworkAddress[];
};

type PreparedWorkflowHttpRequest = {
  target: ResolvedTarget;
  headers: Record<string, string>;
};

export const isUnsafeWorkflowHttpAddress = isUnsafeNetworkAddress;

const normalizeHostname = normalizeNetworkHostname;

const resolveTarget = async (rawUrl: string, deps: WorkflowHttpClientDeps, locale?: string): Promise<Result<ResolvedTarget>> => {
  const t = workflowServiceText(locale);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(err.badInput(t.httpUrlInvalid));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fail(err.badInput(t.httpProtocolInvalid));
  if (url.username || url.password) return fail(err.badInput(t.httpCredentialsForbidden));

  try {
    const addresses = await resolvePublicNetworkAddresses(url.hostname, deps.lookup);
    return ok({ url, addresses });
  } catch (error) {
    return fail(err.badInput(error instanceof NetworkTargetBlockedError ? t.httpTargetPrivate : t.httpTargetUnresolved));
  }
};

const BLOCKED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const requestHeaders = (input: WorkflowHttpRequestInput): Result<Record<string, string>> => {
  const t = workflowServiceText(input.locale);
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  for (const [rawName, value] of Object.entries(input.headers ?? {})) {
    const name = rawName.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      return fail(err.badInput(t.httpHeaderInvalid({ name: rawName })));
    }
    if (BLOCKED_REQUEST_HEADERS.has(name)) return fail(err.badInput(t.httpHeaderForbidden({ name: rawName })));
    headers[name] = value;
  }
  if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
  if (input.body !== undefined) {
    const bodyBytes = Buffer.byteLength(input.body);
    if (bodyBytes > MAX_REQUEST_BYTES) return fail(err.badInput(t.httpBodyTooLarge));
    headers["content-type"] ??= "application/json";
    headers["content-length"] = String(bodyBytes);
  }
  return ok(headers);
};

const prepareWorkflowHttpRequest = async (
  input: WorkflowHttpRequestInput,
  deps: WorkflowHttpClientDeps,
  signal: AbortSignal,
): Promise<Result<PreparedWorkflowHttpRequest>> => {
  const t = workflowServiceText(input.locale);
  const headers = requestHeaders(input);
  if (!headers.ok) return headers;
  try {
    const target = await Promise.race([
      resolveTarget(input.url, deps, input.locale),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("request timed out"), { name: "AbortError" })), {
          once: true,
        });
      }),
    ]);
    if (!target.ok) return target;
    return ok({ target: target.data, headers: headers.data });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return fail(err.badInput(t.httpResolutionTimeout));
    return fail(err.badInput(t.httpTargetUnresolved));
  }
};

export const preflightWorkflowHttp = async (
  input: WorkflowHttpRequestInput,
  deps: WorkflowHttpClientDeps = {},
): Promise<Result<{ host: string }>> => {
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const prepared = await prepareWorkflowHttpRequest(input, deps, controller.signal);
    return prepared.ok ? ok({ host: prepared.data.target.url.host }) : prepared;
  } finally {
    clearTimeout(timer);
  }
};

const sendPinnedRequest = (
  target: ResolvedTarget,
  input: WorkflowHttpRequestInput,
  headers: Record<string, string>,
  signal: AbortSignal,
  deps: WorkflowHttpClientDeps,
  onDispatched: () => void,
): Promise<WorkflowHttpResponse> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const factory = deps.request ?? (target.url.protocol === "https:" ? httpsRequest : httpRequest);
    const options = {
      protocol: target.url.protocol,
      hostname: normalizeHostname(target.url.hostname),
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: input.method,
      headers,
      servername: networkAddressFamily(target.url.hostname) ? undefined : normalizeHostname(target.url.hostname),
      lookup: pinnedNetworkLookup(target.addresses),
    } satisfies RequestOptions & { servername?: string };
    const request = factory(options, (response) => {
      onDispatched();
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        request.destroy();
        finish(() => reject(new Error("response too large")));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (size + buffer.length > MAX_RESPONSE_BYTES) {
          response.destroy();
          request.destroy();
          finish(() => reject(new Error("response too large")));
          return;
        }
        size += buffer.length;
        chunks.push(buffer);
      });
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        finish(() =>
          resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks, size).toString("utf8"), host: target.url.host }),
        );
      });
      response.once("error", (error) => finish(() => reject(error)));
    });
    const abort = () => request.destroy(Object.assign(new Error("request timed out"), { name: "AbortError" }));
    request.once("finish", onDispatched);
    request.once("error", (error) => finish(() => reject(error)));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    request.end(input.body);
  });

export const requestWorkflowHttp = async (
  input: WorkflowHttpRequestInput,
  deps: WorkflowHttpClientDeps = {},
): Promise<Result<WorkflowHttpResponse>> => {
  const t = workflowServiceText(input.locale);
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatched = false;
  try {
    const prepared = await prepareWorkflowHttpRequest(input, deps, controller.signal);
    if (!prepared.ok) return prepared;
    return ok(
      await sendPinnedRequest(prepared.data.target, input, prepared.data.headers, controller.signal, deps, () => (dispatched = true)),
    );
  } catch (error) {
    if (dispatched) {
      return fail({
        code: "WORKFLOW_HTTP_OUTCOME_UNKNOWN",
        message: t.httpOutcomeUnknown,
        status: 500,
      });
    }
    if (error instanceof Error && error.name === "AbortError") {
      return fail({ code: "WORKFLOW_HTTP_RETRYABLE", message: t.httpSendTimeout, status: 500 });
    }
    return fail({
      code: "WORKFLOW_HTTP_RETRYABLE",
      message: t.httpConnectionFailed,
      status: 500,
    });
  } finally {
    clearTimeout(timer);
  }
};
