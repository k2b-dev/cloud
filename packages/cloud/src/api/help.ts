import { Hono, type MiddlewareHandler } from "hono";
import { type AuthContext, auth, getLocale } from "../server";
import { createHelpReader, type HelpReaderFactory } from "../services/help";
import type { HelpDocumentPayload, HelpSearchPayload } from "../shared/help";
import { renderHelpMarkdown } from "../shared/markdown";
import { helpApiMessages } from "./help-messages";

export type HelpRouteDependencies = {
  help?: HelpReaderFactory;
  authenticate?: MiddlewareHandler<AuthContext>;
  renderMarkdown?: (markdown: string) => string;
};

export const createHelpRoutes = (dependencies: HelpRouteDependencies = {}) => {
  const reader = dependencies.help ?? createHelpReader;
  return new Hono<AuthContext>()
    .use(dependencies.authenticate ?? auth.requireRole("*"))
    .get("/help/v1/:appId/search", async (c) => {
      const locale = getLocale(c);
      const query = c.req.query("q")?.trim().slice(0, 200) ?? "";
      const payload: HelpSearchPayload = {
        locale,
        ids: (await reader(locale).search({ query, appId: c.req.param("appId"), limit: 25 })).map((document) => document.documentId),
      };
      return c.json(payload);
    })
    .get("/help/v1/:appId/documents/:documentId", async (c) => {
      const locale = getLocale(c);
      const { t } = helpApiMessages.resolve([locale]);
      const document = await reader(locale).read({ appId: c.req.param("appId"), documentId: c.req.param("documentId") });
      if (!document) return c.json({ code: "HELP_NOT_FOUND", message: t.notFound }, 404);
      const payload: HelpDocumentPayload = {
        locale: document.locale,
        id: document.documentId,
        title: document.title,
        markdown: document.markdown,
        html: (dependencies.renderMarkdown ?? renderHelpMarkdown)(document.markdown),
      };
      return c.json(payload);
    });
};
export type HelpApiType = ReturnType<typeof createHelpRoutes>;
