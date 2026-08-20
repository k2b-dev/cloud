import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { AiSkillLastAdminError, aiSkills } from "../ai/skills";
import { PrincipalSchema } from "../contracts/shared";
import { type AuthContext, auth, err, fail, ok, respond, v } from "../server";

const ListSkillsSchema = z
  .object({
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const SkillAccessSchema = z.object({ principal: PrincipalSchema, permission: z.enum(["read", "write", "admin"]) }).strict();
const SkillAccessUpdateSchema = z.object({ permission: z.enum(["read", "write", "admin"]) }).strict();

const notFound = (c: Parameters<typeof respond>[0], noun: string) => respond(c, fail(err.notFound(noun)));
const conflict = (c: Parameters<typeof respond>[0], error: AiSkillLastAdminError) =>
  respond(c, { ok: false, error: error.message, status: 409 as const });

export const createAdminAiSkillsRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .get("/", v("query", ListSkillsSchema), async (c) => {
      const query = c.req.valid("query");
      const [skills, summary] = await Promise.all([aiSkills.admin.list(query), aiSkills.admin.summary({ search: query.search })]);
      return respond(
        c,
        ok({
          ...skills,
          items: skills.items.map((skill) => ({ ...skill, id: skill.shortId })),
          summary,
        }),
      );
    })
    .get("/:skillId/access", async (c) => {
      const skill = await aiSkills.admin.getByShortId(c.req.param("skillId")!);
      return skill ? respond(c, ok({ access: await aiSkills.admin.listAccess(skill.id) })) : notFound(c, "Skill");
    })
    .post("/:skillId/access", v("json", SkillAccessSchema), async (c) => {
      const skill = await aiSkills.admin.getByShortId(c.req.param("skillId")!);
      if (!skill) return notFound(c, "Skill");
      const access = await aiSkills.admin.grantAccess(skill.id, c.req.valid("json"));
      return access ? respond(c, ok({ access }), 201) : notFound(c, "Skill");
    })
    .patch("/:skillId/access/:accessId", v("json", SkillAccessUpdateSchema), async (c) => {
      const skill = await aiSkills.admin.getByShortId(c.req.param("skillId")!);
      if (!skill) return notFound(c, "Skill");
      try {
        return (await aiSkills.admin.updateAccess(skill.id, c.req.param("accessId")!, c.req.valid("json").permission))
          ? respond(c, ok({ updated: true }))
          : notFound(c, "Access entry");
      } catch (error) {
        if (error instanceof AiSkillLastAdminError) return conflict(c, error);
        throw error;
      }
    })
    .delete("/:skillId/access/:accessId", async (c) => {
      const skill = await aiSkills.admin.getByShortId(c.req.param("skillId")!);
      if (!skill) return notFound(c, "Skill");
      try {
        return (await aiSkills.admin.revokeAccess(skill.id, c.req.param("accessId")!))
          ? respond(c, ok({ deleted: true }))
          : notFound(c, "Access entry");
      } catch (error) {
        if (error instanceof AiSkillLastAdminError) return conflict(c, error);
        throw error;
      }
    })
    .delete("/:skillId", async (c) => {
      const skill = await aiSkills.admin.getByShortId(c.req.param("skillId")!);
      if (!skill) return notFound(c, "Skill");
      return (await aiSkills.admin.delete(skill.id)) ? respond(c, ok({ deleted: true })) : notFound(c, "Skill");
    });

export default createAdminAiSkillsRoutes();
