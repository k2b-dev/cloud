import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { PrincipalSchema } from "../contracts/shared";
import { type AuthContext, auth, err, fail, ok, rateLimit, respond, v } from "../server";
import {
  AI_SKILL_DESCRIPTION_MAX_CHARS,
  AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS,
  AI_SKILL_INSTRUCTIONS_MAX_CHARS,
  AI_SKILL_NAME_MAX_CHARS,
  AI_SKILL_NAME_PATTERN,
  AI_SKILL_REFERENCE_MAX_CHARS,
  AI_SKILL_REFERENCE_MAX_ITEMS,
} from "./skill-format";
import {
  type AiSkill,
  AiSkillInputError,
  AiSkillLastAdminError,
  AiSkillRevisionConflictError,
  type AiSkillSummary,
  aiSkills,
} from "./skills";

const SkillReferenceSchema = z.object({
  path: z.string().trim().min(1).max(200),
  content: z.string().max(AI_SKILL_REFERENCE_MAX_CHARS),
});

const SkillFieldsSchema = z.object({
  name: z.string().trim().min(1).max(AI_SKILL_NAME_MAX_CHARS).regex(AI_SKILL_NAME_PATTERN),
  description: z.string().trim().min(1).max(AI_SKILL_DESCRIPTION_MAX_CHARS),
  instructions: z.string().trim().min(1).max(AI_SKILL_INSTRUCTIONS_MAX_CHARS),
  extraFrontmatter: z.record(z.string(), z.unknown()).default({}).refine(
    (value) => JSON.stringify(value).length <= AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS,
    "Optional SKILL.md frontmatter is too large.",
  ),
  references: z.array(SkillReferenceSchema).max(AI_SKILL_REFERENCE_MAX_ITEMS).default([]),
});

const UpdateSkillSchema = SkillFieldsSchema.extend({ expectedRevision: z.number().int().positive() });
const SkillAccessSchema = z.object({ principal: PrincipalSchema, permission: z.enum(["read", "write", "admin"]) });
const SkillAccessUpdateSchema = z.object({ permission: z.enum(["read", "write", "admin"]) });

const publicSummary = (skill: AiSkillSummary): AiSkillSummary => ({ ...skill, id: skill.shortId });
const publicSkill = (skill: AiSkill): AiSkill => ({ ...skill, id: skill.shortId });

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";

type AiSkillsRouteDependencies = {
  limit?: MiddlewareHandler<AuthContext>;
  authenticate?: MiddlewareHandler<AuthContext>;
};

const buildAiSkillsRoutes = (dependencies: AiSkillsRouteDependencies = {}) =>
  new Hono<AuthContext>()
    .use(dependencies.limit ?? rateLimit())
    .use("*", dependencies.authenticate ?? auth.requireRole("*"))
    .get("/", async (c) =>
      respond(c, ok({ skills: (await aiSkills.list(c.get("accessSubject") ?? null)).map(publicSummary) })),
    )
    .post("/", dependencies.authenticate ?? auth.requireRole("authenticated"), v("json", SkillFieldsSchema), async (c) => {
      const subject = c.get("accessSubject");
      if (!subject) return respond(c, fail(err.forbidden("Skills require an authenticated access subject.")));
      try {
        return respond(c, ok({ skill: publicSkill(await aiSkills.create({ subject, ...c.req.valid("json") })) }), 201);
      } catch (error) {
        if (isUniqueViolation(error)) return respond(c, fail(err.conflict("A skill with this name already exists.")));
        if (error instanceof AiSkillInputError) return respond(c, fail(err.badInput(error.message)));
        throw error;
      }
    })
    .get("/:skillId", async (c) => {
      const skill = await aiSkills.getByShortId(c.req.param("skillId")!, c.get("accessSubject") ?? null);
      return skill ? respond(c, ok({ skill: publicSkill(skill) })) : respond(c, fail(err.notFound("Skill")));
    })
    .put("/:skillId", v("json", UpdateSkillSchema), async (c) => {
      const existing = await aiSkills.getByShortId(c.req.param("skillId")!, c.get("accessSubject") ?? null, "write");
      if (!existing) return respond(c, fail(err.notFound("Skill")));
      try {
        const skill = await aiSkills.update(existing.id, c.get("accessSubject") ?? null, c.req.valid("json"));
        return skill ? respond(c, ok({ skill: publicSkill(skill) })) : respond(c, fail(err.notFound("Skill")));
      } catch (error) {
        if (isUniqueViolation(error)) return respond(c, fail(err.conflict("A skill with this name already exists.")));
        if (error instanceof AiSkillRevisionConflictError) return respond(c, fail(err.conflict(error.message)));
        if (error instanceof AiSkillInputError) return respond(c, fail(err.badInput(error.message)));
        throw error;
      }
    })
    .delete("/:skillId", async (c) => {
      const skill = await aiSkills.getByShortId(c.req.param("skillId")!, c.get("accessSubject") ?? null, "admin");
      return skill && (await aiSkills.delete(skill.id, c.get("accessSubject") ?? null))
        ? respond(c, ok({ deleted: true }))
        : respond(c, fail(err.notFound("Skill")));
    })
    .get("/:skillId/access", async (c) => {
      const skill = await aiSkills.getByShortId(c.req.param("skillId")!, c.get("accessSubject") ?? null, "admin");
      const access = skill ? await aiSkills.listAccess(skill.id, c.get("accessSubject") ?? null) : null;
      return access ? respond(c, ok({ access })) : respond(c, fail(err.notFound("Skill")));
    })
    .post("/:skillId/access", v("json", SkillAccessSchema), async (c) => {
      const skill = await aiSkills.getByShortId(c.req.param("skillId")!, c.get("accessSubject") ?? null, "admin");
      const access = skill ? await aiSkills.grantAccess(skill.id, c.get("accessSubject") ?? null, c.req.valid("json")) : null;
      return access ? respond(c, ok({ access }), 201) : respond(c, fail(err.notFound("Skill")));
    })
    .patch("/:skillId/access/:accessId", v("json", SkillAccessUpdateSchema), async (c) => {
      const skill = await aiSkills.getByShortId(c.req.param("skillId")!, c.get("accessSubject") ?? null, "admin");
      try {
        return skill &&
          (await aiSkills.updateAccess(
            skill.id,
            c.req.param("accessId")!,
            c.get("accessSubject") ?? null,
            c.req.valid("json").permission,
          ))
          ? respond(c, ok({ updated: true }))
          : respond(c, fail(err.notFound("Access entry")));
      } catch (error) {
        if (error instanceof AiSkillLastAdminError) return respond(c, fail(err.conflict(error.message)));
        throw error;
      }
    })
    .delete("/:skillId/access/:accessId", async (c) => {
      const skill = await aiSkills.getByShortId(c.req.param("skillId")!, c.get("accessSubject") ?? null, "admin");
      try {
        return skill &&
          (await aiSkills.revokeAccess(skill.id, c.req.param("accessId")!, c.get("accessSubject") ?? null))
          ? respond(c, ok({ deleted: true }))
          : respond(c, fail(err.notFound("Access entry")));
      } catch (error) {
        if (error instanceof AiSkillLastAdminError) return respond(c, fail(err.conflict(error.message)));
        throw error;
      }
    });

export const aiSkillsRoutes = buildAiSkillsRoutes();
/** @internal Test seam. */
export const __buildAiSkillsRoutesForTest = buildAiSkillsRoutes;
export type AiSkillsRoutes = typeof aiSkillsRoutes;
