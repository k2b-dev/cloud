import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { appAccess, appRegistry } from "@k2b/cloud";
import { accounts, coreSettings, serviceAccountCredentials } from "@k2b/cloud/services";
import * as notificationPlatform from "@k2b/cloud/services/notifications/platform";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { encryptValue } from "@k2b/cloud/services/settings/crypto";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import * as machineAuthority from "../service/workflow-machine-authority";
import { getWorkflowRunByShortId, getWorkflowRunScope } from "../service/workflow-runs";
import { getWorkflowTriggerRuntimeState, invokeGridsWorkflow, runGridsWorkflowRun } from "../service/workflow-runtime";
import "../../../../scripts/fixtures/authorization-preload";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { app } from "../config";
import { testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess, lockBaseAuthorization, revokeAccess } from "../service/access";
import type { SqlClient } from "../service/audit";
import { apply as applyCustomApp, publish as publishCustomApp } from "../service/custom-apps";
import { enable as enableHistory } from "../service/durable-history";
import { create as createEmailTemplate } from "../service/email-templates";
import { enable as enableFinalization } from "../service/record-finalization";
import { canExecuteRunBeforeHttp, canExecuteWorkflow } from "../service/workflow-action-scope";
import { lockWorkflowCatalogMutation } from "../service/workflow-catalog-mutation";
import { createWorkflow, updateWorkflow } from "../service/workflow-definitions";
import { sendWorkflowEmail } from "../service/workflow-email-send";
import { requestWorkflowHttp } from "../service/workflow-http-client";
import { createLauncher } from "../service/workflow-launchers";
import {
  getWorkflowMachineAuthority,
  machineWorkflowOwnerPrincipal,
  validateWorkflowMachineMandate,
} from "../service/workflow-machine-authority";
import { deleteTestWorkflowScope } from "../service/workflow-test-fixture";
import { type WorkflowMachineAuthorityChange, WorkflowMachineAuthoritySchema } from "../workflows/contracts";
import api from ".";

const suite = suiteFor("database", "nats", "valkey");
beforeAll(async () => {
  if (testInfra.database) await migrate();
});
// Mandate validation resolves the live application through the real test NATS
// registry. Publish the application's actual entry contract, without replacing
// identity, app access, credential or mandate authorization.
beforeEach(async () => {
  if (testInfra.database && testInfra.nats) await appRegistry().upsert({ key: "apps/grids", value: { ...app.meta, baseUrl: app.baseUrl } });
});
afterEach(async () => {
  if (testInfra.database && testInfra.nats) await appRegistry().delete({ key: "apps/grids" });
});
const source = `triggers:
  schedule:
    cron: "0 8 * * *"
    timezone: UTC
steps:
  - succeed:
      message: Done`;
suite("machine workflow execution authority", () => {
  for (const kind of ["standalone", "agent"] as const)
    test(`${kind}: real token, mandate and effect-time revocation remain independent of the administrator`, async () => {
      const ownerId = testUuid(),
        accountId = crypto.randomUUID(),
        baseId = testUuid(),
        otherBaseId = testUuid(),
        ownerAccess = testUuid(),
        machineAccess = testUuid();
      const mandates: string[] = [];
      try {
        await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${ownerId}::uuid,${`workflow-admin-${ownerId}`},'local','user',TRUE)`;
        await sql`INSERT INTO auth.service_accounts(id,name,kind) VALUES(${accountId}::uuid,${`Workflow ${kind}`},${kind})`;
        await sql`INSERT INTO grids.bases(id,short_id,name) VALUES(${baseId}::uuid,${testShortId()},'Machine workflow'),(${otherBaseId}::uuid,${testShortId()},'Other base')`;
        await sql`INSERT INTO auth.access(id,user_id,permission) VALUES(${ownerAccess}::uuid,${ownerId}::uuid,'admin')`;
        await sql`INSERT INTO grids.base_access(base_id,access_id) VALUES(${baseId}::uuid,${ownerAccess}::uuid)`;
        const created = await createWorkflow(baseId, { name: "Scheduled machine work", source, enabled: true }, ownerId);
        if (!created.ok) throw new Error(created.error.message);
        const workflow = created.data;
        const key = await serviceAccountCredentials.createApiToken({
          serviceAccountId: accountId,
          name: "Workflow",
          scopes: ["grids:write"],
        });
        const readKey = await serviceAccountCredentials.createApiToken({
          serviceAccountId: accountId,
          name: "Read",
          scopes: ["grids:read"],
        });
        if (!key.ok || !readKey.ok) throw new Error("Key fixtures failed");
        const cookie = `session_token=${await createTestSession(ownerId)}`;
        const authorization = `Bearer ${key.data.token}`;
        const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = { authorization }) =>
          api.request(path, {
            method,
            headers: {
              ...headers,
              "x-forwarded-for": uniqueCallerAddress(),
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        const authorityPath = `/workflows/${workflow.shortId}/machine-authority`;
        const change = (body: unknown) => call(authorityPath, "PUT", body, { cookie });
        const invoke = (credential = authorization) =>
          call(
            `/workflows/${workflow.shortId}/invoke`,
            "POST",
            { inputs: {}, idempotencyKey: crypto.randomUUID(), mode: "execute" },
            { authorization: credential },
          );
        expect((await invoke()).status).toBe(403);
        expect(
          (await change({ action: "assign", serviceAccountId: accountId, expected: { serviceAccountId: null, mandate: null } })).status,
        ).toBe(403);
        await sql`INSERT INTO auth.access(id,service_account_id,permission) VALUES(${machineAccess}::uuid,${accountId}::uuid,'write')`;
        await sql`INSERT INTO grids.base_access(base_id,access_id) VALUES(${baseId}::uuid,${machineAccess}::uuid)`;
        const assignedResponse = await change({
          action: "assign",
          serviceAccountId: accountId,
          expected: { serviceAccountId: null, mandate: null },
        });
        expect(assignedResponse.status, await assignedResponse.clone().text()).toBe(200);
        const assigned = WorkflowMachineAuthoritySchema.parse(await assignedResponse.json());
        mandates.push(assigned.mandate!.id);
        expect(assigned).toMatchObject({ serviceAccountId: accountId, kind, mandate: { state: "active", permissionCap: "write" } });
        const accepted = await invoke();
        expect(accepted.status).toBe(200);
        const receipt = z.object({ runId: z.string() }).parse(await accepted.json());
        const acceptedRun = await getWorkflowRunByShortId(receipt.runId);
        if (!acceptedRun) throw new Error("Accepted workflow run missing");
        expect((await invoke(`Bearer ${readKey.data.token}`)).status).toBe(403);
        expect(
          (
            await call(authorityPath, "PUT", {
              action: "assign",
              serviceAccountId: accountId,
              expected: { serviceAccountId: null, mandate: null },
            })
          ).status,
        ).toBe(403);
        const principal = await machineWorkflowOwnerPrincipal(workflow.id);
        if (!principal) throw new Error("Missing machine principal");
        const claim = { workflowId: workflow.id, baseId, principal, launcherId: null, authorization: { kind: "workflow" as const } };
        expect(await canExecuteWorkflow(claim)).toBe(true);
        // A domain grant and a live mandate cannot bypass the application's
        // current entry rule, including inside the effect transaction.
        await appRegistry().upsert({
          key: "apps/grids",
          value: { ...app.meta, baseUrl: app.baseUrl, access: appAccess.roles(["admin"]) },
        });
        expect((await invoke()).status).toBe(403);
        expect(await canExecuteWorkflow(claim)).toBe(false);
        expect(await sql.begin((db) => canExecuteWorkflow(claim, db))).toBe(false);
        expect((await getWorkflowTriggerRuntimeState(workflow)).schedule?.state).toBe("degraded");
        await appRegistry().upsert({ key: "apps/grids", value: { ...app.meta, baseUrl: app.baseUrl } });
        expect(await canExecuteWorkflow(claim)).toBe(true);
        expect((await invoke()).status).toBe(200);
        expect(await canExecuteWorkflow({ ...claim, baseId: otherBaseId })).toBe(false);
        expect(await canExecuteWorkflow({ ...claim, workflowId: testUuid() })).toBe(false);
        const pause = await change({ action: "pause", expected: snapshot(assigned) });
        expect(pause.status).toBe(200);
        const paused = WorkflowMachineAuthoritySchema.parse(await pause.json());
        expect((await invoke()).status).toBe(403);
        expect(await canExecuteWorkflow(claim)).toBe(false);
        await runGridsWorkflowRun(acceptedRun.id);
        const [blockedRun] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${acceptedRun.id}::uuid`;
        expect(blockedRun?.state).toBe("failed");
        const resume = await change({ action: "resume", expected: snapshot(paused) });
        expect(resume.status).toBe(200);
        const resumed = WorkflowMachineAuthoritySchema.parse(await resume.json());
        // Resuming creates a new revision; previously queued work stays fenced.
        expect(await canExecuteWorkflow(claim)).toBe(false);
        expect((await invoke()).status).toBe(200);
        await sql`DELETE FROM grids.base_access WHERE base_id=${baseId}::uuid AND access_id=${machineAccess}::uuid`;
        expect((await invoke()).status).toBe(403);
        await sql`INSERT INTO grids.base_access(base_id,access_id) VALUES(${baseId}::uuid,${machineAccess}::uuid)`;
        await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${accountId}::uuid`;
        expect((await invoke()).status).toBe(401);
        const disabledPrincipal = await machineWorkflowOwnerPrincipal(workflow.id);
        expect(await canExecuteWorkflow({ ...claim, principal: disabledPrincipal! })).toBe(false);
        expect((await getWorkflowTriggerRuntimeState(workflow)).schedule?.state).toBe("degraded");
        expect((await getWorkflowTriggerRuntimeState({ ...workflow, enabled: false })).schedule?.state).toBe("paused");
        await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${accountId}::uuid`;
        expect((await change({ action: "revoke", expected: snapshot(resumed) })).status).toBe(200);
        expect((await invoke()).status).toBe(403);
        const state = await call(authorityPath);
        expect(WorkflowMachineAuthoritySchema.parse(await state.json()).mandate?.state).toBe("revoked");
        // Removing the platform row must not turn a configured machine owner
        // into an ordinary token-only invocation with a wider authority path.
        await sql`DELETE FROM auth.mandates WHERE id=${resumed.mandate!.id}::uuid`;
        expect((await invoke()).status).toBe(403);
      } finally {
        await deleteTestWorkflowScope(baseId);
        for (const id of mandates) await sql`DELETE FROM auth.mandates WHERE id=${id}::uuid`;
        await sql`DELETE FROM grids.bases WHERE id IN (${baseId}::uuid,${otherBaseId}::uuid)`;
        await sql`DELETE FROM auth.access WHERE id IN (${ownerAccess}::uuid,${machineAccess}::uuid)`;
        await sql`DELETE FROM auth.service_accounts WHERE id=${accountId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${ownerId}::uuid`;
      }
    });
});

const snapshot = (value: { serviceAccountId: string | null; mandate: { id: string; revision: number } | null }) => ({
  serviceAccountId: value.serviceAccountId,
  mandate: value.mandate ? { id: value.mandate.id, revision: value.mandate.revision } : null,
});
const emptyAuthority = { serviceAccountId: null, mandate: null };

const authorityFixture = async (write = false) => {
  const ownerId = testUuid(),
    keeperId = testUuid(),
    baseId = testUuid();
  // Credential creation accepts the UUID format used by real service accounts.
  const accountIds = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const accessIds = [testUuid(), testUuid(), testUuid(), testUuid()];
  await sql`INSERT INTO auth.users(id,uid,provider,profile,admin)
    VALUES(${ownerId}::uuid,${`authority-owner-${ownerId}`},'local','user',TRUE),
      (${keeperId}::uuid,${`authority-keeper-${keeperId}`},'local','user',TRUE)`;
  await sql`INSERT INTO auth.service_accounts(id,name,kind)
    VALUES(${accountIds[0]!}::uuid,'Inventory agent','agent'),(${accountIds[1]!}::uuid,'Inventory service','standalone')`;
  await sql`INSERT INTO grids.bases(id,short_id,name) VALUES(${baseId}::uuid,${testShortId()},'Authority concurrency')`;
  for (const [index, id] of [ownerId, keeperId].entries())
    await sql`INSERT INTO auth.access(id,user_id,permission) VALUES(${accessIds[index]!}::uuid,${id}::uuid,'admin')`;
  for (const [index, id] of accountIds.entries())
    await sql`INSERT INTO auth.access(id,service_account_id,permission) VALUES(${accessIds[index + 2]!}::uuid,${id}::uuid,'write')`;
  for (const id of accessIds) await sql`INSERT INTO grids.base_access(base_id,access_id) VALUES(${baseId}::uuid,${id}::uuid)`;
  const tableId = testUuid();
  if (write) {
    await sql`INSERT INTO grids.tables(id,short_id,base_id,name,position) VALUES(${tableId}::uuid,${testShortId()},${baseId}::uuid,'Tasks',0)`;
    await sql`INSERT INTO grids.fields(id,short_id,table_id,name,type,config,position)
      VALUES(${testUuid()}::uuid,${testShortId()},${tableId}::uuid,'Name','text','{}'::jsonb,0)`;
  }
  const workflow = await createWorkflow(
    baseId,
    {
      name: "Authority concurrency",
      source: write ? "steps:\n  - createRecord:\n      table: Tasks\n      values:\n        Name: Created by machine" : source,
      enabled: true,
    },
    ownerId,
  );
  if (!workflow.ok) throw new Error(workflow.error.message);
  const cookie = `session_token=${await createTestSession(ownerId)}`;
  const change = async (body: WorkflowMachineAuthorityChange) =>
    api.request(`/workflows/${workflow.data.shortId}/machine-authority`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
      body: JSON.stringify(body),
    });
  const assign = async (serviceAccountId = accountIds[0]!, expected: ReturnType<typeof snapshot> = emptyAuthority) => {
    const response = await change({ action: "assign", serviceAccountId, expected });
    expect(response.status, await response.clone().text()).toBe(200);
    return WorkflowMachineAuthoritySchema.parse(await response.json());
  };
  return {
    ownerId,
    tableId,
    keeperId,
    baseId,
    accountIds,
    accessIds,
    workflow: workflow.data,
    change,
    assign,
    cleanup: async () => {
      await deleteTestWorkflowScope(baseId);
      await sql`DELETE FROM auth.mandates WHERE owner_app_id='grids' AND workload_type='grids.workflow' AND workload_id=${workflow.data.id}`;
      await sql`DELETE FROM grids.bases WHERE id=${baseId}::uuid`;
      for (const id of accessIds) await sql`DELETE FROM auth.access WHERE id=${id}::uuid`;
      for (const id of accountIds) await sql`DELETE FROM auth.service_accounts WHERE id=${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid,${keeperId}::uuid)`;
    },
  };
};

// Observe the real waiter before releasing or deleting the locked row. The
// deadline bounds a failed test, never application authorization or retry work.
const waitForBlocked = async (blocker: number) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await sql<{ waiting: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}::int=ANY(pg_blocking_pids(pid))
    ) AS waiting`;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("Authority operation never reached the database lock barrier");
};
const responseWithinLock = async (pending: Promise<Response>): Promise<Response> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Authority mutation waited instead of releasing its account locks")), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
const locked = async <T>(lock: (db: SqlClient) => Promise<unknown>, work: (db: SqlClient, pid: number) => Promise<T>) =>
  sql.begin(async (db) => {
    await lock(db);
    const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    if (!backend) throw new Error("Missing database backend");
    return work(db, backend.pid);
  });

suite("machine authority concurrency", () => {
  test("all changes reject a replaced mandate with the same revision, including initial and existing assignments", async () => {
    const f = await authorityFixture();
    try {
      const first = await f.assign();
      const firstPause = await f.change({ action: "pause", expected: snapshot(first) });
      const stale = snapshot(WorkflowMachineAuthoritySchema.parse(await firstPause.json()));
      const second = await f.assign(f.accountIds[1]!, stale);
      const secondPause = await f.change({ action: "pause", expected: snapshot(second) });
      const paused = WorkflowMachineAuthoritySchema.parse(await secondPause.json());
      expect(paused.mandate!.revision).toBe(stale.mandate!.revision);
      expect(paused.mandate!.id).not.toBe(stale.mandate!.id);
      for (const action of ["pause", "resume", "revoke"] as const) expect((await f.change({ action, expected: stale })).status).toBe(409);
      expect((await f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: stale })).status).toBe(409);
      expect((await f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: emptyAuthority })).status).toBe(409);
      expect(await getWorkflowMachineAuthority(f.workflow.id)).toMatchObject({
        serviceAccountId: f.accountIds[1],
        mandate: paused.mandate ? { id: paused.mandate.id, state: "paused", revision: 2 } : null,
      });
      expect((await f.change({ action: "resume", expected: snapshot(paused) })).status).toBe(200);
    } finally {
      await f.cleanup();
    }
  });

  for (const provider of ["local", "ipa"] as const)
    test(`${provider} installation administration revoked during an account lock wait cannot assign authority`, async () => {
      const f = await authorityFixture();
      let pending: Promise<Response> | undefined;
      try {
        if (provider === "ipa") {
          await sql`UPDATE auth.users SET provider='ipa',admin=FALSE WHERE id=${f.ownerId}::uuid`;
          await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${f.ownerId}::uuid,'admins')`;
          // Canonical IPA authority does not require a mirrored auth.groups row.
          expect((await accounts.users.getRoles(f.ownerId)).includes("admin")).toBe(true);
        }
        await locked(
          (db) => db`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[0]!}::uuid FOR UPDATE`,
          async (_db, pid) => {
            pending = f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: emptyAuthority });
            await waitForBlocked(pid);
            if (provider === "local") expect((await accounts.users.setAdmin({ id: f.ownerId, admin: false })).ok).toBe(true);
            else await sql`DELETE FROM auth.ipa_user_effective_groups WHERE user_id=${f.ownerId}::uuid`;
          },
        );
        expect((await pending!).status).toBe(403);
        expect(await getWorkflowMachineAuthority(f.workflow.id)).toMatchObject({ serviceAccountId: null, mandate: null });
      } finally {
        await Promise.allSettled(pending ? [pending] : []);
        await f.cleanup();
      }
    });

  test("canonical IPA installation authority can assign, and rejects stale captured admin roles", async () => {
    const f = await authorityFixture();
    try {
      await sql`UPDATE auth.users SET provider='ipa',admin=FALSE WHERE id=${f.ownerId}::uuid`;
      await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${f.ownerId}::uuid,'admins')`;
      const assigned = await f.assign();
      expect(assigned.mandate?.state).toBe("active");
      const user = await accounts.users.get({ id: f.ownerId });
      if (!user) throw new Error("Actor missing");
      expect(user.roles).toContain("admin");
      await sql`DELETE FROM auth.ipa_user_effective_groups WHERE user_id=${f.ownerId}::uuid`;
      await sql.begin(async (db) => {
        expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user }, db)).toBe(false);
      });
      expect((await f.change({ action: "pause", expected: snapshot(assigned) })).status).toBe(403);
    } finally {
      await f.cleanup();
    }
  });

  for (const provider of ["local", "ipa"] as const)
    test(`${provider} installation authority remains locked through the domain commit`, async () => {
      const f = await authorityFixture();
      let revoking: Promise<unknown> | undefined;
      try {
        if (provider === "ipa") {
          await sql`UPDATE auth.users SET provider='ipa',admin=FALSE WHERE id=${f.ownerId}::uuid`;
          await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${f.ownerId}::uuid,'admins')`;
        }
        const user = await accounts.users.get({ id: f.ownerId });
        if (!user) throw new Error("Actor missing");
        await sql.begin(async (db) => {
          expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user }, db)).toBe(true);
          const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          if (!backend) throw new Error("Missing database backend");
          revoking =
            provider === "local"
              ? accounts.users.setAdmin({ id: f.ownerId, admin: false })
              : sql`DELETE FROM auth.ipa_user_effective_groups WHERE user_id=${f.ownerId}::uuid`.execute();
          await waitForBlocked(backend.pid);
          expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user }, db)).toBe(true);
        });
        await revoking;
        await sql.begin(async (db) => {
          expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user }, db)).toBe(false);
        });
      } finally {
        await Promise.allSettled(revoking ? [revoking] : []);
        await f.cleanup();
      }
    });

  test("IPA projection replacement during a lock wait remains fenced through commit", async () => {
    const f = await authorityFixture();
    let pending: Promise<void> | undefined;
    let revoking: Promise<unknown> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let validated!: () => void;
    const reached = new Promise<void>((resolve) => {
      validated = resolve;
    });
    let authorityPid = 0;
    try {
      await sql`UPDATE auth.users SET provider='ipa',admin=FALSE WHERE id=${f.ownerId}::uuid`;
      await sql`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${f.ownerId}::uuid,'admins')`;
      const user = await accounts.users.get({ id: f.ownerId });
      if (!user) throw new Error("Actor missing");
      await locked(
        async (db) => {
          await db`DELETE FROM auth.ipa_user_effective_groups WHERE user_id=${f.ownerId}::uuid`;
          await db`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${f.ownerId}::uuid,'admins')`;
        },
        async (_db, pid) => {
          pending = sql.begin(async (tx) => {
            expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user }, tx)).toBe(true);
            const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            if (!backend) throw new Error("Missing database backend");
            authorityPid = backend.pid;
            validated();
            await gate;
          });
          await waitForBlocked(pid);
        },
      );
      await Promise.race([
        reached,
        pending!.then(() => {
          throw new Error("Authority transaction ended before the barrier");
        }),
      ]);
      revoking = sql`DELETE FROM auth.ipa_user_effective_groups WHERE user_id=${f.ownerId}::uuid`.execute();
      await waitForBlocked(authorityPid);
      release();
      await pending;
      await revoking;
    } finally {
      release();
      await Promise.allSettled([...(pending ? [pending] : []), ...(revoking ? [revoking] : [])]);
      await f.cleanup();
    }
  });

  test("installation authority reads transaction-local IPA configuration, not the settings cache", async () => {
    const f = await authorityFixture();
    const rollback = new Error("rollback authority settings fixture");
    try {
      const user = await accounts.users.get({ id: f.ownerId });
      if (!user) throw new Error("Actor missing");
      try {
        await sql.begin(async (db) => {
          await db`UPDATE auth.users SET provider='ipa',admin=FALSE WHERE id=${f.ownerId}::uuid`;
          await db`INSERT INTO auth.ipa_user_effective_groups(user_id,group_name) VALUES(${f.ownerId}::uuid,'workflow administrators')`;
          await db`INSERT INTO settings.entries(key,value) VALUES('freeipa.groups.admin',${await encryptValue([" workflow administrators "])})
            ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
          expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user }, db)).toBe(true);
          expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user, sessionKind: "app" }, db)).toBe(false);
          expect(
            await accounts.users.hasInstallationAdminInTransaction(
              { kind: "user", user: { ...user, roles: ["user", "local", "local/user"] } },
              db,
            ),
          ).toBe(false);
          await db`UPDATE settings.entries SET value=${await encryptValue(["other administrators"])} WHERE key='freeipa.groups.admin'`;
          expect(await accounts.users.hasInstallationAdminInTransaction({ kind: "user", user }, db)).toBe(false);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    } finally {
      await f.cleanup();
    }
  });

  test("user deletion commits while assignment waits on an account, without retaining a user lock", async () => {
    const f = await authorityFixture();
    let pending: Promise<Response> | undefined;
    try {
      await sql`UPDATE auth.service_accounts SET created_by=${f.ownerId}::uuid WHERE id=${f.accountIds[0]!}::uuid`;
      await locked(
        async (db) => {
          await db`SELECT id FROM auth.users WHERE id=${f.ownerId}::uuid FOR UPDATE`;
          await db`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[0]!}::uuid FOR UPDATE`;
        },
        async (db, pid) => {
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: emptyAuthority });
          await waitForBlocked(pid);
          await db`DELETE FROM auth.users WHERE id=${f.ownerId}::uuid`;
        },
      );
      expect((await pending!).status).toBe(403);
      expect((await getWorkflowMachineAuthority(f.workflow.id))?.mandate).toBeNull();
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await f.cleanup();
    }
  });

  test("a busy acting user rolls assignment back before its deletion reaches an account", async () => {
    const f = await authorityFixture();
    let pending: Promise<Response> | undefined;
    try {
      await sql`UPDATE auth.service_accounts SET created_by=${f.ownerId}::uuid WHERE id=${f.accountIds[0]!}::uuid`;
      await locked(
        (db) => db`SELECT id FROM auth.users WHERE id=${f.ownerId}::uuid FOR UPDATE`,
        async (db) => {
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: emptyAuthority });
          expect((await responseWithinLock(pending)).status).toBe(409);
          await db`DELETE FROM auth.users WHERE id=${f.ownerId}::uuid`;
        },
      );
      expect((await getWorkflowMachineAuthority(f.workflow.id))?.mandate).toBeNull();
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await f.cleanup();
    }
  });

  test("creator deletion and a waiting grant mutation cannot invert account and membership locks", async () => {
    const f = await authorityFixture();
    let pending: Promise<Response> | undefined;
    let grantWaiter: Promise<unknown> | undefined;
    try {
      await sql`UPDATE auth.service_accounts SET created_by=${f.keeperId}::uuid WHERE id=${f.accountIds[0]!}::uuid`;
      await locked(
        (db) => db`LOCK TABLE auth.user_groups_v2 IN ROW EXCLUSIVE MODE`,
        async (db, pid) => {
          grantWaiter = sql.begin((tx) => lockBaseAuthorization([f.baseId], tx));
          await waitForBlocked(pid);
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: emptyAuthority });
          expect((await responseWithinLock(pending)).status).toBe(409);
          // The failed assignment released its account locks, so the creator's
          // cascade can finish before this transaction releases memberships.
          await db`DELETE FROM auth.users WHERE id=${f.keeperId}::uuid`;
        },
      );
      await grantWaiter;
      expect((await getWorkflowMachineAuthority(f.workflow.id))?.mandate).toBeNull();
    } finally {
      await Promise.allSettled([...(pending ? [pending] : []), ...(grantWaiter ? [grantWaiter] : [])]);
      await f.cleanup();
    }
  });

  test("assignment rechecks base administration revoked while waiting on the machine account", async () => {
    const f = await authorityFixture();
    let pending: Promise<Response> | undefined;
    try {
      await locked(
        (db) => db`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[0]!}::uuid FOR UPDATE`,
        async (_db, pid) => {
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: emptyAuthority });
          await waitForBlocked(pid);
          const revoked = await revokeAccess(f.accessIds[0]!, f.keeperId, {
            subject: { type: "user", userId: f.keeperId },
            permissionCap: "admin",
          });
          expect(revoked.ok).toBe(true);
        },
      );
      expect((await pending!).status).toBe(403);
      expect(await getWorkflowMachineAuthority(f.workflow.id)).toMatchObject({ serviceAccountId: null, mandate: null });
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await f.cleanup();
    }
  });

  test("assignment also rechecks administration after waiting for the base authorization lock", async () => {
    const f = await authorityFixture();
    let pending: Promise<Response> | undefined;
    try {
      await locked(
        (db) => lockBaseAuthorization([f.baseId], db),
        async (db, pid) => {
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[0]!, expected: emptyAuthority });
          await waitForBlocked(pid);
          await db`DELETE FROM auth.access WHERE id=${f.accessIds[0]!}::uuid`;
        },
      );
      expect((await pending!).status).toBe(403);
      expect(await getWorkflowMachineAuthority(f.workflow.id)).toMatchObject({ serviceAccountId: null, mandate: null });
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await f.cleanup();
    }
  });

  test("a busy proposed account rejects reassignment and releases the current owner's lock", async () => {
    const f = await authorityFixture();
    let pending: Promise<Response> | undefined;
    try {
      const first = await f.assign();
      await locked(
        (db) => db`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[1]!}::uuid FOR UPDATE`,
        async (_db) => {
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[1]!, expected: snapshot(first) });
          expect((await responseWithinLock(pending)).status).toBe(409);
          await f.assign(f.accountIds[0]!, snapshot(first));
        },
      );
      expect((await pending!).status).toBe(409);
      expect((await getWorkflowMachineAuthority(f.workflow.id))?.serviceAccountId).toBe(f.accountIds[0]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await f.cleanup();
    }
  });

  test("two distinct IPA creators can be deleted in one batch while reassignment contends on its second account", async () => {
    const f = await authorityFixture();
    const secondCreator = testUuid();
    let pending: Promise<Response> | undefined;
    try {
      await sql`UPDATE auth.users SET provider='ipa',admin=FALSE WHERE id=${f.keeperId}::uuid`;
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${secondCreator}::uuid,${`creator-${secondCreator}`},'ipa','user')`;
      await sql`UPDATE auth.service_accounts SET created_by=${f.keeperId}::uuid WHERE id=${f.accountIds[0]!}::uuid`;
      await sql`UPDATE auth.service_accounts SET created_by=${secondCreator}::uuid WHERE id=${f.accountIds[1]!}::uuid`;
      const first = await f.assign();
      await locked(
        (db) => db`DELETE FROM auth.users WHERE id=${secondCreator}::uuid`,
        async (db) => {
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[1]!, expected: snapshot(first) });
          expect((await responseWithinLock(pending)).status).toBe(409);
          // Canonical IPA sync retains both creator cascades in this transaction.
          await db`DELETE FROM auth.users WHERE id=${f.keeperId}::uuid`;
        },
      );
      expect((await getWorkflowMachineAuthority(f.workflow.id))?.serviceAccountId).toBe(f.accountIds[0]);
      const rows = await sql<{ created_by: string | null }[]>`SELECT created_by FROM auth.service_accounts
        WHERE id IN (${f.accountIds[0]!}::uuid,${f.accountIds[1]!}::uuid)`;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.created_by === null)).toBe(true);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await f.cleanup();
      await sql`DELETE FROM auth.users WHERE id=${secondCreator}::uuid`;
    }
  });

  for (const action of ["assign", "pause", "resume", "revoke", "effect"] as const)
    test(`account deletion commits while ${action} waits, without retaining a profile or mandate lock`, async () => {
      const f = await authorityFixture();
      let pending: Promise<Response | boolean> | undefined;
      try {
        let current = await f.assign();
        if (action === "resume") {
          const response = await f.change({ action: "pause", expected: snapshot(current) });
          current = WorkflowMachineAuthoritySchema.parse(await response.json());
        }
        const principal = await machineWorkflowOwnerPrincipal(f.workflow.id);
        if (!principal) throw new Error("Missing principal");
        await locked(
          (db) => db`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[0]!}::uuid FOR UPDATE`,
          async (db, pid) => {
            pending =
              action === "effect"
                ? sql.begin((tx) => validateWorkflowMachineMandate(principal, f.baseId, tx))
                : f.change(
                    action === "assign"
                      ? { action, serviceAccountId: f.accountIds[1]!, expected: snapshot(current) }
                      : { action, expected: snapshot(current) },
                  );
            await waitForBlocked(pid);
            await db`DELETE FROM auth.service_accounts WHERE id=${f.accountIds[0]!}::uuid`;
          },
        );
        const result = await pending!;
        if (typeof result === "boolean") expect(result).toBe(false);
        else expect(result.status).toBe(409);
        expect(await getWorkflowMachineAuthority(f.workflow.id)).toMatchObject({
          ownerUserId: null,
          serviceAccountId: null,
          mandate: null,
        });
        expect((await getWorkflowTriggerRuntimeState(f.workflow)).schedule?.state).toBe("degraded");
      } finally {
        await Promise.allSettled(pending ? [pending] : []);
        await f.cleanup();
      }
    });

  for (const action of ["assign", "effect"] as const)
    test(`mandate deletion commits while ${action} waits before the profile lock`, async () => {
      const f = await authorityFixture();
      let pending: Promise<Response | boolean> | undefined;
      try {
        const current = await f.assign();
        const principal = await machineWorkflowOwnerPrincipal(f.workflow.id);
        if (!principal) throw new Error("Missing principal");
        await locked(
          (db) => db`SELECT id FROM auth.mandates WHERE id=${current.mandate!.id}::uuid FOR UPDATE`,
          async (db, pid) => {
            pending =
              action === "effect"
                ? sql.begin((tx) => validateWorkflowMachineMandate(principal, f.baseId, tx))
                : f.change({ action, serviceAccountId: f.accountIds[1]!, expected: snapshot(current) });
            await waitForBlocked(pid);
            await db`DELETE FROM auth.mandates WHERE id=${current.mandate!.id}::uuid`;
          },
        );
        const result = await pending!;
        if (typeof result === "boolean") expect(result).toBe(false);
        else expect(result.status).toBe(409);
        expect((await getWorkflowMachineAuthority(f.workflow.id))?.mandate).toBeNull();
      } finally {
        await Promise.allSettled(pending ? [pending] : []);
        await f.cleanup();
      }
    });
});

suite("machine owner changes preserve independent callers", () => {
  for (const caller of ["human", "unrelated machine"] as const)
    test(`${caller}: a previously queued domain write retains its own authority`, async () => {
      const f = await authorityFixture(true);
      try {
        let headers: Record<string, string>;
        if (caller === "human") headers = { cookie: `session_token=${await createTestSession(f.ownerId)}` };
        else {
          const token = await serviceAccountCredentials.createApiToken({
            serviceAccountId: f.accountIds[1]!,
            name: "Independent caller",
            scopes: ["grids:write"],
          });
          if (!token.ok) throw new Error(token.error.message);
          headers = { authorization: `Bearer ${token.data.token}` };
        }
        const response = await api.request(`/workflows/${f.workflow.shortId}/invoke`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
          body: JSON.stringify({ inputs: {}, idempotencyKey: crypto.randomUUID(), mode: "execute" }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const receipt = z.object({ runId: z.string() }).parse(await response.json());
        const run = await getWorkflowRunByShortId(receipt.runId);
        if (!run) throw new Error("Queued run missing");
        const owner = await f.assign();
        expect((await f.change({ action: "revoke", expected: snapshot(owner) })).status).toBe(200);
        await runGridsWorkflowRun(run.id);
        const [finished] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${run.id}::uuid`;
        expect(finished?.state).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.records WHERE table_id=${f.tableId}::uuid`).toHaveLength(1);
      } finally {
        await f.cleanup();
      }
    });
});

suite("credential snapshots queued before machine owner assignment", () => {
  for (const kind of ["standalone", "agent"] as const)
    for (const lifecycle of ["active", "pause", "revoke", "delete"] as const)
      for (const boundary of ["execution", "transactional effect"] as const)
        test(`${kind}: ${lifecycle} rejects a stale createRecord run at ${boundary}`, async () => {
          const f = await authorityFixture(true);
          let pending: ReturnType<typeof runGridsWorkflowRun> | undefined;
          let release: (() => void) | undefined;
          let barrier: ReturnType<typeof spyOn<typeof machineAuthority, "validateWorkflowOwnerSnapshot">> | undefined;
          try {
            const accountId = f.accountIds[0]!;
            await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id=${accountId}::uuid`;
            const token = await serviceAccountCredentials.createApiToken({
              serviceAccountId: accountId,
              name: "Queued write",
              scopes: ["grids:write"],
            });
            if (!token.ok) throw new Error(token.error.message);
            const queue = async () => {
              const response = await api.request(`/workflows/${f.workflow.shortId}/invoke`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token.data.token}`,
                  "content-type": "application/json",
                  "x-forwarded-for": uniqueCallerAddress(),
                },
                body: JSON.stringify({ inputs: {}, idempotencyKey: crypto.randomUUID(), mode: "execute" }),
              });
              expect(response.status, await response.clone().text()).toBe(200);
              const receipt = z.object({ runId: z.string() }).parse(await response.json());
              const run = await getWorkflowRunByShortId(receipt.runId);
              if (!run) throw new Error("Queued run missing");
              return run;
            };
            // Prove this exact token, source, grant and domain write work before assignment.
            const baseline = await queue();
            await runGridsWorkflowRun(baseline.id);
            const records = () => sql`SELECT id FROM grids.records WHERE table_id=${f.tableId}::uuid`;
            expect(await records()).toHaveLength(1);
            const run = await queue();
            const accepted = await getWorkflowRunScope(run.id);
            expect(accepted?.principal.credential?.id).toBeTruthy();
            expect(accepted?.principal.mandate ?? null).toBeNull();
            if (!accepted) throw new Error("Queued scope missing");
            expect(await canExecuteWorkflow({ ...accepted, workflowId: f.workflow.id })).toBe(true);
            if (boundary === "transactional effect") {
              let entered!: () => void;
              const reached = new Promise<void>((resolve) => {
                entered = resolve;
              });
              const gate = new Promise<void>((resolve) => {
                release = resolve;
              });
              const original = machineAuthority.validateWorkflowOwnerSnapshot;
              let first = true;
              barrier = spyOn(machineAuthority, "validateWorkflowOwnerSnapshot").mockImplementation(async (...args) => {
                if (first && args[2] !== undefined) {
                  first = false;
                  entered();
                  await gate;
                }
                return original(...args);
              });
              // Pause inside the actual createRecord transaction before its
              // authority read. No authorization result is replaced or skipped.
              pending = runGridsWorkflowRun(run.id);
              await Promise.race([
                reached,
                pending.then(() => {
                  throw new Error("Run ended before the transactional authority barrier");
                }),
              ]);
            }
            const assigned = await f.assign(accountId);
            if (lifecycle === "delete") await sql`DELETE FROM auth.mandates WHERE id=${assigned.mandate!.id}::uuid`;
            else if (lifecycle !== "active") expect((await f.change({ action: lifecycle, expected: snapshot(assigned) })).status).toBe(200);
            if (boundary === "execution") expect(await canExecuteWorkflow({ ...accepted, workflowId: f.workflow.id })).toBe(false);
            release?.();
            await (pending ?? runGridsWorkflowRun(run.id));
            const [failed] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${run.id}::uuid`;
            expect(failed?.state).toBe("failed");
            if (boundary === "transactional effect") {
              const outcomes = await sql<{ outcome: { error?: { code?: string } } }[]>`
                SELECT outcome->'outcome' AS outcome FROM workflows.step_outcome WHERE run_id=${run.id}::uuid`;
              expect(outcomes.some((row) => row.outcome?.error?.code === "FORBIDDEN")).toBe(true);
            }
            expect(await records()).toHaveLength(1);
            expect((await getWorkflowRunScope(run.id))?.principal.mandate ?? null).toBeNull();
            const effects = await sql`SELECT id FROM grids.audit_log WHERE base_id=${f.baseId}::uuid AND action='workflow.record.created'`;
            expect(effects).toHaveLength(1);
            if (lifecycle === "active") {
              const fresh = await queue();
              expect((await getWorkflowRunScope(fresh.id))?.principal.mandate).toEqual({
                id: assigned.mandate!.id,
                revision: assigned.mandate!.revision,
                workflowId: f.workflow.id,
              });
              await runGridsWorkflowRun(fresh.id);
              expect(await records()).toHaveLength(2);
              const [finished] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${fresh.id}::uuid`;
              expect(finished?.state).toBe("succeeded");
            }
          } finally {
            release?.();
            await Promise.allSettled(pending ? [pending] : []);
            barrier?.mockRestore();
            await f.cleanup();
          }
        });
});

suite("machine email authority at each recipient", () => {
  for (const kind of ["standalone", "agent"] as const)
    for (const loss of ["revoke", "disable"] as const)
      for (const caller of ["owner", "human", "unrelated machine"] as const)
        test(`${kind}: ${loss} between recipients preserves completed mail for ${caller}`, async () => {
          const f = await authorityFixture();
          let pending: ReturnType<typeof runGridsWorkflowRun> | undefined;
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let entered!: () => void;
          const reached = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const sentIds: string[] = [];
          const send = spyOn(notificationPlatform, "sendTypedNotification").mockImplementation(async () => {
            const id = testUuid();
            sentIds.push(id);
            if (sentIds.length === 1) {
              entered();
              await gate;
            }
            return { id, created: true, status: "delivered", deliveries: [] };
          });
          try {
            await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id IN (${f.accountIds[0]!}::uuid,${f.accountIds[1]!}::uuid)`;
            const template = await createEmailTemplate(
              f.baseId,
              { name: "Recipient notice", subject: "Notice", html: "<p>Notice</p>" },
              f.ownerId,
            );
            if (!template.ok) throw new Error(template.error.message);
            const updated = await updateWorkflow(
              f.workflow.id,
              {
                source:
                  "steps:\n  - sendEmail:\n      template: Recipient notice\n      to:\n        - email: first@example.invalid\n        - email: second@example.invalid",
              },
              f.ownerId,
              f.workflow.revision,
            );
            if (!updated.ok) throw new Error(updated.error.message);
            const assigned = await f.assign();
            let headers: Record<string, string>;
            if (caller === "human") headers = { cookie: `session_token=${await createTestSession(f.ownerId)}` };
            else {
              const token = await serviceAccountCredentials.createApiToken({
                serviceAccountId: f.accountIds[caller === "owner" ? 0 : 1]!,
                name: "Recipient sender",
                scopes: ["grids:write"],
              });
              if (!token.ok) throw new Error(token.error.message);
              headers = { authorization: `Bearer ${token.data.token}` };
            }
            const response = await api.request(`/workflows/${f.workflow.shortId}/invoke`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
              body: JSON.stringify({ inputs: {}, idempotencyKey: crypto.randomUUID(), mode: "execute" }),
            });
            expect(response.status, await response.clone().text()).toBe(200);
            const receipt = z.object({ runId: z.string() }).parse(await response.json());
            const run = await getWorkflowRunByShortId(receipt.runId);
            if (!run) throw new Error("Email run missing");
            const scope = await getWorkflowRunScope(run.id);
            if (!scope) throw new Error("Email scope missing");
            expect(Boolean(scope.principal.mandate)).toBe(caller === "owner");
            pending = runGridsWorkflowRun(run.id);
            await Promise.race([
              reached,
              pending.then(() => {
                throw new Error("Run ended before the first send");
              }),
            ]);
            if (loss === "revoke") expect((await f.change({ action: "revoke", expected: snapshot(assigned) })).status).toBe(200);
            else await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${f.accountIds[0]!}::uuid`;
            release();
            await pending;
            const [finished] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${run.id}::uuid`;
            expect(finished?.state).toBe(caller === "owner" ? "failed" : "succeeded");
            expect(sentIds).toHaveLength(caller === "owner" ? 1 : 2);
            const deliveries = await sql<
              { status: string; notification_id: string | null; workflow_step_key: string; idempotency_key: string }[]
            >`
              SELECT status, notification_id, workflow_step_key, idempotency_key FROM grids.workflow_email_deliveries
              WHERE workflow_run_id=${run.id}::uuid ORDER BY recipient_index`;
            expect(deliveries).toHaveLength(2);
            expect(deliveries[0]).toMatchObject({ status: "sent", notification_id: sentIds[0] });
            expect(deliveries[1]).toMatchObject(
              caller === "owner" ? { status: "pending", notification_id: null } : { status: "sent", notification_id: sentIds[1] },
            );
            const audits = await sql<
              { user_id: string | null; identity: { actorServiceAccountId: string | null; mandateId: string | null } }[]
            >`
              SELECT user_id, diff->'workflowEmail'->'new' AS identity FROM grids.audit_log
              WHERE base_id=${f.baseId}::uuid AND action='workflow.email.sent' ORDER BY created_at`;
            expect(audits).toHaveLength(sentIds.length);
            expect(audits[0]).toMatchObject({
              user_id: caller === "human" ? f.ownerId : null,
              identity: {
                actorServiceAccountId: caller === "human" ? null : f.accountIds[caller === "owner" ? 0 : 1],
                mandateId: caller === "owner" ? assigned.mandate!.id : null,
              },
            });
            if (caller === "owner") {
              const outcomes = await sql<
                { code: string | null }[]
              >`SELECT outcome->'outcome'->'error'->>'code' AS code FROM workflows.step_outcome WHERE run_id=${run.id}::uuid`;
              expect(outcomes.some((row) => row.code === "FORBIDDEN")).toBe(true);
              const replay = () =>
                sendWorkflowEmail({
                  scope,
                  template: template.data,
                  recipients: [
                    { kind: "email", value: "first@example.invalid" },
                    { kind: "email", value: "second@example.invalid" },
                  ],
                  data: {},
                  occurredAt: "2026-10-23T08:00:00.000Z",
                  effectKey: deliveries[0]!.idempotency_key.replace(/:recipient:1$/, ""),
                  workflowStepKey: deliveries[0]!.workflow_step_key,
                });
              await expect(replay()).rejects.toMatchObject({ code: "FORBIDDEN" });
              expect(sentIds).toHaveLength(1);
              if (loss === "disable") {
                await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${f.accountIds[0]!}::uuid`;
                await replay();
                expect(sentIds).toHaveLength(2);
                const restored = await sql<
                  { status: string; notification_id: string | null }[]
                >`SELECT status, notification_id FROM grids.workflow_email_deliveries WHERE workflow_run_id=${run.id}::uuid ORDER BY recipient_index`;
                expect(restored.map((delivery) => delivery.status)).toEqual(["sent", "sent"]);
                expect(restored.map((delivery) => delivery.notification_id)).toEqual(sentIds);
              }
            }
          } finally {
            release();
            await Promise.allSettled(pending ? [pending] : []);
            send.mockRestore();
            await f.cleanup();
          }
        });
});

suite("published App machine-owner admission", () => {
  for (const kind of ["standalone", "agent"] as const)
    test(`${kind}: published actions retain live base-write authority and preserve queued snapshots`, async () => {
      const f = await authorityFixture(true);
      let pending: ReturnType<typeof runGridsWorkflowRun> | undefined;
      let release: (() => void) | undefined;
      let barrier: ReturnType<typeof spyOn<typeof machineAuthority, "validateWorkflowOwnerSnapshot">> | undefined;
      try {
        const accountId = f.accountIds[0]!;
        await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id=${accountId}::uuid`;
        const launcher = await createLauncher(
          f.workflow,
          { name: "Write a task", config: { kind: "customApp", inputMode: "fixed", inputBindings: {} }, enabled: true },
          f.ownerId,
        );
        if (!launcher.ok) throw new Error(launcher.error.message);
        const [base] = await sql<{ short_id: string }[]>`SELECT short_id FROM grids.bases WHERE id=${f.baseId}::uuid`;
        if (!base) throw new Error("Base missing");
        const app = await applyCustomApp(
          {
            schemaVersion: 5,
            kind: "grids.custom-app",
            id: testShortId(),
            baseId: base.short_id,
            name: "Task actions",
            startPageId: "home",
            pages: [
              {
                id: "home",
                title: "Home",
                navigation: { visible: true },
                parameters: {},
                rows: [
                  {
                    id: "main",
                    columns: [
                      {
                        id: "content",
                        span: 12,
                        blocks: [
                          {
                            id: "actions",
                            type: "actions",
                            actions: [
                              {
                                id: "run",
                                label: "Write",
                                kind: "workflow",
                                launcherId: launcher.data.shortId,
                                variant: "primary",
                                inputs: {},
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          f.ownerId,
        );
        if (!app.ok) throw new Error(app.error.message);
        expect((await publishCustomApp(app.data.id, f.ownerId)).ok).toBe(true);
        const grant = await grantAccess({
          resourceType: "customApp",
          resourceId: app.data.id,
          principal: { type: "service_account", serviceAccountId: accountId },
          permission: "read",
          actorId: f.ownerId,
        });
        if (!grant.ok) throw new Error(grant.error.message);
        f.accessIds.push(grant.data.accessId);
        const token = await serviceAccountCredentials.createApiToken({
          serviceAccountId: accountId,
          name: "App action",
          scopes: ["grids:write"],
        });
        if (!token.ok) throw new Error(token.error.message);
        const invoke = async () =>
          api.request(`/apps/runtime/${app.data.shortId}/home/actions/actions/run`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token.data.token}`,
              "content-type": "application/json",
              "x-forwarded-for": uniqueCallerAddress(),
            },
            body: JSON.stringify({ operationId: crypto.randomUUID() }),
          });
        const acceptedRun = async () => {
          const response = await invoke();
          expect(response.status, await response.clone().text()).toBe(202);
          const receipt = z.object({ runId: z.string() }).parse(await response.json());
          const run = await getWorkflowRunByShortId(receipt.runId);
          if (!run) throw new Error("App action run missing");
          return run;
        };
        const stale = await acceptedRun();
        expect((await getWorkflowRunScope(stale.id))?.principal.mandate ?? null).toBeNull();
        const assigned = await f.assign();
        const fresh = await acceptedRun();
        expect((await getWorkflowRunScope(fresh.id))?.principal.mandate).toEqual({
          id: assigned.mandate!.id,
          revision: assigned.mandate!.revision,
          workflowId: f.workflow.id,
        });
        await runGridsWorkflowRun(fresh.id);
        const [finished] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${fresh.id}::uuid`;
        expect(finished?.state).toBe("succeeded");
        await runGridsWorkflowRun(stale.id);
        const [denied] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${stale.id}::uuid`;
        expect(denied?.state).toBe("failed");
        expect((await getWorkflowRunScope(stale.id))?.principal.mandate ?? null).toBeNull();
        const records = () => sql`SELECT id FROM grids.records WHERE table_id=${f.tableId}::uuid`;
        const effects = () => sql`SELECT id FROM grids.audit_log WHERE base_id=${f.baseId}::uuid AND action='workflow.record.created'`;
        expect(await records()).toHaveLength(1);
        expect(await effects()).toHaveLength(1);
        let baseAccessId = f.accessIds[2]!;
        for (const boundary of ["execution", "transactional effect"] as const) {
          const queued = await acceptedRun();
          const accepted = await getWorkflowRunScope(queued.id);
          if (!accepted) throw new Error("Mandated App scope missing");
          expect(accepted.principal.mandate).toEqual((await getWorkflowRunScope(fresh.id))?.principal.mandate);
          expect(await canExecuteWorkflow({ ...accepted, workflowId: f.workflow.id })).toBe(true);
          if (boundary === "transactional effect") {
            let entered!: () => void;
            const reached = new Promise<void>((resolve) => {
              entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            const original = machineAuthority.validateWorkflowOwnerSnapshot;
            let first = true;
            barrier = spyOn(machineAuthority, "validateWorkflowOwnerSnapshot").mockImplementation(async (...args) => {
              if (first && args[2] !== undefined) {
                first = false;
                entered();
                await gate;
              }
              return original(...args);
            });
            // The real createRecord transaction has started; pause before its
            // authority read, then commit the actual grant revocation.
            pending = runGridsWorkflowRun(queued.id);
            await Promise.race([
              reached,
              pending.then(() => {
                throw new Error("App run ended before the transactional authority barrier");
              }),
            ]);
          }
          expect((await revokeAccess(baseAccessId, f.ownerId)).ok).toBe(true);
          expect(
            await sql`SELECT a.id FROM auth.access a JOIN grids.custom_app_access ca ON ca.access_id=a.id
              WHERE ca.custom_app_id=${app.data.id}::uuid AND a.id=${grant.data.accessId}::uuid AND a.permission='read'`,
          ).toHaveLength(1);
          expect((await invoke()).status).toBe(403);
          expect(await canExecuteWorkflow({ ...accepted, workflowId: f.workflow.id })).toBe(false);
          release?.();
          await (pending ?? runGridsWorkflowRun(queued.id));
          const [blocked] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${queued.id}::uuid`;
          expect(blocked?.state).toBe("failed");
          if (boundary === "transactional effect") {
            const outcomes = await sql<{ code: string | null }[]>`
              SELECT outcome->'outcome'->'error'->>'code' AS code FROM workflows.step_outcome WHERE run_id=${queued.id}::uuid`;
            expect(outcomes.some((row) => row.code === "FORBIDDEN")).toBe(true);
          }
          expect(await records()).toHaveLength(1);
          expect(await effects()).toHaveLength(1);
          expect((await getWorkflowRunScope(queued.id))?.principal).toEqual(accepted.principal);
          barrier?.mockRestore();
          barrier = undefined;
          pending = undefined;
          release = undefined;
          const restored = await grantAccess({
            resourceType: "base",
            resourceId: f.baseId,
            principal: { type: "service_account", serviceAccountId: accountId },
            permission: "write",
            actorId: f.ownerId,
          });
          if (!restored.ok) throw new Error(restored.error.message);
          baseAccessId = restored.data.accessId;
          f.accessIds.push(baseAccessId);
        }
        // Base and App grants are valid again, so the remaining denials prove
        // account and mandate revocation independently of the base grant.
        const restored = await acceptedRun();
        await runGridsWorkflowRun(restored.id);
        const [restoredRun] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${restored.id}::uuid`;
        expect(restoredRun?.state).toBe("succeeded");
        expect(await records()).toHaveLength(2);
        await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${accountId}::uuid`;
        expect((await invoke()).status).toBe(401);
        await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${accountId}::uuid`;
        await acceptedRun();
        expect((await f.change({ action: "revoke", expected: snapshot(assigned) })).status).toBe(200);
        expect((await invoke()).status).toBe(403);
      } finally {
        release?.();
        await Promise.allSettled(pending ? [pending] : []);
        barrier?.mockRestore();
        await f.cleanup();
      }
    });
});

suite("automatic owner snapshots", () => {
  for (const kind of ["standalone", "agent"] as const)
    for (const channel of ["schedule", "recordEvent"] as const)
      for (const boundary of ["captured owner", "admission lock", "queued effect"] as const)
        test(`${kind} ${channel}: former human owner cannot survive machine assignment at ${boundary}`, async () => {
          const f = await authorityFixture(true);
          let pending: ReturnType<typeof invokeGridsWorkflow> | undefined;
          try {
            await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id=${f.accountIds[0]!}::uuid`;
            const updated = await updateWorkflow(
              f.workflow.id,
              {
                source: `triggers:
  schedule:
    cron: "0 8 * * *"
    timezone: UTC
  recordEvent:
    event: created
    table: Tasks
steps:
  - createRecord:
      table: Tasks
      values:
        Name: Automatic owner`,
              },
              f.ownerId,
              f.workflow.revision,
            );
            if (!updated.ok) throw new Error(updated.error.message);
            const invoke = () =>
              invokeGridsWorkflow({
                workflowId: f.workflow.id,
                mode: "execute",
                channel,
                inputs: {},
                idempotencyKey: crypto.randomUUID(),
                principal: { userId: f.ownerId, serviceAccountId: null, groupIds: [] },
                occurredAt: "2026-10-24T08:00:00.000Z",
              });
            // Prove the real automatic channel and this human's domain grant.
            const baseline = await invoke();
            if (!baseline.ok) throw new Error(baseline.error.message);
            await runGridsWorkflowRun(baseline.data.runId);
            expect(await sql`SELECT id FROM grids.records WHERE table_id=${f.tableId}::uuid`).toHaveLength(1);
            const blockOwner = async () => {
              const assigned = await f.assign();
              const response = await f.change({ action: kind === "agent" ? "revoke" : "pause", expected: snapshot(assigned) });
              expect(response.status, await response.clone().text()).toBe(200);
            };
            if (boundary === "queued effect") {
              const queued = await invoke();
              if (!queued.ok) throw new Error(queued.error.message);
              expect((await getWorkflowRunScope(queued.data.runId))?.channel).toBe(channel);
              await blockOwner();
              await runGridsWorkflowRun(queued.data.runId);
              const [run] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${queued.data.runId}::uuid`;
              expect(run?.state).toBe("failed");
            } else {
              if (boundary === "admission lock") {
                await locked(
                  (db) => lockWorkflowCatalogMutation(f.baseId, db),
                  async (_db, pid) => {
                    pending = invoke();
                    await waitForBlocked(pid);
                    await blockOwner();
                  },
                );
              } else {
                await blockOwner();
                pending = invoke();
              }
              const denied = await pending!;
              expect(denied.ok).toBe(false);
              if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
              expect(await sql`SELECT run_id FROM grids.workflow_run_profile WHERE workflow_id=${f.workflow.id}::uuid`).toHaveLength(1);
            }
            expect(await sql`SELECT id FROM grids.records WHERE table_id=${f.tableId}::uuid`).toHaveLength(1);
          } finally {
            await Promise.allSettled(pending ? [pending] : []);
            await f.cleanup();
          }
        });
});

const queueFixtureMachine = async (f: Awaited<ReturnType<typeof authorityFixture>>, inputs: Record<string, string> = {}) => {
  const token = await serviceAccountCredentials.createApiToken({
    serviceAccountId: f.accountIds[0]!,
    name: "Effect boundary",
    scopes: ["grids:write"],
  });
  if (!token.ok) throw new Error(token.error.message);
  const response = await api.request(`/workflows/${f.workflow.shortId}/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.data.token}`, "content-type": "application/json", "x-forwarded-for": uniqueCallerAddress() },
    body: JSON.stringify({ inputs, idempotencyKey: crypto.randomUUID(), mode: "execute" }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const receipt = z.object({ runId: z.string() }).parse(await response.json());
  const run = await getWorkflowRunByShortId(receipt.runId);
  if (!run) throw new Error("Machine run missing");
  return run;
};

suite("machine effects after preparation waits", () => {
  for (const kind of ["standalone", "agent"] as const)
    for (const boundary of ["table", "history"] as const)
      for (const action of ["createRecord", "atomicRecords"] as const)
        test(`${kind} ${action}: real ${boundary} lock wait cannot retain revoked base authority`, async () => {
          const f = await authorityFixture(true);
          let pending: ReturnType<typeof runGridsWorkflowRun> | undefined;
          try {
            await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id=${f.accountIds[0]!}::uuid`;
            const inputs: Record<string, string> = {};
            const expectedRecords = action === "atomicRecords" ? 2 : 1;
            if (action === "atomicRecords") {
              const coordinationId = testUuid();
              inputs.coordination = testShortId();
              await sql`INSERT INTO grids.records(id,short_id,table_id,data) VALUES(${coordinationId}::uuid,${inputs.coordination},${f.tableId}::uuid,'{}'::jsonb)`;
              const updated = await updateWorkflow(
                f.workflow.id,
                {
                  source: `inputs:
  coordination:
    type: record
    table: Tasks
    required: true
steps:
  - atomicRecords:
      locks: [inputs.coordination]
      checks:
        - table: Tasks
          where:
            - field: Name
              op: equals
              value: Never present
          assert: empty
      changes:
        - createRecord:
            table: Tasks
            values:
              Name: Atomic machine`,
                },
                f.ownerId,
                f.workflow.revision,
              );
              if (!updated.ok) throw new Error(updated.error.message);
            }
            await f.assign();
            const baseline = await queueFixtureMachine(f, inputs);
            await runGridsWorkflowRun(baseline.id);
            expect(await sql`SELECT id FROM grids.records WHERE table_id=${f.tableId}::uuid`).toHaveLength(expectedRecords);
            const queued = await queueFixtureMachine(f, inputs);
            await locked(
              (db) =>
                boundary === "table"
                  ? db`SELECT id FROM grids.tables WHERE id=${f.tableId}::uuid FOR UPDATE`
                  : db`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:durable-history:${f.tableId}`},0))`,
              async (_db, pid) => {
                pending = runGridsWorkflowRun(queued.id);
                await waitForBlocked(pid);
                expect((await revokeAccess(f.accessIds[2]!, f.ownerId)).ok).toBe(true);
              },
            );
            await pending!;
            const [run] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${queued.id}::uuid`;
            expect(run?.state).toBe("failed");
            const outcomes = await sql<{ code: string | null }[]>`
            SELECT outcome->'outcome'->'error'->>'code' AS code FROM workflows.step_outcome WHERE run_id=${queued.id}::uuid`;
            expect(outcomes.some((row) => row.code === "FORBIDDEN")).toBe(true);
            expect(await sql`SELECT id FROM grids.records WHERE table_id=${f.tableId}::uuid`).toHaveLength(expectedRecords);
            expect(
              await sql`SELECT id FROM grids.audit_log WHERE base_id=${f.baseId}::uuid AND action='workflow.record.created'`,
            ).toHaveLength(1);
          } finally {
            await Promise.allSettled(pending ? [pending] : []);
            await f.cleanup();
          }
        });

  for (const kind of ["standalone", "agent"] as const)
    for (const change of ["revoke", "disable"] as const)
      test(`${kind}: ${change} during DNS resolution prevents HTTP dispatch`, async () => {
        const f = await authorityFixture();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let pending: ReturnType<typeof requestWorkflowHttp> | undefined;
        let sent = 0;
        try {
          await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id=${f.accountIds[0]!}::uuid`;
          const assigned = await f.assign();
          const queued = await queueFixtureMachine(f);
          const scope = await getWorkflowRunScope(queued.id);
          if (!scope) throw new Error("Machine scope missing");
          const input = {
            url: "https://api.example.com/hooks",
            method: "POST" as const,
            authorize: (signal: AbortSignal) => canExecuteRunBeforeHttp(scope, signal),
          };
          const request = () => {
            sent += 1;
            throw new Error("Observed dispatch without opening a socket");
          };
          await requestWorkflowHttp(input, { lookup: async () => [{ address: "93.184.216.34", family: 4 }], request });
          expect(sent).toBe(1);
          pending = requestWorkflowHttp(input, {
            lookup: async () => {
              entered.resolve();
              await release.promise;
              return [{ address: "93.184.216.34", family: 4 }];
            },
            request,
          });
          await entered.promise;
          if (change === "disable") await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${f.accountIds[0]!}::uuid`;
          else expect((await f.change({ action: "revoke", expected: snapshot(assigned) })).status).toBe(200);
          release.resolve();
          const denied = await pending;
          expect(denied.ok).toBe(false);
          if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
          expect(sent).toBe(1);
        } finally {
          release.resolve();
          await Promise.allSettled(pending ? [pending] : []);
          await f.cleanup();
        }
      });
});

suite("automatic admission and user deletion", () => {
  for (const channel of ["schedule", "recordEvent"] as const)
    test(`${channel}: admission locks its human before ownership and actor foreign keys`, async () => {
      const f = await authorityFixture(true);
      const entered = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const original = machineAuthority.validateWorkflowOwnerSnapshot;
      let pending: ReturnType<typeof invokeGridsWorkflow> | undefined;
      let deletion: Promise<unknown> | undefined;
      let first = true;
      const barrier = spyOn(machineAuthority, "validateWorkflowOwnerSnapshot").mockImplementation(async (...args) => {
        const allowed = await original(...args);
        if (first && args[2] !== undefined && args[3] === channel) {
          first = false;
          const [backend] = await args[2]<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          if (!backend) throw new Error("Admission backend missing");
          entered.resolve(backend.pid);
          await release.promise;
        }
        return allowed;
      });
      try {
        const updated = await updateWorkflow(
          f.workflow.id,
          {
            source: `triggers:
  schedule:
    cron: "0 8 * * *"
    timezone: UTC
  recordEvent:
    event: created
    table: Tasks
steps:
  - succeed:
      message: Done`,
          },
          f.ownerId,
          f.workflow.revision,
        );
        if (!updated.ok) throw new Error(updated.error.message);
        pending = invokeGridsWorkflow({
          workflowId: f.workflow.id,
          mode: "execute",
          channel,
          inputs: {},
          idempotencyKey: crypto.randomUUID(),
          principal: { userId: f.ownerId, serviceAccountId: null, groupIds: [] },
          occurredAt: "2026-10-24T08:00:00.000Z",
        });
        const pid = await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Admission ended before owner lock barrier");
          }),
        ]);
        deletion = sql`DELETE FROM auth.users WHERE id=${f.ownerId}::uuid`.execute();
        await waitForBlocked(pid);
        release.resolve();
        const admitted = await pending;
        expect(admitted.ok).toBe(true);
        await deletion;
        if (!admitted.ok) throw new Error(admitted.error.message);
        await runGridsWorkflowRun(admitted.data.runId);
        const [run] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${admitted.data.runId}::uuid`;
        expect(run?.state).toBe("failed");
      } finally {
        release.resolve();
        await Promise.allSettled([...(pending ? [pending] : []), ...(deletion ? [deletion] : [])]);
        barrier.mockRestore();
        await f.cleanup();
      }
    });
});

suite("record mutation authority after writer waits", () => {
  for (const kind of ["standalone", "agent"] as const)
    for (const operation of ["updateRecord", "deleteRecord", "finalizeRecord"] as const)
      for (const atomic of [false, true])
        test(`${kind} ${atomic ? "atomic" : "single"} ${operation}: revocation during writer preparation rolls back the effect`, async () => {
          const f = await authorityFixture(true);
          let pending: ReturnType<typeof runGridsWorkflowRun> | undefined;
          try {
            await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id=${f.accountIds[0]!}::uuid`;
            const history = await enableHistory(f.tableId, f.ownerId);
            if (!history.ok) throw new Error(history.error.message);
            if (operation === "finalizeRecord") {
              const enabled = await enableFinalization(f.tableId, { mode: "direct" }, f.ownerId);
              if (!enabled.ok) throw new Error(enabled.error.message);
            }
            const [field] = await sql<
              { id: string }[]
            >`SELECT id::text FROM grids.fields WHERE table_id=${f.tableId}::uuid AND name='Name'`;
            if (!field) throw new Error("Name field missing");
            const targets = [testUuid(), testUuid()];
            const shortIds = [testShortId(), testShortId()];
            for (let i = 0; i < targets.length; i++)
              await sql`INSERT INTO grids.records(id,short_id,table_id,data)
              VALUES(${targets[i]!}::uuid,${shortIds[i]!},${f.tableId}::uuid,${{ [field.id]: "Before" }}::jsonb)`;
            const change = `${operation}:\n${atomic ? "            " : "      "}record: inputs.target${operation === "updateRecord" ? `\n${atomic ? "            " : "      "}set:\n${atomic ? "              " : "        "}Name: Changed` : ""}`;
            const workflowSource = `inputs:
  target:
    type: record
    table: Tasks
    required: true
steps:
${
  atomic
    ? `  - atomicRecords:
      locks: [inputs.target]
      checks:
        - table: Tasks
          where:
            - field: Name
              op: equals
              value: Never present
          assert: empty
      changes:
        - ${change}`
    : `  - ${change}`
}`;
            const updated = await updateWorkflow(f.workflow.id, { source: workflowSource }, f.ownerId, f.workflow.revision);
            if (!updated.ok) throw new Error(updated.error.message);
            await f.assign();
            const baseline = await queueFixtureMachine(f, { target: shortIds[0]! });
            await runGridsWorkflowRun(baseline.id);
            const [worked] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${baseline.id}::uuid`;
            expect(worked?.state).toBe("succeeded");
            const [before] = await sql<
              { data: Record<string, unknown>; deleted_at: Date | null; finalized_at: Date | null }[]
            >`SELECT data,deleted_at,finalized_at FROM grids.records WHERE id=${targets[0]!}::uuid`;
            if (operation === "updateRecord") expect(before?.data[field.id]).toBe("Changed");
            else if (operation === "deleteRecord") expect(before?.deleted_at).not.toBeNull();
            else expect(before?.finalized_at).not.toBeNull();
            const queued = await queueFixtureMachine(f, { target: shortIds[1]! });
            await locked(
              (db) =>
                operation === "finalizeRecord"
                  ? db`SELECT table_id FROM grids.table_finalization_activations WHERE table_id=${f.tableId}::uuid FOR UPDATE`
                  : db`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:durable-history:${f.tableId}`},0))`,
              async (_db, pid) => {
                pending = runGridsWorkflowRun(queued.id);
                await waitForBlocked(pid);
                expect((await revokeAccess(f.accessIds[2]!, f.ownerId)).ok).toBe(true);
              },
            );
            await pending!;
            const [failed] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${queued.id}::uuid`;
            expect(failed?.state).toBe("failed");
            const [after] = await sql<
              { data: Record<string, unknown>; deleted_at: Date | null; finalized_at: Date | null; version: number }[]
            >`SELECT data,deleted_at,finalized_at,version FROM grids.records WHERE id=${targets[1]!}::uuid`;
            expect(after).toEqual({ data: { [field.id]: "Before" }, deleted_at: null, finalized_at: null, version: 1 });
            const outcomes = await sql<
              { code: string | null }[]
            >`SELECT outcome->'outcome'->'error'->>'code' AS code FROM workflows.step_outcome WHERE run_id=${queued.id}::uuid`;
            expect(outcomes.some((row) => row.code === "FORBIDDEN")).toBe(true);
          } finally {
            await Promise.allSettled(pending ? [pending] : []);
            await sql`UPDATE grids.records SET finalized_at=NULL,finalized_by=NULL,final_revision_id=NULL WHERE table_id=${f.tableId}::uuid`;
            await sql`DELETE FROM grids.record_revisions WHERE table_id=${f.tableId}::uuid`;
            await sql`DELETE FROM grids.table_finalization_activations WHERE table_id=${f.tableId}::uuid`;
            await sql`DELETE FROM grids.durable_history_activations WHERE table_id=${f.tableId}::uuid`;
            await sql`DELETE FROM grids.table_schema_revisions WHERE table_id=${f.tableId}::uuid`;
            await f.cleanup();
          }
        });
});

suite("HTTP authorization cancellation", () => {
  test("the request budget cancels the real account lock waiter before its blocker releases", async () => {
    const f = await authorityFixture();
    let pending: ReturnType<typeof requestWorkflowHttp> | undefined;
    try {
      await f.assign();
      const queued = await queueFixtureMachine(f);
      const scope = await getWorkflowRunScope(queued.id);
      if (!scope) throw new Error("Machine scope missing");
      let sent = false;
      await locked(
        (db) => db`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[0]!}::uuid FOR UPDATE`,
        async (_db, blocker) => {
          pending = requestWorkflowHttp(
            {
              url: "https://api.example.com/hooks",
              method: "POST",
              timeoutMs: 1000,
              authorize: (signal) => canExecuteRunBeforeHttp(scope, signal),
            },
            {
              lookup: async () => [{ address: "93.184.216.34", family: 4 }],
              request: () => {
                sent = true;
                throw new Error("Unexpected dispatch");
              },
            },
          );
          await waitForBlocked(blocker);
          const result = await pending;
          expect(result.ok ? "" : result.error.code).toBe("WORKFLOW_HTTP_RETRYABLE");
          expect(sent).toBe(false);
          const [waiting] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND ${blocker}::int=ANY(pg_blocking_pids(pid))`;
          expect(waiting?.count).toBe(0);
        },
      );
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await f.cleanup();
    }
  });
});

suite("HTTP authorization registry cancellation", () => {
  test("the request releases account locks before a delayed registry read returns", async () => {
    const f = await authorityFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pending: ReturnType<typeof requestWorkflowHttp> | undefined;
    const registry = appRegistry();
    const original = registry.snapshot;
    let hold = false;
    const snapshotRead = spyOn(registry, "snapshot").mockImplementation(async (...args) => {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
      return original.apply(registry, args);
    });
    try {
      await f.assign();
      const queued = await queueFixtureMachine(f);
      const scope = await getWorkflowRunScope(queued.id);
      if (!scope) throw new Error("Machine scope missing");
      let sent = false;
      hold = true;
      pending = requestWorkflowHttp(
        {
          url: "https://api.example.com/hooks",
          method: "POST",
          timeoutMs: 1000,
          authorize: (signal) => canExecuteRunBeforeHttp(scope, signal),
        },
        {
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          request: () => {
            sent = true;
            throw new Error("Unexpected dispatch");
          },
        },
      );
      await entered.promise;
      // Keep the real response pending through HTTP completion and SQL cleanup.
      // Authorization itself is never replaced.
      const result = await pending;
      expect(result.ok ? "" : result.error.code).toBe("WORKFLOW_HTTP_RETRYABLE");
      expect(sent).toBe(false);
      await sql.begin(async (tx) => {
        const rows = await tx`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[0]!}::uuid FOR UPDATE NOWAIT`;
        expect(rows).toHaveLength(1);
      });
    } finally {
      hold = false;
      release.resolve();
      await Promise.allSettled(pending ? [pending] : []);
      snapshotRead.mockRestore();
      await f.cleanup();
    }
  });
});

suite("document-link effect authority", () => {
  for (const kind of ["standalone", "agent"] as const)
    test(`${kind}: revocation during public URL settings prevents a link effect`, async () => {
      const f = await authorityFixture(true);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let pending: ReturnType<typeof runGridsWorkflowRun> | undefined;
      const original = coreSettings.get;
      let hold = false;
      const settings = spyOn(coreSettings, "get").mockImplementation(async (...args) => {
        if (hold && args[0] === "app.url") {
          entered.resolve();
          await release.promise;
        }
        return original(...args);
      });
      try {
        await sql`UPDATE auth.service_accounts SET kind=${kind} WHERE id=${f.accountIds[0]!}::uuid`;
        await sql`INSERT INTO grids.records(id,short_id,table_id,data)
          VALUES(${testUuid()}::uuid,${testShortId()},${f.tableId}::uuid,'{}'::jsonb)`;
        const updated = await updateWorkflow(
          f.workflow.id,
          {
            source: `steps:
  - query:
      source: |
        from table Tasks
        select Name
      saveAs: report
  - generateDocument:
      data: report
      output:
        kind: csv
      saveAs: reportFile
  - createDocumentLink:
      document: reportFile
      expiresIn: 7d
      saveAs: reportLink`,
          },
          f.ownerId,
          f.workflow.revision,
        );
        if (!updated.ok) throw new Error(updated.error.message);
        await f.assign();
        const baseline = await queueFixtureMachine(f);
        await runGridsWorkflowRun(baseline.id);
        const [worked] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${baseline.id}::uuid`;
        expect(worked?.state).toBe("succeeded");
        expect(await sql`SELECT id FROM grids.document_links WHERE base_id=${f.baseId}::uuid`).toHaveLength(1);
        const queued = await queueFixtureMachine(f);
        hold = true;
        pending = runGridsWorkflowRun(queued.id);
        await entered.promise;
        expect((await revokeAccess(f.accessIds[2]!, f.ownerId)).ok).toBe(true);
        release.resolve();
        await pending;
        const [failed] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id=${queued.id}::uuid`;
        expect(failed?.state).toBe("failed");
        expect(await sql`SELECT id FROM grids.document_links WHERE base_id=${f.baseId}::uuid`).toHaveLength(1);
        expect(
          await sql`SELECT id FROM grids.audit_log WHERE base_id=${f.baseId}::uuid AND action='workflow.document_link.created'`,
        ).toHaveLength(1);
        const outcomes = await sql<{ code: string | null }[]>`SELECT outcome->'outcome'->'error'->>'code' AS code
          FROM workflows.step_outcome WHERE run_id=${queued.id}::uuid`;
        expect(outcomes.some((row) => row.code === "FORBIDDEN")).toBe(true);
      } finally {
        release.resolve();
        await Promise.allSettled(pending ? [pending] : []);
        settings.mockRestore();
        // Issued documents and query snapshots retain their base, matching the
        // existing workflow-actions/document-issuance fixture contract.
        const retained = await sql`SELECT id FROM grids.documents WHERE base_id=${f.baseId}::uuid
          UNION ALL SELECT id FROM grids.record_snapshots WHERE base_id=${f.baseId}::uuid LIMIT 1`;
        if (retained.length === 0) await f.cleanup();
      }
    });
});
