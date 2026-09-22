import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { aiFileContentVersion } from "./file-content-version";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { AI_SHORT_ID_PATTERN } from "./short-id";
import { aiConversations } from "./store";

const insertUser = async (label: string) => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-project-${label}-${suffix}`}, 'local', 'user', ${`Project ${label}`}, ${`ai-project-${suffix}@example.test`}, 'AI', 'Project')
    RETURNING id
  `;
  return row!.id;
};

const insertServiceAccount = async (label: string) => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${`AI Project ${label} ${suffix}`}, 'resource_bound', 'assistant', 'project-test', ${suffix})
    RETURNING id
  `;
  return row!.id;
};

databaseSuite()("aiProjects (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("project file paths are NFC and legacy spellings migrate", async () => {
    const userId = await insertUser("unicode");
    const subject = { type: "user" as const, userId };
    const project = await aiProjects.create({ subject, name: "Unicode" });
    const nfd = "Anlagevermo\u0308gen.pdf";
    const nfc = "Anlageverm\u00f6gen.pdf";
    try {
      await sql`INSERT INTO ai.project_files (short_id, project_id, path, media_type, bytes, size) VALUES ('legacy1', ${project.id}::uuid, ${`alt/${nfd}`}, 'text/plain', ${new Uint8Array([1])}, 1)`;
      await migrateCloudAi();
      expect((await aiProjects.readFileByPath(project.id, `alt/${nfc}`, subject))?.path).toBe(`alt/${nfc}`);

      const written = await aiProjects.writeFile(project.id, subject, { path: nfd, mediaType: "text/plain", bytes: new Uint8Array([2]) });
      expect(written?.path).toBe(nfc);
      expect((await aiProjects.readFileByPath(project.id, nfd, subject))?.bytes).toEqual(new Uint8Array([2]));
      expect((await aiProjects.listFiles(project.id, subject, { limit: 10 })).map((file) => file.path).sort()).toEqual(
        [nfc, `alt/${nfc}`].sort(),
      );
    } finally {
      await aiProjects.delete(project.id, subject);
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("versioned Project file transfers serialize replacements and reject stale content", async () => {
    const userId = await insertUser("file-transfer");
    const subject = { type: "user" as const, userId };
    const project = await aiProjects.create({ subject, name: "Transfer" });
    try {
      const input = { path: "invoice.pdf", mediaType: "application/pdf", bytes: new Uint8Array([0, 128, 255]), expectedVersion: null };
      await aiProjects.writeFile(project.id, subject, input);
      const current = (await aiProjects.readFileByPath(project.id, input.path, subject))!;
      const version = aiFileContentVersion(current);
      const writes = await Promise.allSettled([
        aiProjects.writeFile(project.id, subject, { ...input, expectedVersion: version, bytes: new Uint8Array([1]) }),
        aiProjects.writeFile(project.id, subject, { ...input, expectedVersion: version, bytes: new Uint8Array([2]) }),
      ]);
      expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
      expect(writes.filter((write) => write.status === "rejected")).toHaveLength(1);
      await expect(aiProjects.writeFile(project.id, subject, input)).rejects.toThrow("version conflict");
      const page = await aiProjects.listFiles(project.id, subject, { limit: 1 });
      expect(page.map((file) => file.path)).toEqual([input.path]);
      expect(await aiProjects.listFiles(project.id, subject, { after: input.path, limit: 1 })).toEqual([]);
    } finally {
      await aiProjects.delete(project.id, subject);
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("uses the access-owned Project schema", async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'ai'
        AND table_name IN ('projects', 'project_references', 'project_resource_refs')
    `;
    expect(columns).not.toContainEqual({ table_name: "projects", column_name: "owner_user_id" });
    expect(columns.some((column) => column.table_name === "project_references")).toBe(false);
    expect(columns.some((column) => column.table_name === "project_resource_refs")).toBe(true);
    expect(columns).not.toContainEqual({ table_name: "project_resource_refs", column_name: "created_by_user_id" });
  });

  test("shares through authoritative group access and snapshots Project context", async () => {
    const ownerId = await insertUser("owner");
    const memberId = await insertUser("member");
    const owner = { type: "user" as const, userId: ownerId };
    const member = { type: "user" as const, userId: memberId };
    const suffix = crypto.randomUUID();
    const [group] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name, description)
      VALUES (${`ai-project-${suffix}`}, 'local', ${`AI Project ${suffix}`}, 'Project integration test')
      RETURNING id
    `;

    try {
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${memberId}::uuid, ${group!.id}::uuid)`;
      const project = await aiProjects.create({
        subject: owner,
        name: "Support",
        instructions: "Answer with the support policy.",
        defaultModelProfileId: "model-support",
      });
      expect(project).not.toHaveProperty("ownerUserId");
      expect(await aiProjects.listAccess(project.id, owner)).toMatchObject([
        { principal: { type: "user", userId: ownerId }, permission: "admin" },
      ]);
      const grant = await aiProjects.grantAccess(project.id, owner, {
        principal: { type: "group", groupId: group!.id },
        permission: "write",
      });
      expect(grant?.permission).toBe("write");
      expect(grant?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect((await aiProjects.list(owner)).map((item) => item.id)).toContain(project.id);
      expect((await aiProjects.list(member)).map((item) => item.id)).toContain(project.id);
      expect(await aiProjects.resolveShortIds([project.id, project.id], member)).toEqual(new Map([[project.id, project.shortId]]));
      const visible = await aiProjects.get(project.id, member, "write");
      expect(visible?.permission).toBe("write");
      const knowledge = await aiProjects.createKnowledge(project.id, member, {
        title: "Escalation",
        content: "Escalate account lockouts to identity operations.",
      });
      const file = await aiProjects.writeFile(project.id, member, {
        path: "guides/triage.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Triage"),
      });
      const reference = await aiProjects.createReference(project.id, member, {
        ref: { type: "notebooks.notebook", id: "support-runbook" },
        label: "Runbook",
      });
      expect(project.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(knowledge?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(file?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(reference?.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(knowledge).not.toBeNull();
      expect(file).not.toBeNull();
      expect(reference).not.toBeNull();
      expect(new TextDecoder().decode((await aiProjects.readFileByPath(project.id, "guides/triage.md", member))?.bytes)).toBe("# Triage");

      const snapshot = await aiProjects.snapshot(project.id, member);
      expect(snapshot?.instructions).toBe("Answer with the support policy.");
      expect(snapshot?.defaultModelProfileId).toBe("model-support");
      expect(snapshot?.context).toContain("Escalation");
      expect(snapshot?.context).toContain("/project/guides/triage.md");
      expect(snapshot?.context).toContain("notebooks.notebook/support-runbook");

      const beforeRollback = await aiProjects.get(project.id, owner);
      await sql
        .unsafe(
          `ALTER TABLE ai.projects ADD CONSTRAINT ai_projects_test_touch_rollback CHECK (id <> '${project.id}'::uuid OR revision < 0) NOT VALID`,
        )
        .simple();
      try {
        await expect(
          aiProjects.createKnowledge(project.id, member, {
            title: "Must roll back",
            content: "The child write must not survive a failed revision bump.",
          }),
        ).rejects.toThrow();
      } finally {
        await sql`ALTER TABLE ai.projects DROP CONSTRAINT ai_projects_test_touch_rollback`;
      }
      expect((await aiProjects.listKnowledge(project.id, member)).some((item) => item.title === "Must roll back")).toBe(false);
      expect((await aiProjects.get(project.id, owner))?.revision).toBe(beforeRollback?.revision);

      const ownerChat = await aiConversations.createConversation({ ownerUserId: ownerId, projectId: project.id });
      const memberChat = await aiConversations.createConversation({ ownerUserId: memberId, projectId: project.id });
      expect((await aiConversations.listConversations({ ownerUserId: ownerId })).map((chat) => chat.id)).toEqual([ownerChat.id]);
      expect((await aiConversations.listConversations({ ownerUserId: memberId })).map((chat) => chat.id)).toEqual([memberChat.id]);
      expect(ownerChat.projectId).toBe(project.id);
      expect(memberChat.projectId).toBe(project.id);

      expect(await aiProjects.revokeAccess(project.id, grant!.id, owner)).toBe(true);
      expect(await aiProjects.get(project.id, member)).toBeNull();
      expect(await aiProjects.readFileByPath(project.id, "guides/triage.md", member)).toBeNull();
      expect(await aiProjects.resolveShortIds([project.id], member)).toEqual(new Map());
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id IN (${ownerId}::uuid, ${memberId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid, ${memberId}::uuid)`;
      await sql`DELETE FROM auth.groups WHERE id = ${group!.id}::uuid`;
    }
  });

  test("creates service-account Projects and permits duplicate display names", async () => {
    const serviceAccountId = await insertServiceAccount("creator");
    const subject = { type: "service_account" as const, serviceAccountId };
    const created: string[] = [];
    try {
      const first = await aiProjects.create({ subject, name: "Duplicate" });
      const second = await aiProjects.create({ subject, name: "Duplicate" });
      created.push(first.id, second.id);
      expect(first.shortId).not.toBe(second.shortId);
      expect((await aiProjects.list(subject)).filter((project) => project.name === "Duplicate")).toHaveLength(2);
      expect(await aiProjects.listAccess(first.id, subject)).toMatchObject([
        { principal: { type: "service_account", serviceAccountId }, permission: "admin" },
      ]);
    } finally {
      for (const projectId of created) await aiProjects.delete(projectId, subject);
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
    }
  });

  test("resolves authenticated principals and rejects public grants", async () => {
    const creatorId = await insertUser("matrix-creator");
    const nestedUserId = await insertUser("matrix-nested");
    const outsideUserId = await insertUser("matrix-outside");
    const serviceAccountId = await insertServiceAccount("matrix");
    const creator = { type: "user" as const, userId: creatorId };
    const nestedUser = { type: "user" as const, userId: nestedUserId };
    const outsideUser = { type: "user" as const, userId: outsideUserId };
    const service = { type: "service_account" as const, serviceAccountId };
    const suffix = crypto.randomUUID();
    const groups = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name, description)
      VALUES
        (${`ai-project-parent-${suffix}`}, 'local', 'Project parent', 'Project matrix parent'),
        (${`ai-project-child-${suffix}`}, 'local', 'Project child', 'Project matrix child')
      RETURNING id
    `;
    let projectId: string | null = null;
    try {
      await sql`
        INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
        VALUES (${groups[0]!.id}::uuid, ${groups[1]!.id}::uuid)
      `;
      await sql`
        INSERT INTO auth.user_groups_v2 (user_id, group_id)
        VALUES (${nestedUserId}::uuid, ${groups[1]!.id}::uuid)
      `;
      const project = await aiProjects.create({ subject: creator, name: "Matrix" });
      projectId = project.id;
      await aiProjects.grantAccess(project.id, creator, {
        principal: { type: "group", groupId: groups[0]!.id },
        permission: "write",
      });
      await aiProjects.grantAccess(project.id, creator, {
        principal: { type: "service_account", serviceAccountId },
        permission: "write",
      });
      await aiProjects.grantAccess(project.id, creator, {
        principal: { type: "authenticated" },
        permission: "read",
      });

      expect((await aiProjects.get(project.id, nestedUser))?.permission).toBe("write");
      expect((await aiProjects.get(project.id, service))?.permission).toBe("write");
      expect((await aiProjects.get(project.id, outsideUser))?.permission).toBe("read");
      expect(await aiProjects.get(project.id, null)).toBeNull();

      await expect(aiProjects.grantAccess(project.id, creator, { principal: { type: "public" }, permission: "admin" })).rejects.toThrow();
      await expect(aiProjects.admin.grantAccess(project.id, { principal: { type: "public" }, permission: "read" })).rejects.toThrow();
      expect(await aiProjects.get(project.id, null)).toBeNull();
      expect(await aiProjects.list(null)).toEqual([]);
      expect(await aiProjects.createKnowledge(project.id, null, { title: "Public", content: "Public write." })).toBeNull();
    } finally {
      if (projectId) await aiProjects.delete(projectId, creator);
      await sql`DELETE FROM auth.users WHERE id IN (${creatorId}::uuid, ${nestedUserId}::uuid, ${outsideUserId}::uuid)`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${groups[0]!.id}::uuid, ${groups[1]!.id}::uuid)`;
    }
  });

  test("keeps a Project and its children when the creator is deleted", async () => {
    const creatorId = await insertUser("deleted-creator");
    const memberId = await insertUser("surviving-member");
    const creator = { type: "user" as const, userId: creatorId };
    const member = { type: "user" as const, userId: memberId };
    const suffix = crypto.randomUUID();
    const [group] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name, description)
      VALUES (${`ai-project-survivor-${suffix}`}, 'local', ${`AI Project survivor ${suffix}`}, 'Project survivor test')
      RETURNING id
    `;
    let projectId: string | null = null;
    try {
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${memberId}::uuid, ${group!.id}::uuid)`;
      const project = await aiProjects.create({ subject: creator, name: "Durable" });
      projectId = project.id;
      const knowledge = await aiProjects.createKnowledge(project.id, creator, { title: "Policy", content: "Keep this." });
      if (!knowledge) throw new Error("Expected Project knowledge");
      await aiProjects.writeFile(project.id, creator, {
        path: "policy.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("Keep this."),
      });
      await aiProjects.createReference(project.id, creator, {
        ref: { type: "notebooks.notebook", id: "durable" },
        label: "Durable",
      });
      await aiProjects.grantAccess(project.id, creator, {
        principal: { type: "group", groupId: group!.id },
        permission: "admin",
      });

      await sql`DELETE FROM auth.users WHERE id = ${creatorId}::uuid`;

      expect(await aiProjects.get(project.id, member, "admin")).not.toBeNull();
      expect(await aiProjects.listKnowledge(project.id, member)).toHaveLength(1);
      expect(await aiProjects.getKnowledgeByShortId(project.id, knowledge.shortId, member)).toMatchObject({ title: "Policy" });
      expect(await aiProjects.listFiles(project.id, member)).toHaveLength(1);
      expect(await aiProjects.listReferences(project.id, member)).toHaveLength(1);
    } finally {
      if (projectId) await aiProjects.delete(projectId, member);
      await sql`DELETE FROM auth.users WHERE id IN (${creatorId}::uuid, ${memberId}::uuid)`;
      await sql`DELETE FROM auth.groups WHERE id = ${group!.id}::uuid`;
    }
  });

  test("keeps a sole-creator Project after external principal deletion", async () => {
    const creatorId = await insertUser("sole-creator");
    const readerId = await insertUser("surviving-reader");
    const rescuerId = await insertUser("project-rescuer");
    const creator = { type: "user" as const, userId: creatorId };
    const rescuer = { type: "user" as const, userId: rescuerId };
    const name = `Unclaimed ${crypto.randomUUID()}`;
    const project = await aiProjects.create({ subject: creator, name });
    let deleted = false;
    try {
      await aiProjects.createKnowledge(project.id, creator, { title: "Policy", content: "Keep this." });
      await aiProjects.grantAccess(project.id, creator, {
        principal: { type: "user", userId: readerId },
        permission: "read",
      });

      await sql`DELETE FROM auth.users WHERE id = ${creatorId}::uuid`;

      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.projects WHERE id = ${project.id}::uuid`)[0]?.count,
      ).toBe(1);
      expect(
        (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.project_knowledge WHERE project_id = ${project.id}::uuid`)[0]
          ?.count,
      ).toBe(1);
      expect(await aiProjects.get(project.id, creator)).toBeNull();

      const adminList = await aiProjects.admin.list({ search: name, page: 1, perPage: 10 });
      expect(adminList.items).toMatchObject([{ id: project.id, shortId: project.shortId, accessCount: 1, adminCount: 0 }]);
      expect(await aiProjects.admin.summary({ search: name })).toEqual({ total: 1, unmanaged: 1, totalAccess: 1 });

      const recovered = await aiProjects.admin.grantAccess(project.id, {
        principal: { type: "user", userId: rescuerId },
        permission: "admin",
      });
      expect(recovered?.permission).toBe("admin");
      expect(await aiProjects.get(project.id, rescuer, "admin")).not.toBeNull();
      await expect(aiProjects.admin.revokeAccess(project.id, recovered!.id)).rejects.toThrow("at least one admin");
      expect(await aiProjects.admin.delete(project.id)).toBe(true);
      deleted = true;
    } finally {
      if (!deleted) {
        if (await aiProjects.get(project.id, rescuer, "admin")) await aiProjects.delete(project.id, rescuer);
        else await sql`DELETE FROM ai.projects WHERE id = ${project.id}::uuid`;
      }
      await sql`DELETE FROM auth.users WHERE id IN (${creatorId}::uuid, ${readerId}::uuid, ${rescuerId}::uuid)`;
    }
  });

  test("does not leak access rows when deletion races a grant", async () => {
    const creatorId = await insertUser("delete-race-creator");
    const targetId = await insertUser("delete-race-target");
    const creator = { type: "user" as const, userId: creatorId };
    const project = await aiProjects.create({ subject: creator, name: "Delete race" });
    const before = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.access WHERE user_id = ${targetId}::uuid`)[0]!
      .count;

    await Promise.all([
      aiProjects.grantAccess(project.id, creator, {
        principal: { type: "user", userId: targetId },
        permission: "read",
      }),
      aiProjects.delete(project.id, creator),
    ]);

    const after = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.access WHERE user_id = ${targetId}::uuid`)[0]!
      .count;
    expect(after).toBe(before);
    await sql`DELETE FROM auth.users WHERE id IN (${creatorId}::uuid, ${targetId}::uuid)`;
  });

  test("never removes the final admin, including concurrent revokes", async () => {
    const firstId = await insertUser("first-admin");
    const secondId = await insertUser("second-admin");
    const first = { type: "user" as const, userId: firstId };
    const second = { type: "user" as const, userId: secondId };
    let projectId: string | null = null;
    try {
      const project = await aiProjects.create({ subject: first, name: "Guarded" });
      projectId = project.id;
      const [initial] = (await aiProjects.listAccess(project.id, first))!;
      await expect(aiProjects.updateAccess(project.id, initial!.id, first, "write")).rejects.toThrow("at least one admin");
      await expect(aiProjects.revokeAccess(project.id, initial!.id, first)).rejects.toThrow("at least one admin");

      const added = await aiProjects.grantAccess(project.id, first, {
        principal: { type: "user", userId: secondId },
        permission: "admin",
      });
      const results = await Promise.all([
        aiProjects.revokeAccess(project.id, added!.id, first),
        aiProjects.revokeAccess(project.id, initial!.id, second),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const survivingSubject = (await aiProjects.get(project.id, first, "admin")) ? first : second;
      expect(await aiProjects.listAccess(project.id, survivingSubject)).toHaveLength(1);
    } finally {
      if (projectId) {
        const subject = (await aiProjects.get(projectId, first, "admin")) ? first : second;
        await aiProjects.delete(projectId, subject);
      }
      await sql`DELETE FROM auth.users WHERE id IN (${firstId}::uuid, ${secondId}::uuid)`;
    }
  });
});
