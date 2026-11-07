import { randomBytes } from "node:crypto";
import { CODE_REQUEST_LIMITS, CodeRouteRequestSchema, codeOwnPath, matchCodeRoute } from "@k2b/cloud/code";
import { type AuthContext, auth, clientIp, clientIpBucket, getEffectiveGroups, middleware, ratelimit } from "@k2b/cloud/server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { waitCodeRequest } from "./request-deadline";
import { CodeRequestError, codeRequestVersion, requestCodeRoute } from "./requests";
import { checkCodeCsrf, codeCsrf } from "./route-security";

const anonymousCookie = "__Host-code-page-csrf";
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
export function createCodeHostingRoutes(deps = { version: codeRequestVersion, request: requestCodeRoute }) {
  const router = new Hono<AuthContext>();
  router.use("/code/:codeId/*", middleware.noTransform(), auth.requireRole("*"));
  router.all("/code/:codeId/*", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const codeId = c.req.param("codeId");
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(CODE_REQUEST_LIMITS.timeoutMs)]);
    try {
      if (!["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].includes(c.req.method))
        return c.json({ code: "code_request_method" }, 405);
      if (Buffer.byteLength(c.req.url) > CODE_REQUEST_LIMITS.urlBytes) return c.json({ code: "code_request_size_limit" }, 413);
      const version = await waitCodeRequest(deps.version(codeId), signal);
      const path = new URL(c.req.url).pathname.slice(`/code/${codeId}`.length) || "/";
      const selected = version.manifest.entrypoints.find(
        (entry) => entry.kind === "route" && entry.route && matchCodeRoute(entry.route, c.req.method, path),
      );
      if (!selected?.route) return c.json({ code: "code_route_not_found" }, 404);
      const isPublic = selected.route.public;
      const actor = c.get("actor");
      const subject = c.get("accessSubject");
      // Interactive pages require a signed-in person. Workload credentials never impersonate a visitor.
      if (
        !isPublic &&
        (c.get("credentialKind") !== "session" || actor?.kind !== "user" || subject?.type !== "user" || subject.userId !== actor.user.id)
      )
        return c.json({ code: "code_sign_in_required" }, 401);
      if (isPublic) {
        const limiter = ratelimit({ id: "code-public-requests", windowSecs: 60, limit: CODE_REQUEST_LIMITS.publicPerMinute });
        if (
          (await waitCodeRequest(limiter.check(`ip:${clientIpBucket(clientIp(c))}`), signal)).limited ||
          (await waitCodeRequest(limiter.check(`code:${codeId}`), signal)).limited
        ) {
          c.header("Retry-After", "60");
          return c.json({ code: "code_request_rate_limit" }, 429);
        }
      }
      const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim() ?? "text/plain";
      if (!["text/plain", "application/json", "application/x-www-form-urlencoded"].includes(contentType))
        return c.json({ code: "code_request_content_type" }, 415);
      let body = await readCodeRequestBody(
        c.req.raw,
        isPublic ? CODE_REQUEST_LIMITS.publicBodyBytes : CODE_REQUEST_LIMITS.bodyBytes,
        signal,
      );
      const sessionBinding = c.get("credentialKind") === "session" ? c.get("sessionToken") : undefined;
      let binding = sessionBinding ?? getCookie(c, anonymousCookie);
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
      if (mutating && !checkCodeCsrf(binding, codeId, received)) return c.json({ code: "code_csrf_required" }, 403);
      if (!binding) {
        binding = randomBytes(32).toString("hex");
        setCookie(c, anonymousCookie, binding, { httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
      }
      c.header("X-Code-CSRF", codeCsrf(binding, codeId));
      const user =
        !isPublic && actor?.kind === "user" && subject?.type === "user"
          ? {
              id: actor.user.id,
              groups: (await waitCodeRequest(getEffectiveGroups({ userId: subject.userId }), signal)).map((group) => group.id),
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
      if (signal.aborted) return c.json({ code: "code_request_timeout" }, 504);
      if (error instanceof CodeRequestError) return c.json({ code: error.code }, error.status);
      return c.json({ code: "code_request_failed" }, 503);
    }
  });
  return router;
}
