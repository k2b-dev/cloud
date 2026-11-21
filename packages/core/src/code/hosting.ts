import { CODE_REQUEST_LIMITS, CodeRouteRequestSchema, codeOwnPath, matchCodeRoute, validateCodePage } from "@k2b/cloud/code";
import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import { auth, getEffectiveGroups, getLocale, middleware } from "@k2b/cloud/server";
import { i18n } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { ssr } from "../config";
import { admitCodePage, isCodePageNavigation } from "./page-admission";
import { codePageLabel } from "./page-provenance";
import type { CodePageProvenanceSeed } from "./page-provenance-contracts";
import { CodeRouteReadsUnavailable, checkCodeRouteReads } from "./page-reads";
import { type CodePageHostingContext, codePageHandlers } from "./render-page";
import { waitCodeRequest } from "./request-deadline";
import { CodeRequestError, codeRequestVersion, requestCodeRoute } from "./requests";
import { checkCodeCsrf, codeCsrf, codePageVersionValue } from "./route-security";

/** The route a request opens: the first route entrypoint that matches its method and path. */
export const selectCodePageRoute = (manifest: CodeCheckedVersionManifest, method: string, path: string) =>
  manifest.entrypoints.find((entry) => entry.kind === "route" && entry.route && matchCodeRoute(entry.route, method, path));

/** Stream into the budget, including chunked bodies; Content-Length alone is never sufficient. */
export async function readCodeRequestBody(request: Request, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          throw new CodeRequestError("code_request_encoding", 400);
        }
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new CodeRequestError("code_request_size_limit", 413);
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
const unavailableMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "This page is not available right now",
      gone: "It may be paused, the link may be out of date, or the page is not shared with you.",
      later: "Try again in a moment.",
      retry: "Try again",
      noAccessTitle: "No access",
      noAccess: "This page shows data you may not read. Ask the person who owns the page, or who manages the data, for access.",
    },
    de: {
      title: "Diese Seite ist gerade nicht erreichbar",
      gone: "Vielleicht ist sie pausiert, der Link stimmt nicht mehr, oder sie ist nicht für dich freigegeben.",
      later: "Versuche es in einem Moment noch einmal.",
      retry: "Erneut versuchen",
      noAccessTitle: "Kein Zugriff",
      noAccess:
        "Diese Seite zeigt Daten, die du nicht lesen darfst. Bitte die Person, der die Seite gehört oder die die Daten verwaltet, um Zugriff.",
    },
  },
});

/**
 * What a person who opened a Code page sees instead of the stable code a script gets: the Cloud's error page. Missing,
 * paused and inaccessible Code look the same; a busy or slow Code offers to try again.
 */
const unavailablePage = (c: Context, status: number) => {
  const { t } = unavailableMessages.resolve([getLocale(c)]);
  const url = new URL(c.req.url);
  if (status === 409 || status === 429 || status >= 500)
    return ssr.error(c, status === 429 ? 429 : status === 504 ? 504 : 503, {
      title: t.title,
      description: t.later,
      action: { label: t.retry, href: url.pathname + url.search, icon: "ti ti-refresh" },
    });
  return ssr.error(c, 404, { title: t.title, description: t.gone });
};

/** G1: the route read data this visitor may not read. The shared no-access page, without naming the data. */
const noAccessPage = (c: Context) => {
  const { t } = unavailableMessages.resolve([getLocale(c)]);
  return ssr.error(c, 403, { title: t.noAccessTitle, description: t.noAccess });
};

export function createCodeHostingRoutes(
  deps: {
    version: typeof codeRequestVersion;
    request: typeof requestCodeRoute;
    /** Tests replace the read check (G1); production always uses `checkCodeRouteReads`. */
    checkReads?: typeof checkCodeRouteReads;
  } = { version: codeRequestVersion, request: requestCodeRoute },
) {
  const router = new Hono<CodePageHostingContext>();
  router.use("/code/:codeId/*", middleware.noTransform(), auth.requireRole("*"));
  router.all(
    "/code/:codeId/*",
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Vary", "X-Code-Page");
      const codeId = c.req.param("codeId");
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(CODE_REQUEST_LIMITS.timeoutMs)]);
      try {
        if (!["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].includes(c.req.method))
          return c.json({ code: "code_request_method" }, 405);
        if (Buffer.byteLength(c.req.url) > CODE_REQUEST_LIMITS.urlBytes)
          return isCodePageNavigation(c) ? await unavailablePage(c, 413) : c.json({ code: "code_request_size_limit" }, 413);
        const path = new URL(c.req.url).pathname.slice(`/code/${codeId}`.length) || "/";
        const admission = await admitCodePage(c, {
          codeId,
          path,
          signal,
          version: deps.version,
          select: (manifest) => selectCodePageRoute(manifest, c.req.method, path),
          limits: { member: "code-visitor-requests", public: "code-public-requests" },
        });
        // A visitor's way to sign-in stays a redirect; refusals become the page.
        if (admission instanceof Response)
          return isCodePageNavigation(c) && admission.status >= 400 ? await unavailablePage(c, admission.status) : admission;
        const { version, selected, isPublic } = admission;
        const actor = c.get("actor");
        const subject = c.get("accessSubject");
        const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim() ?? "text/plain";
        if (!["text/plain", "application/json", "application/x-www-form-urlencoded"].includes(contentType))
          return c.json({ code: "code_request_content_type" }, 415);
        let body = await readCodeRequestBody(
          c.req.raw,
          isPublic ? CODE_REQUEST_LIMITS.publicBodyBytes : CODE_REQUEST_LIMITS.bodyBytes,
          signal,
        );
        // Public Code has no visitor authority: never bind it to a browser session or an anonymous cookie.
        const binding = !isPublic && c.get("credentialKind") === "session" ? c.get("sessionToken") : undefined;
        const mutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
        let received = c.req.header("X-Code-CSRF");
        if (contentType === "application/x-www-form-urlencoded") {
          const form = new URLSearchParams(body);
          received ??= form.get("_csrf") ?? undefined;
          form.delete("_csrf");
          body = form.toString();
        }
        if (Buffer.byteLength(body) > (isPublic ? CODE_REQUEST_LIMITS.publicBodyBytes : CODE_REQUEST_LIMITS.bodyBytes))
          return c.json({ code: "code_request_size_limit" }, 413);
        if (!isPublic && mutating && !checkCodeCsrf(binding, codeId, received)) return c.json({ code: "code_csrf_required" }, 403);
        const csrf = binding ? codeCsrf(binding, codeId) : null;
        if (csrf !== null) c.header("X-Code-CSRF", csrf);
        const effectiveGroups =
          !isPublic && subject?.type === "user" ? await waitCodeRequest(getEffectiveGroups({ userId: subject.userId }), signal) : [];
        const user =
          !isPublic && actor?.kind === "user" && subject?.type === "user"
            ? {
                id: actor.user.id,
                username: actor.user.uid,
                groupIds: effectiveGroups.map((group) => group.id),
                groupNames: effectiveGroups.map((group) => group.name),
                kind: actor.user.profile,
                name: actor.user.displayName,
              }
            : null;
        const response = await waitCodeRequest(
          deps.request({
            codeId,
            versionId: version.versionId,
            entrypoint: selected.entrypoint,
            signal,
            request: CodeRouteRequestSchema.parse({
              codeId,
              method: c.req.method,
              path,
              query: new URL(c.req.url).search,
              contentType: contentType,
              body,
              params: matchCodeRoute(selected.route, c.req.method, path)!,
              user,
            }),
          }),
          signal,
        );
        // G1: nothing the route answered leaves before the visitor's own right to read each resource it read is checked.
        const reads = await waitCodeRequest(
          (deps.checkReads ?? checkCodeRouteReads)({
            reads: response.reads,
            route: selected.route,
            visitor: isPublic ? null : auth.getAuthority(c),
            databaseMayHoldAppData: version.manifest.database === true && version.manifest.policyRows.includes("read"),
            locale: getLocale(c),
            signal,
          }),
          signal,
        ).catch((error: unknown) => {
          if (error instanceof CodeRouteReadsUnavailable) throw new CodeRequestError("code_page_access_unavailable", 503);
          throw error;
        });
        if (reads === "forbidden")
          return isCodePageNavigation(c) ? await noAccessPage(c) : c.json({ code: "code_page_access_denied" }, 403);
        if (response.kind === "page") {
          const tree = validateCodePage(response.tree, codeId);
          // The page's own island asks for the checked tree alone after a submit or a followed event.
          // Code responses cannot set headers, so this marker tells the island the tree passed validation.
          if (c.req.header("X-Code-Page") === "tree") return c.json({ tree, csrf }, 200, { "X-Code-Page": "tree" });
          // The label beside the tree, reduced to this viewer; the card asks for the rest when it opens.
          const provenance: CodePageProvenanceSeed = {
            label: await waitCodeRequest(
              codePageLabel(version.owner, { actor, accessSubject: subject, credentialKind: c.get("credentialKind") }, getLocale(c)),
              signal,
            ),
            version: codePageVersionValue(codeId, version.versionId),
            path,
            cloudName: c.get("settings")?.app?.name || "Cloud",
          };
          const page = { tree, codeId, csrf, provenance };
          c.set("hostedCodePage", selected.route.layout === "plain" ? { ...page, layout: "plain" } : page);
          await waitCodeRequest(next(), signal);
          if (c.req.method === "HEAD") c.res = c.newResponse(null, c.res);
          return c.res;
        }
        if (response.kind === "redirect") return c.redirect(codeOwnPath(codeId, response.location), response.status);
        return c.newResponse(
          ["HEAD"].includes(c.req.method) || [204, 205, 304].includes(response.status) ? null : response.body,
          new Response(null, {
            status: response.status,
            headers: new Headers({
              "Content-Type": response.kind === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
            }),
          }),
        );
      } catch (error) {
        const failure = signal.aborted
          ? { code: "code_request_timeout", status: 504 as const }
          : error instanceof CodeRequestError
            ? { code: error.code, status: error.status }
            : { code: "code_request_failed", status: 503 as const };
        // A person who opened the page reads a Cloud page with a way out, never the code.
        if (isCodePageNavigation(c)) return await unavailablePage(c, failure.status);
        return c.json({ code: failure.code }, failure.status);
      }
    },
    ...codePageHandlers,
  );
  return router;
}
