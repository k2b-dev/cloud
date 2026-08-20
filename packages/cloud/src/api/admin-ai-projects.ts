import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { AiProjectLastAdminError, aiProjects } from "../ai/projects";
import { PrincipalSchema } from "../contracts/shared";
import { type AuthContext, auth, err, fail, ok, respond, v } from "../server";

const ListProjectsSchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const ProjectAccessSchema = z.object({ principal: PrincipalSchema, permission: z.enum(["read", "write", "admin"]) }).strict();
const ProjectAccessUpdateSchema = z.object({ permission: z.enum(["read", "write", "admin"]) }).strict();

const notFound = (c: Parameters<typeof respond>[0], noun: string) => respond(c, fail(err.notFound(noun)));
const lastAdminConflict = (c: Parameters<typeof respond>[0], error: AiProjectLastAdminError) =>
  respond(c, { ok: false, error: error.message, status: 409 as const });

export const createAdminAiProjectsRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .get("/", v("query", ListProjectsSchema), async (c) => {
      const query = c.req.valid("query");
      const [projects, summary] = await Promise.all([aiProjects.admin.list(query), aiProjects.admin.summary({ search: query.search })]);
      return respond(
        c,
        ok({
          ...projects,
          items: projects.items.map((project) => ({ ...project, id: project.shortId })),
          summary,
        }),
      );
    })
    .get("/:projectId/access", async (c) => {
      const project = await aiProjects.admin.getByShortId(c.req.param("projectId")!);
      return project ? respond(c, ok({ access: await aiProjects.admin.listAccess(project.id) })) : notFound(c, "Project");
    })
    .post("/:projectId/access", v("json", ProjectAccessSchema), async (c) => {
      const project = await aiProjects.admin.getByShortId(c.req.param("projectId")!);
      const access = project ? await aiProjects.admin.grantAccess(project.id, c.req.valid("json")) : null;
      return access ? respond(c, ok({ access }), 201) : notFound(c, "Project");
    })
    .patch("/:projectId/access/:accessId", v("json", ProjectAccessUpdateSchema), async (c) => {
      const project = await aiProjects.admin.getByShortId(c.req.param("projectId")!);
      if (!project) return notFound(c, "Project");
      try {
        return (await aiProjects.admin.updateAccess(project.id, c.req.param("accessId")!, c.req.valid("json").permission))
          ? respond(c, ok({ updated: true }))
          : notFound(c, "Access entry");
      } catch (error) {
        if (error instanceof AiProjectLastAdminError) return lastAdminConflict(c, error);
        throw error;
      }
    })
    .delete("/:projectId/access/:accessId", async (c) => {
      const project = await aiProjects.admin.getByShortId(c.req.param("projectId")!);
      if (!project) return notFound(c, "Project");
      try {
        return (await aiProjects.admin.revokeAccess(project.id, c.req.param("accessId")!))
          ? respond(c, ok({ deleted: true }))
          : notFound(c, "Access entry");
      } catch (error) {
        if (error instanceof AiProjectLastAdminError) return lastAdminConflict(c, error);
        throw error;
      }
    })
    .delete("/:projectId", async (c) => {
      const project = await aiProjects.admin.getByShortId(c.req.param("projectId")!);
      return project && (await aiProjects.admin.delete(project.id)) ? respond(c, ok({ deleted: true })) : notFound(c, "Project");
    });

export default createAdminAiProjectsRoutes();
