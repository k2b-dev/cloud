import { type AuthContext, auth, getLocale, rateLimit } from "@k2b/cloud/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { pdfResponse } from "../api/download-response";
import { ssr } from "../config";
import { gridsService } from "../service";
import documentTemplatePage from "./[baseId]/document/[documentTableId]/[documentTemplateId]/page";
import documentsPage from "./[baseId]/documents/page";
import baseDetailPage from "./[baseId]/page";
import queryWorkspacePage from "./[baseId]/query/page";
import queryReferencePage from "./[baseId]/query-reference/page";
import formulaReferencePage from "./[baseId]/table/[tableId]/formula-reference/page";
import tableRecordsPage from "./[baseId]/table/[tableId]/page";
import viewRecordsPage from "./[baseId]/table/[tableId]/view/[viewId]/page";
import adminPage from "./admin";
import customAppPage from "./custom-app/page";
import { resolveGridsMessages } from "./messages";
import indexPage from "./page";
import publicDocumentPage from "./public/documents/[token]/page";
import publicFormPage from "./public/forms/[token]/page";
import recordEventFailuresPage from "./record-event-failures";

/** Admin pages mounted at `/admin/grids` — platform-admin only. */
export const adminRoutes = new Hono<AuthContext>()
  .get("/", auth.requireRole("admin", ssr.access), ...adminPage)
  .get("/:baseId/record-event-failures", auth.requireRole("admin", ssr.access), ...recordEventFailuresPage);

const auditRequestContext = (c: Context<AuthContext>) => ({
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || null,
  userAgent: c.req.header("user-agent") ?? null,
});

/** Public pages mounted at `/share/grids` — anonymous-friendly. */
export const publicRoutes = new Hono<AuthContext>()
  .get("/forms/:token", auth.requireRole("*"), ...publicFormPage)
  .get("/documents/:token/download", rateLimit({ keyBy: "ip", limitPerSecond: 10, windowSecs: 60 }), auth.requireRole("*"), async (c) => {
    const { t } = resolveGridsMessages(getLocale(c));
    const requestAudit = auditRequestContext(c);
    const resolved = await gridsService.document.resolveDocumentLinkDownload(c.req.param("token") ?? "");
    if (!resolved.ok) return c.json({ message: t.documentLinkNotFound }, 404);
    const pdf = await gridsService.document.getPdf(resolved.data.document);
    if (!pdf.ok) return c.json({ message: pdf.error.message }, pdf.error.status);
    const access = await gridsService.document.recordDocumentLinkAccess(resolved.data.link.id, requestAudit);
    if (!access.ok) return c.json({ message: t.documentLinkNotFound }, 404);
    return pdfResponse(pdf.data.pdf, resolved.data.document.filename, {
      "X-Grids-Document-Id": resolved.data.document.shortId,
      "X-Grids-Document-Link-Id": resolved.data.link.shortId,
      "X-Grids-Document-Artifact": "stored",
    });
  })
  .get("/documents/:token", rateLimit({ keyBy: "ip", limitPerSecond: 10, windowSecs: 60 }), auth.requireRole("*"), ...publicDocumentPage);

/** Standalone published Apps mounted at `/apps`. */
export const customAppRoutes = new Hono<AuthContext>()
  .get("/:shortId/:pageId", auth.requireRole("*"), ...customAppPage)
  .get("/:shortId", auth.requireRole("*"), ...customAppPage);

/**
 * Default export = user-facing app pages mounted at `/app/grids`.
 *
 * URL shape (path-based, mirrors notebooks). Routes are registered in
 * specificity order so Hono's matcher tries the longest path first:
 *
 *   /:base/table/:table/view/:view       → records page scoped to view
 *   /:base/table/:table                  → table records page
 *   /:base/document/:table/:template     → document template workspace
 *   /:base/reference/...                 → reference window
 *   /:base/query                         → GQL query explorer
 *   /:base/workflows[/workflow]          → workflow overview/detail
 *   /:base                               → workspace shell/default redirect
 */
export default new Hono<AuthContext>()
  .get("/", auth.requireRole("user", ssr.access), ...indexPage)
  // Old edit URLs redirect to the canonical in-context edit mode.
  .get("/:baseId/table/:tableId/view/:viewId/edit", auth.requireRole("user", ssr.access), (c) =>
    c.redirect(`/app/grids/${c.req.param("baseId")}/table/${c.req.param("tableId")}/view/${c.req.param("viewId")}?edit=true`, 302),
  )
  .get("/:baseId/table/:tableId/edit", auth.requireRole("user", ssr.access), (c) =>
    c.redirect(`/app/grids/${c.req.param("baseId")}/table/${c.req.param("tableId")}?edit=true`, 302),
  )
  // View paths.
  .get("/:baseId/table/:tableId/view/:viewId/query", auth.requireRole("user", ssr.access), ...baseDetailPage)
  .get("/:baseId/table/:tableId/view/:viewId", auth.requireRole("user", ssr.access), ...viewRecordsPage)
  .get("/:baseId/table/:tableId/formula-reference", auth.requireRole("user", ssr.access), ...formulaReferencePage)
  // Table paths.
  .get("/:baseId/table/:tableId/query", auth.requireRole("user", ssr.access), ...baseDetailPage)
  .get("/:baseId/table/:tableId", auth.requireRole("user", ssr.access), ...tableRecordsPage)
  // Document template paths.
  .get("/:baseId/document/:documentTableId/:documentTemplateId", auth.requireRole("user", ssr.access), ...documentTemplatePage)
  .get("/:baseId/documents", auth.requireRole("user", ssr.access), ...documentsPage)
  .get("/:baseId/reference/tables/:sourceId", auth.requireRole("user", ssr.access), ...queryReferencePage)
  .get("/:baseId/reference/:tab", auth.requireRole("user", ssr.access), ...queryReferencePage)
  .get("/:baseId/reference", auth.requireRole("user", ssr.access), ...queryReferencePage)
  .get("/:baseId/query-reference", auth.requireRole("user", ssr.access), ...queryReferencePage)
  .get("/:baseId/query", auth.requireRole("user", ssr.access), ...queryWorkspacePage)
  .get("/:baseId/apps/:customAppId", auth.requireRole("user", ssr.access), ...baseDetailPage)
  .get("/:baseId/workflows/:workflowId", auth.requireRole("user", ssr.access), ...baseDetailPage)
  .get("/:baseId/workflows", auth.requireRole("user", ssr.access), ...baseDetailPage)
  .get("/:baseId", auth.requireRole("user", ssr.access), ...baseDetailPage);
