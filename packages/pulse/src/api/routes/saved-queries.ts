import { type AuthContext, jsonResponse, respond, respondMessage, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { pulseService } from "../../service";
import { projectSavedQueries } from "../../service/public-resources";
import { CreateSavedQuerySchema, SavedQuerySchema } from "../schemas";
import { projectResult, requestAccessScope, requireBaseResourceParam, requirePublicIdParam } from "../shared";

const routes = new Hono<AuthContext>()
  .get(
    "/bases/:baseId/saved-queries",
    describeRoute({
      tags: ["Pulse"],
      summary: "List saved Pulse queries",
      responses: { 200: jsonResponse(z.array(SavedQuerySchema), "Saved Pulse queries") },
    }),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(c, projectResult(pulseService.savedQuery.list(baseId.value, requestAccessScope(c)), projectSavedQueries));
    },
  )
  .post(
    "/bases/:baseId/saved-queries",
    describeRoute({
      tags: ["Pulse"],
      summary: "Save a Pulse query",
      responses: { 201: jsonResponse(SavedQuerySchema, "Saved Pulse query") },
    }),
    v("json", CreateSavedQuerySchema),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(
        c,
        projectResult(
          pulseService.savedQuery.create({ baseId: baseId.value, user: requestAccessScope(c), ...c.req.valid("json") }),
          (item) => projectSavedQueries([item]).then(([value]) => value!),
        ),
      );
    },
  )
  .delete("/bases/:baseId/saved-queries/:queryId", async (c) => {
    const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
    if (!baseId.ok) return respond(c, baseId.result);
    const queryId = await requireBaseResourceParam(c.req.param("queryId"), "saved query ID", "saved_queries", baseId.value);
    if (!queryId.ok) return respond(c, queryId.result);
    return respondMessage(
      c,
      pulseService.savedQuery.remove({ baseId: baseId.value, queryId: queryId.value, user: requestAccessScope(c) }),
      "Query removed",
    );
  });

export default routes;
