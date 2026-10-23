import { fail, ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { listApps } from "../_internal/registry";
import { CapabilityAppIdSchema } from "../contracts/capabilities";
import { SaveServiceAccountAvatarSchema } from "../contracts/profile";
import { AI_INFERENCE_SCOPE } from "../contracts/shared";
import { type AuthContext, auth, err, respond, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { clearServiceAccountAvatar, getServiceAccountAvatarState, updateServiceAccountAvatar } from "../services/accounts/avatar";
import { audit } from "../services/audit";
import { getIdentitySigningKeyStatus, identityMetrics, revokeIdentitySigningKey, rewrapIdentitySigningKeys } from "../services/identity";
import { WORKLOAD_SCOPES } from "../services/identity/workload-auth";
import { mandateMetrics, mandates } from "../services/mandates";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { isStandaloneServiceAccountKind, STANDALONE_SERVICE_ACCOUNT_KINDS, serviceAccounts } from "../services/service-accounts";

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

const StandaloneServiceAccountKindSchema = z.enum(STANDALONE_SERVICE_ACCOUNT_KINDS);
const ServiceAccountParamsSchema = z.object({ id: z.uuid() }).strict();
const ServiceAccountListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(500).default(100),
    kind: StandaloneServiceAccountKindSchema.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    search: z.string().trim().max(200).optional(),
  })
  .strict();
const ServiceAccountInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: StandaloneServiceAccountKindSchema.default("standalone"),
  })
  .strict();
const ServiceAccountStatusInputSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();
const ServiceAccountApiKeyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z
      .array(z.string().trim().min(1).max(64))
      .max(20)
      .default([])
      .refine((scopes) => !scopes.includes(AI_INFERENCE_SCOPE), "ai:inference is reserved for models-only personal API keys"),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

type IdentityAdminDependencies = {
  apps: () => Promise<Array<{ id: string; name: string }>>;
  status: typeof getIdentitySigningKeyStatus;
  rewrap: typeof rewrapIdentitySigningKeys;
  revoke: typeof revokeIdentitySigningKey;
  serviceAccounts: Pick<typeof serviceAccounts, "getOrCreateResourceBound" | "createStandalone" | "listStandalone" | "get" | "setStatus">;
  credentials: Pick<
    typeof serviceAccountCredentials,
    "createResourceApiToken" | "createStandaloneApiToken" | "getOverview" | "listOverview" | "revoke"
  >;
  mandates: Pick<typeof mandates, "list">;
  audit: Pick<typeof audit, "record">;
  avatars: {
    state: typeof getServiceAccountAvatarState;
    update: typeof updateServiceAccountAvatar;
    clear: typeof clearServiceAccountAvatar;
  };
};

const dependencies: IdentityAdminDependencies = {
  apps: async () => (await listApps()).map(({ id, name }) => ({ id, name })),
  status: getIdentitySigningKeyStatus,
  rewrap: rewrapIdentitySigningKeys,
  revoke: revokeIdentitySigningKey,
  serviceAccounts,
  credentials: serviceAccountCredentials,
  mandates,
  audit,
  avatars: { state: getServiceAccountAvatarState, update: updateServiceAccountAvatar, clear: clearServiceAccountAvatar },
};

const auditActor = (user: AuthContext["Variables"]["user"]) => ({
  userId: user.id,
  uid: user.uid,
  provider: user.provider,
  roles: user.roles,
});

export const createAdminIdentityRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: IdentityAdminDependencies = dependencies,
) =>
  new Hono<AuthContext>()
    // Mandate lists hold every user's grant inputs, which users write at will and which can carry private text.
    .use("*", noTransform())
    .use(authenticate)
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/workloads",
      describeRoute({ tags: ["App credentials"], summary: "List registered applications for workload credentials" }),
      async (c) => c.json(await service.apps()),
    )
    .get(
      "/workloads/credentials",
      describeRoute({ tags: ["App credentials"], summary: "List credential metadata across applications without secrets" }),
      v("query", WorkloadCredentialListQuerySchema),
      async (c) =>
        c.json(
          await service.credentials.listOverview({
            pagination: c.req.valid("query"),
            filter: { serviceAccountKind: "resource_bound", resourceType: "cloud.app" },
          }),
        ),
    )
    .post(
      "/workloads/:appId/credentials",
      describeRoute({ tags: ["App credentials"], summary: "Create an app-bound credential; return its token once" }),
      v("param", WorkloadAppParamsSchema),
      v("json", WorkloadCredentialInputSchema),
      async (c) =>
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
    .get(
      "/workloads/:appId/credentials",
      describeRoute({ tags: ["App credentials"], summary: "List app credential metadata without secrets" }),
      v("param", WorkloadAppParamsSchema),
      v("query", WorkloadCredentialListQuerySchema),
      async (c) => {
        const { appId } = c.req.valid("param");
        return c.json(
          await service.credentials.listOverview({
            pagination: c.req.valid("query"),
            filter: { serviceAccountKind: "resource_bound", appId, resourceType: "cloud.app", resourceId: appId },
          }),
        );
      },
    )
    .delete(
      "/workloads/:appId/credentials/:credentialId",
      describeRoute({ tags: ["App credentials"], summary: "Revoke one exact app credential" }),
      v("param", WorkloadCredentialParamsSchema),
      async (c) =>
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
    // Standalone principals: service accounts with no delegated user and no
    // resource binding. Access is granted to them like to a user; a new account
    // starts with nothing. Credentials: OAuth client (OAuth admin API) or the
    // API key minted below.
    .get(
      "/service-accounts",
      describeRoute({ tags: ["Service accounts"], summary: "List standalone service accounts (kind standalone or agent)" }),
      v("query", ServiceAccountListQuerySchema),
      async (c) => c.json(await service.serviceAccounts.listStandalone(c.req.valid("query"))),
    )
    .post(
      "/service-accounts",
      describeRoute({ tags: ["Service accounts"], summary: "Create a standalone service account without any access" }),
      v("json", ServiceAccountInputSchema),
      async (c) =>
        respond(
          c,
          async () => {
            const input = c.req.valid("json");
            const actor = c.get("user");
            const created = await service.serviceAccounts.createStandalone({ ...input, createdBy: actor.id });
            if (!created.ok) return created;
            await service.audit.record({
              action: "service_account.create",
              outcome: "allowed",
              actor: auditActor(actor),
              target: { type: "service_account", id: created.data.id, label: created.data.name },
              metadata: { serviceAccountId: created.data.id, serviceAccountKind: created.data.kind },
            });
            return created;
          },
          201,
        ),
    )
    .get(
      "/service-accounts/:id",
      describeRoute({ tags: ["Service accounts"], summary: "Read one standalone service account" }),
      v("param", ServiceAccountParamsSchema),
      async (c) =>
        respond(c, async () => {
          const account = await service.serviceAccounts.get({ id: c.req.valid("param").id });
          return account && isStandaloneServiceAccountKind(account.kind) ? ok(account) : fail(err.notFound("Service account"));
        }),
    )
    .patch(
      "/service-accounts/:id",
      describeRoute({
        tags: ["Service accounts"],
        summary: "Enable or disable a standalone service account; disabled accounts reject every credential immediately",
      }),
      v("param", ServiceAccountParamsSchema),
      v("json", ServiceAccountStatusInputSchema),
      async (c) =>
        respond(c, async () => {
          const { id } = c.req.valid("param");
          const { status } = c.req.valid("json");
          const actor = c.get("user");
          const account = await service.serviceAccounts.get({ id });
          if (!account || !isStandaloneServiceAccountKind(account.kind)) return fail(err.notFound("Service account"));
          const updated = await service.serviceAccounts.setStatus({ id, status });
          if (!updated.ok) return updated;
          await service.audit.record({
            action: status === "disabled" ? "service_account.disable" : "service_account.enable",
            outcome: "allowed",
            actor: auditActor(actor),
            target: { type: "service_account", id: account.id, label: account.name },
            metadata: { serviceAccountId: account.id, serviceAccountKind: account.kind, status },
          });
          return ok({ ...account, status });
        }),
    )
    // Every service account shows a robot drawn from its id until someone customises it or sets a photo.
    .get(
      "/service-accounts/:id/avatar",
      describeRoute({ tags: ["Service accounts"], summary: "Read a standalone service account's picture: its robot or photo" }),
      v("param", ServiceAccountParamsSchema),
      async (c) =>
        respond(c, async () => {
          const { id } = c.req.valid("param");
          const account = await service.serviceAccounts.get({ id });
          if (!account || !isStandaloneServiceAccountKind(account.kind)) return fail(err.notFound("Service account"));
          const state = await service.avatars.state({ id });
          return state ? ok(state) : fail(err.notFound("Service account"));
        }),
    )
    .put(
      "/service-accounts/:id/avatar",
      describeRoute({
        tags: ["Service accounts"],
        summary: "Set a standalone service account's picture: a photo, a customised robot, or which of them shows",
      }),
      v("param", ServiceAccountParamsSchema),
      v("json", SaveServiceAccountAvatarSchema),
      async (c) =>
        respond(c, async () => {
          const { id } = c.req.valid("param");
          const actor = c.get("user");
          const account = await service.serviceAccounts.get({ id });
          if (!account || !isStandaloneServiceAccountKind(account.kind)) return fail(err.notFound("Service account"));
          const updated = await service.avatars.update({ id, change: c.req.valid("json") });
          if (!updated.ok)
            return fail(updated.status === 409 ? { ...err.conflict("Picture"), message: updated.error } : err.badInput(updated.error));
          await service.audit.record({
            action: "service_account.avatar.update",
            outcome: "allowed",
            actor: auditActor(actor),
            target: { type: "service_account", id: account.id, label: account.name },
            metadata: { serviceAccountId: account.id, serviceAccountKind: account.kind, kind: updated.data.kind },
          });
          return ok(updated.data);
        }),
    )
    .delete(
      "/service-accounts/:id/avatar",
      describeRoute({ tags: ["Service accounts"], summary: "Delete a standalone service account's photo; its robot shows again" }),
      v("param", ServiceAccountParamsSchema),
      async (c) =>
        respond(c, async () => {
          const { id } = c.req.valid("param");
          const actor = c.get("user");
          const account = await service.serviceAccounts.get({ id });
          if (!account || !isStandaloneServiceAccountKind(account.kind)) return fail(err.notFound("Service account"));
          const cleared = await service.avatars.clear({ id });
          if (!cleared.ok) return fail(err.notFound("Service account"));
          await service.audit.record({
            action: "service_account.avatar.clear",
            outcome: "allowed",
            actor: auditActor(actor),
            target: { type: "service_account", id: account.id, label: account.name },
            metadata: { serviceAccountId: account.id, serviceAccountKind: account.kind },
          });
          return ok(cleared.data);
        }),
    )
    .post(
      "/service-accounts/:id/api-keys",
      describeRoute({ tags: ["Service accounts"], summary: "Create an API key for a standalone service account; return its token once" }),
      v("param", ServiceAccountParamsSchema),
      v("json", ServiceAccountApiKeyInputSchema),
      async (c) =>
        respond(
          c,
          // The raw token intentionally appears only in this one create response.
          () =>
            service.credentials.createStandaloneApiToken({
              serviceAccountId: c.req.valid("param").id,
              actor: c.get("user"),
              ...c.req.valid("json"),
            }),
          201,
        ),
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
