import { Hono, type MiddlewareHandler } from "hono";
import { type AuthContext, auth, getLocale } from "../server";
import { buildHelpDocumentPayload } from "../server/help-payload";
import { createHelpReader, type HelpReaderFactory } from "../services/help";
import type { HelpSearchPayload } from "../shared/help";
import type { renderHelpMarkdown } from "../shared/markdown";
import { helpApiMessages } from "./help-messages";

export type HelpRouteDependencies = {
  help?: HelpReaderFactory;
  authenticate?: MiddlewareHandler<AuthContext>;
  renderMarkdown?: typeof renderHelpMarkdown;
};

export const createHelpRoutes = (dependencies: HelpRouteDependencies = {}) => {
  const reader = dependencies.help ?? createHelpReader;
  // Help is for signed-in people; the reader then hides apps the viewer may not see, like missing ones.
  // Scoped to Help's paths: Core mounts these routes at its API root, before MCP and the other APIs.
  return new Hono<AuthContext>()
    .use("/help/v1/*", dependencies.authenticate ?? auth.requireRole("authenticated"))
    .use("/help/v1/*", auth.requireOAuthScope("read", "admin"))
    .get("/help/v1/:appId/search", async (c) => {
      const locale = getLocale(c);
      const query = c.req.query("q")?.trim().slice(0, 200) ?? "";
      const payload: HelpSearchPayload = {
        locale,
        ids: (await reader(locale, c.get("actor")).search({ query, appId: c.req.param("appId"), limit: 25 })).map(
          (document) => document.documentId,
        ),
      };
      return c.json(payload);
    })
    .get("/help/v1/:appId/documents/:documentId", async (c) => {
      const locale = getLocale(c);
      const { t } = helpApiMessages.resolve([locale]);
      const document = await reader(locale, c.get("actor")).read({ appId: c.req.param("appId"), documentId: c.req.param("documentId") });
      if (!document) return c.json({ code: "HELP_NOT_FOUND", message: t.notFound }, 404);
      const payload = buildHelpDocumentPayload(document, c.req.header("User-Agent") ?? "", dependencies.renderMarkdown);
      return c.json(payload);
    });
};
export type HelpApiType = ReturnType<typeof createHelpRoutes>;
