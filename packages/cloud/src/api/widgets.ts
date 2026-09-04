import { Hono, type MiddlewareHandler } from "hono";
import { readBoundedJson } from "../_internal/bounded-json";
import { listWidgets } from "../_internal/registry";
import { WIDGET_MAX_RESPONSE_BYTES, WidgetResponseSchema } from "../contracts/widgets";
import { type AuthContext, auth, preferredLocale, rejectReservedWorkloadCredential } from "../server";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { widgetInvocationOperation } from "../services/identity/invocation-operations";
import { normalizeInvocationRequestId, signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { logger } from "../services/logging";
import { LOCALE_HEADER } from "../shared/locale";

type WidgetRouteDependencies = {
  listWidgets?: typeof listWidgets;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  authenticate?: MiddlewareHandler<AuthContext>;
  signInvocation?: typeof signInvocationToken;
  withActiveSigner?: typeof withActiveIdentitySigner;
  timeoutMs?: number;
};

export const WIDGET_PROXY_TIMEOUT_MS = 500;
const log = logger("widgets");
type WidgetRejectionReason =
  | "upstream_timeout"
  | "upstream_status"
  | "too_large"
  | "invalid_json"
  | "invalid_schema"
  | "deadline_exceeded"
  | "request_cancelled"
  | "operation_failed";

const jsonError = (message: string, status: 502 | 504): Response =>
  Response.json({ message }, { status, headers: { "content-type": "application/json" } });

const waitWithin = <T>(value: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });

export const createWidgetRoutes = (dependencies: WidgetRouteDependencies = {}) => {
  const registry = dependencies.listWidgets ?? listWidgets;
  const fetchWidget = dependencies.fetch ?? globalThis.fetch;

  return new Hono<AuthContext>()
    .use(dependencies.authenticate ?? auth.requireRole("authenticated"))
    .use(rejectReservedWorkloadCredential)
    .use(auth.requireOAuthScope("read", "admin"))
    .get("/widgets/v1/:appId/:widgetId", async (c) => {
      const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? WIDGET_PROXY_TIMEOUT_MS);
      const signal = AbortSignal.any([c.req.raw.signal, timeout]);
      const appId = c.req.param("appId");
      const widgetId = c.req.param("widgetId");
      const requestId = normalizeInvocationRequestId(c.req.header("x-request-id"));
      let phase: "registry" | "signing" | "provider" | "response" = "registry";
      const reject = (reason: WidgetRejectionReason, message: string, status: 502 | 504, upstreamStatus?: number): Response => {
        log.warn("Widget proxy rejected response", {
          appId: appId.slice(0, 80),
          widgetId: widgetId.slice(0, 100),
          phase,
          reason,
          ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
        });
        return jsonError(message, status);
      };
      try {
        const widget = (await waitWithin(registry(), signal)).find((entry) => entry.appId === appId && entry.widgetId === widgetId);
        if (!widget) return c.json({ message: "Widget not found" }, 404);

        phase = "signing";
        const headers = await (async () => {
          const signed = await waitWithin(
            (dependencies.withActiveSigner ?? withActiveIdentitySigner)(
              "invocation",
              (signer) =>
                (dependencies.signInvocation ?? signInvocationToken)({
                  targetAppId: widget.appId,
                  callingAppId: "core",
                  operation: widgetInvocationOperation(widget.widgetId),
                  schemaHash: null,
                  authority: invocationAuthorityFromRequest(auth.getAuthority(c)),
                  requestId,
                  signer,
                  issuer: signer.issuer,
                }),
              { signal, timeoutMs: dependencies.timeoutMs ?? WIDGET_PROXY_TIMEOUT_MS },
            ),
            signal,
          );
          return new Headers({ authorization: `Bearer ${signed.token}` });
        })();

        if (requestId) headers.set("x-request-id", requestId);
        for (const name of ["traceparent", "tracestate"] as const) {
          const value = c.req.header(name);
          if (value) headers.set(name, value);
        }
        const locale = preferredLocale(c.req.raw.headers);
        if (locale) headers.set(LOCALE_HEADER, locale);
        headers.set("x-cloud-invocation-operation", widgetInvocationOperation(widget.widgetId));

        const targetUrl = new URL(`/api/_internal/widgets/v1/${encodeURIComponent(widget.widgetId)}`, widget.url);
        phase = "provider";
        signal.throwIfAborted();
        const response = await fetchWidget(targetUrl, { headers, signal });
        if (response.status === 204 || response.status === 403) {
          await response.body?.cancel();
          return new Response(null, { status: response.status, headers: { "content-type": "application/json" } });
        }
        if (!response.ok) {
          await response.body?.cancel();
          return response.status === 504
            ? reject("upstream_timeout", "Widget deadline exceeded", 504, response.status)
            : reject("upstream_status", "Widget is unavailable", 502, response.status);
        }
        phase = "response";
        const body = await readBoundedJson(response, WIDGET_MAX_RESPONSE_BYTES);
        signal.throwIfAborted();
        if (!body.ok) return reject(body.reason, "Widget returned invalid or oversized JSON", 502);
        const parsed = WidgetResponseSchema.safeParse(body.data);
        if (!parsed.success) return reject("invalid_schema", "Widget returned an invalid response", 502);
        return Response.json(parsed.data, { headers: { "content-type": "application/json" } });
      } catch (error) {
        const isTimeout = timeout.aborted || (error instanceof Error && error.name === "TimeoutError");
        return isTimeout
          ? reject("deadline_exceeded", "Widget deadline exceeded", 504)
          : reject(signal.aborted ? "request_cancelled" : "operation_failed", "Widget is unavailable", 502);
      }
    });
};
