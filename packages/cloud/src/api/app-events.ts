import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { AppDetailsSchema } from "../contracts/app-details";
import { AppEventEnvelopeSchema } from "../contracts/app-events";
import { CapabilityQualifiedIdSchema } from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import { type AuthContext, auth, expectUserBackedActor, getLocale, v } from "../server";
import { AppAccessManagementError } from "../services/app-access-management";
import { appDetails } from "../services/app-details";
import { appEventShape, appEventShapeId, recordedAppEventShape } from "../services/app-event-shapes";
import { appEventBroker } from "../services/app-events";

const App = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const Filter = z.object({
  app: App.optional(),
  state: z.enum(["pending", "retrying", "done", "failed", "cancelled"]).optional(),
  eventType: CapabilityQualifiedIdSchema.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const createAppEventRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service = appEventBroker,
  details = appDetails,
) =>
  new Hono<AuthContext>()
    .use(authenticate)
    .use((c, next) =>
      auth.requireOAuthScope(...(c.req.method === "GET" || c.req.method === "HEAD" ? ["read", "admin"] : ["admin"]))(c, next),
    )
    .get(
      "/apps/:appId",
      describeRoute({ tags: ["App events"], summary: "Inspect one application's access, events and notifications" }),
      v("param", z.object({ appId: App })),
      async (c) => {
        try {
          const result = await details(c.req.valid("param").appId, { authority: auth.getAuthority(c), locale: getLocale(c) });
          return result ? c.json(AppDetailsSchema.parse(result)) : c.json({ code: "app_not_found" }, 404);
        } catch (error) {
          if (error instanceof AppAccessManagementError) return c.json({ code: error.code, message: error.message }, error.status);
          throw error;
        }
      },
    )
    .get("/catalog", describeRoute({ tags: ["App events"], summary: "List declared event types and subscribers" }), async (c) =>
      c.json(await service.catalog(getLocale(c))),
    )
    .get(
      "/subscriptions",
      describeRoute({ tags: ["App events"], summary: "Inspect declared subscriptions and delivery counts" }),
      v("query", z.object({ app: App.optional() })),
      async (c) => c.json(await service.subscriptions(c.req.valid("query").app)),
    )
    .get("/deliveries", describeRoute({ tags: ["App events"], summary: "List app event deliveries" }), v("query", Filter), async (c) =>
      c.json(await service.deliveries(c.req.valid("query"))),
    )
    .post(
      "/deliveries/:id/redeliver",
      describeRoute({ tags: ["App events"], summary: "Retry one delivery preserving its event ID" }),
      v("param", z.object({ id: z.uuid() })),
      async (c) => {
        const user = expectUserBackedActor(c);
        const result = await service.redeliver(c.req.valid("param").id, {
          userId: user.id,
          uid: user.uid,
          provider: user.provider,
          roles: user.roles,
        });
        return result ? c.json(result) : c.json({ code: "not_redeliverable" }, 409);
      },
    )
    .post("/status/acknowledge", describeRoute({ tags: ["App events"], summary: "Acknowledge a reconciled retention gap" }), async (c) => {
      const user = expectUserBackedActor(c);
      const result = await service.acknowledgeGap({ userId: user.id, uid: user.uid, provider: user.provider, roles: user.roles });
      return result ? c.json(result) : c.json({ code: "no_gap_detected" }, 409);
    })
    .get(
      "/status",
      describeRoute({ tags: ["App events"], summary: "Read broker progress, retention gaps and rejected-event metadata" }),
      async (c) => c.json(await service.status()),
    )
    .get(
      "/record/:eventType",
      describeRoute({ tags: ["App events"], summary: "Record schema-only JSONL fixtures; no stored event values are returned" }),
      v("param", z.object({ eventType: CapabilityQualifiedIdSchema })),
      v("query", z.object({ shapeOnly: z.literal("true"), limit: z.coerce.number().int().min(1).max(100).default(10) })),
      async (c) => {
        const { eventType } = c.req.valid("param");
        const { limit } = c.req.valid("query");
        const catalog = await service.catalog();
        const rows = await sql<
          { version: number; envelope: { data: unknown } }[]
        >`SELECT version, envelope FROM events.app_events WHERE type=${eventType} AND state='accepted' ORDER BY seq DESC LIMIT ${limit}`;
        try {
          const shapes = new Map<string, { version: number; shape: ReturnType<typeof recordedAppEventShape> }>();
          for (const row of rows) {
            const shape = recordedAppEventShape(row.envelope.data);
            shapes.set(JSON.stringify([row.version, shape]), { version: row.version, shape });
          }
          const lines = [...shapes.values()].map((row) => {
            const declaration = catalog.events.find((event) => event.type === eventType && event.version === row.version);
            if (!declaration) throw new Error("shape_unavailable");
            return JSON.stringify(
              AppEventEnvelopeSchema.parse({
                id: appEventShapeId(eventType, row.version, row.shape),
                type: eventType,
                version: row.version,
                source: eventType.split(".")[0],
                time: "2000-01-01T00:00:00.000Z",
                subject: { type: declaration.subject, id: "00000000-0000-4000-8000-000000000001" },
                ...(declaration.place ? { place: { type: declaration.place, id: "00000000-0000-4000-8000-000000000001" } } : {}),
                data: appEventShape(declaration.dataSchema, 0, row.shape),
              }),
            );
          });
          return c.body(lines.length ? lines.join("\n") + "\n" : "", 200, {
            "content-type": "application/x-ndjson",
            "cache-control": "no-store",
          });
        } catch {
          return c.json({ code: "shape_unavailable", message: "A deterministic fixture cannot be generated for this declaration." }, 422);
        }
      },
    );
