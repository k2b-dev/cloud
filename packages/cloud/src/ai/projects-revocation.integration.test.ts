import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import type { Principal } from "../server/services/access";
import { serviceAccounts } from "../services/service-accounts";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { userResourceContext } from "./projects.test-fixture";
import type { AiResourceContext } from "./projects-authorization";

type CallerKind = "user" | "standalone" | "agent";

const fixture = async (kind: CallerKind) => {
  const users: string[] = [];
  const accounts: string[] = [];
  let projectId: string | undefined;
  const cleanup = async () => {
    if (projectId) await aiProjects.admin.delete(projectId);
    for (const id of accounts) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  };
  const user = async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`project-revocation-${crypto.randomUUID()}`}, 'local', 'user', 'Project revocation fixture') RETURNING id
    `;
    if (!row) throw new Error("Missing user fixture");
    users.push(row.id);
    return userResourceContext({ type: "user", userId: row.id });
  };
  try {
    const owner = await user();
    let caller: AiResourceContext;
    let principal: Principal;
    if (kind === "user") {
      caller = await user();
      principal = { type: "user", userId: users[1]! };
    } else {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.service_accounts (name, kind)
        VALUES (${`Project revocation ${kind} ${crypto.randomUUID()}`}, ${kind}) RETURNING id
      `;
      if (!row) throw new Error("Missing service account fixture");
      accounts.push(row.id);
      const serviceAccount = await serviceAccounts.get({ id: row.id });
      if (!serviceAccount) throw new Error("Missing service account");
      caller = {
        actor: { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["admin"] },
        accessSubject: { type: "service_account", serviceAccountId: row.id },
      };
      principal = { type: "service_account", serviceAccountId: row.id };
    }
    const project = await aiProjects.create({
      subject: owner,
      name: "Original name",
      description: "Original description",
      instructions: "Original instructions",
      defaultModelProfileId: "original-model",
    });
    projectId = project.id;
    const grant = await aiProjects.grantAccess(project.id, owner, { principal, permission: "admin" });
    const knowledge = await aiProjects.createKnowledge(project.id, owner, { title: "Original title", content: "Original content" });
    const reference = await aiProjects.createReference(project.id, owner, {
      ref: { type: "notebooks.note", id: "original-note" },
      label: "Original reference",
    });
    if (!grant || !knowledge || !reference) throw new Error("Missing Project content fixture");
    return {
      owner,
      caller,
      projectId: project.id,
      grantId: grant.id,
      knowledgeId: knowledge.shortId,
      referenceId: reference.shortId,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

const state = async (f: Fixture) => ({
  project: await aiProjects.get(f.projectId, f.owner),
  knowledge: await aiProjects.listKnowledge(f.projectId, f.owner),
  references: await aiProjects.listReferences(f.projectId, f.owner),
});

/** Hold the same resource lock as revocation, and commit only after the mutation is observed waiting. */
const afterRevocation = async <T>(f: Fixture, mutate: () => Promise<T>, change: "revoke" | "demote" = "revoke"): Promise<T> => {
  let pending: Promise<T> | undefined;
  let settled = false;
  try {
    await sql.begin(async (tx) => {
      const [holder] = await tx<{ pid: number }[]>`
        SELECT pg_backend_pid()::int AS pid FROM ai.projects WHERE id = ${f.projectId}::uuid FOR UPDATE
      `;
      if (!holder) throw new Error("Missing Project to lock");
      pending = mutate().finally(() => {
        settled = true;
      });
      // Always drain the mutation, including when lock observation fails and this transaction rolls back.
      pending.catch(() => {});
      const deadline = performance.now() + 2_000;
      while (true) {
        const [row] = await sql<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND ${holder.pid}::int = ANY(pg_blocking_pids(pid))
          ) AS blocked
        `;
        if (row?.blocked) break;
        if (settled) throw new Error("Project mutation finished before waiting for revocation");
        if (performance.now() >= deadline) throw new Error("Project mutation did not wait for the resource lock");
      }
      if (change === "revoke") {
        await tx`DELETE FROM auth.access WHERE id = (
          SELECT access_id FROM ai.project_access WHERE project_id = ${f.projectId}::uuid AND short_id = ${f.grantId}
        )`;
      } else {
        await tx`UPDATE auth.access SET permission = 'write' WHERE id = (
          SELECT access_id FROM ai.project_access WHERE project_id = ${f.projectId}::uuid AND short_id = ${f.grantId}
        )`;
      }
    });
    if (!pending) throw new Error("Project mutation was not started");
    return await pending;
  } finally {
    await pending?.catch(() => {});
  }
};

const mutations: { name: string; run: (f: Fixture) => Promise<unknown>; denied: null | false }[] = [
  {
    name: "metadata update",
    run: (f) => aiProjects.update(f.projectId, f.caller, { name: "Changed", description: "Changed", icon: "ti ti-file" }),
    denied: null,
  },
  {
    name: "trusted instructions and default model update",
    run: (f) => aiProjects.update(f.projectId, f.caller, { instructions: "Changed", defaultModelProfileId: "changed-model" }),
    denied: null,
  },
  {
    name: "knowledge creation",
    run: (f) => aiProjects.createKnowledge(f.projectId, f.caller, { title: "Changed", content: "Changed" }),
    denied: null,
  },
  {
    name: "knowledge update",
    run: (f) => aiProjects.updateKnowledge(f.projectId, f.knowledgeId, f.caller, { title: "Changed", content: "Changed" }),
    denied: null,
  },
  { name: "knowledge deletion", run: (f) => aiProjects.deleteKnowledge(f.projectId, f.knowledgeId, f.caller), denied: false },
  {
    name: "reference creation",
    run: (f) => aiProjects.createReference(f.projectId, f.caller, { ref: { type: "notebooks.note", id: "changed-note" } }),
    denied: null,
  },
  { name: "reference deletion", run: (f) => aiProjects.deleteReference(f.projectId, f.referenceId, f.caller), denied: false },
];

databaseSuite()("Project mutations queued behind revocation", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  for (const kind of ["standalone", "agent", "user"] as const) {
    for (const mutation of mutations) {
      test(`${kind}: ${mutation.name} is rejected without persistence after revocation commits`, async () => {
        const f = await fixture(kind);
        try {
          expect((await aiProjects.get(f.projectId, f.caller))?.permission).toBe("admin");
          const before = await state(f);
          expect(await afterRevocation(f, () => mutation.run(f))).toBe(mutation.denied);
          expect(await aiProjects.get(f.projectId, f.caller)).toBeNull();
          // The response alone misses an UPDATE that persists and only then discovers the revoked grant.
          expect(await state(f)).toEqual(before);
        } finally {
          await f.cleanup();
        }
      });
    }

    test(`${kind}: a queued trusted update requires current admin permission after demotion`, async () => {
      const f = await fixture(kind);
      try {
        const before = await state(f);
        expect(
          await afterRevocation(
            f,
            () => aiProjects.update(f.projectId, f.caller, { instructions: "Changed", defaultModelProfileId: "changed-model" }),
            "demote",
          ),
        ).toBeNull();
        expect((await aiProjects.get(f.projectId, f.caller))?.permission).toBe("write");
        expect(await state(f)).toEqual(before);
      } finally {
        await f.cleanup();
      }
    });
  }
});
