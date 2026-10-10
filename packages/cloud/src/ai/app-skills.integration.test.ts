import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import type { AppRegistryEntry } from "../contracts/registry";
import { getRoles } from "../services/accounts/users";
import { toPgTextArray } from "../services/postgres";
import { aiAppSkills, reconcileAppSkills } from "./app-skill-store";
import { type AppSkillDefinition, appSkillManifestHash, registerAppSkills, skill } from "./app-skills";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { AiSkillAppForbiddenError, AiSkillInputError, AiSkillRevisionConflictError, aiSkills } from "./skills";
import { aiConversations } from "./store";

const definition = (name: string, instructions = "Count each item.", references: Record<string, string> = {}): AppSkillDefinition =>
  skill({ markdown: `---\nname: ${name}\ndescription: Count inventory.\n---\n\n${instructions}\n`, references });
const user = async (profile: "user" | "guest" = "user") => {
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
    VALUES (${`app-skills-${crypto.randomUUID()}`}, 'local', ${profile}, 'App skills test') RETURNING id`;
  if (!row) throw new Error("Missing fixture user");
  return { type: "user" as const, userId: row.id };
};
const app = (skills: readonly AppSkillDefinition[], roles?: AppRegistryEntry["nav"]): AppRegistryEntry => ({
  id: `third-party-${crypto.randomUUID()}`,
  name: "Inventory",
  description: "Count inventory",
  icon: "ti ti-box",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory"],
  nav: roles,
  skills: { manifestHash: appSkillManifestHash(skills) },
});
const publish = async (entry: AppRegistryEntry, skills: readonly AppSkillDefinition[]): Promise<AppRegistryEntry> => {
  const next = { ...entry, skills: { manifestHash: appSkillManifestHash(skills) } };
  await registerAppSkills(next.id, skills, next.skills.manifestHash);
  await reconcileAppSkills([next]);
  return next;
};
const cleanup = async (appIds: string[]) => {
  const associations = await sql<{ skill_id: string | null }[]>`SELECT skill_id FROM ai.app_skills
    WHERE app_id=ANY(${toPgTextArray(appIds)}::text[])`;
  for (const row of associations) if (row.skill_id) await aiSkills.admin.delete(row.skill_id);
  await sql`DELETE FROM ai.app_skills WHERE app_id=ANY(${toPgTextArray(appIds)}::text[])`;
  await sql`DELETE FROM ai.app_skill_catalogs WHERE app_id=ANY(${toPgTextArray(appIds)}::text[])`;
};

// Every ordinary scenario owns a distinct app id and skill name. Migration uses the mandated old seed mappings.
databaseSuite()("app skills (integration)", () => {
  beforeAll(migrateCloudAi);

  test("third-party catalog installs ordinary read-only Skills and updates unedited content exactly once", async () => {
    const subject = await user(),
      name = `count-${crypto.randomUUID()}`;
    const first = definition(name, "Read [rules](references/rules.md).", { "references/rules.md": "Old rules" });
    let entry = app([first]);
    try {
      entry = await publish(entry, [first]);
      const installed = (await aiSkills.getByName(name, subject))!;
      expect(installed).toMatchObject({ revision: 1, permission: "read", source: { appId: entry.id, appName: "Inventory" } });
      expect(await aiSkills.admin.summary({ search: name })).toMatchObject({ unmanaged: 0 });
      expect(await aiSkills.admin.listAccess(installed.id)).toMatchObject([{ principal: { type: "authenticated" }, permission: "read" }]);
      await publish(entry, [first]);
      expect(await aiSkills.get(installed.id, subject)).toEqual(installed);
      const next = definition(name, "Read [rules](references/new.md).", { "references/new.md": "New rules" });
      entry = await publish(entry, [next]);
      const updated = (await aiSkills.get(installed.id, subject))!;
      // Compare plain JSON: definitions are deeply frozen and database rows are not plain objects.
      expect(
        JSON.parse(
          JSON.stringify({
            shortId: updated.shortId,
            revision: updated.revision,
            instructions: updated.instructions,
            references: updated.references,
          }),
        ),
      ).toEqual({
        shortId: installed.shortId,
        revision: 2,
        instructions: next.instructions,
        references: JSON.parse(JSON.stringify(next.references)),
      });
      expect((await aiSkills.admin.getByShortId(updated.shortId))?.source?.status).toBe("current");
      await publish(entry, [next]);
      expect(await aiSkills.get(installed.id, subject)).toEqual(updated);
      const [catalog] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.app_skill_catalogs WHERE app_id=${entry.id}`;
      expect(catalog?.count).toBe(2);
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("keeps administrator changes, reports updates, diffs and resets at the reviewed revision", async () => {
    const subject = await user(),
      name = `custom-${crypto.randomUUID()}`,
      first = definition(name);
    let entry = app([first]);
    try {
      entry = await publish(entry, [first]);
      const installed = (await aiSkills.getByName(name, subject))!;
      await aiSkills.admin.grantAccess(installed.id, { principal: { type: "user", userId: subject.userId }, permission: "write" });
      const customized = (await aiSkills.update(installed.id, subject, {
        ...installed,
        instructions: "Custom rules",
        expectedRevision: 1,
      }))!;
      expect((await aiSkills.admin.getByShortId(installed.shortId))?.source?.status).toBe("modified");
      const latest = definition(name, "New app rules");
      entry = await publish(entry, [latest]);
      expect(await aiSkills.get(installed.id, subject)).toEqual(customized);
      expect((await aiSkills.admin.getByShortId(installed.shortId))?.source?.status).toBe("update_available");
      const diff = (await aiAppSkills.appVersion(installed.id))!;
      expect(diff.current.markdown).toContain("Custom rules");
      expect(diff.app?.markdown).toContain("New app rules");
      expect(diff.appVersion).toBe(latest.hash);
      await expect(aiAppSkills.reset(installed.id, 1, latest.hash)).rejects.toBeInstanceOf(AiSkillRevisionConflictError);
      // A release published after the comparison is never applied unseen.
      await expect(aiAppSkills.reset(installed.id, 2, first.hash)).rejects.toThrow("Compare it again");
      expect(await aiAppSkills.reset(installed.id, 2, latest.hash)).toBe(true);
      expect(await aiSkills.get(installed.id, subject)).toMatchObject({ revision: 3, instructions: "New app rules" });
      expect((await aiSkills.admin.getByShortId(installed.shortId))?.source?.status).toBe("current");
      const converged = definition(name, "Converged rules");
      await aiSkills.update(installed.id, subject, { ...customized, instructions: converged.instructions, expectedRevision: 3 });
      await publish(entry, [converged]);
      expect(await aiSkills.get(installed.id, subject)).toMatchObject({ revision: 4, instructions: converged.instructions });
      const [managed] = await sql<{ applied_hash: string }[]>`SELECT applied_hash FROM ai.app_skills WHERE skill_id=${installed.id}::uuid`;
      expect(managed?.applied_hash).toBe(converged.hash);
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("every content field protects customization and concurrent edits share the revision lock", async () => {
    const subject = await user(),
      suffix = crypto.randomUUID().slice(0, 8),
      entry = app([]);
    try {
      for (const field of ["name", "description", "instructions", "extraFrontmatter", "references"] as const) {
        const name = `field-${field.toLowerCase()}-${suffix}`;
        const original = definition(name);
        const catalog = await publish(entry, [original]);
        const installed = (await aiSkills.getByName(name, subject))!;
        await aiSkills.admin.grantAccess(installed.id, { principal: { type: "user", userId: subject.userId }, permission: "write" });
        const fields = {
          name: `${name}-renamed`,
          description: "Custom description",
          instructions: "Custom instructions",
          extraFrontmatter: { metadata: { customized: true } },
          references: [{ path: "references/custom.md", content: "Custom" }],
        };
        const customized = (await aiSkills.update(installed.id, subject, { ...installed, [field]: fields[field], expectedRevision: 1 }))!;
        await publish(catalog, [definition(name, "App update")]);
        expect(await aiSkills.get(installed.id, subject)).toEqual(customized);
        expect((await aiSkills.admin.getByShortId(installed.shortId))?.source?.status).toBe("update_available");
      }
      const name = `race-${suffix}`,
        original = definition(name);
      const catalog = await publish(entry, [original]);
      const installed = (await aiSkills.getByName(name, subject))!;
      await aiSkills.admin.grantAccess(installed.id, { principal: { type: "user", userId: subject.userId }, permission: "write" });
      const results = await Promise.allSettled([
        aiSkills.update(installed.id, subject, { ...installed, instructions: "Concurrent edit", expectedRevision: 1 }),
        publish(catalog, [definition(name, "Concurrent app update")]),
      ]);
      expect(results[1]!.status).toBe("fulfilled");
      const current = (await aiSkills.get(installed.id, subject))!;
      expect(current.revision).toBe(2);
      expect(current.instructions).toBe(results[0]!.status === "fulfilled" ? "Concurrent edit" : "Concurrent app update");
      if (results[0]!.status === "rejected") expect(results[0]!.reason).toBeInstanceOf(AiSkillRevisionConflictError);
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("reset refuses a colliding original name without touching the administrator's content", async () => {
    const subject = await user(),
      name = `reset-name-${crypto.randomUUID()}`,
      source = definition(name);
    const entry = app([source]);
    let userSkillId: string | undefined;
    try {
      await publish(entry, [source]);
      const installed = (await aiSkills.getByName(name, subject))!;
      await aiSkills.admin.grantAccess(installed.id, { principal: { type: "user", userId: subject.userId }, permission: "write" });
      const customized = await aiSkills.update(installed.id, subject, { ...installed, name: `${name}-custom`, expectedRevision: 1 });
      const owned = await aiSkills.create({ subject, name, description: "User skill", instructions: "Keep my work" });
      userSkillId = owned.id;
      await expect(aiAppSkills.reset(installed.id, 2, source.hash)).rejects.toThrow("name already exists");
      expect(await aiSkills.get(installed.id, subject)).toEqual(customized);
      expect(await aiSkills.get(owned.id, subject)).toEqual(owned);
      await aiSkills.admin.delete(owned.id);
      expect(await aiAppSkills.reset(installed.id, 2, source.hash)).toBe(true);
      expect(await aiSkills.get(installed.id, subject)).toMatchObject({ name, revision: 3 });
    } finally {
      if (userSkillId) await aiSkills.admin.delete(userSkillId);
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("offline and removed skills disappear from every access path and return without losing edits or preferences", async () => {
    const subject = await user(),
      name = `offline-${crypto.randomUUID()}`,
      first = definition(name);
    let entry = app([first]);
    const conversation = await aiConversations.createConversation({ ownerUserId: subject.userId });
    const [turn] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id, conversation_id, status)
      VALUES (${`app-skill-${crypto.randomUUID()}`}, ${conversation.id}::uuid, 'queued') RETURNING id`;
    try {
      entry = await publish(entry, [first]);
      const installed = (await aiSkills.getByName(name, subject))!;
      expect(await aiSkills.loadForTurn(turn!.id, name, subject)).not.toBeNull();
      await aiSkills.admin.grantAccess(installed.id, { principal: { type: "user", userId: subject.userId }, permission: "admin" });
      await reconcileAppSkills([]);
      expect((await aiSkills.list(subject)).some((row) => row.id === installed.id)).toBe(false);
      expect((await aiSkills.search(subject, name)).skills).toEqual([]);
      expect(await aiSkills.get(installed.id, subject)).toBeNull();
      expect(await aiSkills.getByShortId(installed.shortId, subject)).toBeNull();
      expect(await aiSkills.getByName(name, subject)).toBeNull();
      expect(await aiSkills.loadForTurn(turn!.id, name, subject)).toBeNull();
      expect(await aiSkills.listTurnFiles(turn!.id, subject)).toEqual([]);
      expect(await aiSkills.readTurnFile(turn!.id, `${name}/SKILL.md`, subject)).toBeNull();
      expect(await aiSkills.setEnabled(installed.id, subject, false)).toBeNull();
      expect(await aiSkills.update(installed.id, subject, { ...installed, expectedRevision: 1 })).toBeNull();
      expect(await aiSkills.admin.getByShortId(installed.shortId)).toMatchObject({ source: { available: false } });
      await publish(entry, [first]);
      expect(await aiSkills.get(installed.id, subject)).toMatchObject({ revision: 1, enabled: true });
      await aiSkills.setEnabled(installed.id, subject, false);
      await publish(entry, []);
      expect(await aiSkills.get(installed.id, subject)).toBeNull();
      await publish(entry, [first]);
      expect(await aiSkills.get(installed.id, subject)).toMatchObject({ id: installed.id, enabled: false });
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("deletion stays tombstoned across new manifests until explicit restore", async () => {
    const subject = await user(),
      name = `deleted-${crypto.randomUUID()}`,
      first = definition(name);
    let entry = app([first]);
    try {
      entry = await publish(entry, [first]);
      const installed = (await aiSkills.getByName(name, subject))!;
      await aiSkills.admin.delete(installed.id);
      await publish(entry, [definition(name, "New app source")]);
      expect(await aiSkills.getByName(name, subject)).toBeNull();
      expect(await aiAppSkills.appSkillIssues()).toContainEqual({
        appId: entry.id,
        appName: "Inventory",
        name,
        state: "deleted",
        available: true,
      });
      expect(await aiAppSkills.restore(entry.id, name)).toBe(true);
      const restored = (await aiSkills.getByName(name, subject))!;
      expect(restored.id).not.toBe(installed.id);
      expect(restored.instructions).toBe("New app source");
      await expect(aiAppSkills.restore(entry.id, name)).rejects.toBeInstanceOf(AiSkillRevisionConflictError);
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("never overwrites or adopts a user skill with a colliding name; restore requires a free name", async () => {
    const subject = await user(),
      name = `collision-${crypto.randomUUID()}`,
      source = definition(name);
    const owned = await aiSkills.create({ subject, name, description: "User rules", instructions: "User instructions" });
    let entry = app([source]);
    try {
      entry = await publish(entry, [source]);
      expect(await aiSkills.get(owned.id, subject)).toEqual(owned);
      expect(await aiAppSkills.appSkillIssues()).toContainEqual({
        appId: entry.id,
        appName: "Inventory",
        name,
        state: "name_taken",
        available: true,
      });
      await expect(aiAppSkills.restore(entry.id, name)).rejects.toBeInstanceOf(AiSkillRevisionConflictError);
      await aiSkills.admin.delete(owned.id);
      expect(await aiAppSkills.restore(entry.id, name)).toBe(true);
      expect(await aiSkills.getByName(name, subject)).toMatchObject({
        permission: "read",
        instructions: source.instructions,
        source: { appId: entry.id },
      });
    } finally {
      await aiSkills.admin.delete(owned.id);
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("role audience excludes guests, delegated guests and standalone accounts; only direct skill grants override audience", async () => {
    const member = await user(),
      guest = await user("guest"),
      name = `audience-${crypto.randomUUID()}`,
      source = definition(name);
    const [sa] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name, kind) VALUES (${`skill-${crypto.randomUUID()}`}, 'standalone') RETURNING id`;
    const standalone = { type: "service_account" as const, serviceAccountId: sa!.id };
    const [delegation] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name, kind, delegated_user_id)
      VALUES (${`delegation-${crypto.randomUUID()}`}, 'user_delegated', ${guest.userId}::uuid) RETURNING id`;
    const delegatedGuest = { ...guest, delegatedByServiceAccountId: delegation!.id };
    let entry = app([source], { href: "/app/inventory", section: "primary", requiresRoles: ["user"] });
    const project = await aiProjects.create({ subject: member, name: "Project audience" });
    try {
      entry = await publish(entry, [source]);
      const installed = (await aiSkills.getByName(name, member))!;
      expect(await getRoles(guest.userId)).toEqual(["guest", "local", "local/guest"]);
      expect(await aiSkills.get(installed.id, guest)).toBeNull();
      expect(await aiSkills.get(installed.id, delegatedGuest)).toBeNull();
      expect(await aiSkills.get(installed.id, standalone)).toBeNull();
      expect((await aiSkills.list(guest)).some((row) => row.id === installed.id)).toBe(false);
      await aiSkills.admin.grantAccess(installed.id, { principal: { type: "user", userId: member.userId }, permission: "admin" });
      await aiProjects.grantAccess(project.id, member, { principal: { type: "user", userId: guest.userId }, permission: "read" });
      await aiSkills.linkProject(installed.id, project.id, true, member);
      expect(await aiSkills.get(installed.id, guest)).toBeNull();
      expect(await aiSkills.get(installed.id, delegatedGuest)).toBeNull();
      expect((await aiSkills.projectSkills(project.id, guest))?.items).toEqual([]);
      await aiSkills.admin.grantAccess(installed.id, { principal: { type: "user", userId: guest.userId }, permission: "read" });
      await aiSkills.admin.grantAccess(installed.id, { principal: standalone, permission: "read" });
      expect(await aiSkills.get(installed.id, guest)).not.toBeNull();
      expect(await aiSkills.get(installed.id, delegatedGuest)).not.toBeNull();
      expect(await aiSkills.get(installed.id, standalone)).not.toBeNull();
      await reconcileAppSkills([]);
      expect(await aiSkills.get(installed.id, guest)).toBeNull();
      expect(await aiSkills.get(installed.id, delegatedGuest)).toBeNull();
      expect(await aiSkills.get(installed.id, standalone)).toBeNull();
      await publish({ ...entry, nav: { ...entry.nav!, requiresRoles: [] } }, [source]);
      expect(await aiSkills.get(installed.id, member)).not.toBeNull(); // explicit direct administrator
    } finally {
      await aiProjects.admin.delete(project.id);
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.service_accounts WHERE id=${standalone.serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${member.userId}::uuid, ${guest.userId}::uuid)`;
    }
  });

  test("read-only app skills return a clear override error for every mutation", async () => {
    const subject = await user(),
      name = `read-only-${crypto.randomUUID()}`,
      source = definition(name);
    let entry = app([source]);
    try {
      entry = await publish(entry, [source]);
      const installed = (await aiSkills.getByName(name, subject))!;
      const operations = [
        () => aiSkills.update(installed.id, subject, { ...installed, expectedRevision: 1 }),
        () => aiSkills.setReference(installed.id, subject, { path: "references/r.md", content: "R", expectedRevision: 1 }),
        () => aiSkills.removeReference(installed.id, subject, { path: "references/r.md", expectedRevision: 1 }),
        () => aiSkills.delete(installed.id, subject),
        () => aiSkills.grantAccess(installed.id, subject, { principal: { type: "authenticated" }, permission: "write" }),
        () => aiSkills.updateAccess(installed.id, "access", subject, "write"),
        () => aiSkills.revokeAccess(installed.id, "access", subject),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toBeInstanceOf(AiSkillAppForbiddenError);
        await expect(operation()).rejects.toThrow("Inventory");
        await expect(operation()).rejects.toThrow("Administration");
      }
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("missing catalogs keep pending state; metadata changes reconcile and expired catalogs are cleaned", async () => {
    const subject = await user(),
      name = `pending-${crypto.randomUUID()}`,
      source = definition(name);
    let entry = app([source]);
    try {
      entry = await publish(entry, [source]);
      const installed = (await aiSkills.getByName(name, subject))!;
      await reconcileAppSkills([{ ...entry, skills: { manifestHash: "a".repeat(64) } }]);
      expect(await aiSkills.get(installed.id, subject)).not.toBeNull();
      await publish({ ...entry, name: "Stock", nav: { href: "/app/inventory", section: "primary", requiresRoles: ["guest"] } }, [source]);
      expect(await aiSkills.get(installed.id, subject)).toBeNull();
      expect((await aiSkills.admin.getByShortId(installed.shortId))?.source?.appName).toBe("Stock");
      await sql`INSERT INTO ai.app_skill_catalogs(app_id, manifest_hash, skills, last_seen_at)
        VALUES (${entry.id}, ${"old"}, '[]'::jsonb, now() - interval '1 day')`;
      await reconcileAppSkills([entry]);
      expect((await sql`SELECT 1 FROM ai.app_skill_catalogs WHERE app_id=${entry.id} AND manifest_hash='old'`).length).toBe(0);
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("untrusted malformed catalog entries become invalid issues without aborting other skills", async () => {
    const subject = await user(),
      name = `invalid-${crypto.randomUUID()}`,
      valid = definition(`valid-${crypto.randomUUID()}`);
    const entry = app([valid]);
    try {
      await sql`INSERT INTO ai.app_skill_catalogs(app_id, manifest_hash, skills)
        VALUES (${entry.id}, ${entry.skills!.manifestHash}, (${JSON.stringify([
          { ...valid, name, instructions: "Read references/missing.md" },
          { ...valid, hash: "forged" },
        ])}::text)::jsonb)`;
      await reconcileAppSkills([entry]);
      expect(await aiSkills.getByName(valid.name, subject)).not.toBeNull();
      expect(await aiSkills.getByName(name, subject)).toBeNull();
      expect(await aiAppSkills.appSkillIssues()).toContainEqual({
        appId: entry.id,
        appName: "Inventory",
        name,
        state: "invalid",
        available: true,
      });
    } finally {
      await cleanup([entry.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("a broken catalog of one app never blocks another app and keeps the run incomplete", async () => {
    const subject = await user(),
      valid = definition(`isolated-${crypto.randomUUID()}`);
    const broken = app([definition(`broken-${crypto.randomUUID()}`)]);
    const healthy = app([valid]);
    try {
      await sql`INSERT INTO ai.app_skill_catalogs(app_id, manifest_hash, skills)
        VALUES (${broken.id}, ${broken.skills!.manifestHash}, '{"not":"a list"}'::jsonb)`;
      await registerAppSkills(healthy.id, [valid], healthy.skills!.manifestHash);
      expect(await reconcileAppSkills([broken, healthy])).toBe(false);
      expect(await aiSkills.getByName(valid.name, subject)).toMatchObject({ source: { appId: healthy.id } });
      expect(await reconcileAppSkills([healthy])).toBe(true);
    } finally {
      await cleanup([broken.id, healthy.id]);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });

  test("one-time seed migration preserves IDs, grants, disabled state, edits and deletion tombstones, and is idempotent", async () => {
    // The migration maps fixed built-in names; clear what an interrupted earlier run may have left in the shared test database.
    await cleanup(["assistant", "weather"]);
    for (const [row] of await Promise.all(
      ["cloud-assistant", "scheduled-tasks", "assistant-code-mode", "cloud-weather"].map(
        (name) => sql<{ id: string }[]>`SELECT id FROM ai.skills WHERE name=${name}`,
      ),
    ))
      if (row) await aiSkills.admin.delete(row.id);
    await sql`DROP TABLE IF EXISTS ai.skill_seeds`.simple();
    const subject = await user();
    const first = definition("cloud-assistant"),
      customizedSource = definition("scheduled-tasks"),
      deletedSource = definition("assistant-code-mode");
    const firstRow = await aiSkills.create({ subject, ...first });
    const edited = await aiSkills.create({ subject, ...customizedSource });
    const legacy = await aiSkills.create({ subject, ...definition("cloud-weather", "Legacy managed content") });
    const unknown = await aiSkills.create({ subject, ...definition(`unknown-${crypto.randomUUID()}`) });
    const tombstoneId = crypto.randomUUID();
    try {
      await aiSkills.setEnabled(firstRow.id, subject, false);
      await aiSkills.update(edited.id, subject, { ...edited, instructions: "Admin override", expectedRevision: 1 });
      await aiSkills.grantAccess(firstRow.id, subject, { principal: { type: "authenticated" }, permission: "read" });
      const grants = await aiSkills.listAccess(firstRow.id, subject);
      await sql`ALTER TABLE ai.skills ADD COLUMN IF NOT EXISTS template_id text, ADD COLUMN IF NOT EXISTS template_version integer, ADD COLUMN IF NOT EXISTS template_hash text`.simple();
      await sql`CREATE TABLE ai.skill_seeds(key text PRIMARY KEY, skill_id uuid, catalog_version integer, seeded_at timestamptz DEFAULT now())`.simple();
      await sql`UPDATE ai.skills SET template_id='assistant:cloud-assistant', template_version=1, template_hash=${first.hash} WHERE id=${firstRow.id}::uuid`;
      await sql`UPDATE ai.skills SET template_id='assistant:scheduled-tasks', template_version=1, template_hash=${customizedSource.hash} WHERE id=${edited.id}::uuid`;
      await sql`UPDATE ai.skills SET managed_key='weather:cloud-weather' WHERE id=${legacy.id}::uuid`;
      await sql`INSERT INTO ai.skill_seeds(key, skill_id, catalog_version) VALUES
        ('assistant:cloud-assistant', ${firstRow.id}::uuid, 1), ('assistant:scheduled-tasks', ${edited.id}::uuid, 1),
        ('assistant:code-mode', ${tombstoneId}::uuid, 1), ('unknown:seed', ${unknown.id}::uuid, 1)`;
      await migrateCloudAi();
      await migrateCloudAi();
      expect((await sql`SELECT 1 FROM ai.app_skills WHERE app_id='assistant'`).length).toBe(3);
      expect((await sql<{ present: boolean }[]>`SELECT to_regclass('ai.skill_seeds') IS NOT NULL AS present`)[0]?.present).toBe(false);
      expect(
        (
          await sql`SELECT 1 FROM information_schema.columns WHERE table_schema='ai' AND table_name='skills' AND column_name LIKE 'template_%'`
        ).length,
      ).toBe(0);
      expect(await aiSkills.get(firstRow.id, subject)).toBeNull(); // adopted, not yet available
      expect((await aiSkills.admin.getByShortId(firstRow.shortId))?.source).toMatchObject({ status: "current", available: false });
      expect((await aiSkills.admin.getByShortId(edited.shortId))?.source?.status).toBe("modified");
      const assistant: AppRegistryEntry = { ...app([first]), id: "assistant", name: "Assistant" };
      const latest = definition(first.name, "Updated instructions");
      const assistantSkills = [latest, definition(customizedSource.name, "Updated scheduled instructions"), deletedSource];
      const weather = { ...app([definition("cloud-weather")]), id: "weather", name: "Weather" };
      await registerAppSkills(assistant.id, assistantSkills, appSkillManifestHash(assistantSkills));
      await registerAppSkills(weather.id, [definition("cloud-weather")], appSkillManifestHash([definition("cloud-weather")]));
      const live = [{ ...assistant, skills: { manifestHash: appSkillManifestHash(assistantSkills) } }, weather];
      await reconcileAppSkills(live);
      await reconcileAppSkills(live);
      expect(await aiSkills.get(firstRow.id, subject)).toMatchObject({
        id: firstRow.id,
        shortId: firstRow.shortId,
        enabled: false,
        revision: 2,
        instructions: latest.instructions,
      });
      expect(await aiSkills.listAccess(firstRow.id, subject)).toEqual(grants);
      expect(await aiSkills.get(edited.id, subject)).toMatchObject({
        id: edited.id,
        shortId: edited.shortId,
        revision: 2,
        instructions: "Admin override",
      });
      expect((await aiSkills.admin.getByShortId(edited.shortId))?.source?.status).toBe("update_available");
      expect(await aiSkills.getByName(deletedSource.name, subject)).toBeNull();
      expect(await aiSkills.get(legacy.id, subject)).toEqual(legacy);
      expect(await aiSkills.get(unknown.id, subject)).toEqual(unknown);
      expect((await sql`SELECT 1 FROM ai.app_skills WHERE app_id='assistant'`).length).toBe(3);
      expect(await aiAppSkills.appSkillIssues()).toEqual(
        expect.arrayContaining([
          { appId: "assistant", appName: "Assistant", name: deletedSource.name, state: "deleted", available: true },
          { appId: "weather", appName: "Weather", name: "cloud-weather", state: "name_taken", available: true },
        ]),
      );
      // An administrator links the pre-template copy to its app instead of deleting it: same ID, content kept as a customization.
      expect(await aiAppSkills.adopt("weather", "cloud-weather")).toBe(true);
      await expect(aiAppSkills.adopt("weather", "cloud-weather")).rejects.toBeInstanceOf(AiSkillRevisionConflictError);
      expect(await aiSkills.get(legacy.id, subject)).toMatchObject({
        id: legacy.id,
        shortId: legacy.shortId,
        instructions: legacy.instructions,
        source: { appId: "weather" },
      });
      expect((await aiSkills.admin.getByShortId(legacy.shortId))?.source?.status).toBe("modified");
      expect((await aiAppSkills.appSkillIssues()).some((issue) => issue.appId === "weather")).toBe(false);
      expect(await aiAppSkills.reset(legacy.id, legacy.revision, definition("cloud-weather").hash)).toBe(true);
      expect((await aiSkills.get(legacy.id, subject))?.instructions).toBe(definition("cloud-weather").instructions);
      await expect(aiAppSkills.adopt("assistant", unknown.name)).resolves.toBe(false);
      await expect(aiAppSkills.reset(unknown.id, 1, first.hash)).rejects.toBeInstanceOf(AiSkillInputError);
    } finally {
      await cleanup(["assistant", "weather"]);
      for (const row of [firstRow, edited, legacy, unknown]) await aiSkills.admin.delete(row.id);
      await sql`DELETE FROM auth.users WHERE id=${subject.userId}::uuid`;
    }
  });
});
