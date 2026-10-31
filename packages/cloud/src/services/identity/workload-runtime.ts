/** Core-only workload issuer. This module never reads identity signing keys, OAuth secrets, or sessions. */
import type { NatsConnection } from "@nats-io/transport-node";
import { sql } from "bun";
import { getProcessNats } from "../../_internal/process-sync";
import { APP_REGISTRY_TTL_MS, appInstancePrefix, appInstanceRegistry } from "../../_internal/registry";
import {
  WORKLOAD_CHECK_INTERVAL_MS,
  WORKLOAD_LIFETIME_MS,
  WORKLOAD_ROTATE_BEFORE_MS,
  type WorkloadRequest,
  WorkloadRequestSchema,
  type WorkloadResponse,
  workloadSubject,
} from "../../_internal/workload-protocol";
import { connections } from "../../runtime/connections";
import { audit } from "../audit";
import { logger } from "../logging";
import { serviceAccountCredentials } from "../service-account-credentials";
import { serviceAccounts } from "../service-accounts";

const isRegistered = async (appId: string, instanceId: string): Promise<boolean> => {
  const key = `${appInstancePrefix(appId)}${instanceId}`;
  const snapshot = await appInstanceRegistry().snapshot({ prefix: key });
  return snapshot.entries.some((entry) => entry.key === key && entry.value.appId === appId && entry.value.instanceId === instanceId);
};

export const issueAppWorkloadCredential = async (
  request: WorkloadRequest,
  registered: (appId: string, instanceId: string) => Promise<boolean> = isRegistered,
): Promise<WorkloadResponse> => {
  if (!(await registered(request.appId, request.instanceId))) return { status: "unregistered" };
  const account = await serviceAccounts.getOrCreateResourceBound({
    name: `${request.appId} workload`,
    appId: request.appId,
    resourceType: "cloud.app",
    resourceId: request.appId,
  });
  if (!account.ok) return { status: "unavailable" };
  return sql.begin(async (db) => {
    // One account lock serializes issuance/rotation/removal across Core replicas. Admin revocation
    // locks the credential row too, so it cannot be overwritten by an in-flight refresh.
    const [owner] = await db<{ status: string }[]>`SELECT status FROM auth.service_accounts WHERE id = ${account.data.id}::uuid FOR UPDATE`;
    if (owner?.status !== "active") return { status: "revoked" };
    const [current] = await db<{ id: string; status: string; expires_at: Date; previous_credential_id: string | null }[]>`
      SELECT c.id, c.status, c.expires_at, i.previous_credential_id FROM auth.app_workload_instances i
      JOIN auth.service_account_credentials c ON c.id = i.credential_id
      WHERE i.app_id = ${request.appId} AND i.instance_id = ${request.instanceId}
      FOR UPDATE OF c
    `;
    if (request.operation === "release") {
      if (current?.status === "active") {
        for (const credentialId of [current.id, current.previous_credential_id]) {
          if (!credentialId) continue;
          const revoked = await serviceAccountCredentials.revoke(
            { credentialId, system: { service: "app-workload", reason: "instance stopped" } },
            { db },
          );
          if (!revoked.ok) throw new Error("Stopped workload credential could not be revoked");
        }
        await db`DELETE FROM auth.app_workload_instances WHERE app_id = ${request.appId} AND instance_id = ${request.instanceId}`;
        await db`DELETE FROM auth.service_account_credentials WHERE id = ${current.id}::uuid OR id = ${current.previous_credential_id}::uuid`;
      }
      return { status: "revoked" };
    }
    if (!(await registered(request.appId, request.instanceId))) return { status: "unregistered" };
    await db`UPDATE auth.app_workload_instances SET last_refreshed_at = now()
      WHERE app_id = ${request.appId} AND instance_id = ${request.instanceId}`;
    if (
      current?.status === "active" &&
      current.id === request.credentialId &&
      current.expires_at.getTime() - Date.now() > WORKLOAD_ROTATE_BEFORE_MS
    ) {
      return { status: "current", credentialId: current.id };
    }
    const expiresAt = new Date(Date.now() + WORKLOAD_LIFETIME_MS).toISOString();
    const issued = await serviceAccountCredentials.createApiToken(
      {
        serviceAccountId: account.data.id,
        name: `Runtime ${request.instanceId}`,
        scopes: ["identity:invoke"],
        expiresAt,
      },
      { db },
    );
    if (!issued.ok) return { status: "unavailable" };
    // An acknowledged current token overlaps its successor until expiry. When a reply was
    // lost, replace only the undelivered generation and keep the token the caller still knows.
    const retainedId = current
      ? request.credentialId === current.id
        ? current.id
        : current.previous_credential_id === request.credentialId
          ? current.previous_credential_id
          : null
      : null;
    for (const retiredId of [current?.id, current?.previous_credential_id]) {
      if (!retiredId || retiredId === retainedId) continue;
      const revoked = await serviceAccountCredentials.revoke(
        { credentialId: retiredId, system: { service: "app-workload", reason: "rotation" } },
        { db },
      );
      if (!revoked.ok) throw new Error("Workload rotation could not retire previous credential");
    }
    await db`
      INSERT INTO auth.app_workload_instances (app_id, instance_id, credential_id, previous_credential_id)
      VALUES (${request.appId}, ${request.instanceId}, ${issued.data.credential.id}::uuid, ${retainedId}::uuid)
      ON CONFLICT (app_id, instance_id) DO UPDATE
      SET credential_id = EXCLUDED.credential_id, previous_credential_id = EXCLUDED.previous_credential_id, last_refreshed_at = now()
    `;
    for (const retiredId of [current?.id, current?.previous_credential_id]) {
      if (retiredId && retiredId !== retainedId) await db`DELETE FROM auth.service_account_credentials WHERE id = ${retiredId}::uuid`;
    }
    await audit.record(
      {
        action: "service_account_credential.create",
        outcome: "allowed",
        target: { type: "service_account_credential", id: issued.data.credential.id, label: issued.data.credential.name },
        metadata: {
          provenance: "system",
          service: "app-workload",
          appId: request.appId,
          instanceId: request.instanceId,
          serviceAccountId: account.data.id,
        },
      },
      db,
    );
    // Deliberately construct the response: only a newly minted app-bound token and its coordinates.
    return {
      status: "issued",
      appId: request.appId,
      instanceId: request.instanceId,
      credentialId: issued.data.credential.id,
      token: issued.data.token,
      expiresAt,
    };
  });
};

/** Revoke disappeared instances, including TTL expiry after an ungraceful stop. Pages bound memory. */
export const revokeRemovedAppWorkloads = async (
  registered: (appId: string, instanceId: string) => Promise<boolean> = isRegistered,
): Promise<void> => {
  let afterApp = "";
  let afterInstance = "";
  for (;;) {
    // Same page size as the credential administration API; never materialize credential history.
    const rows = await sql<{ app_id: string; instance_id: string; credential_id: string; service_account_id: string }[]>`
      SELECT i.app_id, i.instance_id, i.credential_id, c.service_account_id
      FROM auth.app_workload_instances i JOIN auth.service_account_credentials c ON c.id = i.credential_id
      WHERE c.status = 'active' AND i.last_refreshed_at < ${new Date(Date.now() - APP_REGISTRY_TTL_MS)} AND (i.app_id, i.instance_id) > (${afterApp}, ${afterInstance})
      ORDER BY i.app_id, i.instance_id LIMIT 100
    `;
    if (!rows.length) return;
    for (const row of rows) {
      afterApp = row.app_id;
      afterInstance = row.instance_id;
      if (await registered(row.app_id, row.instance_id)) continue;
      await sql.begin(async (db) => {
        await db`SELECT id FROM auth.service_accounts WHERE id = ${row.service_account_id}::uuid FOR UPDATE`;
        if (await registered(row.app_id, row.instance_id)) return;
        // Read again under the account lock, in case another Core replica rotated it meanwhile.
        const [current] = await db<
          { credential_id: string; previous_credential_id: string | null; status: string; last_refreshed_at: Date }[]
        >`
          SELECT i.credential_id, i.previous_credential_id, c.status, i.last_refreshed_at FROM auth.app_workload_instances i
          JOIN auth.service_account_credentials c ON c.id = i.credential_id
          WHERE i.app_id = ${row.app_id} AND i.instance_id = ${row.instance_id}
          FOR UPDATE OF c
        `;
        if (current?.status === "active" && current.last_refreshed_at.getTime() < Date.now() - APP_REGISTRY_TTL_MS) {
          for (const credentialId of [current.credential_id, current.previous_credential_id]) {
            if (!credentialId) continue;
            const revoked = await serviceAccountCredentials.revoke(
              { credentialId, system: { service: "app-workload", reason: "instance removed" } },
              { db },
            );
            if (!revoked.ok) throw new Error("Removed workload credential could not be revoked");
          }
          // An automatically retired instance may register again after a registry reset. An
          // admin-revoked credential keeps its mapping and disabled account until explicit recovery.
          await db`DELETE FROM auth.app_workload_instances WHERE app_id = ${row.app_id} AND instance_id = ${row.instance_id}`;
          await db`DELETE FROM auth.service_account_credentials WHERE id = ${current.credential_id}::uuid OR id = ${current.previous_credential_id}::uuid`;
        }
      });
    }
  }
};

export const startAppWorkloadBroker = async (
  options: {
    connection?: NatsConnection;
    namespace?: string;
    issue?: (request: WorkloadRequest) => Promise<WorkloadResponse>;
    reconcile?: () => Promise<void>;
  } = {},
): Promise<() => Promise<void>> => {
  const connection = options.connection ?? getProcessNats();
  const issue = options.issue ?? issueAppWorkloadCredential;
  const reconcile = options.reconcile ?? revokeRemovedAppWorkloads;
  const log = logger("app-workload");
  // Issuance gets four concurrent DB transactions per Core replica, reserving the rest of
  // Bun SQL's default ten-connection pool for identity requests. Overload retries at the caller.
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  let maintenance: Promise<void> | undefined;
  let timer: Timer | undefined;
  const subscription = connection.subscribe(workloadSubject(options.namespace ?? connections().nats.namespace), {
    queue: "core-workload-v1",
    callback: (error, message) => {
      if (error || !message.reply) return;
      // App id, instance id and UUID fit in 1 KiB including JSON escaping. Reject larger input before parsing.
      if (stopped || inFlight.size >= 4 || message.data.length > 1024) {
        message.respond(JSON.stringify({ status: "unavailable" }));
        return;
      }
      const operation = (async () => {
        let response: WorkloadResponse = { status: "unavailable" };
        try {
          const parsed = WorkloadRequestSchema.safeParse(message.json<unknown>());
          if (parsed.success) response = await issue(parsed.data);
        } catch {
          log.error("Workload credential issuance failed; caller will retry");
        }
        if (!stopped) message.respond(JSON.stringify(response));
      })();
      inFlight.add(operation);
      void operation.finally(() => inFlight.delete(operation));
    },
  });
  const maintain = () => {
    maintenance = reconcile()
      .catch(() => {
        log.error("Workload removal reconciliation failed; retrying");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(maintain, WORKLOAD_CHECK_INTERVAL_MS);
      });
  };
  const stop = async () => {
    stopped = true;
    clearTimeout(timer);
    subscription.unsubscribe();
    await Promise.allSettled([...inFlight, ...(maintenance ? [maintenance] : [])]);
  };
  maintain();
  try {
    await connection.flush();
  } catch (error) {
    await stop();
    throw error;
  }
  return stop;
};
