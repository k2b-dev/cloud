import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { DslQueryAutocompleteResponseSchema } from "../contracts";
import { renderGqlAssistantContext, renderGqlAssistantSkill } from "../query-dsl/assistant-docs";
import { buildDslQueryIntelligence } from "../query-dsl/intelligence";
import { presentDslQueryCompletions } from "../query-dsl/intelligence-presentation";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { gridsService } from "../service";
import { projectPublicId, type resolvePublicId } from "../service/public-resources";
import {
  fromPublicGqlScope,
  PublicDslQueryAutocompleteBodySchema,
  PublicDslQueryCompileViewBodySchema,
  PublicDslQueryCompileViewResponseSchema,
  PublicDslQueryExecuteBodySchema,
  PublicDslQueryExecuteResponseSchema,
  PublicDslQueryPreviewBodySchema,
  PublicDslQueryPreviewResponseSchema,
  toPublicGqlResponse,
} from "./gql-public";
import {
  buildPermissionedGqlResolverContext,
  canonicalGqlSource,
  emptyDslAst,
  executeGqlSource,
  executeSavedViewSource,
  gqlDiagnosticsForLocale,
  sourceAst,
} from "./gql-runtime";
import { apiMessages } from "./messages";
import { gateAt } from "./permissions";
import { queryAdmissionMiddleware } from "./query-admission";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";

type GqlApiOptions = {
  requireAuthenticated?: MiddlewareHandler<AuthContext>;
  resolveId?: typeof resolvePublicId;
};

const markdownAttachment = (c: Context, filename: string, body: string) =>
  c.text(body, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });

export const createGqlApi = (options: GqlApiOptions = {}) =>
  new Hono<AuthContext>()
    .use(options.requireAuthenticated ?? auth.requireRole("authenticated"))
    .use("/by-base/:baseId/*", requirePublicIdParam("baseId", "base", "Base", options.resolveId))
    .use("/by-base/:baseId/views/:viewId/*", requirePublicIdParam("viewId", "view", "View", options.resolveId))
    .use("/by-base/:baseId/preview", queryAdmissionMiddleware())
    .use("/by-base/:baseId/execute", queryAdmissionMiddleware())
    .use("/by-base/:baseId/views/:viewId/execute", queryAdmissionMiddleware())
    .get(
      "/by-base/:baseId/assistant/SKILL.md",
      describeRoute({
        tags: ["Grids:GQL"],
        summary: "Download the Grids GQL assistant skill",
        responses: {
          200: { description: "Markdown skill file" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        return markdownAttachment(c, "SKILL.md", renderGqlAssistantSkill());
      },
    )
    .get(
      "/by-base/:baseId/assistant/context.md",
      describeRoute({
        tags: ["Grids:GQL"],
        summary: "Download permission-safe Grids schema context for a GQL assistant",
        responses: {
          200: { description: "Markdown schema context file" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const base = await gridsService.base.get(baseId);
        if (!base) return c.text(apiMessages(c).baseNotFound, 404);
        const ctx = await buildPermissionedGqlResolverContext(c, base.id, undefined, undefined, emptyDslAst(), {
          loadViews: true,
          loadAllFields: true,
        });

        return markdownAttachment(
          c,
          "context.md",
          renderGqlAssistantContext({
            base,
            ctx,
            generatedAt: new Date().toISOString(),
          }),
        );
      },
    )
    .post(
      "/by-base/:baseId/preview",
      describeRoute({
        tags: ["Grids:GQL"],
        summary: "Parse and preview a GQL statement",
        responses: {
          200: jsonResponse(PublicDslQueryPreviewResponseSchema, "Query diagnostics or tabular preview"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          503: jsonResponse(ErrorResponseSchema, "Query capacity exhausted"),
        },
      }),
      v("json", PublicDslQueryPreviewBodySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const body = c.req.valid("json");
        const scope = await fromPublicGqlScope(baseId, body, { locale: getLocale(c) });
        if (!scope.ok) return c.json({ message: scope.error.message }, scope.error.status);
        const result = await executeGqlSource(
          c,
          baseId,
          { ...body, ...scope.data, surface: body.surface ?? "query-explorer" },
          { operation: "preview" },
        );
        return c.json(await toPublicGqlResponse(result.response));
      },
    )
    .post(
      "/by-base/:baseId/execute",
      describeRoute({
        tags: ["Grids:GQL"],
        summary: "Execute a GQL statement for records/table surfaces",
        responses: {
          200: jsonResponse(PublicDslQueryExecuteResponseSchema, "Query diagnostics or tabular result"),
          503: jsonResponse(ErrorResponseSchema, "Query capacity exhausted"),
        },
      }),
      v("json", PublicDslQueryExecuteBodySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const body = c.req.valid("json");
        const scope = await fromPublicGqlScope(baseId, body, { locale: getLocale(c) });
        if (!scope.ok) return c.json({ message: scope.error.message }, scope.error.status);
        const result = await executeGqlSource(c, baseId, { ...body, ...scope.data }, { maxRows: 10_000, operation: "execute" });
        return c.json(await toPublicGqlResponse(result.response));
      },
    )
    .post(
      "/by-base/:baseId/views/:viewId/execute",
      describeRoute({
        tags: ["Grids:GQL"],
        summary: "Execute the exact stored GQL source for one saved view",
        responses: {
          200: jsonResponse(PublicDslQueryExecuteResponseSchema, "Query diagnostics or tabular result"),
          503: jsonResponse(ErrorResponseSchema, "Query capacity exhausted"),
        },
      }),
      v("json", PublicDslQueryExecuteBodySchema.pick({ pageSize: true, cursor: true, surface: true })),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const body = c.req.valid("json");
        const response = await executeSavedViewSource(c, baseId, internalIdParam(c, "viewId")!, {
          maxRows: 10_000,
          pageSize: body.pageSize,
          cursor: body.cursor,
          surface: body.surface ?? "api",
        });
        return c.json(await toPublicGqlResponse(response));
      },
    )
    .post(
      "/by-base/:baseId/autocomplete",
      describeRoute({
        tags: ["Grids:GQL"],
        summary: "Return permission-safe GQL autocomplete items and diagnostics",
        responses: {
          200: jsonResponse(DslQueryAutocompleteResponseSchema, "GQL autocomplete items and diagnostics"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDslQueryAutocompleteBodySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const publicBody = c.req.valid("json");
        const scope = await fromPublicGqlScope(baseId, publicBody, { locale: getLocale(c) });
        if (!scope.ok) return c.json({ message: scope.error.message }, scope.error.status);
        const body = { ...publicBody, ...scope.data };
        const parsed = parseGridsQueryDsl(body.query);
        const seedAst = parsed.ok ? parsed.ast : emptyDslAst();
        const ctx = await buildPermissionedGqlResolverContext(c, baseId, body.currentTableId, body.currentSource, seedAst, {
          loadViews: true,
          loadAllFields: true,
        });

        const diagnostics = parsed.ok
          ? (() => {
              const ast = sourceAst(parsed.ast, body.currentSource, ctx);
              const resolved = resolveDslQueryToQueryPlan(ast, ctx);
              return resolved.ok ? [] : gqlDiagnosticsForLocale(resolved.diagnostics, getLocale(c), "gql.resolution");
            })()
          : gqlDiagnosticsForLocale(parsed.diagnostics, getLocale(c), "gql.syntax");
        const items = presentDslQueryCompletions(
          buildDslQueryIntelligence({
            query: body.query,
            caret: body.caret ?? body.query.length,
            ctx,
            ...(body.currentSource ? { currentSource: body.currentSource } : {}),
            ...(body.contextKeys ? { contextKeys: body.contextKeys } : {}),
          }),
          getLocale(c),
        );

        return c.json({ ok: true as const, diagnostics, items });
      },
    )
    .post(
      "/by-base/:baseId/compile-view",
      describeRoute({
        tags: ["Grids:GQL"],
        summary: "Compile and canonicalize a GQL statement for a saved view",
        responses: {
          200: jsonResponse(PublicDslQueryCompileViewResponseSchema, "Canonical View source or diagnostics"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDslQueryCompileViewBodySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const publicBody = c.req.valid("json");
        const scope = await fromPublicGqlScope(baseId, publicBody, { locale: getLocale(c) });
        if (!scope.ok) return c.json({ message: scope.error.message }, scope.error.status);
        const body = { ...publicBody, ...scope.data };
        const canonical = await canonicalGqlSource(c, baseId, body);
        if (!canonical.ok) return c.json({ ok: false, diagnostics: canonical.diagnostics });

        const tableId = await projectPublicId("table", canonical.tableId);
        if (!tableId) return c.json({ message: apiMessages(c).missingPublicTableId }, 500);
        return c.json({ ok: true, tableId, source: canonical.source });
      },
    );

const app = createGqlApi();
export default app;
