import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { getCapability } from "../_internal/registry";
import { CloudResourceRefSchema, cloudResourceRefAppId, resolveCapabilityResourceReader } from "../contracts/capabilities";
import { AuthenticatedPrincipalSchema } from "../contracts/shared";
import { type AuthContext, auth, err, fail, ok, rateLimit, respond, v } from "../server";
import { decodeAiFileContent } from "./files-store";
import {
  AI_PROJECT_DESCRIPTION_MAX_CHARS,
  AI_PROJECT_FILE_MAX_BYTES,
  AI_PROJECT_INSTRUCTIONS_MAX_CHARS,
  AI_PROJECT_KNOWLEDGE_MAX_CHARS,
  AI_PROJECT_NAME_MAX_CHARS,
  type AiProject,
  type AiProjectFile,
  type AiProjectKnowledge,
  AiProjectLastAdminError,
  type AiProjectReference,
  aiProjects,
} from "./projects";

const ProjectFieldsSchema = z.object({
  name: z.string().trim().min(1).max(AI_PROJECT_NAME_MAX_CHARS),
  description: z.string().trim().max(AI_PROJECT_DESCRIPTION_MAX_CHARS).default(""),
  icon: z.string().trim().min(1).max(80).default("ti ti-folders"),
  instructions: z.string().trim().max(AI_PROJECT_INSTRUCTIONS_MAX_CHARS).default(""),
  defaultModelProfileId: z.string().trim().min(1).max(120).nullable().optional(),
});

const UpdateProjectSchema = ProjectFieldsSchema.partial().refine((input) => Object.keys(input).length > 0, "No changes supplied.");
const ProjectAccessSchema = z.object({ principal: AuthenticatedPrincipalSchema, permission: z.enum(["read", "write", "admin"]) });
const ProjectAccessUpdateSchema = z.object({ permission: z.enum(["read", "write", "admin"]) });
const KnowledgeSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(AI_PROJECT_KNOWLEDGE_MAX_CHARS),
});
const UpdateKnowledgeSchema = KnowledgeSchema.partial().refine((input) => Object.keys(input).length > 0, "No changes supplied.");
const KnowledgeQuerySchema = z.object({ q: z.string().trim().max(200).optional() });
const ProjectFileSchema = z.object({
  path: z.string().trim().min(1).max(500),
  mediaType: z.string().trim().min(1).max(120).default("application/octet-stream"),
  content: z.string().max(Math.ceil((AI_PROJECT_FILE_MAX_BYTES * 4) / 3) + 4),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});
const ReferenceSchema = z.object({
  ref: CloudResourceRefSchema,
  label: z.string().trim().max(200).default(""),
});

const notFound = (c: Parameters<typeof respond>[0], noun = "Project") => respond(c, fail(err.notFound(noun)));
const publicProject = (project: AiProject): AiProject => ({ ...project, id: project.shortId });
const publicKnowledge = (knowledge: AiProjectKnowledge, projectId: string): AiProjectKnowledge => ({
  ...knowledge,
  id: knowledge.shortId,
  projectId,
});
const publicFile = (file: AiProjectFile, projectId: string): AiProjectFile => ({ ...file, id: file.shortId, projectId });
const publicReference = (reference: AiProjectReference, projectId: string): AiProjectReference => ({
  ...reference,
  id: reference.shortId,
  projectId,
});

type AiProjectsRouteDependencies = {
  limit?: MiddlewareHandler<AuthContext>;
  authenticate?: MiddlewareHandler<AuthContext>;
  getCapability?: typeof getCapability;
};

const buildAiProjectsRoutes = (dependencies: AiProjectsRouteDependencies = {}) =>
  new Hono<AuthContext>()
    .use(dependencies.limit ?? rateLimit())
    .use("*", dependencies.authenticate ?? auth.requireRole("authenticated"))
    .get("/", async (c) => respond(c, ok({ projects: (await aiProjects.list(c.get("accessSubject") ?? null)).map(publicProject) })))
    .post("/", dependencies.authenticate ?? auth.requireRole("authenticated"), v("json", ProjectFieldsSchema), async (c) =>
      respond(
        c,
        ok({
          project: publicProject(await aiProjects.create({ subject: c.get("accessSubject"), ...c.req.valid("json") })),
        }),
        201,
      ),
    )
    .get("/:projectId", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null);
      return project ? respond(c, ok({ project: publicProject(project) })) : notFound(c);
    })
    .patch("/:projectId", v("json", UpdateProjectSchema), async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "write");
      if (!project) return notFound(c);
      const updated = await aiProjects.update(project.id, c.get("accessSubject") ?? null, c.req.valid("json"));
      return updated ? respond(c, ok({ project: publicProject(updated) })) : notFound(c);
    })
    .delete("/:projectId", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "admin");
      return project && (await aiProjects.delete(project.id, c.get("accessSubject") ?? null))
        ? respond(c, ok({ deleted: true }))
        : notFound(c);
    })
    .get("/:projectId/access", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "admin");
      const access = project ? await aiProjects.listAccess(project.id, c.get("accessSubject") ?? null) : null;
      return access ? respond(c, ok({ access })) : notFound(c);
    })
    .post("/:projectId/access", v("json", ProjectAccessSchema), async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "admin");
      const access = project ? await aiProjects.grantAccess(project.id, c.get("accessSubject") ?? null, c.req.valid("json")) : null;
      return access ? respond(c, ok({ access }), 201) : notFound(c);
    })
    .patch("/:projectId/access/:accessId", v("json", ProjectAccessUpdateSchema), async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "admin");
      try {
        return project &&
          (await aiProjects.updateAccess(
            project.id,
            c.req.param("accessId")!,
            c.get("accessSubject") ?? null,
            c.req.valid("json").permission,
          ))
          ? respond(c, ok({ updated: true }))
          : notFound(c, "Access entry");
      } catch (error) {
        if (error instanceof AiProjectLastAdminError) return respond(c, fail(err.conflict(error.message)));
        throw error;
      }
    })
    .delete("/:projectId/access/:accessId", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "admin");
      try {
        return project && (await aiProjects.revokeAccess(project.id, c.req.param("accessId")!, c.get("accessSubject") ?? null))
          ? respond(c, ok({ deleted: true }))
          : notFound(c, "Access entry");
      } catch (error) {
        if (error instanceof AiProjectLastAdminError) return respond(c, fail(err.conflict(error.message)));
        throw error;
      }
    })
    .get("/:projectId/knowledge", v("query", KnowledgeQuerySchema), async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null);
      if (!project) return notFound(c);
      return respond(
        c,
        ok({
          knowledge: (await aiProjects.listKnowledge(project.id, c.get("accessSubject") ?? null, c.req.valid("query").q)).map((item) =>
            publicKnowledge(item, project.shortId),
          ),
        }),
      );
    })
    .post("/:projectId/knowledge", v("json", KnowledgeSchema), async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "write");
      const knowledge = project ? await aiProjects.createKnowledge(project.id, c.get("accessSubject") ?? null, c.req.valid("json")) : null;
      return knowledge ? respond(c, ok({ knowledge: publicKnowledge(knowledge, project!.shortId) }), 201) : notFound(c);
    })
    .patch("/:projectId/knowledge/:knowledgeId", v("json", UpdateKnowledgeSchema), async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "write");
      const knowledge =
        project &&
        (await aiProjects.updateKnowledge(project.id, c.req.param("knowledgeId")!, c.get("accessSubject") ?? null, c.req.valid("json")));
      return knowledge ? respond(c, ok({ knowledge: publicKnowledge(knowledge, project!.shortId) })) : notFound(c, "Knowledge entry");
    })
    .delete("/:projectId/knowledge/:knowledgeId", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "write");
      return project && (await aiProjects.deleteKnowledge(project.id, c.req.param("knowledgeId")!, c.get("accessSubject") ?? null))
        ? respond(c, ok({ deleted: true }))
        : notFound(c, "Knowledge entry");
    })
    .get("/:projectId/files", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null);
      if (!project) return notFound(c);
      return respond(
        c,
        ok({
          files: (await aiProjects.listFiles(project.id, c.get("accessSubject") ?? null)).map((file) => publicFile(file, project.shortId)),
        }),
      );
    })
    .post("/:projectId/files", v("json", ProjectFileSchema), async (c) => {
      const body = c.req.valid("json");
      try {
        const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "write");
        const file = project
          ? await aiProjects.writeFile(project.id, c.get("accessSubject") ?? null, {
              path: body.path,
              mediaType: body.mediaType,
              bytes: decodeAiFileContent(body.content, body.encoding),
            })
          : null;
        return file ? respond(c, ok({ file: publicFile(file, project!.shortId) }), 201) : notFound(c);
      } catch (error) {
        return respond(c, fail(err.badInput(error instanceof Error ? error.message : "Invalid project file.")));
      }
    })
    .get("/:projectId/files/:fileId", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null);
      const file = project ? await aiProjects.readFile(project.id, c.req.param("fileId")!, c.get("accessSubject") ?? null) : null;
      if (!file) return notFound(c, "Project file");
      return respond(
        c,
        ok({
          file: { ...publicFile(file, project!.shortId), bytes: undefined },
          content: Buffer.from(file.bytes).toString("base64"),
          encoding: "base64",
        }),
      );
    })
    .delete("/:projectId/files/:fileId", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "write");
      return project && (await aiProjects.deleteFile(project.id, c.req.param("fileId")!, c.get("accessSubject") ?? null))
        ? respond(c, ok({ deleted: true }))
        : notFound(c, "Project file");
    })
    .get("/:projectId/references", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null);
      if (!project) return notFound(c);
      return respond(
        c,
        ok({
          references: (await aiProjects.listReferences(project.id, c.get("accessSubject") ?? null)).map((reference) =>
            publicReference(reference, project.shortId),
          ),
        }),
      );
    })
    .post("/:projectId/references", v("json", ReferenceSchema), async (c) => {
      const body = c.req.valid("json");
      const subject = c.get("accessSubject") ?? null;
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, subject, "write");
      if (!project) return notFound(c);
      let entry: Awaited<ReturnType<typeof getCapability>>;
      try {
        entry = await (dependencies.getCapability ?? getCapability)(cloudResourceRefAppId(body.ref));
      } catch {
        return c.json({ code: "APP_UNAVAILABLE", message: "Capability registry is currently unavailable" }, 503);
      }
      if (!entry || !resolveCapabilityResourceReader(entry.manifest, body.ref)) {
        return respond(c, fail(err.badInput("Cloud resource type is unknown or has no reader.")));
      }
      const reference = await aiProjects.createReference(project.id, subject, body);
      return reference ? respond(c, ok({ reference: publicReference(reference, project.shortId) }), 201) : notFound(c);
    })
    .delete("/:projectId/references/:referenceId", async (c) => {
      const project = await aiProjects.getByShortId(c.req.param("projectId")!, c.get("accessSubject") ?? null, "write");
      return project && (await aiProjects.deleteReference(project.id, c.req.param("referenceId")!, c.get("accessSubject") ?? null))
        ? respond(c, ok({ deleted: true }))
        : notFound(c, "Project reference");
    });

export const aiProjectsRoutes = buildAiProjectsRoutes();
/** @internal Test seam; applications use aiProjectsRoutes. */
export const __buildAiProjectsRoutesForTest = buildAiProjectsRoutes;
export type AiProjectsRoutes = typeof aiProjectsRoutes;
