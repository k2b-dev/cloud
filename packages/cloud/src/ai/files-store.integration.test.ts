import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { aiFileStore, normalizeAiFilePath } from "./files-store";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

const canUseAiDatabase = async () => {
  try {
    const [authRow] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!authRow?.users) return false;
    await migrateCloudAi();
    const [aiRow] = await sql<{ files: string | null }[]>`SELECT to_regclass('ai.files')::text AS files`;
    return Boolean(aiRow?.files);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseAiDatabase()) ? describe : describe.skip;

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-files-${suffix}`}, 'local', 'user', 'AI Files Test', ${`ai-files-${suffix}@example.test`}, 'AI', 'Files')
    RETURNING id
  `;
  return row!.id;
};

const bytes = (text: string) => new TextEncoder().encode(text);

suite("normalizeAiFilePath", () => {
  test("accepts absolute clean paths and rejects traversal", () => {
    expect(normalizeAiFilePath("/a.txt")).toBe("/a.txt");
    expect(normalizeAiFilePath("/notes//b/./c.txt")).toBe("/notes/b/c.txt");
    expect(normalizeAiFilePath("relative.txt")).toBeNull();
    expect(normalizeAiFilePath("/notes/../etc/passwd")).toBeNull();
    expect(normalizeAiFilePath("/report\nignore.md")).toBeNull();
    expect(normalizeAiFilePath("/")).toBeNull();
  });
});

suite("aiFileStore integration", () => {
  test("allocates distinct paths for concurrent same-named user uploads", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      const uploads = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          aiFileStore.createUserUpload({
            conversationId: conversation.id,
            path: "/pasted-text.txt",
            bytes: bytes(`paste ${index}`),
            mediaType: "text/plain",
          }),
        ),
      );

      expect(uploads.map((file) => file.path).sort()).toEqual(["/pasted-text-2.txt", "/pasted-text-3.txt", "/pasted-text.txt"]);
      expect(uploads.every((file) => file.origin === "user")).toBe(true);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("allocates distinct assistant file paths without replacing user uploads", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      await aiFileStore.createUserUpload({
        conversationId: conversation.id,
        path: "/imports/report.pdf",
        bytes: bytes("user source"),
        mediaType: "application/pdf",
      });
      const fetched = await Promise.all(
        Array.from({ length: 2 }, (_, index) =>
          aiFileStore.createAssistantFile({
            conversationId: conversation.id,
            path: "/imports/report.pdf",
            bytes: bytes(`fetched ${index}`),
            mediaType: "application/pdf",
          }),
        ),
      );

      expect(fetched.map((file) => file.path).sort()).toEqual(["/imports/report-2.pdf", "/imports/report-3.pdf"]);
      expect(fetched.every((file) => file.origin === "assistant")).toBe(true);
      expect(
        new TextDecoder().decode((await aiFileStore.read({ conversationId: conversation.id, path: "/imports/report.pdf" }))!.bytes),
      ).toBe("user source");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("write, stat, slice reads, rename, remove, totals", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/data.csv",
        bytes: bytes("a,b\n1,2\n3,4\n"),
        mediaType: "text/csv",
      });
      const stat = await aiFileStore.stat({ conversationId: conversation.id, path: "/data.csv" });
      expect(stat?.size).toBe(12);
      expect(stat?.mediaType).toBe("text/csv");

      // Partial read: bytes 4..9 without loading the whole value.
      const slice = await aiFileStore.readSlice({ conversationId: conversation.id, path: "/data.csv", offset: 4, length: 4 });
      expect(new TextDecoder().decode(slice!)).toBe("1,2\n");

      await aiFileStore.append({ conversationId: conversation.id, path: "/data.csv", bytes: bytes("5,6\n") });
      const all = await aiFileStore.readAll({ conversationId: conversation.id, path: "/data.csv" });
      expect(new TextDecoder().decode(all!)).toEndWith("5,6\n");

      await aiFileStore.write({ conversationId: conversation.id, path: "/out/report.md", bytes: bytes("# Report\n") });
      const listed = await aiFileStore.list({ conversationId: conversation.id, prefix: "/out" });
      expect(listed.map((entry) => entry.path)).toEqual(["/out/report.md"]);

      expect(await aiFileStore.totalBytes(conversation.id)).toBe(16 + 9);

      const renamed = await aiFileStore.rename({ conversationId: conversation.id, from: "/out/report.md", to: "/report.md" });
      expect(renamed).toBe("renamed");

      const removed = await aiFileStore.remove({ conversationId: conversation.id, path: "/data.csv" });
      expect(removed).toBe(1);
      expect(await aiFileStore.stat({ conversationId: conversation.id, path: "/data.csv" })).toBeNull();
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("enforces per-file and per-conversation limits in the store", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      await expect(
        aiFileStore.write({ conversationId: conversation.id, path: "/big.bin", bytes: bytes("xxxxxxxxxx"), maxFileBytes: 5 }),
      ).rejects.toThrow(/per-file limit/);

      await aiFileStore.write({ conversationId: conversation.id, path: "/a.bin", bytes: bytes("12345"), maxConversationBytes: 8 });
      await expect(
        aiFileStore.write({ conversationId: conversation.id, path: "/b.bin", bytes: bytes("12345"), maxConversationBytes: 8 }),
      ).rejects.toThrow(/storage limit/);
      // Overwriting the same path counts the replaced size, not double.
      await aiFileStore.write({ conversationId: conversation.id, path: "/a.bin", bytes: bytes("1234567"), maxConversationBytes: 8 });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("keeps user uploads user-owned and blocks assistant overwrites", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/photo.png",
        bytes: bytes("user"),
        mediaType: "image/png",
        origin: "user",
      });
      await expect(
        aiFileStore.write({ conversationId: conversation.id, path: "/photo.png", bytes: bytes("assistant"), origin: "assistant" }),
      ).rejects.toThrow(/user-uploaded/);

      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/photo.png",
        bytes: bytes("edited"),
        mediaType: "image/png",
        origin: "user",
        allowUserOverwrite: true,
      });
      expect((await aiFileStore.stat({ conversationId: conversation.id, path: "/photo.png" }))?.origin).toBe("user");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("copyToConversation carries the VFS into a fork", async () => {
    const userId = await insertUser();
    const source = await aiConversations.createConversation({ ownerUserId: userId });
    const target = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      await aiFileStore.write({ conversationId: source.id, path: "/a.txt", bytes: bytes("hello"), origin: "user" });
      await aiFileStore.write({ conversationId: source.id, path: "/b.txt", bytes: bytes("world") });
      const copied = await aiFileStore.copyToConversation({ sourceConversationId: source.id, targetConversationId: target.id });
      expect(copied).toBe(2);
      const all = await aiFileStore.readAll({ conversationId: target.id, path: "/b.txt" });
      expect(new TextDecoder().decode(all!)).toBe("world");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${source.id}::uuid`;
      await sql`DELETE FROM ai.conversations WHERE id = ${target.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("migrates historical inline images into referenced user files", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "legacy-test",
        runConfig: {
          kind: "chat",
          input: [{ type: "file", mediaType: "image/png", data: "AQID" }],
          toolSource: { kind: "none" },
        },
        userMessage: { role: "user", content: [{ type: "file", mediaType: "image/png", data: "AQID" }] },
      });
      await sql`UPDATE ai.turns SET status = 'completed' WHERE conversation_id = ${conversation.id}::uuid`;

      const [before] = await sql<{ message: string; json_type: string; content_type: string | null }[]>`
        SELECT message, jsonb_typeof(message) AS json_type, jsonb_typeof(message->'content') AS content_type
        FROM ai.messages WHERE conversation_id = ${conversation.id}::uuid AND role = 'user'
      `;
      expect(JSON.parse(before?.message ?? "null")).toEqual({
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: "AQID" }],
      });
      expect(before).toMatchObject({ json_type: "string", content_type: null });

      await migrateCloudAi();

      const files = await aiFileStore.list({ conversationId: conversation.id });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ mediaType: "image/png", size: 3, origin: "user" });
      const [message] = await aiConversations.listMessages({ conversationId: conversation.id });
      const part = message?.message.role === "user" ? message.message.content[0] : null;
      expect(typeof part === "object" && part?.type === "text" ? part.text : null).toBe(
        `<attachment path="${files[0]?.path}" media-type="image/png" size="3" />`,
      );
      expect(JSON.stringify(message?.message)).not.toContain('"data":"AQID"');
      const [turn] = await sql<{ run_config: string }[]>`
        SELECT run_config FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid
      `;
      const parsedConfig = typeof turn?.run_config === "string" ? JSON.parse(turn.run_config) : turn?.run_config;
      const serializedConfig = JSON.stringify(parsedConfig);
      expect(serializedConfig).toContain(`attachment path=\\"${files[0]?.path}\\" media-type=\\"image/png\\" size=\\"3\\"`);
      expect(serializedConfig).not.toContain('"data":"AQID"');
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
