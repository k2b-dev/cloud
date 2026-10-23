import { CodeResourceId } from "@k2b/cloud/ai/browser";
import {
  type AuthContext,
  auth,
  getLocale,
  getTimeZone,
  isRequestCredentialCurrent,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  rateLimit,
  respond,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { adminIdentity } from "./admin";
import { ArtifactUpdate, LIMITS } from "./contracts";
import { artifactDatabase, DatabaseError } from "./database";
import { FlatDatabaseRequest } from "./database-runtime";
import { SecretSave } from "./http-contracts";
import { machineAudit } from "./machine-audit";
import { machineIdentity } from "./machine-authority";
import { MachineExecution, MachineRights } from "./machine-contracts";
import { executeMachine, MachineExecutionError } from "./machine-execution";
import { machineMessages } from "./machine-messages";
import { machineAccess } from "./machine-service";
import { artifactMessages } from "./messages";
import { CloudError } from "./runtime/errors";
import { ArtifactError, type ArtifactIdentity, artifacts, requireArtifact } from "./service";
import { StorageFileQuery, StorageJsonRequest } from "./storage-contracts";

const identity = (c: Context<AuthContext>): ArtifactIdentity => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  credentialKind: c.get("credentialKind"),
  ...(c.get("credentialKind") === "oauth"
    ? {
        machineCredential: {
          reference: `oauth:${new Bun.CryptoHasher("sha256").update(c.req.header("authorization") ?? "").digest("hex")}`,
          isCurrent: () => isRequestCredentialCurrent(c),
        },
      }
    : {}),
});
const manager = (c: Context<AuthContext>) => (c.req.query("administrative") === "true" ? adminIdentity(identity(c)) : identity(c));
const ManagerQuery = v("query", z.object({ administrative: z.enum(["true", "false"]).optional() }));
const id = (c: Context<AuthContext>) => CodeResourceId.parse(c.req.param("id"));

/** Mounted before the human Assistant API; its authentication does not open any chat routes. */
export const createMachineRoutes = () =>
  new Hono<AuthContext>()
    .use("*", (c, next) => (c.req.path.endsWith("/storage/file") ? next() : bodyLimit({ maxSize: LIMITS.rpcBytes })(c, next)))
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .use("*", async (c, next) => {
      const requestId = crypto.randomUUID();
      c.header("X-Studio-Request-Id", requestId);
      await next();
      const who = identity(c),
        resource = CodeResourceId.safeParse(c.req.param("id"));
      if (who.actor.kind !== "service_account" || who.actor.delegatedUser !== null || !resource.success || c.req.path.endsWith("/execute"))
        return;
      await machineAudit(
        who,
        { id: resource.data, requestId, version: null },
        `${c.req.method.toLowerCase()}.${c.req.path.includes("/storage") ? "storage" : c.req.path.includes("/database") ? "database" : c.req.path.includes("/source") ? "source" : c.req.path.includes("/runs/") ? "status" : "sharing"}`,
        c.res.ok ? "allowed" : "denied",
        c.res.ok ? undefined : "OPERATION_FAILED",
      );
    })
    .onError((error, c) => {
      if (error instanceof DatabaseError)
        return c.json({ code: error.code, message: machineMessages.resolve([getLocale(c)]).t.EXECUTION_FAILED }, error.status);
      if (error instanceof CloudError) {
        const status = { denied: 403, not_found: 404, invalid: 400, conflict: 409, limit: 413, unavailable: 503, cancelled: 409 } as const;
        return c.json({ code: error.code, message: machineMessages.resolve([getLocale(c)]).t.EXECUTION_FAILED }, status[error.code]);
      }
      const code =
        error instanceof ArtifactError || error instanceof MachineExecutionError
          ? error.code
          : error instanceof z.ZodError
            ? "INVALID_INPUT"
            : "EXECUTION_FAILED";
      const status = code === "ACCESS_DENIED" ? 403 : code === "NOT_FOUND" ? 404 : code === "INVALID_INPUT" ? 400 : 409;
      return c.json(
        {
          code,
          message:
            error instanceof MachineExecutionError
              ? machineMessages.resolve([getLocale(c)]).t[error.code]
              : error instanceof ArtifactError
                ? artifactMessages.resolve([getLocale(c)]).t[error.code]
                : machineMessages.resolve([getLocale(c)]).t.EXECUTION_FAILED,
        },
        status,
      );
    })
    .get("/:id/source", v("query", z.object({ draft: z.enum(["true"]).optional() })), async (c) => {
      await machineIdentity(identity(c), id(c));
      const draft = c.req.valid("query").draft === "true";
      if (draft) await sql.begin((db) => requireArtifact(db, id(c), identity(c), "admin"));
      return respond(c, ok(await artifacts.get(id(c), identity(c), undefined, !draft)));
    })
    .put("/:id/source", v("json", ArtifactUpdate), async (c) => {
      await machineIdentity(identity(c), id(c), "admin");
      return respond(c, ok(await artifacts.update(id(c), c.req.valid("json"), identity(c))));
    })
    .post(
      "/:id/grants",
      v(
        "json",
        z
          .object({
            principal: z.discriminatedUnion("type", [
              z.object({ type: z.literal("user"), userId: z.uuid() }),
              z.object({ type: z.literal("group"), groupId: z.uuid() }),
              z.object({ type: z.literal("service_account"), serviceAccountId: z.uuid() }),
              z.object({ type: z.literal("authenticated") }),
              z.object({ type: z.literal("public") }),
            ]),
            permission: z.enum(["read", "admin"]),
          })
          .strict(),
      ),
      async (c) => {
        await machineIdentity(identity(c), id(c), "admin");
        return respond(c, ok(await artifacts.grant(id(c), c.req.valid("json").principal, c.req.valid("json").permission, identity(c))));
      },
    )
    .put("/:id/grants/:accessId", v("json", z.object({ permission: z.enum(["read", "admin"]).nullable() }).strict()), async (c) => {
      await machineIdentity(identity(c), id(c), "admin");
      return respond(
        c,
        ok(await artifacts.changeGrant(id(c), z.uuid().parse(c.req.param("accessId")), c.req.valid("json").permission, identity(c))),
      );
    })
    .post("/:id/storage", v("json", StorageJsonRequest), async (c) => {
      await machineIdentity(identity(c), id(c));
      return respond(c, ok(await artifacts.storage(id(c), c.req.valid("json"), identity(c))));
    })
    .get("/:id/storage/file", v("query", StorageFileQuery), async (c) => {
      await machineIdentity(identity(c), id(c));
      const result = await artifacts.storage(id(c), { area: "files", operation: "read", key: c.req.valid("query").key }, identity(c));
      if (!("item" in result) || !result.item?.data) throw new ArtifactError("NOT_FOUND");
      return new Response(new Uint8Array(result.item.data), {
        headers: {
          "content-type": result.item.mediaType || "application/octet-stream",
          "content-disposition": "attachment",
          "cache-control": "private, no-store",
        },
      });
    })
    .put("/:id/storage/file", v("query", StorageFileQuery), async (c) => {
      await machineIdentity(identity(c), id(c), "write");
      const maximum = await artifacts.storageFileLimit(id(c), c.req.valid("query").key, identity(c));
      return bodyLimit({ maxSize: maximum })(c, async () => {
        c.res = await respond(
          c,
          ok(
            await artifacts.storage(
              id(c),
              {
                area: "files",
                operation: "write",
                key: c.req.valid("query").key,
                mediaType: c.req.header("content-type") ?? "application/octet-stream",
              },
              identity(c),
              false,
              new Uint8Array(await c.req.arrayBuffer()),
            ),
          ),
        );
      });
    })
    .post("/:id/database", v("json", FlatDatabaseRequest), async (c) => {
      setRequestTimeout(c, 60);
      try {
        await machineIdentity(identity(c), id(c));
        return respond(
          c,
          ok(
            await artifactDatabase.runtime(
              id(c),
              c.req.valid("json"),
              identity(c),
              AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(45000)]),
            ),
          ),
        );
      } finally {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
      }
    })
    .post("/:id/execute", v("json", MachineExecution), async (c) => {
      setRequestTimeout(c, 60);
      try {
        return respond(
          c,
          ok(
            await executeMachine(id(c), c.req.valid("json"), identity(c), {
              signal: c.req.raw.signal,
              locale: getLocale(c),
              timeZone: getTimeZone(c),
            }),
          ),
        );
      } finally {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
      }
    })
    .get("/:id/runs/:requestId", async (c) => {
      const who = identity(c);
      const account = await machineIdentity(who, id(c));
      await artifacts.get(id(c), who, undefined, true);
      await sql`UPDATE assistant.artifact_machine_runs r SET status='failed',error_code='EXECUTION_UNKNOWN',finished_at=now()
      FROM assistant.artifacts a WHERE a.id=r.artifact_id AND a.short_id=${id(c)} AND r.id=${z.uuid().parse(c.req.param("requestId"))}::uuid
      AND r.principal_id=${account.serviceAccountId}::uuid AND r.status='running' AND r.created_at < now() - interval '45 seconds'`;
      const [run] =
        await sql`SELECT r.id,r.version,r.operation,r.status,r.error_code AS "errorCode",r.created_at AS "createdAt",r.finished_at AS "finishedAt"
      FROM assistant.artifact_machine_runs r JOIN assistant.artifacts a ON a.id=r.artifact_id
      WHERE a.short_id=${id(c)} AND r.id=${z.uuid().parse(c.req.param("requestId"))}::uuid AND r.principal_id=${account.serviceAccountId}::uuid`;
      if (!run) throw new ArtifactError("NOT_FOUND");
      return respond(c, ok(run));
    })
    .get("/:id/access", ManagerQuery, async (c) => respond(c, ok(await machineAccess.list(id(c), manager(c)))))
    .put(
      "/:id/access/:accessId",
      ManagerQuery,
      v("json", z.object({ rights: MachineRights, expectedRevision: z.uuid().nullable() }).strict()),
      async (c) =>
        respond(c, ok(await machineAccess.save(id(c), z.uuid().parse(c.req.param("accessId")), c.req.valid("json"), manager(c)))),
    )
    .get("/:id/secrets", ManagerQuery, async (c) => respond(c, ok(await machineAccess.secretList(id(c), manager(c)))))
    .put("/:id/secrets", ManagerQuery, v("json", SecretSave), async (c) =>
      respond(c, ok(await machineAccess.saveSecret(id(c), c.req.valid("json"), manager(c)))),
    )
    .delete("/:id/secrets/:name", ManagerQuery, v("json", z.object({ revision: z.uuid() }).strict()), async (c) =>
      respond(
        c,
        ok(await machineAccess.removeSecret(id(c), z.string().parse(c.req.param("name")), c.req.valid("json").revision, manager(c))),
      ),
    );

export const machineApi = new Hono<AuthContext>()
  .use(rateLimit())
  .use("*", auth.requireRole("authenticated"))
  .route("/", createMachineRoutes());
