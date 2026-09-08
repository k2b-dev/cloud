import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { LinuxIdentityConfigurationSchema, PosixOverridesSchema } from "../contracts/posix";
import { auth, type AuthContext, v } from "../server";
import { posix, PosixError } from "../services/accounts/posix";

const Id = z.object({ id: z.uuid() });
const Configure = z.object({ config: LinuxIdentityConfigurationSchema, rangeReserved: z.boolean() }).strict();

export const createAdminLinuxIdentityRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: typeof posix = posix,
) =>
  new Hono<AuthContext>()
    .use(authenticate)
    .onError((error, c) => {
      if (error instanceof PosixError) return c.json({ code: error.code }, error.status);
      throw error;
    })
    .get(
      "/",
      describeRoute({ tags: ["Linux identities"], summary: "Preview Linux identities without provisioning accounts" }),
      v("query", z.object({ after: z.uuid().optional() })),
      async (c) => c.json(await service.overview(c.get("user"), c.req.valid("query").after ?? null)),
    )
    .put(
      "/configuration",
      describeRoute({ tags: ["Linux identities"], summary: "Configure local Linux identity preparation; does not enable computer login" }),
      v("json", Configure),
      async (c) => {
        const { config, rangeReserved } = c.req.valid("json");
        if (config.enabled && !rangeReserved) throw new PosixError("range_confirmation_required", 400);
        return c.json(await service.configure(c.get("user"), config));
      },
    )
    .get(
      "/users/:id",
      describeRoute({ tags: ["Linux identities"], summary: "Read a local or FreeIPA Linux identity" }),
      v("param", Id),
      async (c) => c.json(await service.get(c.get("user"), c.req.valid("param").id)),
    )
    .post(
      "/users/:id",
      describeRoute({ tags: ["Linux identities"], summary: "Prepare one local full account; safe to repeat after interruption" }),
      v("param", Id),
      async (c) => c.json(await service.provision(c.get("user"), c.req.valid("param").id)),
    )
    .post(
      "/groups/:id",
      describeRoute({ tags: ["Linux identities"], summary: "Assign a stable Linux GID to a local group" }),
      v("param", Id),
      async (c) => c.json(await service.provisionGroup(c.get("user"), c.req.valid("param").id)),
    )
    .patch(
      "/users/:id",
      describeRoute({ tags: ["Linux identities"], summary: "Change local home and shell without changing numeric IDs or moving files" }),
      v("param", Id),
      v("json", PosixOverridesSchema),
      async (c) => c.json(await service.update(c.get("user"), c.req.valid("param").id, c.req.valid("json"))),
    );

export default createAdminLinuxIdentityRoutes();
