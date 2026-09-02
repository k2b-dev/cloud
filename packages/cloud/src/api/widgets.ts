import { Hono, type MiddlewareHandler } from "hono";
import { readBoundedJson } from "../_internal/bounded-json";
import { listWidgets } from "../_internal/registry";
import { WIDGET_MAX_RESPONSE_BYTES, WidgetResponseSchema } from "../contracts/widgets";
import { type AuthContext, auth, preferredLocale, rejectReservedWorkloadCredential } from "../server";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { widgetInvocationOperation } from "../services/identity/invocation-operations";
import { invocationIssuanceMode } from "../services/identity/invocation-runtime";
import { signInvocationToken } from "../services/identity/invocation-token";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { LOCALE_HEADER } from "../shared/locale";
import { capabilityCredentialHeaders } from "./capabilities";

type WidgetRouteDependencies = {
  listWidgets?: typeof listWidgets;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  authenticate?: MiddlewareHandler<AuthContext>;
  signInvocation?: typeof signInvocationToken;
  withActiveSigner?: typeof withActiveIdentitySigner;
  timeoutMs?: number;
};

export const WIDGET_PROXY_TIMEOUT_MS = 500;

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
    .get("/widgets/v1/:appId/:widgetId", async (c) => {
      const timeout = AbortSignal.timeout(dependencies.timeoutMs ?? WIDGET_PROXY_TIMEOUT_MS);
      const signal = AbortSignal.any([c.req.raw.signal, timeout]);
      try {
        const appId = c.req.param("appId");
        const widgetId = c.req.param("widgetId");
        const widget = (await waitWithin(registry(), signal)).find((entry) => entry.appId === appId && entry.widgetId === widgetId);
        if (!widget) return c.json({ message: "Widget not found" }, 404);

        const useInvocation = invocationIssuanceMode() === "jwt";
        const headers = useInvocation
          ? await (async () => {
              const signed = await waitWithin(
                (dependencies.withActiveSigner ?? withActiveIdentitySigner)("invocation", (signer) =>
                  (dependencies.signInvocation ?? signInvocationToken)({
                    targetAppId: widget.appId,
                    callingAppId: "core",
                    operation: widgetInvocationOperation(widget.widgetId),
                    schemaHash: null,
                    authority: invocationAuthorityFromRequest(auth.getAuthority(c)),
                    requestId: c.req.header("x-request-id")?.slice(0, 200),
                    signer,
                  }),
                ),
                signal,
              );
              return new Headers({ authorization: `Bearer ${signed.token}` });
            })()
          : capabilityCredentialHeaders(c.req.raw);

        for (const name of ["x-request-id", "traceparent", "tracestate"] as const) {
          const value = c.req.header(name);
          if (value) headers.set(name, value);
        }
        const locale = preferredLocale(c.req.raw.headers);
        if (locale) headers.set(LOCALE_HEADER, locale);
        headers.set("x-cloud-invocation-operation", widgetInvocationOperation(widget.widgetId));

        // Legacy keeps the existing public target so Core/dashboard can roll
        // out before every app has the framework-owned internal handler. JWT
        // issuance switches only to the invocation-authenticated route.
        const targetUrl = useInvocation
          ? new URL(`/api/_internal/widgets/v1/${encodeURIComponent(widget.widgetId)}`, widget.url)
          : new URL(widget.url);
        const response = await fetchWidget(targetUrl, { headers, signal });
        if (response.status === 204 || response.status === 403) {
          await response.body?.cancel();
          return new Response(null, { status: response.status, headers: { "content-type": "application/json" } });
        }
        if (!response.ok) {
          await response.body?.cancel();
          return jsonError("Widget is unavailable", 502);
        }
        const body = await readBoundedJson(response, WIDGET_MAX_RESPONSE_BYTES);
        if (!body.ok) return jsonError("Widget returned invalid or oversized JSON", 502);
        const parsed = WidgetResponseSchema.safeParse(body.data);
        if (!parsed.success) return jsonError("Widget returned an invalid response", 502);
        return Response.json(parsed.data, { headers: { "content-type": "application/json" } });
      } catch {
        return jsonError(timeout.aborted ? "Widget deadline exceeded" : "Widget is unavailable", timeout.aborted ? 504 : 502);
      }
    });
};
