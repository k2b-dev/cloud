import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrateCloudAi } from "./migrate";
import { aiSkills } from "./skills";
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
        name: skill.name,
        description: skill.description,
        instructions: "List wins, blockers, and next steps.",
        extraFrontmatter: {},
        references: skill.references,
      });
      expect(updated?.revision).toBe(2);
      expect((await aiSkills.loadForTurn(turn!.id, skill.name, member))?.instructions).toBe("List wins and blockers.");

      expect((await aiSkills.list(member)).find((entry) => entry.id === skill.id)?.enabled).toBe(true);
      expect(await aiSkills.setEnabled(skill.id, member, false)).toBe(false);
      expect((await aiSkills.list(member)).find((entry) => entry.id === skill.id)?.enabled).toBe(false);
      expect(await aiSkills.loadForTurn(turn!.id, skill.name, member)).toBeNull();
      expect(await aiSkills.listTurnFiles(turn!.id, member)).toEqual([]);
      expect(await aiSkills.readTurnFile(turn!.id, `${skill.name}/SKILL.md`, member)).toBeNull();

      expect(await aiSkills.setEnabled(skill.id, member, true)).toBe(true);
      expect((await aiSkills.list(member)).find((entry) => entry.id === skill.id)?.enabled).toBe(true);
      expect((await aiSkills.listTurnFiles(turn!.id, member)).length).toBe(2);

      expect(await aiSkills.revokeAccess(skill.id, grant!.id, owner)).toBe(true);
      expect(await aiSkills.listTurnFiles(turn!.id, member)).toEqual([]);
      expect(await aiSkills.readTurnFile(turn!.id, `${skill.name}/SKILL.md`, member)).toBeNull();
    } finally {
      if (skillId) await aiSkills.delete(skillId, owner);
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid, ${memberId}::uuid)`;
    }
  });
});
