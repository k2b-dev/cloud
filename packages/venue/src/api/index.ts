import type { WidgetResponse } from "@k2b/cloud/contracts";
import {
  AccessEntrySchema,
  ErrorResponseSchema,
  GrantAccessSchema,
  MessageResponseSchema,
  type PermissionLevel,
  ServiceAccountCredentialSchema,
  UpdateAccessSchema,
} from "@k2b/cloud/contracts";
import {
  type AuthContext,
  auth,
  err,
  fail,
  getLocale,
  jsonResponse,
  ok,
  type Result,
  rateLimit,
  respond,
  respondMessage,
  v,
} from "@k2b/cloud/server";
import { coreSettings, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { venueAccessScopeFor } from "../access-control";
import {
  DateOverrideInputSchema,
  FeedbackEntrySchema,
  FeedbackInputSchema,
  FreeSignupInputSchema,
  OpeningRuleInputSchema,
  PublicSectionInputSchema,
  PublicStatusSchema,
  ShiftAssignmentSchema,
  ShiftTemplateInputSchema,
  TemplateSignupInputSchema,
  UpcomingSlotSchema,
  VenueDashboardQuerySchema,
  VenueDashboardSchema,
  VenueInputSchema,
  VenueResourceIdSchema,
  VenueSchema,
  VenueTemplateCreateInputSchema,
  VenueTemplateSummarySchema,
} from "../contracts";
import { venueMessages } from "../messages";
import { venueService } from "../service";

const VenueIdParamSchema = z.object({ id: VenueResourceIdSchema });
const AccessParamSchema = z.object({ id: VenueResourceIdSchema, accessId: z.string().uuid() });
const ApiKeyParamSchema = z.object({ id: VenueResourceIdSchema, credentialId: z.string().uuid() });
const ResourceParamSchema = z.object({ id: VenueResourceIdSchema, resourceId: VenueResourceIdSchema });
const TemplateParamSchema = z.object({ id: VenueResourceIdSchema, templateId: VenueResourceIdSchema });
const AssignmentParamSchema = z.object({ id: VenueResourceIdSchema, assignmentId: VenueResourceIdSchema });
const PublicVenueParamSchema = z.object({ id: VenueResourceIdSchema });
const TokenParamSchema = z.object({ token: z.string().min(16).max(128) });
const VenueTemplateParamSchema = z.object({ templateId: z.string().min(1).max(80) });
const TemplateWeeksInputSchema = TemplateSignupInputSchema.extend({ weeks: z.number().int().min(1).max(12).default(4) });
const VenueApiKeySchema = ServiceAccountCredentialSchema.extend({
  permission: z.enum(["none", "read", "write", "admin"]),
});
const CreateVenueApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
  permission: z.enum(["read", "write", "admin"]).default("read"),
});
const CreateVenueApiKeyResponseSchema = z.object({
  credential: VenueApiKeySchema,
  token: z.string(),
});
const VenueSettingsContextSchema = VenueDashboardSchema.pick({
  venue: true,
  openingRules: true,
  overrides: true,
  templates: true,
}).extend({
  accessEntries: z.array(AccessEntrySchema),
  apiKeys: z.array(VenueApiKeySchema),
});

type VenueApiKey = z.infer<typeof VenueApiKeySchema>;
type UserBackedActor = AuthContext["Variables"]["user"];

const VENUE_APP_ID = "venue";
const VENUE_RESOURCE_TYPE = "venue";

const getUserBackedActor = (c: Context<AuthContext>): UserBackedActor | null => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

const requireUserBackedActor = (c: Context<AuthContext>) => {
  const user = getUserBackedActor(c);
  if (!user) return fail(err.forbidden("Venues require a user-backed actor for this action"));
  return ok(user);
};

const getVenueAccessSubject = (c: Context<AuthContext>, venueId?: string) => {
  const scope = venueAccessScopeFor(c.get("actor"), c.get("accessSubject"));
  if (!scope.ok || !venueId || !scope.data.serviceAccountResourceId || scope.data.serviceAccountResourceId === venueId) return scope;
  return fail(err.forbidden("Access denied"));
};

const requireVenue = async (c: Context<AuthContext>, id: string, permission: PermissionLevel) => {
  const internalId = await venueService.publicResources.resolve("venues", id);
  if (!internalId) return fail(err.notFound("Venue"));
  const subject = getVenueAccessSubject(c, internalId);
  if (!subject.ok) return subject;
  const venue = await venueService.venues.get(internalId, subject.data);
  if (!venue) return fail(err.notFound("Venue"));
  const allowed = await venueService.access.require(id, subject.data, permission);
  if (!allowed.ok) return allowed;
  return ok(venue);
};

const resolveOwned = async (
  table: "openingRules" | "overrides" | "templates" | "assignments" | "sections",
  venueId: string,
  id: string,
) => {
  const internalId = await venueService.publicResources.resolveOwned(table, venueId, id);
  return internalId ? ok(internalId) : fail(err.notFound("Venue resource"));
};

const projectResult = async <T, U>(result: Result<T>, project: (value: T) => Promise<U>): Promise<Result<U>> =>
  result.ok ? ok(await project(result.data)) : result;

const readVenue = async (c: Context<AuthContext>, id: string) => requireVenue(c, id, "read");
const writeVenue = async (c: Context<AuthContext>, id: string) => requireVenue(c, id, "write");
const adminVenue = async (c: Context<AuthContext>, id: string) => requireVenue(c, id, "admin");

const listVenueApiKeys = async (venueId: string): Promise<VenueApiKey[]> => {
  const [keys, accessEntries] = await Promise.all([
    serviceAccountCredentials.listOverview({
      pagination: { page: 1, perPage: 500 },
      filter: {
        serviceAccountKind: "resource_bound",
        credentialStatus: "active",
        appId: VENUE_APP_ID,
        resourceType: VENUE_RESOURCE_TYPE,
        resourceId: venueId,
      },
    }),
    venueService.access.list(venueId),
  ]);

  const permissionByServiceAccountId = new Map(
    accessEntries
      .filter((entry) => entry.principal.type === "service_account")
      .map((entry) => [(entry.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId, entry.permission]),
  );

  return keys.items.map((item) => {
    const permission = permissionByServiceAccountId.get(item.serviceAccount.id) ?? "none";
    const { serviceAccount: _serviceAccount, owner: _owner, ...credential } = item;
    return { ...credential, permission };
  });
};

const root = new Hono<AuthContext>();
// biome-ignore format: check-service-api-contracts requires a leading `.use(...)` line before route handlers.
root
  .use(rateLimit());

export const venueTodayWidgetHandler = async (c: Context<AuthContext>) => {
  const { locale, t } = venueMessages.resolve([getLocale(c)]);
  const userResult = requireUserBackedActor(c);
  if (!userResult.ok) return c.body(null, 403);
  const user = userResult.data;
  const venues = await venueService.venues.list(user);
  const venue = venues[0];
  if (!venue) return c.body(null, 204);

  const dashboard = await venueService.dashboard(venue, user);
  const [publicVenue] = await venueService.publicResources.projectVenues([venue]);
  const status = await venueService.publicStatus(publicVenue!.id, new Date(), getLocale(c));
  const nextShift = dashboard.myUpcomingShifts[0];
  const missing = dashboard.slots.reduce((sum, slot) => sum + slot.missingPeople, 0);

  const response: WidgetResponse = {
    title: venue.name,
    icon: venue.icon || "ti ti-building-carousel",
    href: `/app/venue/${publicVenue!.id}`,
    meta: status?.statusLabel ?? t.widgetVenue,
    blocks: [
      {
        kind: "status",
        tone: status?.open ? "ok" : "info",
        title: status?.statusLabel ?? t.widgetStatusUnavailable,
        message: status?.todayLabel ?? t.widgetNoStatus,
        icon: status?.open ? "ti ti-door-gate-open" : "ti ti-door",
      },
      {
        kind: "stat",
        label: t.widgetOpenRegistrations,
        value: missing,
        sub: t.widgetRegistrationNeeded({ count: missing }),
        accent: missing > 0 ? { tone: "amber", icon: "ti ti-user-plus" } : { tone: "emerald", icon: "ti ti-check" },
      },
      nextShift
        ? {
            kind: "list",
            items: [
              {
                icon: "ti ti-calendar-event",
                label: t.widgetNextShift,
                sub: new Date(nextShift.startsAt).toLocaleString(locale),
                href: `/app/venue/${publicVenue!.id}`,
              },
            ],
          }
        : { kind: "placeholder", title: t.widgetNoUpcoming, icon: "ti ti-calendar-off" },
    ],
  };
  return respond(c, ok(response));
};

const widgetRoutes = new Hono<AuthContext>().get("/today", auth.requireRole("authenticated"), venueTodayWidgetHandler);

const calendarRoutes = new Hono<AuthContext>()
  .get("/my", auth.requireRole("authenticated"), async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    const token = await venueService.ical.getOrCreateToken(user.data.id);
    const appUrl = await coreSettings.get<string>("app.url");
    return respond(c, ok({ href: `${appUrl}/api/venue/calendar/${token}.ics` }));
  })
  .get("/:token", v("param", TokenParamSchema), async (c) => {
    const raw = c.req.valid("param").token;
    const token = raw.endsWith(".ics") ? raw.slice(0, -4) : raw;
    const userId = await venueService.ical.getUserIdByToken(token);
    if (!userId) return respond(c, fail(err.notFound("Calendar")));
    const content = await venueService.ical.generateUser(userId, await coreSettings.get<string>("app.url"));
    return c.text(content, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="venue-shifts.ics"',
    });
  });

const venueTemplateRoutes = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .get(
    "/",
    describeRoute({
      tags: ["Venues:Templates"],
      summary: "List built-in venue templates",
      responses: { 200: jsonResponse(z.array(VenueTemplateSummarySchema), "Templates") },
    }),
    (c) => respond(c, ok(venueService.venueTemplates.list(getLocale(c)))),
  )
  .post(
    "/:templateId",
    describeRoute({
      tags: ["Venues:Templates"],
      summary: "Create a venue from a built-in template",
      responses: {
        201: jsonResponse(VenueSchema, "Created venue"),
        400: jsonResponse(ErrorResponseSchema, "Invalid template"),
        404: jsonResponse(ErrorResponseSchema, "Template not found"),
      },
    }),
    v("param", VenueTemplateParamSchema),
    v("json", VenueTemplateCreateInputSchema),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const created = await venueService.venueTemplates.instantiate(
        c.req.valid("param").templateId,
        c.req.valid("json"),
        user.data,
        getLocale(c),
      );
      return respond(
        c,
        await projectResult(created, async (venue) => (await venueService.publicResources.projectVenues([venue]))[0]!),
        201,
      );
    },
  );

const publicRoutes = new Hono<AuthContext>()
  .get(
    "/:id/status",
    describeRoute({
      tags: ["Public"],
      summary: "Get public venue status",
      responses: {
        200: jsonResponse(PublicStatusSchema, "Public venue status"),
        404: jsonResponse(ErrorResponseSchema, "Venue not found"),
      },
    }),
    v("param", PublicVenueParamSchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const status = await venueService.publicStatus(c.req.valid("param").id, new Date(), getLocale(c));
      return status
        ? respond(c, ok(await venueService.publicResources.projectPublicStatus(status)))
        : respond(c, fail(err.notFound("Venue")));
    },
  )
  .post(
    "/:id/feedback",
    rateLimit({ limitPerSecond: 1, windowSecs: 60, keyBy: "ip" }),
    v("param", PublicVenueParamSchema),
    v("json", FeedbackInputSchema),
    async (c) => {
      const venue = await venueService.venues.getByShortId(c.req.valid("param").id);
      if (!venue || !venue.publicEnabled) return respond(c, fail(err.notFound("Venue")));
      const created = await venueService.feedback.create(venue.id, c.req.valid("json"));
      return respond(
        c,
        await projectResult(created, async (entry) => (await venueService.publicResources.projectFeedbackEntries([entry]))[0]!),
        201,
      );
    },
  );

const venueRoutes = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .get(
    "/",
    describeRoute({
      tags: ["Venues"],
      summary: "List accessible venues",
      responses: { 200: jsonResponse(z.object({ venues: z.array(VenueSchema) }), "Accessible venues") },
    }),
    async (c) => {
      const subject = getVenueAccessSubject(c);
      if (!subject.ok) return respond(c, subject);
      return respond(c, ok({ venues: await venueService.publicResources.projectVenues(await venueService.venues.list(subject.data)) }));
    },
  )
  .post(
    "/",
    describeRoute({
      tags: ["Venues"],
      summary: "Create venue",
      responses: { 201: jsonResponse(VenueSchema, "Created venue"), 400: jsonResponse(ErrorResponseSchema, "Invalid venue") },
    }),
    v("json", VenueInputSchema),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const created = await venueService.venues.create(c.req.valid("json"), user.data);
      return respond(
        c,
        await projectResult(created, async (venue) => (await venueService.publicResources.projectVenues([venue]))[0]!),
        201,
      );
    },
  )
  .get("/:id/dashboard", v("param", VenueIdParamSchema), v("query", VenueDashboardQuerySchema), async (c) => {
    const venue = await readVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    return respond(
      c,
      ok(
        await venueService.publicResources.projectDashboard(
          await venueService.dashboard(venue.data, getUserBackedActor(c), c.req.valid("query")),
        ),
      ),
    );
  })
  .get(
    "/:id/settings-context",
    describeRoute({
      tags: ["Venues"],
      summary: "Load venue settings context",
      responses: { 200: jsonResponse(VenueSettingsContextSchema, "Venue settings context") },
    }),
    v("param", VenueIdParamSchema),
    async (c) => {
      const venue = await readVenue(c, c.req.valid("param").id);
      if (!venue.ok) return respond(c, venue);
      const isAdmin = venue.data.permission === "admin";
      const [openingRules, overrides, templates, accessEntries, apiKeys] = await Promise.all([
        venueService.openingRules.list(venue.data.id),
        venueService.overrides.list(venue.data.id),
        venueService.templates.list(venue.data.id),
        isAdmin ? venueService.access.list(venue.data.id) : Promise.resolve([]),
        isAdmin ? listVenueApiKeys(venue.data.id) : Promise.resolve([]),
      ]);
      return respond(
        c,
        ok({
          venue: (await venueService.publicResources.projectVenues([venue.data]))[0]!,
          openingRules: await venueService.publicResources.projectOpeningRules(openingRules),
          overrides: await venueService.publicResources.projectOverrides(overrides),
          templates: await venueService.publicResources.projectTemplates(templates),
          accessEntries,
          apiKeys,
        }),
      );
    },
  )
  .patch("/:id", v("param", VenueIdParamSchema), v("json", VenueInputSchema), async (c) => {
    const venue = await adminVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    const updated = await venueService.venues.update(venue.data.id, c.req.valid("json"));
    return respond(c, await projectResult(updated, async (value) => (await venueService.publicResources.projectVenues([value]))[0]!));
  })
  .delete(
    "/:id",
    describeRoute({
      tags: ["Venues"],
      summary: "Delete venue",
      description: "Delete a venue and all venue-owned data. Requires admin permission.",
      responses: {
        200: jsonResponse(MessageResponseSchema, "Venue deleted"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Venue not found"),
      },
    }),
    v("param", VenueIdParamSchema),
    async (c) => {
      const venue = await adminVenue(c, c.req.valid("param").id);
      if (!venue.ok) return respond(c, venue);
      return respondMessage(c, venueService.venues.delete(venue.data.id), "Venue deleted");
    },
  )
  .get("/:id/access", v("param", VenueIdParamSchema), async (c) => {
    const venue = await adminVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    return respond(c, ok({ entries: await venueService.access.list(venue.data.id) }));
  })
  .post("/:id/access", v("param", VenueIdParamSchema), v("json", GrantAccessSchema), async (c) => {
    const venue = await adminVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    const body = c.req.valid("json");
    return respond(c, () => venueService.access.grant(venue.data.id, body.principal, body.permission), 201);
  })
  .patch("/:id/access/:accessId", v("param", AccessParamSchema), v("json", UpdateAccessSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    return respond(c, () => venueService.access.update(venue.data.id, param.accessId, c.req.valid("json").permission));
  })
  .delete("/:id/access/:accessId", v("param", AccessParamSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    return respond(c, () => venueService.access.revoke(venue.data.id, param.accessId));
  })
  .get(
    "/:id/api-keys",
    describeRoute({
      tags: ["Venues"],
      summary: "List venue API keys",
      responses: {
        200: jsonResponse(z.object({ items: z.array(VenueApiKeySchema) }), "Venue API keys"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Venue not found"),
      },
    }),
    v("param", VenueIdParamSchema),
    async (c) => {
      const venue = await adminVenue(c, c.req.valid("param").id);
      if (!venue.ok) return respond(c, venue);
      return respond(c, ok({ items: await listVenueApiKeys(venue.data.id) }));
    },
  )
  .post(
    "/:id/api-keys",
    describeRoute({
      tags: ["Venues"],
      summary: "Create venue API key",
      description: "Create a resource-bound API key for this venue. The raw token is returned once. Requires admin permission.",
      responses: {
        201: jsonResponse(CreateVenueApiKeyResponseSchema, "Venue API key created"),
        400: jsonResponse(ErrorResponseSchema, "Failed to create API key"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Venue not found"),
      },
    }),
    v("param", VenueIdParamSchema),
    v("json", CreateVenueApiKeySchema),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const venue = await adminVenue(c, c.req.valid("param").id);
      if (!venue.ok) return respond(c, venue);
      const data = c.req.valid("json");

      return respond(
        c,
        async () => {
          const serviceAccount = await serviceAccounts.createResourceBound({
            name: `${venue.data.name} API key: ${data.name}`,
            appId: VENUE_APP_ID,
            resourceType: VENUE_RESOURCE_TYPE,
            resourceId: venue.data.id,
            createdBy: user.data.id,
          });
          if (!serviceAccount.ok) return serviceAccount;

          const cleanupServiceAccount = async () => {
            await serviceAccounts.delete({ id: serviceAccount.data.id });
          };

          const access = await venueService.access.grant(
            venue.data.id,
            { type: "service_account", serviceAccountId: serviceAccount.data.id },
            data.permission,
          );
          if (!access.ok) {
            await cleanupServiceAccount();
            return access;
          }

          const created = await serviceAccountCredentials.createResourceApiToken({
            serviceAccountId: serviceAccount.data.id,
            actor: user.data,
            name: data.name,
            expiresAt: data.expiresAt ?? null,
            scopes: [data.permission],
          });
          if (!created.ok) {
            await cleanupServiceAccount();
            return created;
          }

          return ok({
            credential: {
              ...created.data.credential,
              permission: access.data.permission,
            },
            token: created.data.token,
          });
        },
        201,
      );
    },
  )
  .delete(
    "/:id/api-keys/:credentialId",
    describeRoute({
      tags: ["Venues"],
      summary: "Revoke venue API key",
      responses: {
        200: jsonResponse(MessageResponseSchema, "Venue API key revoked"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "API key not found"),
      },
    }),
    v("param", ApiKeyParamSchema),
    async (c) => {
      const user = requireUserBackedActor(c);
      if (!user.ok) return respond(c, user);
      const param = c.req.valid("param");
      const venue = await adminVenue(c, param.id);
      if (!venue.ok) return respond(c, venue);

      return respond(c, async () => {
        const keys = await listVenueApiKeys(venue.data.id);
        if (!keys.some((key) => key.id === param.credentialId)) return fail(err.notFound("API key"));
        const revoked = await serviceAccountCredentials.revoke({ credentialId: param.credentialId, actor: user.data });
        if (!revoked.ok) return revoked;
        return ok({ message: "API key revoked." });
      });
    },
  )
  .post("/:id/opening-rules", v("param", VenueIdParamSchema), v("json", OpeningRuleInputSchema), async (c) => {
    const venue = await adminVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    const created = await venueService.openingRules.create(venue.data.id, c.req.valid("json"));
    return respond(
      c,
      await projectResult(created, async (value) => (await venueService.publicResources.projectOpeningRules([value]))[0]!),
      201,
    );
  })
  .patch("/:id/opening-rules/:resourceId", v("param", ResourceParamSchema), v("json", OpeningRuleInputSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("openingRules", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    const updated = await venueService.openingRules.update(venue.data.id, resource.data, c.req.valid("json"));
    return respond(c, await projectResult(updated, async (value) => (await venueService.publicResources.projectOpeningRules([value]))[0]!));
  })
  .delete("/:id/opening-rules/:resourceId", v("param", ResourceParamSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("openingRules", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    return respond(c, () => venueService.openingRules.delete(venue.data.id, resource.data));
  })
  .post("/:id/overrides", v("param", VenueIdParamSchema), v("json", DateOverrideInputSchema), async (c) => {
    const venue = await adminVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    const saved = await venueService.overrides.upsert(venue.data.id, c.req.valid("json"));
    return respond(c, await projectResult(saved, async (value) => (await venueService.publicResources.projectOverrides([value]))[0]!), 201);
  })
  .patch("/:id/overrides/:resourceId", v("param", ResourceParamSchema), v("json", DateOverrideInputSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("overrides", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    const updated = await venueService.overrides.update(venue.data.id, resource.data, c.req.valid("json"));
    return respond(c, await projectResult(updated, async (value) => (await venueService.publicResources.projectOverrides([value]))[0]!));
  })
  .delete("/:id/overrides/:resourceId", v("param", ResourceParamSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("overrides", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    return respond(c, () => venueService.overrides.delete(venue.data.id, resource.data));
  })
  .post("/:id/templates", v("param", VenueIdParamSchema), v("json", ShiftTemplateInputSchema), async (c) => {
    const venue = await adminVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    const created = await venueService.templates.create(venue.data.id, c.req.valid("json"));
    return respond(
      c,
      await projectResult(created, async (value) => (await venueService.publicResources.projectTemplates([value]))[0]!),
      201,
    );
  })
  .patch("/:id/templates/:resourceId", v("param", ResourceParamSchema), v("json", ShiftTemplateInputSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("templates", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    const updated = await venueService.templates.update(venue.data.id, resource.data, c.req.valid("json"));
    return respond(c, await projectResult(updated, async (value) => (await venueService.publicResources.projectTemplates([value]))[0]!));
  })
  .delete("/:id/templates/:resourceId", v("param", ResourceParamSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("templates", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    return respond(c, () => venueService.templates.delete(venue.data.id, resource.data));
  })
  .post("/:id/templates/:templateId/signup", v("param", TemplateParamSchema), v("json", TemplateSignupInputSchema), async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    const param = c.req.valid("param");
    const venue = await writeVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    if (venue.data.signupMode === "free") return respond(c, fail(err.badInput("Shift signup is disabled for this venue")));
    const template = await resolveOwned("templates", venue.data.id, param.templateId);
    if (!template.ok) return respond(c, template);
    const created = await venueService.assignments.signupTemplate(venue.data, template.data, c.req.valid("json"), user.data);
    return respond(
      c,
      await projectResult(created, async (value) => (await venueService.publicResources.projectAssignments([value]))[0]!),
      201,
    );
  })
  .post("/:id/templates/:templateId/signup-weeks", v("param", TemplateParamSchema), v("json", TemplateWeeksInputSchema), async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    const param = c.req.valid("param");
    const venue = await writeVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    if (venue.data.signupMode === "free") return respond(c, fail(err.badInput("Shift signup is disabled for this venue")));
    const template = await resolveOwned("templates", venue.data.id, param.templateId);
    if (!template.ok) return respond(c, template);
    const body = c.req.valid("json");
    const created = await venueService.assignments.signupTemplateWeeks(venue.data, template.data, body.date, body.weeks, user.data);
    return respond(c, await projectResult(created, (values) => venueService.publicResources.projectAssignments(values)), 201);
  })
  .post("/:id/free-signup", v("param", VenueIdParamSchema), v("json", FreeSignupInputSchema), async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    const venue = await writeVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    if (venue.data.signupMode === "templates") return respond(c, fail(err.badInput("Free signup is disabled for this venue")));
    const created = await venueService.assignments.signupFree(venue.data.id, c.req.valid("json"), user.data);
    return respond(
      c,
      await projectResult(created, async (value) => (await venueService.publicResources.projectAssignments([value]))[0]!),
      201,
    );
  })
  .delete("/:id/assignments/:assignmentId", v("param", AssignmentParamSchema), async (c) => {
    const user = requireUserBackedActor(c);
    if (!user.ok) return respond(c, user);
    const param = c.req.valid("param");
    const venue = await readVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const assignment = await resolveOwned("assignments", venue.data.id, param.assignmentId);
    if (!assignment.ok) return respond(c, assignment);
    const canAdmin = hasAdminPermission(venue.data.permission);
    return respond(c, () => venueService.assignments.cancel(venue.data.id, assignment.data, user.data, canAdmin));
  })
  .post("/:id/sections", v("param", VenueIdParamSchema), v("json", PublicSectionInputSchema), async (c) => {
    const venue = await adminVenue(c, c.req.valid("param").id);
    if (!venue.ok) return respond(c, venue);
    const created = await venueService.sections.create(venue.data.id, c.req.valid("json"));
    return respond(
      c,
      await projectResult(created, async (value) => (await venueService.publicResources.projectSections([value]))[0]!),
      201,
    );
  })
  .patch("/:id/sections/:resourceId", v("param", ResourceParamSchema), v("json", PublicSectionInputSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("sections", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    const updated = await venueService.sections.update(venue.data.id, resource.data, c.req.valid("json"));
    return respond(c, await projectResult(updated, async (value) => (await venueService.publicResources.projectSections([value]))[0]!));
  })
  .delete("/:id/sections/:resourceId", v("param", ResourceParamSchema), async (c) => {
    const param = c.req.valid("param");
    const venue = await adminVenue(c, param.id);
    if (!venue.ok) return respond(c, venue);
    const resource = await resolveOwned("sections", venue.data.id, param.resourceId);
    if (!resource.ok) return respond(c, resource);
    return respond(c, () => venueService.sections.delete(venue.data.id, resource.data));
  });

const hasAdminPermission = (permission: PermissionLevel | undefined): boolean => permission === "admin";

const app = root
  .route("/widget", widgetRoutes)
  .route("/calendar", calendarRoutes)
  .route("/templates", venueTemplateRoutes)
  .route("/public", publicRoutes)
  .route("/venues", venueRoutes)
  .get(
    "/schema",
    describeRoute({
      tags: ["Meta"],
      summary: "Venue schemas",
      responses: {
        200: jsonResponse(
          z.object({
            venue: VenueSchema,
            dashboard: VenueDashboardSchema,
            slot: UpcomingSlotSchema,
            assignment: ShiftAssignmentSchema,
            feedback: FeedbackEntrySchema,
            access: AccessEntrySchema,
            message: MessageResponseSchema,
          }),
          "Schema references",
        ),
      },
    }),
    (c) => respond(c, ok({ message: "Venue API" })),
  );

export default app;
export type ApiType = typeof app;
