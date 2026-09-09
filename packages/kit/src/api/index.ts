import { Hono, type Context } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { describeRoute } from "hono-openapi";
import { auth, getLocale, v, type AuthContext } from "@valentinkolb/cloud/server";
import { PublicId, GrantInput, ProjectInput, SaveInput, LIMITS } from "../contracts";
import { projects, ProjectError, type Identity } from "../service";
import { compile } from "../runtime/compile";
import { ProjectValidationError } from "../project";
import { starter } from "../starter";
import { apiErrorMessage, errorMessages } from "../errors";
import { sdkReference } from "../sdk";
const invalidInput = (c: Context) => ({ code: "INVALID_INPUT", message: apiErrorMessage("INVALID_INPUT", getLocale(c)) });
const router = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .use("*", bodyLimit({
    maxSize: LIMITS.sourceBytes + 128 * 1024,
    onError: c => c.json({ code: "INVALID_INPUT", message: apiErrorMessage("INVALID_INPUT", getLocale(c)) }, 413),
  }))
  .use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  })
  .onError((e, c) => {
    if (e instanceof ProjectValidationError) return c.json({ code: "INVALID_PROJECT", message: e.localized(getLocale(c)) }, 400);
    if (e instanceof ProjectError) return c.json({ code: e.code, message: apiErrorMessage(e.code, getLocale(c)) }, e.status);
    if (e instanceof z.ZodError) return c.json({ code: "INVALID_INPUT", message: apiErrorMessage("INVALID_INPUT", getLocale(c)) }, 400);
    console.error("Kit API failed", e instanceof Error ? e.message : "Unknown error");
    return c.json({ code: "REQUEST_FAILED", message: apiErrorMessage("REQUEST_FAILED", getLocale(c)) }, 500);
  })
  .get("/sdk", (c) => c.json(sdkReference))
  .get("/starter", (c) => c.json(starter))
  .get("/projects", describeRoute({ tags: ["Kit"], summary: "List accessible Kit apps" }), async (c) => {
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .parse(c.req.query("page") ?? 1);
    return c.json(
      await projects.list(
        { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
        page,
        z
          .string()
          .max(120)
          .parse(c.req.query("q") ?? ""),
      ),
    );
  })
  .post("/projects", v("json", ProjectInput, invalidInput), async (c) =>
    c.json(
      await projects.create(c.req.valid("json"), {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      }),
      201,
    ),
  )
  .get("/projects/:id", async (c) =>
    c.json(
      await projects.get(PublicId.parse(c.req.param("id")), {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      }),
    ),
  )
  .put("/projects/:id", v("json", SaveInput, invalidInput), async (c) => {
    const { expectedRevision, ...input } = c.req.valid("json");
    return c.json(
      await projects.save(PublicId.parse(c.req.param("id")), input, expectedRevision, {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      }),
    );
  })
  .delete("/projects/:id", async (c) =>
    c.json(
      await projects.remove(PublicId.parse(c.req.param("id")), {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      }),
    ),
  )
  .get("/projects/:id/access", async (c) =>
    c.json(
      await projects.access(PublicId.parse(c.req.param("id")), {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      }),
    ),
  )
  .post("/projects/:id/access", v("json", GrantInput, invalidInput), async (c) => {
    const input = c.req.valid("json");
    return c.json(
      await projects.grant(PublicId.parse(c.req.param("id")), input.principal, input.permission, {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      }),
    );
  })
  .patch("/projects/:id/access/:accessId", v("json", z.object({ permission: z.enum(["read", "write", "admin"]) }), invalidInput), async (c) =>
    c.json(
      await projects.changeGrant(
        PublicId.parse(c.req.param("id")),
        z.uuid().parse(c.req.param("accessId")),
        c.req.valid("json").permission,
        { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
      ),
    ),
  )
  .delete("/projects/:id/access/:accessId", async (c) =>
    c.json(
      await projects.changeGrant(PublicId.parse(c.req.param("id")), z.uuid().parse(c.req.param("accessId")), null, {
        actor: c.get("actor"),
        accessSubject: c.get("accessSubject"),
      }),
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
      return c.json(
        await compile(
          input.preview ?? {
            name: saved.name,
            description: saved.description,
            persistenceEnabled: saved.persistenceEnabled,
            files: saved.files,
          },
          input.entry,
        ),
      );
    } catch (e) {
      return c.json(
        {
          code: "COMPILE_FAILED",
          message: e instanceof ProjectValidationError ? e.localized(getLocale(c)) : errorMessages.resolve([getLocale(c)]).t.compile,
        },
        400,
      );
    }
  });
export default router;
export type ApiType = typeof router;
