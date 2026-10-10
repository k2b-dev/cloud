import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { accessRevision } from "../server/services/access-revision";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { AiSkillRevisionConflictError, aiSkills } from "./skills";
import { aiConversations } from "./store";

const insertUser = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-skill-${label}-${suffix}`}, 'local', 'user', ${`Skill ${label}`}, ${`ai-skill-${suffix}@example.test`}, 'AI', 'Skill')
    RETURNING id
  `;
  return row!.id;
};

databaseSuite()("aiSkills (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("blocks anonymous legacy grants and converts only Skill/Project grants to authenticated access", async () => {
    const userId = await insertUser("authenticated-only");
    const owner = { type: "user" as const, userId };
    const skill = await aiSkills.create({
      subject: owner,
      name: `auth-only-${crypto.randomUUID()}`,
      description: "Private skill.",
      instructions: "Private instructions.",
    });
    const project = await aiProjects.create({ subject: owner, name: "Authenticated project" });
    const grants = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (permission, authenticated_only) VALUES ('read', false), ('write', false), ('read', false) RETURNING id`;
    try {
      await sql`INSERT INTO ai.skill_access(skill_id, access_id, short_id) VALUES (${skill.id}::uuid, ${grants[0]!.id}::uuid, 'Aut234')`;
      await sql`INSERT INTO ai.project_access(project_id, access_id, short_id) VALUES (${project.id}::uuid, ${grants[1]!.id}::uuid, 'Aut234')`;
      await aiProjects.createKnowledge(project.id, owner, { title: "Private", content: "Private knowledge" });
      await aiProjects.writeFile(project.id, owner, {
        path: "private.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("Private file"),
      });
      expect(await aiSkills.get(skill.id, null)).toBeNull();
      expect(await aiSkills.list(null)).toEqual([]);
      expect((await aiSkills.search(null, "private")).skills).toEqual([]);
      expect(await aiProjects.get(project.id, null)).toBeNull();
      expect(await aiProjects.list(null)).toEqual([]);
      expect(await aiProjects.listKnowledge(project.id, null)).toEqual([]);
      expect(await aiProjects.listFiles(project.id, null)).toEqual([]);
      expect(await aiProjects.readFileByPath(project.id, "private.txt", null)).toBeNull();
      expect(await aiProjects.createKnowledge(project.id, null, { title: "Bad", content: "Anonymous" })).toBeNull();
      await expect(aiSkills.grantAccess(skill.id, owner, { principal: { type: "public" }, permission: "read" })).rejects.toThrow();
      await expect(aiSkills.admin.grantAccess(skill.id, { principal: { type: "public" }, permission: "read" })).rejects.toThrow();
      for (let run = 0; run < 2; run++) {
        await migrateCloudAi();
        const rows = await sql<
          { id: string; authenticated_only: boolean; permission: string }[]
        >`SELECT id, authenticated_only, permission FROM auth.access WHERE id IN (${grants[0]!.id}::uuid, ${grants[1]!.id}::uuid, ${grants[2]!.id}::uuid)`;
        expect(rows.find((row) => row.id === grants[0]!.id)).toMatchObject({ authenticated_only: true, permission: "read" });
        expect(rows.find((row) => row.id === grants[1]!.id)).toMatchObject({ authenticated_only: true, permission: "write" });
        expect(rows.find((row) => row.id === grants[2]!.id)).toMatchObject({ authenticated_only: false, permission: "read" });
      }
      expect((await aiSkills.listAccess(skill.id, owner))?.find((entry) => entry.shortId === "Aut234")?.principal).toEqual({
        type: "authenticated",
      });
      expect((await aiProjects.listAccess(project.id, owner))?.find((entry) => entry.shortId === "Aut234")?.principal).toEqual({
        type: "authenticated",
      });
      expect(await aiSkills.get(skill.id, null)).toBeNull();
      expect(await aiProjects.get(project.id, null)).toBeNull();
    } finally {
      await aiSkills.admin.delete(skill.id);
      await aiProjects.admin.delete(project.id);
      await sql`DELETE FROM auth.access WHERE id = ${grants[2]!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("Project links grant read/use and survive their creator losing access", async () => {
    const ownerId = await insertUser("project-owner"),
      memberId = await insertUser("project-member"),
      successorId = await insertUser("successor");
    const owner = { type: "user" as const, userId: ownerId },
      member = { type: "user" as const, userId: memberId },
      successor = { type: "user" as const, userId: successorId };
    const skill = await aiSkills.create({
      subject: owner,
      name: `project-skill-${crypto.randomUUID()}`,
      description: "A reconciliation workflow.",
      instructions: "Reconcile statements.",
    });
    const project = await aiProjects.create({ subject: owner, name: "Linked skills" });
    const conversation = await aiConversations.createConversation({ ownerUserId: memberId });
    const [turn] = await sql<
      { id: string }[]
    >`INSERT INTO ai.turns(short_id,conversation_id,status) VALUES(${`skill-${crypto.randomUUID()}`},${conversation.id}::uuid,'queued') RETURNING id`;
    try {
      await aiProjects.grantAccess(project.id, owner, { principal: { type: "user", userId: memberId }, permission: "read" });
      expect(await aiSkills.linkProject(skill.id, project.id, true, member)).toBe(false);
      expect(
        (await aiSkills.projectSkills(project.id, owner, { available: true, query: "reconciliation" }))?.items.map((item) => item.id),
      ).toContain(skill.id);
      expect(await aiSkills.projectSkills(project.id, member, { available: true })).toBeNull();
      expect(await aiSkills.linkProject(skill.id, project.id, true, owner)).toBe(true);
      expect((await aiSkills.projectSkills(project.id, owner, { available: true }))?.items).toEqual([]);
      expect((await aiSkills.projectSkills(project.id, member))?.items).toMatchObject([{ id: skill.id, permission: "read" }]);
      expect((await aiSkills.get(skill.id, member))?.permission).toBe("read");
      expect(await aiSkills.get(skill.id, member, "write")).toBeNull();
      expect(await aiSkills.listAccess(skill.id, member)).toBeNull();
      expect((await aiSkills.search(member, "reconciliation")).skills.map((item) => item.id)).toContain(skill.id);
      expect(await aiSkills.get(skill.id, null)).toBeNull();
      expect(await aiSkills.loadForTurn(turn!.id, skill.name, member)).toMatchObject({ instructions: "Reconcile statements." });
      expect(await aiSkills.listTurnFiles(turn!.id, member)).toHaveLength(1);
      await aiSkills.setEnabled(skill.id, member, false);
      expect((await aiSkills.search(member, "reconciliation")).skills.map((item) => item.id)).not.toContain(skill.id);
      expect(await aiSkills.readTurnFile(turn!.id, `${skill.name}/SKILL.md`, member)).toBeNull();
      await aiSkills.setEnabled(skill.id, member, true);
      expect(await aiSkills.readTurnFile(turn!.id, `${skill.name}/SKILL.md`, member)).not.toBeNull();
      // A link has no dependency on its creator's later grants or membership.
      await aiSkills.grantAccess(skill.id, owner, { principal: { type: "user", userId: successorId }, permission: "admin" });
      const ownSkillGrant = (await aiSkills.listAccess(skill.id, owner))!.find(
        (entry) => entry.principal.type === "user" && entry.principal.userId === ownerId,
      )!;
      await aiSkills.revokeAccess(skill.id, ownSkillGrant.id, successor);
      expect((await aiSkills.get(skill.id, member))?.permission).toBe("read");
      expect(await aiSkills.linkedProjects(skill.id, successor)).toEqual([{ projectId: project.id, shortId: null, name: null }]);
      await aiProjects.grantAccess(project.id, owner, { principal: { type: "user", userId: successorId }, permission: "admin" });
      const ownProjectGrant = (await aiProjects.listAccess(project.id, owner))!.find(
        (entry) => entry.principal.type === "user" && entry.principal.userId === ownerId,
      )!;
      await aiProjects.revokeAccess(project.id, ownProjectGrant.id, successor);
      expect(await aiSkills.get(skill.id, owner)).toBeNull();
      expect((await aiSkills.get(skill.id, member))?.permission).toBe("read");
      const memberGrant = (await aiProjects.listAccess(project.id, successor))!.find(
        (entry) => entry.principal.type === "user" && entry.principal.userId === memberId,
      )!;
      await aiProjects.revokeAccess(project.id, memberGrant.id, successor);
      expect(await aiSkills.get(skill.id, member)).toBeNull();
      expect(await aiSkills.listTurnFiles(turn!.id, member)).toEqual([]);
      expect(await aiSkills.readTurnFile(turn!.id, `${skill.name}/SKILL.md`, member)).toBeNull();
      await aiProjects.grantAccess(project.id, successor, { principal: { type: "user", userId: memberId }, permission: "read" });
      await aiSkills.linkProject(skill.id, project.id, false, successor);
      expect(await aiSkills.get(skill.id, member)).toBeNull();
      await aiSkills.grantAccess(skill.id, successor, { principal: { type: "user", userId: memberId }, permission: "read" });
      await aiSkills.linkProject(skill.id, project.id, true, successor);
      await aiSkills.linkProject(skill.id, project.id, false, successor);
      expect((await aiSkills.get(skill.id, member))?.permission).toBe("read");
    } finally {
      await aiSkills.admin.delete(skill.id);
      await aiProjects.admin.delete(project.id);
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid,${memberId}::uuid,${successorId}::uuid)`;
    }
  });

  test("search ranks names and descriptions, tolerates typos, and checks access before limiting", async () => {
    const userId = await insertUser("search"),
      otherId = await insertUser("search-other");
    const owner = { type: "user" as const, userId },
      other = { type: "user" as const, userId: otherId };
    const suffix = crypto.randomUUID().slice(0, 8);
    const skills: Awaited<ReturnType<typeof aiSkills.create>>[] = [];
    try {
      skills.push(
        await aiSkills.create({
          subject: owner,
          name: `zz-invoices-${suffix}`,
          description: "Match receipts to bank transactions.",
          instructions: "Private instructions never searched.",
        }),
      );
      skills.push(
        await aiSkills.create({
          subject: owner,
          name: `aa-ledger-${suffix}`,
          description: "Process invoices and reconcile accounting.",
          instructions: "Do the work.",
        }),
      );
      skills.push(
        await aiSkills.create({
          subject: other,
          name: `secret-invoices-${suffix}`,
          description: "Private invoices.",
          instructions: "Do the work.",
        }),
      );
      // Built-in Skills seeded for every authenticated user share the catalog; rank only the fixture rows among them.
      const fixtureIds = (result: { skills: { id: string }[] }) =>
        result.skills.map((skill) => skill.id).filter((id) => skills.some((skill) => skill.id === id));
      const exact = await aiSkills.search(owner, `zz-invoices-${suffix}`, 1);
      expect(exact.skills.map((skill) => skill.id)).toEqual([skills[0]!.id]);
      // A typo in the name outranks the same typo in a description.
      expect(fixtureIds(await aiSkills.search(owner, "invioces"))).toEqual([skills[0]!.id, skills[1]!.id]);
      // The other user's Skill ranks highest for this query but must not consume the single slot.
      const fuzzy = await aiSkills.search(owner, "invioces", 1);
      expect(fuzzy.skills).toHaveLength(1);
      expect(fuzzy.skills[0]!.id).not.toBe(skills[2]!.id);
      expect(fuzzy.more).toBe(true);
      expect(fixtureIds(await aiSkills.search(owner, "reciepts transactions"))).toEqual([skills[0]!.id]);
      expect((await aiSkills.search(owner, "secret")).skills).toEqual([]);
      expect((await aiSkills.search(owner, "Private instructions")).skills).toEqual([]);
      expect((await aiSkills.search(owner, "%%%")).skills).toEqual([]);
      await aiSkills.setEnabled(skills[0]!.id, owner, false);
      expect(fixtureIds(await aiSkills.search(owner, "receipts"))).toEqual([]);
      expect((await aiSkills.list(owner)).some((skill) => skill.id === skills[0]!.id && !skill.enabled)).toBe(true);
      await aiSkills.setEnabled(skills[0]!.id, owner, true);
      // The result must remain discoverable beyond the old 200-row catalog cap.
      await sql`INSERT INTO ai.skills (short_id, name, description, instructions)
        SELECT 't' || lpad(n::text, 5, '0'), 'a-padding-' || ${suffix} || '-' || n, 'Other work', 'Work'
        FROM generate_series(1, 201) n`;
      await sql`INSERT INTO ai.skill_access(skill_id, access_id, short_id)
        SELECT padding.id, original.access_id, padding.short_id FROM ai.skills padding
        CROSS JOIN ai.skill_access original WHERE original.skill_id = ${skills[0]!.id}::uuid
        AND padding.name LIKE ${"a-padding-" + suffix + "-%"} `;
      expect(fixtureIds(await aiSkills.search(owner, "receipts"))).toEqual([skills[0]!.id]);
      expect(fixtureIds(await aiSkills.search(owner, "reciepts"))).toEqual([skills[0]!.id]);
    } finally {
      await sql`DELETE FROM ai.skills WHERE name LIKE ${"a-padding-" + suffix + "-%"}`;
      for (const skill of skills) await aiSkills.admin.delete(skill.id);
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${otherId}::uuid)`;
    }
  });

  test("grant revisions serialize reviewed changes and keep the last administrator", async () => {
    const ownerId = await insertUser("access-owner"),
      otherId = await insertUser("access-reader");
    const owner = { type: "user" as const, userId: ownerId };
    const skill = await aiSkills.create({
      subject: owner,
      name: `access-${crypto.randomUUID()}`,
      description: "Reviewed access fixture",
      instructions: "Summarize the supplied text.",
    });
    try {
      const initial = (await aiSkills.listAccess(skill.id, owner))!;
      const expected = accessRevision(initial);
      const changes = await Promise.allSettled([
        aiSkills.grantAccess(skill.id, owner, { principal: { type: "user", userId: otherId }, permission: "read" }, expected),
        aiSkills.grantAccess(skill.id, owner, { principal: { type: "authenticated" }, permission: "read" }, expected),
      ]);
      expect(changes.filter((change) => change.status === "fulfilled")).toHaveLength(1);
      expect(changes.filter((change) => change.status === "rejected")).toHaveLength(1);
      const current = (await aiSkills.listAccess(skill.id, owner))!;
      await expect(aiSkills.revokeAccess(skill.id, initial[0]!.id, owner, accessRevision(current))).rejects.toThrow("at least one admin");
      await expect(aiSkills.updateAccess(skill.id, initial[0]!.id, owner, "read", expected)).rejects.toBeInstanceOf(
        AiSkillRevisionConflictError,
      );
      expect(await aiSkills.listAccess(skill.id, { type: "user", userId: otherId })).toBeNull();
    } finally {
      await aiSkills.admin.delete(skill.id);
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid,${otherId}::uuid)`;
    }
  });
  test("returns an agent grant with its kind so the permission editor can name it", async () => {
    const userId = await insertUser("agent-kind");
    const owner = { type: "user" as const, userId };
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`AI Skill agent ${crypto.randomUUID()}`}, 'agent') RETURNING id
    `;
    const principal = { type: "service_account" as const, serviceAccountId: agent!.id };
    const skill = await aiSkills.create({
      subject: owner,
      name: `agent-kind-${crypto.randomUUID()}`,
      description: "Agent kind fixture",
      instructions: "Summarize the supplied text.",
    });
    try {
      expect(await aiSkills.grantAccess(skill.id, owner, { principal, permission: "read" })).toMatchObject({
        principal,
        serviceAccountKind: "agent",
      });
      expect((await aiSkills.listAccess(skill.id, owner))?.find((entry) => entry.principal.type === "service_account")).toMatchObject({
        principal,
        serviceAccountKind: "agent",
      });
    } finally {
      await aiSkills.admin.delete(skill.id);
      await sql`DELETE FROM auth.service_accounts WHERE id = ${agent!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("shares through Cloud access, pins one turn revision, and rechecks access for mounted files", async () => {
    const ownerId = await insertUser("owner");
    const memberId = await insertUser("member");
    const owner = { type: "user" as const, userId: ownerId };
    const member = { type: "user" as const, userId: memberId };
    const conversation = await aiConversations.createConversation({ ownerUserId: ownerId });
    const [turn] = await sql<{ id: string }[]>`
      INSERT INTO ai.turns (short_id, conversation_id, status)
      VALUES (${`skill-${crypto.randomUUID()}`}, ${conversation.id}::uuid, 'queued')
      RETURNING id
    `;
    let skillId: string | undefined;

    try {
      const skill = await aiSkills.create({
        subject: owner,
        name: `weekly-${crypto.randomUUID().slice(0, 8)}`,
        description: "Summarize recent work.",
        instructions: "List wins and blockers.",
        references: [{ path: "references/style.md", content: "Be concise." }],
      });
      skillId = skill.id;
      const grant = await aiSkills.grantAccess(skill.id, owner, {
        principal: { type: "user", userId: memberId },
        permission: "read",
      });
      expect((await aiSkills.get(skill.id, member))?.permission).toBe("read");

      const loaded = await aiSkills.loadForTurn(turn!.id, skill.name, member);
      expect(loaded).toMatchObject({ revision: 1, instructions: "List wins and blockers." });
      expect(loaded?.files.map((file) => file.path)).toEqual([
        `/skills/${skill.name}/SKILL.md`,
        `/skills/${skill.name}/references/style.md`,
      ]);

      const updated = await aiSkills.update(skill.id, owner, {
        expectedRevision: skill.revision,
        name: `${skill.name}-renamed`,
        description: skill.description,
        instructions: "List wins, blockers, and next steps.",
        extraFrontmatter: {},
        references: skill.references,
      });
      expect(updated?.revision).toBe(2);
      expect((await aiSkills.loadForTurn(turn!.id, { id: skill.shortId }, member))?.instructions).toBe("List wins and blockers.");
      expect(await aiSkills.loadForTurn(turn!.id, skill.name, member)).toBeNull();

      expect((await aiSkills.list(member)).find((entry) => entry.id === skill.id)?.enabled).toBe(true);
      expect(await aiSkills.setEnabled(skill.id, member, false)).toBe(false);
      expect((await aiSkills.list(member)).find((entry) => entry.id === skill.id)?.enabled).toBe(false);
      expect(await aiSkills.loadForTurn(turn!.id, { id: skill.shortId }, member)).toBeNull();
      expect(await aiSkills.listTurnFiles(turn!.id, member)).toEqual([]);
      expect(await aiSkills.readTurnFile(turn!.id, `${skill.name}/SKILL.md`, member)).toBeNull();

      expect(await aiSkills.setEnabled(skill.id, member, true)).toBe(true);
      expect((await aiSkills.list(member)).find((entry) => entry.id === skill.id)?.enabled).toBe(true);
      expect((await aiSkills.listTurnFiles(turn!.id, member)).length).toBe(2);

      expect(await aiSkills.revokeAccess(skill.id, grant!.id, owner)).toBe(true);
      expect(await aiSkills.loadForTurn(turn!.id, { id: skill.shortId }, member)).toBeNull();
      expect(await aiSkills.listTurnFiles(turn!.id, member)).toEqual([]);
      expect(await aiSkills.readTurnFile(turn!.id, `${skill.name}/SKILL.md`, member)).toBeNull();
    } finally {
      if (skillId) await aiSkills.delete(skillId, owner);
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid, ${memberId}::uuid)`;
    }
  });

  test("sets a reference batch atomically in one Skill revision", async () => {
    const ownerId = await insertUser("reference-batch");
    const owner = { type: "user" as const, userId: ownerId };
    let skillId: string | undefined;

    try {
      const skill = await aiSkills.create({
        subject: owner,
        name: `batch-${crypto.randomUUID().slice(0, 8)}`,
        description: "Exercise atomic reference batches.",
        instructions: "Use the supporting references.",
        references: [{ path: "references/topic-1.md", content: "Old topic 1" }],
      });
      skillId = skill.id;
      const references = Array.from({ length: 16 }, (_, index) => ({
        path: `references/topic-${index + 1}.md`,
        content: `Topic ${index + 1}`,
      }));

      const updated = await aiSkills.setReferences(skill.id, owner, {
        expectedRevision: skill.revision,
        references,
      });

      expect(updated).toMatchObject({ revision: 2, referenceCount: 16 });
      const sortedReferences = references.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      expect(updated?.references).toEqual(sortedReferences);

      await expect(
        aiSkills.setReferences(skill.id, owner, {
          expectedRevision: skill.revision,
          references: [{ path: "references/stale.md", content: "Must not be written." }],
        }),
      ).rejects.toBeInstanceOf(AiSkillRevisionConflictError);

      await expect(
        aiSkills.setReferences(skill.id, owner, {
          expectedRevision: updated!.revision,
          references: [
            { path: "references/duplicate.md", content: "First" },
            { path: "references/duplicate.md", content: "Second" },
          ],
        }),
      ).rejects.toThrow('Reference path "references/duplicate.md" is duplicated.');

      const unchanged = await aiSkills.get(skill.id, owner);
      expect(unchanged).toMatchObject({ revision: 2, referenceCount: 16 });
      expect(unchanged?.references).toEqual(sortedReferences);
    } finally {
      if (skillId) await aiSkills.delete(skillId, owner);
      await sql`DELETE FROM auth.users WHERE id = ${ownerId}::uuid`;
    }
  });

  test("recovers and deletes a Skill after its sole administrator account disappears", async () => {
    const ownerId = await insertUser("orphan-owner");
    const rescuerId = await insertUser("orphan-rescuer");
    const owner = { type: "user" as const, userId: ownerId };
    const rescuer = { type: "user" as const, userId: rescuerId };
    const name = `orphan-${crypto.randomUUID().slice(0, 8)}`;
    let skillId: string | undefined;

    try {
      const skill = await aiSkills.create({
        subject: owner,
        name,
        description: "Exercise platform administrator recovery.",
        instructions: "Recover this Skill.",
      });
      skillId = skill.id;
      await sql`DELETE FROM auth.users WHERE id = ${ownerId}::uuid`;

      expect((await aiSkills.admin.list({ search: name })).items).toMatchObject([{ id: skill.id, shortId: skill.shortId, adminCount: 0 }]);
      expect(await aiSkills.admin.summary({ search: name })).toEqual({ total: 1, unmanaged: 1, totalAccess: 0 });

      const recovered = await aiSkills.admin.grantAccess(skill.id, {
        principal: { type: "user", userId: rescuerId },
        permission: "admin",
      });
      expect(recovered?.permission).toBe("admin");
      expect(await aiSkills.get(skill.id, rescuer, "admin")).not.toBeNull();

      expect(await aiSkills.admin.delete(skill.id)).toBe(true);
      skillId = undefined;
      expect((await aiSkills.admin.list({ search: name })).items).toEqual([]);
    } finally {
      if (skillId) await aiSkills.admin.delete(skillId);
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid, ${rescuerId}::uuid)`;
    }
  });

  test("search ranks a typo'd name above a description word that shares a prefix", async () => {
    const userId = await insertUser("typo-rank");
    const owner = { type: "user" as const, userId };
    const suffix = crypto.randomUUID().slice(0, 8);
    const skills: Awaited<ReturnType<typeof aiSkills.create>>[] = [];
    try {
      skills.push(
        await aiSkills.create({
          subject: owner,
          name: `zz-invoices-${suffix}`,
          description: "Match receipts to bank transactions.",
          instructions: "Do the work.",
        }),
      );
      // "invioces" is closer to the partial extent "invi…" of "invitations" than to the whole word "invoices",
      // and "spaces" adds a small name hit; the typo'd name must still win.
      skills.push(
        await aiSkills.create({
          subject: owner,
          name: `aa-spaces-${suffix}`,
          description: "Send calendar invitations for events.",
          instructions: "Do the work.",
        }),
      );
      const result = await aiSkills.search(owner, "invioces");
      expect(result.skills[0]?.id).toBe(skills[0]!.id);
      expect(result.skills.map((skill) => skill.id).filter((id) => skills.some((skill) => skill.id === id))).toEqual([
        skills[0]!.id,
        skills[1]!.id,
      ]);
    } finally {
      for (const skill of skills) await aiSkills.admin.delete(skill.id);
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
