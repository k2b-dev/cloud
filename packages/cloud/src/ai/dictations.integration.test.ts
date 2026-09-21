import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import { createAccess } from "../server/services/access";
import { processAiDictation } from "./dictation-runtime";
import { aiDictations } from "./dictations";
import { aiFileStore } from "./files-store";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";
import type { AiResolvedAudioModel } from "./transcription";

const suite = databaseSuite();
beforeAll(async () => {
  if (!testInfra.database) return;
  await migrateCloudAi();
});
const audio = new Uint8Array(44);
audio.set(new TextEncoder().encode("RIFF"));
audio.set(new TextEncoder().encode("WAVE"), 8);
const setup = async () => {
  const tag = crypto.randomUUID();
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`dictation-${tag}`}, 'local', 'user', 'Audio Test', ${`${tag}@example.test`}, 'Audio', 'Test') RETURNING id`;
  const userId = user!.id;
  const conversation = await aiConversations.createConversation({ ownerUserId: userId });
  const profileId = `audio-test-${tag}`;
  const access = await createAccess({ principal: { type: "user", userId }, permission: "read" });
  if (!access.ok) throw new Error("Could not create test access");
  await sql`INSERT INTO ai.model_access_resources (profile_id) VALUES (${profileId})`;
  await sql`INSERT INTO ai.model_access (profile_id, access_id) VALUES (${profileId}, ${access.data.id})`;
  const model: AiResolvedAudioModel = {
    profile: {
      id: profileId,
      label: "Test",
      provider: "openai-compatible",
      model: "test",
      baseURL: "http://example.invalid",
      enabled: true,
      capabilities: ["transcription"],
      dataBoundary: "private",
    },
    provider: { name: "test", model: "test", transcribe: async () => ({ text: "Memo" }) },
  };
  const input = {
    conversationId: conversation.id,
    userId,
    operationId: crypto.randomUUID(),
    bytes: audio,
    resolveModel: async () => model,
  };
  return {
    input,
    conversation,
    model,
    cleanup: async () => {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}`;
      await sql`DELETE FROM auth.access WHERE id = ${access.data.id}`;
      await sql`DELETE FROM ai.model_access_resources WHERE profile_id = ${profileId}`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}`;
    },
  };
};

suite("durable dictation", () => {
  test("dictation provenance survives rename, copies and turn snapshots without classifying uploaded audio", async () => {
    const { input, cleanup } = await setup();
    const target = await aiConversations.createConversation({ ownerUserId: input.userId });
    try {
      const dictation = await aiDictations.start(input);
      const original = (await aiFileStore.stat({ ...input, path: dictation.sourcePath }))!;
      expect(original.dictationRecordedAt).toBe(dictation.createdAt);
      expect(original.origin).toBe("user");
      const upload = await aiFileStore.createUserUpload({ ...input, path: "/dictation-manual.m4a", mediaType: "audio/mp4" });
      expect(upload.dictationRecordedAt).toBeUndefined();
      await aiFileStore.rename({ ...input, from: original.path, to: "/renamed.wav" });
      const file = (await aiFileStore.stat({ ...input, path: "/renamed.wav" }))!;
      expect(file.dictationRecordedAt).toBe(original.dictationRecordedAt);
      await expect(aiFileStore.write({ ...input, path: file.path, origin: "assistant" })).rejects.toThrow("Cannot overwrite");
      await aiFileStore.copyToConversation({ sourceConversationId: input.conversationId, targetConversationId: target.id });
      expect((await aiFileStore.stat({ conversationId: target.id, path: file.path }))?.dictationRecordedAt).toBe(
        original.dictationRecordedAt,
      );
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: input.conversationId,
        modelProfileId: "test",
        runConfig: {
          kind: "chat",
          input: "Inspect recording",
          toolSource: { kind: "none" },
          files: { attached: [file], available: [file, upload], total: 2 },
        },
        userMessage: { role: "user", content: ["Inspect recording"] },
      });
      await aiFileStore.write({ ...input, path: file.path, origin: "user", allowUserOverwrite: true });
      expect((await aiFileStore.stat({ ...input, path: file.path }))?.dictationRecordedAt).toBeUndefined();
      expect((await aiFileStore.readTurnFile({ turnId: turn.id, path: file.path }))?.dictationRecordedAt).toBe(
        original.dictationRecordedAt,
      );
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${target.id}`;
      await cleanup();
    }
  });

  test("atomic upload retries preserve one file, snapshot quota and pinned model; changed payload conflicts", async () => {
    const { input, cleanup } = await setup();
    try {
      const task = await aiDictations.start(input);
      const again = await aiDictations.start({
        ...input,
        resolveModel: async () => {
          throw new Error("Changed config must not affect retry");
        },
      });
      expect(again.id).toBe(task.id);
      expect(await aiFileStore.list(input)).toHaveLength(1);
      expect(await aiFileStore.totalBytes(input.conversationId)).toBe(audio.length * 2);
      await expect(
        aiFileStore.createUserUpload({ ...input, path: "/extra", bytes: new Uint8Array(1), maxConversationBytes: audio.length * 2 }),
      ).rejects.toThrow();
      const different = new Uint8Array(audio);
      different[20] = 1;
      await expect(aiDictations.start({ ...input, bytes: different })).rejects.toThrow("different audio");
      await aiDictations.discard({ ...input, id: task.id });
      expect(await aiFileStore.totalBytes(input.conversationId)).toBe(audio.length);
      expect((await aiDictations.list(input)).items).toEqual([]);
    } finally {
      await cleanup();
    }
  });
  test("discard before start fences delayed uploads without creating a file", async () => {
    const { input, cleanup } = await setup();
    try {
      expect(await aiDictations.discardOperation(input)).toEqual({ disposition: "discarded" });
      expect(await aiDictations.discardOperation(input)).toEqual({ disposition: "discarded" });
      await expect(aiDictations.start(input)).rejects.toThrow("discarded");
      expect(await aiFileStore.list(input)).toHaveLength(0);
      expect((await aiDictations.list(input)).items).toHaveLength(0);
      await expect(aiDictations.discardOperation({ ...input, userId: crypto.randomUUID() })).rejects.toThrow("unavailable");
    } finally {
      await cleanup();
    }
  });
  test("concurrent start and operation discard leave no runnable job and retain any committed file", async () => {
    const { input, cleanup } = await setup();
    try {
      const [start] = await Promise.allSettled([aiDictations.start(input), aiDictations.discardOperation(input)]);
      expect((await aiDictations.list(input)).items).toHaveLength(0);
      await expect(aiDictations.start(input)).rejects.toThrow("discarded");
      if (start.status === "fulfilled") {
        expect((await aiDictations.get({ ...input, id: start.value.id }))?.disposition).toBe("discarded");
        expect(await aiFileStore.totalBytes(input.conversationId)).toBe(audio.length);
      }
    } finally {
      await cleanup();
    }
  });
  test("apply and operation discard serialize without removing an already applied draft", async () => {
    const { input, cleanup } = await setup();
    try {
      const task = await aiDictations.start(input);
      await sql`UPDATE ai.dictations SET status = 'succeeded', result = 'Saved words', source_bytes = NULL WHERE short_id = ${task.id}`;
      const [applied] = await Promise.all([
        aiDictations.apply({ ...input, id: task.id, expectedRevision: 0, content: [] }),
        aiDictations.discardOperation(input),
      ]);
      const result = await aiDictations.get({ ...input, id: task.id });
      if (applied.disposition === "applied") {
        expect(result?.disposition).toBe("applied");
        expect(await aiDictations.discardOperation(input)).toEqual({ disposition: "applied" });
        expect(applied.draft?.content).toEqual([{ type: "text", text: "Saved words" }]);
      } else {
        expect(result?.disposition).toBe("discarded");
        expect(applied.draft).toBeNull();
      }
    } finally {
      await cleanup();
    }
  });
  test("source replacement cannot change processing; apply uses CAS and is persisted at most once", async () => {
    const { input, conversation, model, cleanup } = await setup();
    try {
      const task = await aiDictations.start(input);
      await aiFileStore.write({ ...input, path: task.sourcePath, bytes: new Uint8Array([1]), origin: "user", allowUserOverwrite: true });
      const [row] = await sql<{ id: string }[]>`SELECT id FROM ai.dictations WHERE short_id = ${task.id}`;
      await processAiDictation(row!.id, new AbortController().signal, async (request) => {
        expect(new Uint8Array(await request.file.arrayBuffer())).toEqual(audio);
        expect(request.requestedModelId).toBe(model.profile.id);
        return { text: "Das Memo", modelProfileId: model.profile.id };
      });
      expect((await aiDictations.get({ ...input, id: task.id }))?.text).toBe("Das Memo");
      expect(await aiFileStore.totalBytes(input.conversationId)).toBe(1);
      await expect(
        aiDictations.apply({ ...input, id: task.id, content: [], expectedRevision: conversation.draft.revision + 1 }),
      ).rejects.toThrow();
      const applied = await aiDictations.apply({
        ...input,
        id: task.id,
        content: [{ type: "text", text: "Prompt" }],
        expectedRevision: conversation.draft.revision,
      });
      expect(applied.draft?.content).toEqual([{ type: "text", text: "Prompt\n\nDas Memo" }]);
      const repeated = await aiDictations.apply({ ...input, id: task.id, content: [], expectedRevision: conversation.draft.revision });
      expect(repeated).toEqual({ disposition: "applied", draft: null });
      expect((await aiDictations.list(input)).items).toEqual([]);
    } finally {
      await cleanup();
    }
  });
  test("expired worker claims recover from the snapshot and concurrent delivery calls the provider once", async () => {
    const { input, model, cleanup } = await setup();
    try {
      const task = await aiDictations.start(input);
      const [row] = await sql<
        { id: string }[]
      >`UPDATE ai.dictations SET status = 'running', attempts = 1, lease_token = ${crypto.randomUUID()}, lease_until = now() - interval '1 minute' WHERE short_id = ${task.id} RETURNING id`;
      let calls = 0;
      const run = async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { text: "Recovered", modelProfileId: model.profile.id };
      };
      await Promise.all([
        processAiDictation(row!.id, new AbortController().signal, run),
        processAiDictation(row!.id, new AbortController().signal, run),
      ]);
      expect(calls).toBe(1);
      expect((await aiDictations.get({ ...input, id: task.id }))?.text).toBe("Recovered");
      const [stored] = await sql<
        { attempts: number; source_bytes: Uint8Array | null }[]
      >`SELECT attempts, source_bytes FROM ai.dictations WHERE id = ${row!.id}`;
      expect(stored?.attempts).toBe(2);
      expect(stored?.source_bytes).toBeNull();
    } finally {
      await cleanup();
    }
  });
  test("other users cannot read or adopt a dictation", async () => {
    const { input, cleanup } = await setup();
    try {
      const task = await aiDictations.start(input);
      const other = { ...input, id: task.id, userId: crypto.randomUUID() };
      expect(await aiDictations.get(other)).toBeNull();
      expect((await aiDictations.list(other)).items).toEqual([]);
      await expect(aiDictations.apply({ ...other, content: [], expectedRevision: 0 })).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
  test("discard fences a provider response already in flight", async () => {
    const { input, model, cleanup } = await setup();
    try {
      const task = await aiDictations.start(input);
      const [row] = await sql<{ id: string }[]>`SELECT id FROM ai.dictations WHERE short_id = ${task.id}`;
      await processAiDictation(row!.id, new AbortController().signal, async () => {
        await aiDictations.discard({ ...input, id: task.id });
        return { text: "Too late", modelProfileId: model.profile.id };
      });
      const result = await aiDictations.get({ ...input, id: task.id });
      expect(result?.status).toBe("canceled");
      expect(result?.text).toBeNull();
      await expect(aiDictations.apply({ ...input, id: task.id, content: [], expectedRevision: 0 })).resolves.toEqual({
        disposition: "discarded",
        draft: null,
      });
    } finally {
      await cleanup();
    }
  });
});
