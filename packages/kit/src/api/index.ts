import { type AuthContext, auth, getLocale, rateLimit, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { GrantInput, LIMITS, ProjectInput, PublicId, SaveInput } from "../contracts";
import { apiErrorMessage, errorMessages } from "../errors";
import { ProjectValidationError } from "../project";
import { compile } from "../runtime/compile";
import { sdkReference } from "../sdk";
import { type Identity, ProjectError, projects } from "../service";
import { MetadataInput, SourceChanges, SourceReadInput } from "../source";
import { starter } from "../starter";

const invalidInput = (c: Context) => ({ code: "INVALID_INPUT", message: apiErrorMessage("INVALID_INPUT", getLocale(c)) });
const router = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .use(rateLimit())
  .use(
    "*",
    bodyLimit({
      maxSize: LIMITS.sourceBytes + 128 * 1024,
      onError: (c) => respond(c, { ok: false, error: apiErrorMessage("INVALID_INPUT", getLocale(c)), status: 413, code: "INVALID_INPUT" }),
    }),
  )
  .use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  })
  .onError((e, c) => {
    if (e instanceof ProjectValidationError)
      return respond(c, { ok: false, error: e.localized(getLocale(c)), status: 400, code: "INVALID_PROJECT" });
    if (e instanceof ProjectError)
      return respond(c, { ok: false, error: apiErrorMessage(e.code, getLocale(c)), status: e.status, code: e.code });
    if (e instanceof z.ZodError)
      return respond(c, { ok: false, error: apiErrorMessage("INVALID_INPUT", getLocale(c)), status: 400, code: "INVALID_INPUT" });
    console.error("Kit API failed", e instanceof Error ? e.message : "Unknown error");
    return respond(c, { ok: false, error: apiErrorMessage("REQUEST_FAILED", getLocale(c)), status: 500, code: "REQUEST_FAILED" });
  })
  .get("/sdk", (c) => respond(c, ok(sdkReference)))
  .get("/starter", (c) => respond(c, ok(starter)))
  .get("/projects", describeRoute({ tags: ["Kit"], summary: "List accessible Kit apps" }), async (c) => {
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .parse(c.req.query("page") ?? 1);
    return respond(
      c,
      ok(
        await projects.list(
          { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
          page,
          z
            .string()
            .max(120)
            .parse(c.req.query("q") ?? ""),
        ),
      ),
    );
  })
  .post("/projects", v("json", ProjectInput, invalidInput), async (c) =>
    respond(
      c,
      ok(
        await projects.create(c.req.valid("json"), {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
        }),
      ),
      201,
    ),
  )
  .get("/projects/:id", async (c) =>
    respond(
      c,
      ok(
        await projects.get(PublicId.parse(c.req.param("id")), {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
        }),
      ),
    ),
  )
  .put("/projects/:id", v("json", SaveInput, invalidInput), async (c) => {
    const { expectedRevision, ...input } = c.req.valid("json");
    return respond(
      c,
      ok(
        await projects.save(PublicId.parse(c.req.param("id")), input, expectedRevision, {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
        }),
      ),
    );
  })
  .get("/projects/:id/manifest", describeRoute({ tags: ["Kit"], summary: "Read app metadata and file manifest" }), async (c) =>
    respond(
      c,
      ok(await projects.manifest(PublicId.parse(c.req.param("id")), { actor: c.get("actor"), accessSubject: c.get("accessSubject") })),
    ),
  )
  .post(
    "/projects/:id/source/read",
    describeRoute({ tags: ["Kit"], summary: "Read a revision-pinned source window" }),
    v("json", SourceReadInput.omit({ id: true }), invalidInput),
    async (c) =>
      respond(
        c,
        ok(
          await projects.readSource(
            { ...c.req.valid("json"), id: c.req.param("id") },
            { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
          ),
        ),
      ),
  )
  .post(
    "/projects/:id/source/validate",
    describeRoute({ tags: ["Kit"], summary: "Validate source changes without saving" }),
    v("json", SourceChanges, invalidInput),
    async (c) =>
      respond(
        c,
        ok(
          await projects.changeSource(PublicId.parse(c.req.param("id")), c.req.valid("json"), {
            actor: c.get("actor"),
            accessSubject: c.get("accessSubject"),
          }),
        ),
      ),
  )
  .post(
    "/projects/:id/source/apply",
    describeRoute({ tags: ["Kit"], summary: "Apply source changes atomically" }),
    v("json", SourceChanges, invalidInput),
    async (c) =>
      respond(
        c,
        ok(
          await projects.changeSource(
            PublicId.parse(c.req.param("id")),
            c.req.valid("json"),
            { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
            true,
          ),
        ),
      ),
  )
  .patch(
    "/projects/:id",
    describeRoute({ tags: ["Kit"], summary: "Update app metadata at an exact revision" }),
    v("json", MetadataInput, invalidInput),
    async (c) =>
      respond(
        c,
        ok(
          await projects.metadata(PublicId.parse(c.req.param("id")), c.req.valid("json"), {
            actor: c.get("actor"),
            accessSubject: c.get("accessSubject"),
          }),
        ),
      ),
  )
  .delete("/projects/:id", async (c) =>
    respond(
      c,
      ok(
        await projects.remove(PublicId.parse(c.req.param("id")), {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
        }),
      ),
    ),
  )
  .get("/projects/:id/access", async (c) =>
    respond(
      c,
      ok(
        await projects.access(PublicId.parse(c.req.param("id")), {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
        }),
      ),
    ),
  )
  .post("/projects/:id/access", v("json", GrantInput, invalidInput), async (c) => {
    const input = c.req.valid("json");
    return respond(
      c,
      ok(
        await projects.grant(PublicId.parse(c.req.param("id")), input.principal, input.permission, {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
        }),
      ),
    );
  })
  .patch(
    "/projects/:id/access/:accessId",
    v("json", z.object({ permission: z.enum(["read", "write", "admin"]) }), invalidInput),
    async (c) =>
      respond(
        c,
        ok(
          await projects.changeGrant(
            PublicId.parse(c.req.param("id")),
            z.uuid().parse(c.req.param("accessId")),
            c.req.valid("json").permission,
            { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
          ),
        ),
      ),
  )
  .delete("/projects/:id/access/:accessId", async (c) =>
    respond(
      c,
      ok(
        await projects.changeGrant(PublicId.parse(c.req.param("id")), z.uuid().parse(c.req.param("accessId")), null, {
          actor: c.get("actor"),
          accessSubject: c.get("accessSubject"),
        }),
      ),
    ),
  )
  .post("/projects/:id/compile", v("json", z.object({ entry: z.string(), preview: ProjectInput.optional() }), invalidInput), async (c) => {
    const input = c.req.valid("json");
    const saved = await projects.get(
      PublicId.parse(c.req.param("id")),
      { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
      input.preview ? "admin" : "write",
    );
    try {
      return respond(
        c,
        ok(
          await compile(
            input.preview ?? {
              name: saved.name,
              description: saved.description,
              persistenceEnabled: saved.persistenceEnabled,
              files: saved.files,
            },
            input.entry,
          ),
        ),
      );
    } catch (e) {
      return respond(c, {
        ok: false,
        error: e instanceof ProjectValidationError ? e.localized(getLocale(c)) : errorMessages.resolve([getLocale(c)]).t.compile,
        status: 400,
        code: "COMPILE_FAILED",
      });
    }
  });
export default router;
export type ApiType = typeof router;
