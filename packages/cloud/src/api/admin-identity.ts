import { fail, ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { CapabilityAppIdSchema } from "../contracts/capabilities";
import { type AuthContext, auth, err, respond, v } from "../server";
import { getIdentitySigningKeyStatus, identityMetrics, revokeIdentitySigningKey, rewrapIdentitySigningKeys } from "../services/identity";
import { WORKLOAD_SCOPES } from "../services/identity/workload-auth";
import { mandateMetrics, mandates } from "../services/mandates";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { serviceAccounts } from "../services/service-accounts";

const WorkloadCredentialInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z
      .array(z.enum(WORKLOAD_SCOPES))
      .min(1)
      .max(WORKLOAD_SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length, "Scopes must be unique"),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

const WorkloadAppParamsSchema = z.object({ appId: CapabilityAppIdSchema }).strict();
const WorkloadCredentialParamsSchema = WorkloadAppParamsSchema.extend({ credentialId: z.uuid() }).strict();
const WorkloadCredentialListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const MandateListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(50),
    ownerAppId: CapabilityAppIdSchema.optional(),
    state: z.enum(["active", "paused", "revoked"]).optional(),
  })
  .strict();

type IdentityAdminDependencies = {
  status: typeof getIdentitySigningKeyStatus;
  rewrap: typeof rewrapIdentitySigningKeys;
  revoke: typeof revokeIdentitySigningKey;
  serviceAccounts: Pick<typeof serviceAccounts, "getOrCreateResourceBound">;
  credentials: Pick<typeof serviceAccountCredentials, "createResourceApiToken" | "getOverview" | "listOverview" | "revoke">;
  mandates: Pick<typeof mandates, "list">;
};

const dependencies: IdentityAdminDependencies = {
  status: getIdentitySigningKeyStatus,
  rewrap: rewrapIdentitySigningKeys,
  revoke: revokeIdentitySigningKey,
  serviceAccounts,
  credentials: serviceAccountCredentials,
  mandates,
};

export const createAdminIdentityRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: IdentityAdminDependencies = dependencies,
) =>
  new Hono<AuthContext>()
    .use(authenticate)
    .post("/workloads/:appId/credentials", v("param", WorkloadAppParamsSchema), v("json", WorkloadCredentialInputSchema), async (c) =>
      respond(
        c,
        async () => {
          const { appId } = c.req.valid("param");
          const input = c.req.valid("json");
          const actor = c.get("user");
          const account = await service.serviceAccounts.getOrCreateResourceBound({
            name: `${appId} workload`,
            appId,
            resourceType: "cloud.app",
            resourceId: appId,
            createdBy: actor.id,
          });
          if (!account.ok) return fail(account.error);

          // The raw token intentionally appears only in this one create response.
          return service.credentials.createResourceApiToken({
            serviceAccountId: account.data.id,
            actor,
            name: input.name,
            scopes: input.scopes,
            expiresAt: input.expiresAt,
          });
        },
        201,
      ),
    )
    .get("/workloads/:appId/credentials", v("param", WorkloadAppParamsSchema), v("query", WorkloadCredentialListQuerySchema), async (c) => {
      const { appId } = c.req.valid("param");
      return c.json(
        await service.credentials.listOverview({
          pagination: c.req.valid("query"),
          filter: { serviceAccountKind: "resource_bound", appId, resourceType: "cloud.app", resourceId: appId },
        }),
      );
    })
    .delete("/workloads/:appId/credentials/:credentialId", v("param", WorkloadCredentialParamsSchema), async (c) =>
      respond(c, async () => {
        const { appId, credentialId } = c.req.valid("param");
        const credential = await service.credentials.getOverview({ id: credentialId });
        if (
          !credential ||
          credential.owner.type !== "resource" ||
          credential.owner.appId !== appId ||
          credential.owner.resourceType !== "cloud.app" ||
          credential.owner.resourceId !== appId
        ) {
          return fail(err.notFound("Workload credential"));
        }

        const revoked = await service.credentials.revoke({ credentialId, actor: c.get("user") });
        return revoked.ok ? ok({ revoked: true as const }) : revoked;
      }),
    )
    .get("/mandates", v("query", MandateListQuerySchema), async (c) => {
      const query = c.req.valid("query");
      return c.json(
        await service.mandates.list({
          scope: { kind: "admin" },
          pagination: { page: query.page, perPage: query.perPage },
          filter: { ownerAppId: query.ownerAppId, state: query.state },
        }),
      );
    })
    .get("/keys", async (c) =>
      c.json({ keys: await service.status(), metrics: identityMetrics.snapshot(), mandateMetrics: mandateMetrics.snapshot() }),
    )
    .post("/keys/rewrap", async (c) => c.json({ rewrapped: await service.rewrap() }))
    .post(
      "/keys/:kid/revoke",
      v("param", z.object({ kid: z.uuid() })),
      v("json", z.object({ reason: z.string().trim().min(1).max(500) })),
      async (c) => {
        const revoked = await service.revoke({
          kid: c.req.valid("param").kid,
          reason: c.req.valid("json").reason,
        });
        return revoked ? c.json({ revoked: true }) : c.json({ message: "Signing key not found" }, 404);
      },
    );

export default createAdminIdentityRoutes();
