import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { readBoundedJson } from "../_internal/bounded-json";
import { type DashboardWidget, type listApps, listWidgets } from "../_internal/registry";
import { parseWidgetSettings } from "../_internal/widget-settings";
import {
  type DashboardWidgetSize,
  fitWidgetSize,
  isDashboardWidgetSize,
  WIDGET_KEY_MAX_LENGTH,
  WIDGET_MAX_RESPONSE_BYTES,
  WIDGET_REQUEST_MAX_BYTES,
  WIDGET_REQUEST_MAX_ENTRIES,
  WIDGET_REQUEST_MAX_ID_LENGTH,
  WIDGET_SETTINGS_MAX_FIELDS,
  type WidgetResponse,
  WidgetResponseSchema,
  type WidgetStreamLine,
  widgetKey,
} from "../contracts/widgets";
import { type AuthContext, auth, preferredLocale, rejectReservedWorkloadCredential } from "../server";
import { AppAccessDeniedError, appAccessDeniedBody } from "../server/middleware/app-access";
import { noTransform } from "../server/middleware/no-transform";
import { WIDGET_SETTINGS_PARAM, WIDGET_SETTINGS_PARAM_MAX_LENGTH, WIDGET_SIZE_PARAM } from "../server/widget-request";
import { appAccessAuthority } from "../services/app-access";
import { discoverableAppEntries } from "../services/app-discovery";
import { CLOUD_INVOCATION_TOKEN_TTL_SECONDS } from "../services/identity/constants";
import { invocationAuthorityFromRequest } from "../services/identity/invocation-authority";
import { widgetInvocationOperation } from "../services/identity/invocation-operations";
import { normalizeInvocationRequestId } from "../services/identity/invocation-token";
import { issueInvocationToken as signInvocationToken } from "../services/identity/issue-invocation";
import { withActiveIdentitySigner } from "../services/identity/key-ring";
import { logger } from "../services/logging";
import { LOCALE_HEADER } from "../shared/locale";
import { ndjsonStream, startBounded, waitWithin } from "./fanout";

type WidgetRouteDependencies = {
  listWidgets?: typeof listWidgets;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  authenticate?: MiddlewareHandler<AuthContext>;
  listApps?: typeof listApps;
  signInvocation?: typeof signInvocationToken;
  withActiveSigner?: typeof withActiveIdentitySigner;
  timeoutMs?: number;
};

/**
 * Each widget's own budget, counted from the moment Core starts it: the same interactive budget Universal Search
 * gives its providers. Widgets stream in as they finish, so a slow one delays only itself.
 */
export const WIDGET_TIMEOUT_MS = 8_000;
/** Widgets Core asks at the same time for one dashboard, as many as Universal Search asks providers. */
export const WIDGET_CONCURRENCY = 8;
/**
 * A stream signs every invocation up front; no widget may still start after those invocations expire. Widgets that
 * have not answered by then end as `timeout`.
 */
const WIDGET_STREAM_DEADLINE_MS = CLOUD_INVOCATION_TOKEN_TTL_SECONDS * 1_000;

const log = logger("widgets");
type WidgetRejectionReason =
  | "upstream_timeout"
  | "upstream_status"
  | "too_large"
  | "settings_too_large"
  | "invalid_json"
  | "invalid_schema"
  | "deadline_exceeded"
  | "request_cancelled"
  | "operation_failed";
type WidgetPhase = "registry" | "signing" | "provider" | "response";

const logRejection = (
  widget: { appId: string; widgetId: string },
  phase: WidgetPhase,
  reason: WidgetRejectionReason,
  upstreamStatus?: number,
) =>
  log.warn("Widget proxy rejected response", {
    appId: widget.appId.slice(0, 80),
    widgetId: widget.widgetId.slice(0, 100),
    phase,
    reason,
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
  });

type ProviderOutcome =
  | { status: "ok"; widget: WidgetResponse }
  | { status: "empty" | "forbidden" }
  | { status: "timeout" | "error"; phase: WidgetPhase; reason: WidgetRejectionReason; upstreamStatus?: number };

/**
 * Calls one provider with its exact invocation and validates the answer. Never throws: every failure becomes a
 * bounded outcome that the caller logs and reports.
 */
const callProvider = async (options: {
  c: Context<AuthContext>;
  widget: DashboardWidget;
  /** What the browser asked for, fitted to the widget's declared sizes before it reaches the app. */
  size: unknown;
  settings?: unknown;
  token: string;
  requestId: string | undefined;
  signal: AbortSignal;
  timeout: AbortSignal;
  fetch: NonNullable<WidgetRouteDependencies["fetch"]>;
}): Promise<ProviderOutcome> => {
  const { c, widget, signal, timeout } = options;
  let phase: WidgetPhase = "provider";
  try {
    const headers = new Headers({ authorization: `Bearer ${options.token}` });
    if (options.requestId) headers.set("x-request-id", options.requestId);
    for (const name of ["traceparent", "tracestate"] as const) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const locale = preferredLocale(c.req.raw.headers);
    if (locale) headers.set(LOCALE_HEADER, locale);
    headers.set("x-cloud-invocation-operation", widgetInvocationOperation(widget.widgetId));

    const targetUrl = new URL(`/api/_internal/widgets/v1/${encodeURIComponent(widget.widgetId)}`, widget.url);
    targetUrl.searchParams.set(WIDGET_SIZE_PARAM, fitWidgetSize(options.size, widget));
    if (widget.settings) {
      const json = JSON.stringify(parseWidgetSettings(widget.settings, options.settings));
      const encodedLength = new URLSearchParams([[WIDGET_SETTINGS_PARAM, json]]).toString().length - WIDGET_SETTINGS_PARAM.length - 1;
      if (encodedLength > WIDGET_SETTINGS_PARAM_MAX_LENGTH) return { status: "error", phase: "provider", reason: "settings_too_large" };
      targetUrl.searchParams.set(WIDGET_SETTINGS_PARAM, json);
    }
    signal.throwIfAborted();
    const response = await options.fetch(targetUrl, { headers, signal });
    if (response.status === 204 || response.status === 403) {
      await response.body?.cancel();
      return { status: response.status === 204 ? "empty" : "forbidden" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return response.status === 504
        ? { status: "timeout", phase, reason: "upstream_timeout", upstreamStatus: response.status }
        : { status: "error", phase, reason: "upstream_status", upstreamStatus: response.status };
    }
    phase = "response";
    const body = await readBoundedJson(response, WIDGET_MAX_RESPONSE_BYTES);
    signal.throwIfAborted();
    if (!body.ok) return { status: "error", phase, reason: body.reason };
    const parsed = WidgetResponseSchema.safeParse(body.data);
    if (!parsed.success) return { status: "error", phase, reason: "invalid_schema" };
    return { status: "ok", widget: parsed.data };
  } catch (error) {
    const isTimeout = timeout.aborted || (error instanceof Error && error.name === "TimeoutError");
    return isTimeout
      ? { status: "timeout", phase, reason: "deadline_exceeded" }
      : { status: "error", phase, reason: signal.aborted ? "request_cancelled" : "operation_failed" };
  }
};

/**
 * `<appId>/<widgetId>` with an optional `@small`, `@medium`, or `@large`, as the key and the size it asks for. The
 * suffix is a size whenever the key before it is declared; `defineApp()` rejects `@` in widget IDs, so only an app
 * built before sizes existed can declare an ID that ends in such a suffix, and it is still asked by that whole ID.
 */
const parseRequestedWidget = (value: string, declared: ReadonlySet<string>): [string, DashboardWidgetSize | undefined] => {
  const at = value.lastIndexOf("@");
  const size = at < 0 ? undefined : value.slice(at + 1);
  return isDashboardWidgetSize(size) && declared.has(value.slice(0, at)) ? [value.slice(0, at), size] : [value, undefined];
};

const WidgetEntriesSchema = z
  .object({
    widgets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(WIDGET_REQUEST_MAX_ID_LENGTH),
            key: z.string().min(1).max(WIDGET_KEY_MAX_LENGTH),
            size: z.string().optional(),
            settings: z
              .record(z.string(), z.unknown())
              .refine((values) => Object.keys(values).length <= WIDGET_SETTINGS_MAX_FIELDS)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(WIDGET_REQUEST_MAX_ENTRIES)
      .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, "Widget entry ids must be unique"),
  })
  .strict();

type WidgetEntry = { widget: DashboardWidget; id?: string; size?: string; settings?: unknown };

export const createWidgetRoutes = (dependencies: WidgetRouteDependencies = {}) => {
  const registry = dependencies.listWidgets ?? listWidgets;
  const fetchWidget = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? WIDGET_TIMEOUT_MS;
  const withActiveSigner = dependencies.withActiveSigner ?? withActiveIdentitySigner;
  const signInvocation = dependencies.signInvocation ?? signInvocationToken;

  const sign = (
    c: Context<AuthContext>,
    widget: DashboardWidget,
    requestId: string | undefined,
    signer: Parameters<Parameters<typeof withActiveIdentitySigner>[1]>[0],
  ) =>
    signInvocation({
      targetAppId: widget.appId,
      callingAppId: "core",
      operation: widgetInvocationOperation(widget.widgetId),
      schemaHash: null,
      authority: invocationAuthorityFromRequest(auth.getAuthority(c)),
      requestId,
      signer,
      issuer: signer.issuer,
    });

  const stream = async (c: Context<AuthContext>, entries: WidgetEntry[], requestId: string | undefined) => {
    const streamDeadline = AbortSignal.timeout(WIDGET_STREAM_DEADLINE_MS);
    // A client that stops reading, such as a browser leaving the dashboard, ends every widget it still waits for.
    const streamCancelled = new AbortController();
    const fanoutSignal = AbortSignal.any([c.req.raw.signal, streamDeadline, streamCancelled.signal]);
    // One signing guard for the whole dashboard, not one Postgres check per widget.
    let tokens: PromiseSettledResult<Awaited<ReturnType<typeof signInvocationToken>>>[] = [];
    try {
      if (entries.length > 0) {
        const signing = AbortSignal.any([fanoutSignal, AbortSignal.timeout(timeoutMs)]);
        tokens = await waitWithin(
          withActiveSigner(
            "invocation",
            (signer) =>
              Promise.all(startBounded(entries, WIDGET_CONCURRENCY, async (entry) => sign(c, entry.widget, requestId, signer), signing)),
            { signal: signing, timeoutMs },
          ),
          signing,
        );
      }
    } catch {
      log.warn("Widget invocation authority unavailable", { reason: fanoutSignal.aborted ? "deadline_exceeded" : "operation_failed" });
      return c.json({ message: "Widget invocation authority is currently unavailable" }, 503);
    }

    const fanoutStarted = performance.now();
    const settled = startBounded(
      entries,
      WIDGET_CONCURRENCY,
      async (entry, index): Promise<WidgetStreamLine> => {
        const { widget } = entry;
        const identity = entry.id === undefined ? {} : { id: entry.id };
        const key = widgetKey(widget.appId, widget.widgetId);
        const started = performance.now();
        const elapsed = () => Math.round(performance.now() - started);
        const token = tokens[index];
        if (token?.status !== "fulfilled") {
          logRejection(widget, "signing", "operation_failed");
          return { type: "widget", ...identity, key, status: "error", ms: elapsed() };
        }
        const timeout = AbortSignal.timeout(timeoutMs);
        const outcome = await callProvider({
          c,
          widget,
          token: token.value.token,
          requestId,
          signal: AbortSignal.any([fanoutSignal, timeout]),
          timeout,
          fetch: fetchWidget,
          size: entry.size,
          settings: entry.settings,
        });
        if (outcome.status === "ok") return { type: "widget", ...identity, key, status: "ok", widget: outcome.widget, ms: elapsed() };
        // A widget the stream itself stopped has already been settled, and is logged once, below.
        if ("reason" in outcome && !fanoutSignal.aborted) logRejection(widget, outcome.phase, outcome.reason, outcome.upstreamStatus);
        return { type: "widget", ...identity, key, status: outcome.status, ms: elapsed() };
      },
      fanoutSignal,
    );

    return ndjsonStream<WidgetStreamLine>({
      first: { type: "start", widgets: entries.map((entry) => entry.id ?? widgetKey(entry.widget.appId, entry.widget.widgetId)) },
      pending: settled.map((pending, index) =>
        pending.then((result): WidgetStreamLine => {
          if (result.status === "fulfilled") return result.value;
          // Only the stream's own deadline or the browser leaving settles a widget this way. Leaving is not a
          // failure of the widget, so only the deadline is logged.
          const entry = entries[index]!;
          const { widget } = entry;
          const status = streamDeadline.aborted ? "timeout" : "error";
          if (streamDeadline.aborted) logRejection(widget, "provider", "deadline_exceeded");
          return {
            type: "widget",
            ...(entry.id === undefined ? {} : { id: entry.id }),
            key: widgetKey(widget.appId, widget.widgetId),
            status,
            ms: Math.round(performance.now() - fanoutStarted),
          };
        }),
      ),
      last: (lines) => ({
        type: "done",
        status: lines.some((line) => line.type === "widget" && (line.status === "timeout" || line.status === "error"))
          ? "partial"
          : "complete",
      }),
      onCancel: () => streamCancelled.abort(),
    });
  };

  return (
    new Hono<AuthContext>()
      .use("/widgets/v1", noTransform())
      .use("/widgets/v1/*", noTransform())
      .use(dependencies.authenticate ?? auth.requireRole("authenticated"))
      .use(rejectReservedWorkloadCredential)
      .use(auth.requireOAuthScope("read", "admin"))
      /**
       * Every requested widget (`?widget=<appId>/<widgetId>`, repeatable, optionally with `@<size>`; all declared
       * widgets without one) as an NDJSON stream: one line per widget as soon as it answers, each within its own budget.
       */
      .get("/widgets/v1", async (c) => {
        const requestId = normalizeInvocationRequestId(c.req.header("x-request-id"));
        const setup = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]);
        let widgets: DashboardWidget[];
        let requested = new Map<string, DashboardWidgetSize | undefined>();
        try {
          const keys = new Set<string>();
          const declared = await waitWithin(
            registry().then((entries) => discoverableAppEntries(appAccessAuthority(c), entries, dependencies.listApps)),
            setup,
          );
          const declaredKeys = new Set(declared.map((widget) => widgetKey(widget.appId, widget.widgetId)));
          requested = new Map((c.req.queries("widget") ?? []).map((value) => parseRequestedWidget(value, declaredKeys)));
          widgets = declared.filter((widget) => {
            const key = widgetKey(widget.appId, widget.widgetId);
            if (keys.has(key) || (requested.size > 0 && !requested.has(key))) return false;
            keys.add(key);
            return true;
          });
        } catch {
          log.warn("Widget registry unavailable", { reason: setup.aborted ? "deadline_exceeded" : "operation_failed" });
          return c.json({ message: "Widget registry is currently unavailable" }, 503);
        }

        return stream(
          c,
          widgets.map((widget) => ({ widget, size: requested.get(widgetKey(widget.appId, widget.widgetId)) })),
          requestId,
        );
      })
      .post(
        "/widgets/v1",
        bodyLimit({ maxSize: WIDGET_REQUEST_MAX_BYTES, onError: (c) => c.json({ message: "Widget request is too large" }, 400) }),
        async (c) => {
          let raw: unknown;
          try {
            raw = await c.req.json();
          } catch {
            return c.json({ message: "Invalid widget request JSON" }, 400);
          }
          const parsed = WidgetEntriesSchema.safeParse(raw);
          if (!parsed.success) return c.json({ message: "Invalid widget request" }, 400);
          const setup = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]);
          let declared: DashboardWidget[];
          try {
            declared = await waitWithin(
              registry().then((entries) => discoverableAppEntries(appAccessAuthority(c), entries, dependencies.listApps)),
              setup,
            );
          } catch {
            log.warn("Widget registry unavailable", { reason: setup.aborted ? "deadline_exceeded" : "operation_failed" });
            return c.json({ message: "Widget registry is currently unavailable" }, 503);
          }
          const byKey = new Map(declared.map((widget) => [widgetKey(widget.appId, widget.widgetId), widget]));
          const entries = parsed.data.widgets.flatMap((entry) => {
            const widget = byKey.get(entry.key);
            return widget ? [{ ...entry, widget }] : [];
          });
          return stream(c, entries, normalizeInvocationRequestId(c.req.header("x-request-id")));
        },
      )
      .get("/widgets/v1/:appId/:widgetId", async (c) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([c.req.raw.signal, timeout]);
        const appId = c.req.param("appId");
        const widgetId = c.req.param("widgetId");
        const requestId = normalizeInvocationRequestId(c.req.header("x-request-id"));
        let phase: WidgetPhase = "registry";
        try {
          const widget = (
            await waitWithin(
              registry().then((entries) => discoverableAppEntries(appAccessAuthority(c), entries, dependencies.listApps)),
              signal,
            )
          ).find((entry) => entry.appId === appId && entry.widgetId === widgetId);
          if (!widget) return c.json({ message: "Widget not found" }, 404);

          phase = "signing";
          const signed = await waitWithin(
            withActiveSigner("invocation", (signer) => sign(c, widget, requestId, signer), { signal, timeoutMs }),
            signal,
          );

          phase = "provider";
          const outcome = await callProvider({
            c,
            widget,
            size: c.req.query(WIDGET_SIZE_PARAM),
            token: signed.token,
            requestId,
            signal,
            timeout,
            fetch: fetchWidget,
          });
          if (outcome.status === "ok") return Response.json(outcome.widget, { headers: { "content-type": "application/json" } });
          if (!("reason" in outcome))
            return new Response(null, { status: outcome.status === "empty" ? 204 : 403, headers: { "content-type": "application/json" } });
          logRejection(widget, outcome.phase, outcome.reason, outcome.upstreamStatus);
          if (outcome.status === "timeout") return Response.json({ message: "Widget deadline exceeded" }, { status: 504 });
          const message =
            outcome.reason === "invalid_schema"
              ? "Widget returned an invalid response"
              : outcome.reason === "too_large" || outcome.reason === "invalid_json"
                ? "Widget returned invalid or oversized JSON"
                : "Widget is unavailable";
          return Response.json({ message }, { status: 502 });
        } catch (error) {
          if (error instanceof AppAccessDeniedError) return Response.json(appAccessDeniedBody(error.app), { status: 403 });
          const isTimeout = timeout.aborted || (error instanceof Error && error.name === "TimeoutError");
          const reason: WidgetRejectionReason = isTimeout ? "deadline_exceeded" : signal.aborted ? "request_cancelled" : "operation_failed";
          logRejection({ appId, widgetId }, phase, reason);
          return isTimeout
            ? Response.json({ message: "Widget deadline exceeded" }, { status: 504 })
            : Response.json({ message: "Widget is unavailable" }, { status: 502 });
        }
      })
  );
};
