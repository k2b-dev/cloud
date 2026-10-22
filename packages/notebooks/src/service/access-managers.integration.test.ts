import { expect, test } from "bun:test";
import { accounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { grantNotebookAccess, listNotebookAccess, removeNotebookAccess, updateNotebookAccess } from "./access";

const suite = suiteFor("database", "nats", "valkey");

const fixture = async () => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
    VALUES (${`notebooks-manager-${suffix}`}, 'local', 'user', 'Mara Lind') RETURNING id`;
  const [resource] = await sql<{ id: string }[]>`INSERT INTO notebooks.notebooks (short_id, name)
    VALUES (${testShortId()}, 'Manager guard') RETURNING id`;
  const [machine] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
    VALUES (${`notebooks helper ${suffix}`}, 'agent') RETURNING id`;
  const [bound] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${`notebooks key ${suffix}`}, 'resource_bound', 'notebooks', 'notebook', ${resource!.id}) RETURNING id`;
  const entries: string[] = [];
  const grant = async (principal: Parameters<typeof grantNotebookAccess>[0]["principal"], permission: "admin" | "read") => {
    const result = await grantNotebookAccess({ notebookId: resource!.id, principal, permission });
    if (!result.ok) throw new Error(result.error.message);
    entries.push(result.data.id);
    return result.data;
  };
  const human = await grant({ type: "user", userId: user!.id }, "admin");
  const agent = await grant({ type: "service_account", serviceAccountId: machine!.id }, "admin");
  const callerUser = await accounts.users.get({ id: user!.id });
  if (!callerUser) throw new Error("Missing fixture user");
  return {
    notebookId: resource!.id,
    human,
    agent,
    boundId: bound!.id,
    grant,
    caller: { actor: { kind: "user" as const, user: callerUser }, accessSubject: { type: "user" as const, userId: user!.id } },
    cleanup: async () => {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${resource!.id}::uuid`;
      for (const id of entries) await sql`DELETE FROM auth.access WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id IN (${machine!.id}::uuid, ${bound!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    },
  };
};

suite("Notebook manager mutation invariants", () => {
  test("public and resource-bound admin entries cannot replace the final independent manager, including adapter removal", async () => {
    const f = await fixture();
    try {
      await f.grant({ type: "public" }, "admin");
      await f.grant({ type: "service_account", serviceAccountId: f.boundId }, "admin");
      expect((await updateNotebookAccess({ notebookId: f.notebookId, accessId: f.agent.id, permission: "read" })).ok).toBe(true);
      const updated = await updateNotebookAccess({ notebookId: f.notebookId, accessId: f.human.id, permission: "read" });
      expect(updated).toMatchObject({ ok: false, error: { code: "LAST_MANAGER", status: 409 } });
      expect(await removeNotebookAccess(f.notebookId, f.human.id)).toMatchObject({
        ok: false,
        error: { code: "LAST_MANAGER", status: 409 },
      });
      const foreign = await updateNotebookAccess({
        notebookId: f.notebookId,
        accessId: crypto.randomUUID(),
        permission: "admin",
        caller: f.caller,
      });
      expect(foreign).toMatchObject({ ok: false, error: { status: 404 } });
      expect((await listNotebookAccess(f.notebookId)).find((entry) => entry.id === f.human.id)?.permission).toBe("admin");
    } finally {
      await f.cleanup();
    }
  });

  test("concurrent demotions of the last two managers cannot both succeed", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all(
        [f.human, f.agent].map((entry) =>
          updateNotebookAccess({
            notebookId: f.notebookId,
            accessId: entry.id,
            permission: "read",
          }),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, error: { code: "LAST_MANAGER" } });
      expect((await listNotebookAccess(f.notebookId)).filter((entry) => entry.permission === "admin")).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  test("a caller whose manager grant changes while waiting for the resource lock is reauthorized", async () => {
    const f = await fixture();
    let pending: ReturnType<typeof updateNotebookAccess> | undefined;
    try {
      await sql.begin(async (tx) => {
        const [resource] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM notebooks.notebooks
          WHERE id = ${f.notebookId}::uuid FOR UPDATE`;
        pending = updateNotebookAccess({ notebookId: f.notebookId, accessId: f.agent.id, permission: "read", caller: f.caller });
        const deadline = Date.now() + 5_000;
        while (true) {
          const [row] = await sql<{ blocked: boolean }[]>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
              AND ${resource!.pid}::int = ANY(pg_blocking_pids(pid))
          ) AS blocked`;
          if (row?.blocked) break;
          if (Date.now() >= deadline) throw new Error("Access mutation did not wait for the resource lock within 5 seconds");
          await Bun.sleep(10);
        }
        await tx`UPDATE auth.access SET permission = 'read' WHERE id = ${f.human.id}::uuid`;
      });
      expect(await pending).toMatchObject({ ok: false, error: { status: 403 } });
      expect((await listNotebookAccess(f.notebookId)).find((entry) => entry.id === f.agent.id)?.permission).toBe("admin");
    } finally {
      await pending;
      await f.cleanup();
    }
  });
});
