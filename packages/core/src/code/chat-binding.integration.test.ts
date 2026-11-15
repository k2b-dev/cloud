import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { UserSchema } from "@k2b/cloud/contracts";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import type { CodeContext } from "./access";
import { listCodeAttention, readCodeAttention } from "./attention";
import { codeAuthoringServices } from "./authoring";
import { createCodeBridgeHost, resolveCodeBoundChat } from "./bridge";
import { codeChatMissing, readCodeChatBinding, setCodeChatBinding } from "./chat-binding";
import { codeReadModelFixtureManifest } from "./read-model/fixtures";
import { loadCodeVersionReadModel } from "./read-model/load";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { createCode, createCodeVersion, insertCodeRun } from "./store";
import { listCodeWaiting } from "./waiting";

const owner = "c4330000-0000-4000-8000-000000000001";
const editor = "c4330000-0000-4000-8000-000000000002";
const fixed = new Date("2030-01-07T08:00:00.000Z");
function context(id = owner): CodeContext {
  const user = UserSchema.parse({
    id,
    uid: id,
    provider: "local",
    profile: "user",
    roles: ["user"],
    displayName: "Fictional person",
    givenname: "Chat",
    sn: "Owner",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  });
  return {
    authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id }, credentialKind: "session", scopes: [] },
    locale: "de",
    requestId: "chat-binding-fixture",
  };
}
async function chat(id: string, account = owner) {
  const [row] = await sql<{ id: string }[]>`INSERT INTO ai.conversations(short_id,title,created_by_user_id)
    VALUES(${id},${`Chat ${id}`},${account}::uuid) RETURNING id`;
  if (!row) throw new Error("Missing chat fixture");
  return row.id;
}
async function code(title: string, conversationId?: string) {
  return createCode(
    { owner: { kind: "person", userId: owner }, title, ...(conversationId ? { chatConversationId: conversationId } : {}) },
    context(),
  );
}

databaseSuite()("personal Code chat binding", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useMigratedDatabase("code_chat_binding");
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) => {
      const setting = Object.entries(CODE_SETTINGS).find(([name]) => name === key)?.[1];
      if (!setting) throw new Error(`Unexpected setting ${key}`);
      return setting.default;
    });
    for (const id of [owner, editor]) await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
  });
  afterAll(async () => {
    settings?.mockRestore();
    await database?.drop();
    setSystemTime();
  });

  test("chat init binds at revision one with an audit row and without a version or source field", async () => {
    const conversationId = await chat("Init433");
    const initialized = await codeAuthoringServices.init(
      { title: "Morning briefing" },
      {
        ...context(),
        submissionOrigin: { kind: "ai_chat", conversationId, cardAnchor: "tool-init", automaticAfterReview: false },
      },
    );
    const codeId = initialized.config.codeId;
    expect(await readCodeChatBinding({ codeId }, context())).toMatchObject({
      revision: 1,
      canChange: true,
      chat: { state: "available", id: "Init433", title: "Chat Init433", project: null, href: "/app/assistant?conversation=Init433" },
    });
    expect(JSON.stringify(initialized)).not.toContain(conversationId);
    expect((await sql`SELECT id FROM code.versions WHERE code_id=${codeId}`).length).toBe(0);
    expect(
      (await sql`SELECT metadata FROM audit.events WHERE action='core.code.chat_binding.changed' AND target_id=${codeId}`)[0]?.metadata,
    ).toEqual({ before: null, after: conversationId, revision: 1 });
  });

  test("shared editors see no title and cannot set; foreign or archived chats are not found; stale revisions conflict", async () => {
    const first = await chat("First433"),
      second = await chat("Second433");
    await chat("Foreign433", editor);
    const item = await code("Personal report", first);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${editor}::uuid,'write') RETURNING id`;
    if (!grant) throw new Error("Missing grant");
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${item.id},${grant.id}::uuid)`;
    expect(await readCodeChatBinding({ codeId: item.id }, context(editor))).toEqual({
      codeId: item.id,
      revision: 1,
      canChange: false,
      chat: { state: "hidden" },
    });
    await expect(setCodeChatBinding({ codeId: item.id, chatId: "Second433", revision: 1 }, context(editor))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(setCodeChatBinding({ codeId: item.id, chatId: "Foreign433", revision: 1 }, context())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const changed = await setCodeChatBinding({ codeId: item.id, chatId: "Second433", revision: 1 }, context());
    expect(changed).toMatchObject({ revision: 2, chat: { state: "available", id: "Second433" } });
    await expect(setCodeChatBinding({ codeId: item.id, chatId: "First433", revision: 1 }, context())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await resolveCodeBoundChat(item.id)).toEqual({ type: "core.ai.chat", id: "Second433" });
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${first}::uuid`;
    await expect(setCodeChatBinding({ codeId: item.id, chatId: "First433", revision: 2 }, context())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const [audit] =
      await sql`SELECT metadata FROM audit.events WHERE action='core.code.chat_binding.changed' AND target_id=${item.id} ORDER BY id DESC LIMIT 1`;
    expect(audit?.metadata).toEqual({ before: first, after: second, revision: 2 });
    expect((await sql`SELECT active_version_id,state FROM code.codes WHERE id=${item.id}`)[0]).toEqual({
      active_version_id: null,
      state: "draft",
    });
  });

  test("project metadata follows current project access even for the chat owner", async () => {
    const conversationId = await chat("Project433");
    const item = await code("Project briefing", conversationId);
    const [project] = await sql<{ id: string }[]>`INSERT INTO ai.projects(short_id,name)
      VALUES('Project433','Fictional project') RETURNING id`;
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission)
      VALUES(${owner}::uuid,'read') RETURNING id`;
    if (!project || !grant) throw new Error("Missing project fixture");
    await sql`UPDATE ai.conversations SET project_id=${project.id}::uuid WHERE id=${conversationId}::uuid`;
    expect(await readCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      chat: { state: "available", project: null },
    });
    await sql`INSERT INTO ai.project_access(project_id,access_id,short_id)
      VALUES(${project.id}::uuid,${grant.id}::uuid,'Grant433')`;
    expect(await readCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      chat: { state: "available", project: { id: "Project433", title: "Fictional project" } },
    });
    await sql`DELETE FROM auth.access WHERE id=${grant.id}::uuid`;
    expect(await readCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      chat: { state: "available", project: null },
    });
  });

  test("version words expose only a live chat naming hint to Code readers and never change version permissions", async () => {
    const destination = await chat("Wrd433");
    const item = await code("Words fixture", destination);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${editor}::uuid,'read') RETURNING id`;
    if (!grant) throw new Error("Missing reader grant");
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${item.id},${grant.id}::uuid)`;
    const version = await createCodeVersion(
      {
        codeId: item.id,
        sourceFiles: { "code.ts": "export {};" },
        bundle: "export {};",
        manifest: {
          ...codeReadModelFixtureManifest,
          permissions: [{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null } }],
          policyRows: ["ai"],
        },
        baseVersionId: null,
      },
      context(),
    );
    const words = (viewer = owner) => loadCodeVersionReadModel({ codeId: item.id, versionId: version.id }, context(viewer));
    for (const viewer of [owner, editor]) {
      const model = await words(viewer);
      expect(model.mayDo.items[0]).toMatchObject({
        text: "In einen Chat schreiben, Gustav antwortet",
        note: "KI · mit deinen Rechten, zählt auf dein Kontingent",
        target: { ref: { type: "core.ai.chat", id: "Wrd433" }, text: "In den Chat „{name}“ schreiben, Gustav antwortet" },
      });
      expect(JSON.stringify(model.mayDo)).not.toContain("Chat Wrd433");
    }
    const changes = (await words()).changes;
    await chat("Rbd433");
    await setCodeChatBinding({ codeId: item.id, chatId: "Rbd433", revision: 1 }, context());
    expect((await words()).mayDo.items[0]?.target?.ref.id).toBe("Rbd433");
    expect((await words()).changes).toEqual(changes);
    const [bound] = await sql<{ chat_conversation_id: string }[]>`SELECT chat_conversation_id FROM code.codes WHERE id=${item.id}`;
    if (!bound) throw new Error("Missing bound fixture");
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${bound.chat_conversation_id}::uuid`;
    expect((await words()).mayDo.items[0]).not.toHaveProperty("target");
    await sql`DELETE FROM ai.conversations WHERE id=${bound.chat_conversation_id}::uuid`;
    expect((await words()).mayDo.items[0]).not.toHaveProperty("target");
    await setCodeChatBinding({ codeId: item.id, chatId: "Wrd433", revision: 2 }, context());
    expect((await words()).mayDo.items[0]?.target?.ref.id).toBe("Wrd433");
    await sql`UPDATE code.codes SET owner_user_id=${editor}::uuid WHERE id=${item.id}`;
    expect((await words(editor)).mayDo.items[0]).not.toHaveProperty("target");
  });

  test("archived and deleted chats fail before dispatch and supply one recoverable waiting entry plus live attention", async () => {
    const destination = await chat("Missing433");
    const item = await code("Morning report", destination);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${editor}::uuid,'read') RETURNING id`;
    if (!grant) throw new Error("Missing reader grant");
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${item.id},${grant.id}::uuid)`;
    const version = await createCodeVersion(
      {
        codeId: item.id,
        sourceFiles: { "code.ts": "export {};" },
        bundle: "export {};",
        manifest: { ...codeReadModelFixtureManifest, permissions: [], policyRows: [] },
        baseVersionId: null,
      },
      context(),
    );
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${destination}::uuid`;
    expect((await readCodeChatBinding({ codeId: item.id }, context())).chat).toEqual({
      state: "unavailable",
      reason: "archived",
      id: "Missing433",
      title: "Chat Missing433",
    });
    expect(await readCodeChatBinding({ codeId: item.id }, context(editor))).toEqual({
      codeId: item.id,
      revision: 1,
      canChange: false,
      chat: { state: "hidden" },
    });
    await expect(resolveCodeBoundChat(item.id)).rejects.toMatchObject({ code: "chat_unavailable" });
    expect(await codeChatMissing(item.id)).toBe(true);
    expect((await readCodeAttention({ owner: item.owner }, context())).items).toContainEqual({
      codeId: item.id,
      reasons: ["chat_missing"],
    });
    expect((await listCodeAttention({}, context())).items).toContainEqual(
      expect.objectContaining({ code: expect.objectContaining({ id: item.id }), reasons: ["chat_missing"] }),
    );
    expect((await loadCodeVersionReadModel({ codeId: item.id, versionId: version.id }, context())).notices.items).toContainEqual(
      expect.objectContaining({ code: "chat_missing", severity: "block" }),
    );
    const waiting = () => listCodeWaiting({ ownerUserId: owner, locale: "de", timeZone: "UTC" }, new AbortController().signal);
    expect((await waiting()).items.filter((row) => row.id === `code-attention:${item.id}`)).toEqual([
      expect.objectContaining({
        kind: "code_attention",
        short: "Morning report braucht einen Chat",
        href: `/app/assistant/code/${item.id}`,
      }),
    ]);
    await sql`UPDATE ai.conversations SET archived_at=NULL WHERE id=${destination}::uuid`;
    expect(await readCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      revision: 1,
      chat: { state: "available", id: "Missing433" },
    });
    expect(await codeChatMissing(item.id)).toBe(false);
    expect((await waiting()).items.some((row) => row.id === `code-attention:${item.id}`)).toBe(false);
    await sql`DELETE FROM ai.conversations WHERE id=${destination}::uuid`;
    expect((await readCodeChatBinding({ codeId: item.id }, context())).chat).toEqual({ state: "unavailable", reason: "deleted" });
    expect((await readCodeChatBinding({ codeId: item.id }, context(editor))).chat).toEqual({ state: "hidden" });
    await expect(resolveCodeBoundChat(item.id)).rejects.toMatchObject({ code: "chat_unavailable" });
    expect(await codeChatMissing(item.id)).toBe(true);
  });

  test("the Core bridge refuses a missing bound chat without invoking Send", async () => {
    const destination = await chat("Bridge433");
    const item = await code("Bridge failure", destination);
    const version = await createCodeVersion(
      {
        codeId: item.id,
        sourceFiles: { "code.ts": "export {};" },
        bundle: "export {};",
        manifest: codeReadModelFixtureManifest,
        baseVersionId: null,
      },
      context(),
    );
    await sql`UPDATE code.versions SET manifest=jsonb_set(jsonb_set(manifest,'{hashes,source}',to_jsonb(source_hash)),'{hashes,bundle}',to_jsonb(bundle_hash)) WHERE id=${version.id}::uuid`;
    const [hash] = await sql<{ bundle_hash: string }[]>`SELECT bundle_hash FROM code.versions WHERE id=${version.id}::uuid`;
    if (!hash) throw new Error("Missing version hash");
    await sql`UPDATE code.codes SET state='active',active_version_id=${version.id}::uuid WHERE id=${item.id}`;
    const runId = await insertCodeRun({ codeId: item.id, versionId: version.id, trigger: "schedule", entrypoint: "daily", input: null });
    await sql`UPDATE code.runs SET state='running',generation=1,started_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=${runId}::uuid`;
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${destination}::uuid`;
    let invoked = false;
    const response = await createCodeBridgeHost().withCall(
      {
        bound: "chat",
        kind: "action",
        call: { capability: "core.ai.chat.send", target: null, refs: {}, input: { text: "Instructions" } },
        claims: {
          ver: 1,
          token_use: "code_run",
          iss: "https://cloud.example",
          aud: "cloud-code-bridge",
          iat: fixed.getTime() / 1000,
          nbf: fixed.getTime() / 1000,
          exp: fixed.getTime() / 1000 + 60,
          codeId: item.id,
          versionId: version.id,
          runId,
          generation: 1,
          mandateId: owner,
          mandateRevision: 1,
          entrypoint: "daily",
          bundleHash: hash.bundle_hash,
        },
      },
      async () => {
        invoked = true;
        throw new Error("Send must not run");
      },
    );
    expect(invoked).toBe(false);
    expect(await response.json()).toEqual({ ok: false, error: { code: "chat_unavailable", status: 409 } });
  });

  test("owner changes clear the binding and advance its revision; new rows start unbound", async () => {
    const destination = await chat("Transfer433");
    const item = await code("Transfer fixture", destination);
    await sql`UPDATE code.codes SET owner_user_id=${editor}::uuid WHERE id=${item.id}`;
    expect(await readCodeChatBinding({ codeId: item.id }, context(editor))).toEqual({
      codeId: item.id,
      revision: 2,
      canChange: true,
      chat: null,
    });
    await expect(resolveCodeBoundChat(item.id)).rejects.toMatchObject({ code: "chat_unbound" });
    const fresh = await code("Copy fixture");
    expect(await readCodeChatBinding({ codeId: fresh.id }, context())).toEqual({
      codeId: fresh.id,
      revision: 0,
      canChange: true,
      chat: null,
    });
  });
});
