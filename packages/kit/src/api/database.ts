import { Hono } from "hono";
import { type AuthContext, getLocale, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { DatabaseCall, DatabaseSettings } from "../database-contracts";
import { database, requireAdmin } from "../service/database";
import { PublicId } from "../contracts";
import { kitService } from "../service";
const identity = (c: import("hono").Context<AuthContext>) => ({ actor: c.get("actor"), accessSubject: c.get("accessSubject") });
const invalid = (c: import("hono").Context) => ({
  code: "INVALID_INPUT",
  message: getLocale(c).startsWith("de") ? "Prüfe die Datenbank-Eingaben." : "Check the database input.",
});
export const databaseApi = new Hono<AuthContext>()
  .get("/admin/settings", describeRoute({ tags: ["Kit admin"], summary: "Read redacted rsql settings" }), async (c) =>
    respond(c, ok(await database.settings(identity(c)))),
  )
  .put("/admin/settings", v("json", DatabaseSettings, invalid), async (c) =>
    respond(c, ok(await database.configure(c.req.valid("json"), identity(c)))),
  )
  .post("/admin/settings/test", v("json", DatabaseSettings, invalid), async (c) =>
    respond(c, ok(await database.test(c.req.valid("json"), identity(c)))),
  )
  .get("/admin/projects", async (c) => {
    requireAdmin(identity(c));
    return respond(
      c,
      ok(
        await kitService.adminList(
          identity(c),
          z.coerce
            .number()
            .int()
            .min(1)
            .max(100000)
            .parse(c.req.query("page") ?? 1),
          (c.req.query("q") ?? "").slice(0, 120),
        ),
      ),
    );
  })
  .get(
    "/projects/:id/database",
    v("query", z.object({ diagnostics: z.enum(["true", "false"]).optional() }), invalid),
    describeRoute({ tags: ["Kit database"], summary: "Read database state and optional diagnostics" }),
    async (c) =>
      respond(c, ok(await database.status(PublicId.parse(c.req.param("id")), identity(c), c.req.query("diagnostics") === "true"))),
  )
  .put("/projects/:id/database", v("json", z.object({ enabled: z.boolean() }).strict(), invalid), async (c) =>
    respond(c, ok(await database.enable(PublicId.parse(c.req.param("id")), c.req.valid("json").enabled, identity(c)))),
  )
  .post("/projects/:id/database/reset", v("json", z.object({ confirm: z.literal(true) }).strict(), invalid), async (c) =>
    respond(c, ok(await database.enable(PublicId.parse(c.req.param("id")), false, identity(c), true))),
  )
  .get("/projects/:id/database/export", async (c) => {
    const id = PublicId.parse(c.req.param("id"));
    const response = await database.export(id, identity(c));
    return new Response(response.body, {
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="kit-${id}.sqlite"`,
        "Cache-Control": "private, no-store",
      },
    });
  })
  .post(
    "/projects/:id/database/call",
    describeRoute({ tags: ["Kit database"], summary: "Perform a generation-bound database operation" }),
    v("json", DatabaseCall, invalid),
    async (c) => {
      const { generation, request } = c.req.valid("json");
      return respond(c, ok(await database.call(PublicId.parse(c.req.param("id")), generation, request, identity(c), c.req.raw.signal)));
    },
  );
