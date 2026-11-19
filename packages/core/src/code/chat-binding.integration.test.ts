import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { CODE_BOUND_CHAT_ID } from "@k2b/cloud/code";
import { type CapabilityExecutionContext, type CodeCheckedVersionManifest, UserSchema } from "@k2b/cloud/contracts";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import type { CodeContext } from "./access";
import { listCodeAttention, readCodeAttention } from "./attention";
import { codeAuthoringServices } from "./authoring";
import { codeChatMissing, getCodeChatBinding, resolveCodeChatDestination, setCodeChatBinding } from "./chat-binding";
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

async function personalRun(codeId: string, account = owner): Promise<CapabilityExecutionContext> {
  const [latest] = await sql<{ id: string }[]>`SELECT id FROM code.versions WHERE code_id=${codeId} ORDER BY number DESC LIMIT 1`;
  const version =
    latest ??
    (await createCodeVersion(
      {
        codeId,
        sourceFiles: { "code.ts": "export {};" },
        bundle: "export {};",
        manifest: codeReadModelFixtureManifest,
        baseVersionId: null,
      },
      context(account),
    ));
  await sql`UPDATE code.codes SET state='active',active_version_id=${version.id}::uuid WHERE id=${codeId}`;
  const runId = await insertCodeRun({ codeId, versionId: version.id, trigger: "schedule", entrypoint: "daily", input: null });
  await sql`UPDATE code.runs SET state='running' WHERE id=${runId}::uuid`;
  const authority = context(account).authority;
  if (authority.actor.kind !== "user") throw new Error("Expected person");
  const user = authority.actor.user;
  return {
    authority,
    actor: {
      kind: "user",
      user,
      delegation: {
        kind: "invocation",
        credentialKind: "mandate",
        callingAppId: "core",
        invocationId: "binding-fixture",
        workloadType: "code.version",
        workloadId: version.id,
        workloadRun: runId,
      },
    },
    accessSubject: authority.accessSubject,
    user,
    origin: "http",
    requestId: "binding-fixture",
    locale: "en",
    signal: new AbortController().signal,
    target: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID },
  };
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
  }, 30_000);
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
    expect(await getCodeChatBinding({ codeId }, context())).toMatchObject({
      revision: 1,
      canChange: true,
      used: false,
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
    expect(await getCodeChatBinding({ codeId: item.id }, context(editor))).toEqual({
      codeId: item.id,
      revision: 1,
      canChange: false,
      used: false,
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
    // Choosing a chat creates no version and activates nothing.
    expect((await sql`SELECT active_version_id,state FROM code.codes WHERE id=${item.id}`)[0]).toEqual({
      active_version_id: null,
      state: "draft",
    });
    await expect(setCodeChatBinding({ codeId: item.id, chatId: "First433", revision: 1 }, context())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await resolveCodeChatDestination(await personalRun(item.id), sql)).toEqual({
      ok: true,
      data: { chatId: "Second433", binding: { codeId: item.id, revision: 2 } },
    });
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${first}::uuid`;
    await expect(setCodeChatBinding({ codeId: item.id, chatId: "First433", revision: 2 }, context())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const [audit] =
      await sql`SELECT metadata FROM audit.events WHERE action='core.code.chat_binding.changed' AND target_id=${item.id} ORDER BY id DESC LIMIT 1`;
    expect(audit?.metadata).toEqual({ before: first, after: second, revision: 2 });
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
    expect(await getCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      chat: { state: "available", project: null },
    });
    await sql`INSERT INTO ai.project_access(project_id,access_id,short_id)
      VALUES(${project.id}::uuid,${grant.id}::uuid,'Grant433')`;
    expect(await getCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      chat: { state: "available", project: { id: "Project433", title: "Fictional project" } },
    });
    await sql`DELETE FROM auth.access WHERE id=${grant.id}::uuid`;
    expect(await getCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      chat: { state: "available", project: null },
    });
  });

  test("version words preserve the viewer's chat presentation and never change version permissions", async () => {
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
          permissions: [{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null }, file: "code.ts", line: 1 }],
          policyRows: ["ai"],
        },
        baseVersionId: null,
      },
      context(),
    );
    const words = (viewer = owner) => loadCodeVersionReadModel({ codeId: item.id, versionId: version.id }, context(viewer));
    {
      const model = await words();
      expect(model.mayDo.items[0]).toMatchObject({
        text: "In einen Chat schreiben, Gustav antwortet",
        note: "KI · mit deinen Rechten, zählt auf dein Kontingent",
        target: { ref: { type: "core.ai.chat", id: "Wrd433" }, text: "In den Chat „{name}“ schreiben, Gustav antwortet" },
      });
      expect(JSON.stringify(model.mayDo)).not.toContain("Chat Wrd433");
    }
    await sql`UPDATE auth.users SET display_name='Lena' WHERE id=${owner}::uuid`;
    const reader = await words(editor);
    expect(reader.mayDo.items[0]).toMatchObject({
      text: "In einen Chat schreiben, Gustav antwortet",
      note: "KI · mit Lenas Rechten, zählt auf Lenas Kontingent",
    });
    expect(reader.mayDo.items[0]?.target?.ref.id).toBe(CODE_BOUND_CHAT_ID);
    expect(JSON.stringify(reader)).not.toContain("Wrd433");
    const guestContext = context(editor);
    if (guestContext.authority.actor.kind !== "user") throw new Error("Expected person");
    guestContext.authority.actor.user.roles = [];
    guestContext.authority.actor.user.profile = "guest";
    const guest = await loadCodeVersionReadModel({ codeId: item.id, versionId: version.id }, guestContext);
    expect(guest.mayDo.items[0]?.note).toBe("KI · mit den Rechten der Person, der die Automation gehört, zählt auf deren Kontingent");
    expect(JSON.stringify(guest.mayDo)).not.toContain("Lena");
    const changes = (await words()).changes;
    await chat("Rbd433");
    await setCodeChatBinding({ codeId: item.id, chatId: "Rbd433", revision: 1 }, context());
    expect((await words()).mayDo.items[0]?.target?.ref.id).toBe("Rbd433");
    expect((await words()).changes).toEqual(changes);
    const [bound] = await sql<{ chat_conversation_id: string }[]>`SELECT chat_conversation_id FROM code.codes WHERE id=${item.id}`;
    if (!bound) throw new Error("Missing bound fixture");
    // Without a readable chat the row keeps the SDK's own handle, so the page can offer its owner to choose one.
    const handle = { ref: { type: "core.ai.chat", id: CODE_BOUND_CHAT_ID }, text: "In den Chat „{name}“ schreiben, Gustav antwortet" };
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${bound.chat_conversation_id}::uuid`;
    expect((await words()).mayDo.items[0]?.target).toEqual(handle);
    expect((await words(editor)).notices.items.map((notice) => notice.code)).not.toContain("chat_missing");
    expect((await readCodeAttention({ owner: item.owner }, context(editor))).items).toContainEqual({ codeId: item.id, reasons: [] });
    await sql`DELETE FROM ai.conversations WHERE id=${bound.chat_conversation_id}::uuid`;
    expect((await words()).mayDo.items[0]?.target).toEqual(handle);
    expect((await words(editor)).notices.items.map((notice) => notice.code)).not.toContain("chat_missing");
    expect((await readCodeAttention({ owner: item.owner }, context(editor))).items).toContainEqual({ codeId: item.id, reasons: [] });
    await setCodeChatBinding({ codeId: item.id, chatId: "Wrd433", revision: 2 }, context());
    expect((await words()).mayDo.items[0]?.target?.ref.id).toBe("Wrd433");
  });

  test("a never-bound chat sender appears in version notices, attention and Waiting until its owner chooses a chat", async () => {
    const item = await code("Unbound briefing");
    const version = await createCodeVersion(
      {
        codeId: item.id,
        sourceFiles: { "code.ts": "export {};" },
        bundle: "export {};",
        manifest: {
          ...codeReadModelFixtureManifest,
          permissions: [{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null }, file: "code.ts", line: 1 }],
          policyRows: ["ai"],
        },
        baseVersionId: null,
      },
      context(),
    );
    expect(await getCodeChatBinding({ codeId: item.id }, context())).toMatchObject({ revision: 0, chat: null });
    expect(await codeChatMissing(item.id)).toBe(true);
    const words = () => loadCodeVersionReadModel({ codeId: item.id, versionId: version.id }, context());
    expect((await words()).notices.items.map((notice) => notice.code)).toContain("chat_missing");
    expect((await readCodeAttention({ owner: item.owner }, context())).items).toContainEqual({
      codeId: item.id,
      reasons: ["chat_missing"],
    });
    expect((await listCodeAttention({}, context())).items).toContainEqual(
      expect.objectContaining({ code: expect.objectContaining({ id: item.id }), reasons: ["chat_missing"] }),
    );
    const waiting = () => listCodeWaiting({ ownerUserId: owner, locale: "de", timeZone: "UTC" }, new AbortController().signal);
    expect((await waiting()).items).toContainEqual(
      expect.objectContaining({ id: `code-attention:${item.id}`, short: "Unbound briefing braucht einen Chat" }),
    );
    // Without a chat there is nothing to restore.
    expect((await waiting()).items.find((row) => row.id === `code-attention:${item.id}`)?.archivedChat).toBeUndefined();
    const meter = await meterSql();
    try {
      expect(await meter.during(words)).toHaveLength(3);
      await chat("Never433");
      await setCodeChatBinding({ codeId: item.id, chatId: "Never433", revision: 0 }, context());
      expect(await meter.during(words)).toHaveLength(4);
    } finally {
      await meter.close();
    }
    expect(await codeChatMissing(item.id)).toBe(false);
    expect((await words()).notices.items.map((notice) => notice.code)).not.toContain("chat_missing");
    expect((await waiting()).items.map((row) => row.id)).not.toContain(`code-attention:${item.id}`);
    const unused = await code("No chat action");
    expect(await codeChatMissing(unused.id)).toBe(false);
    await createCodeVersion(
      {
        codeId: unused.id,
        sourceFiles: { "code.ts": "export {};" },
        bundle: "export {};",
        manifest: {
          ...codeReadModelFixtureManifest,
          permissions: [{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: "Literal433" }, file: "code.ts", line: 1 }],
        },
        baseVersionId: null,
      },
      context(),
    );
    expect(await codeChatMissing(unused.id)).toBe(false);
  });

  test.each(["page", "Chat app"])("an archived init binding is irrelevant to Code using only %s", async (kind) => {
    const destination = await chat(kind === "page" ? "Page433" : "App433");
    const initialized = await codeAuthoringServices.init(
      { title: `Unused binding ${kind}` },
      { ...context(), submissionOrigin: { kind: "ai_chat", conversationId: destination, automaticAfterReview: false } },
    );
    const codeId = initialized.config.codeId;
    const version = await createCodeVersion(
      {
        codeId,
        sourceFiles: { "code.ts": "export {};" },
        bundle: "export {};",
        manifest: {
          ...codeReadModelFixtureManifest,
          entrypoints: kind === "page" ? [] : codeReadModelFixtureManifest.entrypoints,
          permissions: kind === "page" ? [] : [{ operation: "chat.message.post", target: null, file: "code.ts", line: 1 }],
          policyRows: [],
        } satisfies CodeCheckedVersionManifest,
        baseVersionId: null,
      },
      context(),
    );
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${destination}::uuid`;
    const words = () => loadCodeVersionReadModel({ codeId, versionId: version.id }, context());
    const meter = await meterSql();
    let statements: string[];
    try {
      statements = await meter.during(words);
    } finally {
      await meter.close();
    }
    const attention = await readCodeAttention({ owner: { kind: "person", userId: owner } }, context());
    const listed = await listCodeAttention({}, context());
    const waiting = await listCodeWaiting({ ownerUserId: owner, locale: "de", timeZone: "UTC" }, new AbortController().signal);
    expect({
      missing: await codeChatMissing(codeId),
      notice: (await words()).notices.items.some((notice) => notice.code === "chat_missing"),
      attention: attention.items.find((item) => item.codeId === codeId)?.reasons,
      listed: listed.items.some((item) => item.code.id === codeId && item.reasons.includes("chat_missing")),
      waiting: waiting.items.some((item) => item.id === `code-attention:${codeId}`),
      chatReads: statements.filter((statement) =>
        statement.startsWith("SELECT short_id,title,project_id,archived_at FROM ai.conversations"),
      ),
    }).toEqual({ missing: false, notice: false, attention: [], listed: false, waiting: false, chatReads: [] });
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
        manifest: {
          ...codeReadModelFixtureManifest,
          permissions: [{ operation: "core.ai.chat.send", target: { type: "core.ai.chat", id: null }, file: "code.ts", line: 1 }],
          policyRows: ["ai"],
        },
        baseVersionId: null,
      },
      context(),
    );
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${destination}::uuid`;
    expect((await getCodeChatBinding({ codeId: item.id }, context())).chat).toEqual({
      state: "unavailable",
      reason: "archived",
      id: "Missing433",
      title: "Chat Missing433",
    });
    expect(await getCodeChatBinding({ codeId: item.id }, context(editor))).toEqual({
      codeId: item.id,
      revision: 1,
      canChange: false,
      used: true,
      chat: { state: "hidden" },
    });
    expect(await resolveCodeChatDestination(await personalRun(item.id), sql)).toMatchObject({
      ok: false,
      error: { code: "chat_unavailable", status: 409 },
    });
    expect(await codeChatMissing(item.id)).toBe(true);
    expect((await readCodeAttention({ owner: item.owner }, context())).items).toContainEqual({
      codeId: item.id,
      reasons: ["chat_missing"],
    });
    expect((await readCodeAttention({ owner: item.owner }, context(editor))).items).toContainEqual({ codeId: item.id, reasons: [] });
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
        reason: "chat_missing",
        // The owner can restore the archived chat right from "Waiting for you".
        archivedChat: { id: "Missing433", title: "Chat Missing433" },
      }),
    ]);
    await sql`UPDATE ai.conversations SET archived_at=NULL WHERE id=${destination}::uuid`;
    expect(await getCodeChatBinding({ codeId: item.id }, context())).toMatchObject({
      revision: 1,
      chat: { state: "available", id: "Missing433" },
    });
    expect(await codeChatMissing(item.id)).toBe(false);
    // The fixture run activated the Code without a mandate; only the chat reason must leave.
    expect((await waiting()).items.map((row) => row.short)).not.toContain("Morning report braucht einen Chat");
    await sql`DELETE FROM ai.conversations WHERE id=${destination}::uuid`;
    expect((await getCodeChatBinding({ codeId: item.id }, context())).chat).toEqual({ state: "unavailable", reason: "deleted" });
    expect((await getCodeChatBinding({ codeId: item.id }, context(editor))).chat).toEqual({ state: "hidden" });
    expect(await resolveCodeChatDestination(await personalRun(item.id), sql)).toMatchObject({
      ok: false,
      error: { code: "chat_unavailable", status: 409 },
    });
    expect(await codeChatMissing(item.id)).toBe(true);
  });

  test("the Send resolver refuses archived bindings and foreign callers", async () => {
    const destination = await chat("Bridge433");
    const item = await code("Send failure", destination);
    const run = await personalRun(item.id);
    expect(await resolveCodeChatDestination(run, sql)).toEqual({
      ok: true,
      data: { chatId: "Bridge433", binding: { codeId: item.id, revision: 1 } },
    });
    await sql`UPDATE ai.conversations SET archived_at=${fixed} WHERE id=${destination}::uuid`;
    expect(await resolveCodeChatDestination(run, sql)).toMatchObject({ ok: false, error: { code: "chat_unavailable", status: 409 } });
    const authority = context(editor).authority;
    if (authority.actor.kind !== "user") throw new Error("Expected person");
    const foreign = {
      ...run,
      user: authority.actor.user,
      accessSubject: authority.accessSubject,
      actor: { ...run.actor, kind: "user" as const, user: authority.actor.user },
    };
    expect(await resolveCodeChatDestination(foreign, sql)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  test("a binding stays with its personal owner and only personal Code can hold one; new rows start unbound", async () => {
    const destination = await chat("Transfer433");
    const item = await code("Transfer fixture", destination);
    const moved = await sql`UPDATE code.codes SET owner_user_id=${editor}::uuid WHERE id=${item.id}`.then(
      () => "moved",
      (error: Error) => error.message,
    );
    expect(moved).toBe("code identity is immutable");
    expect(await getCodeChatBinding({ codeId: item.id }, context())).toMatchObject({ revision: 1, canChange: true });
    const [guard] = await sql<{ definition: string }[]>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='code.codes'::regclass AND conname='codes_chat_binding_personal'`;
    expect(guard?.definition).toContain("owner_kind = 'person'");
    const fresh = await code("Copy fixture");
    expect(await getCodeChatBinding({ codeId: fresh.id }, context())).toEqual({
      codeId: fresh.id,
      revision: 0,
      canChange: true,
      used: false,
      chat: null,
    });
  });
});
