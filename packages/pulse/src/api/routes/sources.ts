import { type AuthContext, auth, getLocale, jsonResponse, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { pulseService } from "../../service";
import { projectPublicRelations, projectSources } from "../../service/public-resources";
import {
  CreateSourceApiKeySchema,
  CreateSourceSchema,
  SourceApiKeySchema,
  SourceSchema,
  SourceScrapeSchema,
  UpdateSourceSchema,
} from "../schemas";
import {
  projectResult,
  requestAccessScope,
  requireBaseResourceParam,
  requirePublicIdParam,
  requireUserBackedActor,
  requireUuidParam,
} from "../shared";
import { localizedScrapeResult } from "../source-errors";

const sourceInputErrorResponse = jsonResponse(
  z.object({ code: z.string(), message: z.string() }),
  "Invalid input, including PULSE_SCRAPE_TARGET_BLOCKED for a disallowed internal target",
);

const routes = new Hono<AuthContext>()
  .get(
    "/bases/:baseId/sources",
    describeRoute({
      tags: ["Pulse"],
      summary: "List Pulse sources for a base",
      responses: { 200: jsonResponse(z.array(SourceSchema), "Pulse sources") },
    }),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(
        c,
        projectResult(pulseService.source.list(baseId.value, requestAccessScope(c)), (items) => projectSources(items)),
      );
    },
  )
  .post(
    "/bases/:baseId/sources",
    describeRoute({
      tags: ["Pulse"],
      summary: "Create a Pulse source",
      responses: { 201: jsonResponse(SourceSchema, "Created Pulse source"), 400: sourceInputErrorResponse },
    }),
    v("json", CreateSourceSchema),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      return respond(
        c,
        localizedScrapeResult(
          projectResult(pulseService.source.create({ baseId: baseId.value, user: requestAccessScope(c), ...c.req.valid("json") }), (item) =>
            projectSources([item]).then(([value]) => value!),
          ),
          getLocale(c),
        ),
        201,
      );
    },
  )
  .post(
    "/bases/:baseId/sources/:sourceId/scrape",
    describeRoute({
      tags: ["Pulse"],
      summary: "Scrape a Pulse metrics source",
      responses: {
        200: jsonResponse(z.object({ metrics: z.number(), events: z.number(), states: z.number() }), "Scraped sample counts"),
        400: sourceInputErrorResponse,
      },
    }),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      const sourceId = await requireBaseResourceParam(c.req.param("sourceId"), "source ID", "sources", baseId.value);
      if (!sourceId.ok) return respond(c, sourceId.result);
      return respond(
        c,
        localizedScrapeResult(
          pulseService.source.scrape({ baseId: baseId.value, sourceId: sourceId.value, user: requestAccessScope(c) }),
          getLocale(c),
        ),
      );
    },
  )
  .get(
    "/bases/:baseId/sources/:sourceId/scrapes",
    describeRoute({
      tags: ["Pulse"],
      summary: "List recent Pulse source scrape attempts",
      responses: { 200: jsonResponse(z.array(SourceScrapeSchema), "Recent source scrape attempts") },
    }),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      const sourceId = await requireBaseResourceParam(c.req.param("sourceId"), "source ID", "sources", baseId.value);
      if (!sourceId.ok) return respond(c, sourceId.result);
      return respond(
        c,
        projectResult(
          pulseService.source.scrapes({ baseId: baseId.value, sourceId: sourceId.value, user: requestAccessScope(c) }),
          projectPublicRelations,
        ),
      );
    },
  )
  .get(
    "/bases/:baseId/sources/:sourceId/api-keys",
    describeRoute({
      tags: ["Pulse"],
      summary: "List Pulse HTTP ingest source API keys",
      responses: { 200: jsonResponse(z.array(SourceApiKeySchema), "Pulse source API keys") },
    }),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      const sourceId = await requireBaseResourceParam(c.req.param("sourceId"), "source ID", "sources", baseId.value);
      if (!sourceId.ok) return respond(c, sourceId.result);
      return respond(c, pulseService.source.apiKeys.list({ baseId: baseId.value, sourceId: sourceId.value, user: user.data }));
    },
  )
  .post(
    "/bases/:baseId/sources/:sourceId/api-keys",
    // A resource API key outlives the phone: the mobile app cannot create one.
    auth.rejectAppSession,
    describeRoute({
      tags: ["Pulse"],
      summary: "Create a Pulse HTTP ingest source API key",
      responses: { 201: jsonResponse(z.object({ credential: SourceApiKeySchema, token: z.string() }), "Created source API key") },
    }),
    v("json", CreateSourceApiKeySchema),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      const sourceId = await requireBaseResourceParam(c.req.param("sourceId"), "source ID", "sources", baseId.value);
      if (!sourceId.ok) return respond(c, sourceId.result);
      return respond(
        c,
        pulseService.source.apiKeys.create({
          baseId: baseId.value,
          sourceId: sourceId.value,
          user: user.data,
          ...c.req.valid("json"),
        }),
        201,
      );
    },
  )
  .delete("/bases/:baseId/sources/:sourceId/api-keys/:credentialId", async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
    if (!baseId.ok) return respond(c, baseId.result);
    const sourceId = await requireBaseResourceParam(c.req.param("sourceId"), "source ID", "sources", baseId.value);
    if (!sourceId.ok) return respond(c, sourceId.result);
    const credentialId = requireUuidParam(c.req.param("credentialId"), "API key ID");
    if (!credentialId.ok) return respond(c, credentialId.result);
    return respond(
      c,
      pulseService.source.apiKeys.remove({
        baseId: baseId.value,
        sourceId: sourceId.value,
        credentialId: credentialId.value,
        user: user.data,
      }),
    );
  })
  .patch(
    "/bases/:baseId/sources/:sourceId",
    describeRoute({
      tags: ["Pulse"],
      summary: "Update a Pulse source",
      responses: { 200: jsonResponse(SourceSchema, "Updated Pulse source"), 400: sourceInputErrorResponse },
    }),
    v("json", UpdateSourceSchema),
    async (c) => {
      const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
      if (!baseId.ok) return respond(c, baseId.result);
      const sourceId = await requireBaseResourceParam(c.req.param("sourceId"), "source ID", "sources", baseId.value);
      if (!sourceId.ok) return respond(c, sourceId.result);
      return respond(
        c,
        localizedScrapeResult(
          projectResult(
            pulseService.source.update({
              baseId: baseId.value,
              sourceId: sourceId.value,
              user: requestAccessScope(c),
              ...c.req.valid("json"),
            }),
            (item) => projectSources([item]).then(([value]) => value!),
          ),
          getLocale(c),
        ),
      );
    },
  )
  .delete("/bases/:baseId/sources/:sourceId", async (c) => {
    const baseId = await requirePublicIdParam(c.req.param("baseId"), "base ID", "bases");
    if (!baseId.ok) return respond(c, baseId.result);
    const sourceId = await requireBaseResourceParam(c.req.param("sourceId"), "source ID", "sources", baseId.value);
    if (!sourceId.ok) return respond(c, sourceId.result);
    return respond(c, pulseService.source.remove({ baseId: baseId.value, sourceId: sourceId.value, user: requestAccessScope(c) }));
  });

export default routes;
