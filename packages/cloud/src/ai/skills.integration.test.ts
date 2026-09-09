import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrateCloudAi } from "./migrate";
import { AiSkillRevisionConflictError, aiSkills } from "./skills";
import { aiConversations } from "./store";

const canUseAiDatabase = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ users: string | null; access: string | null }[]>`
      SELECT to_regclass('auth.users')::text AS users, to_regclass('auth.access')::text AS access
    `;
    if (!row?.users || !row.access) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};

const insertUser = async (label: string): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-skill-${label}-${suffix}`}, 'local', 'user', ${`Skill ${label}`}, ${`ai-skill-${suffix}@example.test`}, 'AI', 'Skill')
    RETURNING id
  `;
  return row!.id;
};

describe.skipIf(!(await canUseAiDatabase()))("aiSkills (integration)", () => {
  test("seeds one ordinary Skill once, then leaves permissions, edits, and deletion to admins", async () => {
    const userId = await insertUser("seeded");
    const subject = { type: "user" as const, userId };
    const suffix = crypto.randomUUID().slice(0, 8);
    const key = `test:seeded-${suffix}`;
    const name = `seeded-${suffix}`;
    let skillId: string | undefined;

    try {
      const seed = {
        key,
        name,
        description: "Create a seeded test workflow when integration coverage needs it.",
        instructions: "Follow the seeded workflow.",
      };
      await aiSkills.seedOnce(seed);
      const first = await aiSkills.getByName(name, subject);
      expect(first).toMatchObject({ permission: "read", enabled: true, revision: 1 });
      skillId = first!.id;

      await aiSkills.seedOnce(seed);
      expect((await aiSkills.getByName(name, subject))?.revision).toBe(1);

      await aiSkills.seedOnce({ ...seed, instructions: "Do not reconcile this later change." });
      expect((await aiSkills.getByName(name, subject))?.instructions).toBe("Follow the seeded workflow.");
      expect(await aiSkills.admin.summary({ search: name })).toEqual({ total: 1, unmanaged: 1, totalAccess: 1 });

      expect(await aiSkills.setEnabled(skillId, subject, false)).toBe(false);
      expect((await aiSkills.getByName(name, subject))?.enabled).toBe(false);

      await aiSkills.admin.grantAccess(skillId, { principal: { type: "user", userId }, permission: "admin" });
      expect(await aiSkills.get(skillId, subject, "admin")).not.toBeNull();
      expect(await aiSkills.admin.delete(skillId)).toBe(true);
      skillId = undefined;

      await aiSkills.seedOnce(seed);
      expect(await aiSkills.getByName(name, subject)).toBeNull();
    } finally {
      if (skillId) await aiSkills.admin.delete(skillId);
      await sql`DELETE FROM ai.skill_seeds WHERE key = ${key}`;
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
});
