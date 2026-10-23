import { beforeAll, expect, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { getWorkflowRunByShortId } from "../service/workflow-runs";
import { getWorkflowTriggerRuntimeState, runGridsWorkflowRun } from "../service/workflow-runtime";
import "../../../../scripts/fixtures/authorization-preload";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { lockBaseAuthorization, revokeAccess } from "../service/access";
import type { SqlClient } from "../service/audit";
import { canExecuteWorkflow } from "../service/workflow-action-scope";
import { createWorkflow } from "../service/workflow-definitions";
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

const authorityFixture = async () => {
  const ownerId = testUuid(),
    keeperId = testUuid(),
    baseId = testUuid();
  const accountIds = [testUuid(), testUuid()].sort();
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
  const workflow = await createWorkflow(baseId, { name: "Authority concurrency", source, enabled: true }, ownerId);
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

  test("detects a replacement made between the initial read and proposed account lock", async () => {
    const f = await authorityFixture();
    let pending: Promise<Response> | undefined;
    try {
      const first = await f.assign();
      await locked(
        (db) => db`SELECT id FROM auth.service_accounts WHERE id=${f.accountIds[1]!}::uuid FOR UPDATE`,
        async (_db, pid) => {
          pending = f.change({ action: "assign", serviceAccountId: f.accountIds[1]!, expected: snapshot(first) });
          await waitForBlocked(pid);
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
