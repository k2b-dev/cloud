import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { redis, sql } from "bun";
import { z } from "zod";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { databaseSuite, suiteFor } from "../../../../scripts/fixtures/test-infra";
import * as aiSettings from "./settings";
import { composeAiSystemPrompt } from "./system-prompt";
import "../../../../scripts/fixtures/authorization-preload";
import { APPROVAL_ACP_CLIENT, APPROVAL_CLIENT_HEADER } from "../contracts/approvals";
import { accounts } from "../services/accounts";
import { approvalScopeFromToolName, approvals } from "../services/approvals";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session/index";
import { createTestSession } from "../services/session/session.test-fixture";
import * as platformSettings from "../services/settings";
import { createAiApprovalPreferenceRoutes } from "./approval-routes";
import { AI_WEBSITE_APPROVAL_TOOL, findRememberedAiToolApproval, hasRememberedAiToolApproval } from "./approvals";
import * as assistantModels from "./assistant-models";
import { aiFileStore } from "./files-store";
import { AI_LOCAL_TOOL_NAMES } from "./local-tool-contracts";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import type { AiStreamEvent } from "./protocol";
import { __aiRoutesTest, aiRoutes } from "./routes";
import * as aiRuntime from "./runtime";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import { publishAiWireEvent } from "./stream";

const suite = databaseSuite();

const insertUser = async (): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-routes-${suffix}`}, 'local', 'user', 'AI Routes', ${`ai-routes-${suffix}@example.test`}, 'AI', 'Routes')
    RETURNING id
  `;
  return row!.id;
};

describe("global AI route registration", () => {
  test("mounts personalization learning activity behind authentication", async () => {
    const config = spyOn(platformSettings, "get").mockResolvedValue(100);
    const counter = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
    try {
      const response = await aiRoutes.request("/memory-learning-runs?page=1&perPage=20");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Authentication required" });
      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(counter).toHaveBeenCalledTimes(1);
      expect(counter.mock.calls[0]?.[0]).toBe("EVAL");
    } finally {
      config.mockRestore();
      counter.mockRestore();
    }
  });
});

suite("global AI conversation boundaries", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("image upload API sanitizes stored bytes and reports malformed images as 422", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const token = await createTestSession(userId);
    try {
      const jpeg = await tinyJpeg();
      const input = withCameraMetadata(jpeg, 1);
      const upload = (bytes: Uint8Array) => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(bytes)], "photo.jpg", { type: "image/jpeg" }));
        return aiRoutes.request(`/conversations/${chat.shortId}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
      };
      expect((await upload(input)).status).toBe(200);
      expect((await aiFileStore.read({ conversationId: chat.id, path: "/photo.jpg" }))?.bytes).toEqual(jpeg);
      expect((await upload(input.subarray(0, 30))).status).toBe(422);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("filters unknown client tools before submitting a saved draft", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const submissions: Parameters<typeof aiRuntime.submitAiChatTurn>[0][] = [];
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) => {
      submissions.push(submission);
      throw new Error("Submission stopped by test");
    });
    try {
      const saved = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: [{ type: "text", text: "Test the app" }],
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error("Draft save failed");
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/turns`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await createTestSession(userId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          draftRevision: saved.draft.revision,
          clientToolIds: ["code_interact", "code_run"],
          client: { kind: "cli", cwd: "/work", os: "Linux", shell: "bash", localTools: "ask" },
          localContext: { instructions: [{ path: "/work/AGENTS.md", content: "Rules." }], skills: [], selectedSkills: [] },
        }),
      });
      expect(response.status).toBe(500);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.clientToolIds).toEqual(["code_run"]);
      expect(submissions[0]?.client?.cwd).toBe("/work");
      expect(submissions[0]?.localContext?.instructions).toEqual([{ path: "/work/AGENTS.md", content: "Rules." }]);
    } finally {
      submit.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test.each([false, true])("message retry uses the retrying client's local context: local=%p", async (local) => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const model = spyOn(assistantModels, "selectAssistantAiModelId").mockResolvedValue("test-model");
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) =>
      aiConversations.submitChatTurn({
        conversationId: submission.conversationId,
        modelProfileId: "test-model",
        userMessage: submission.userMessage,
        truncateFromSeq: submission.truncateFromSeq,
        runConfig: {
          kind: "chat",
          input: submission.input,
          toolSource: submission.toolSource ?? { kind: "none" },
          clientToolIds: submission.clientToolIds,
          client: submission.client,
          localContext: submission.localContext,
        },
      }),
    );
    const selectedSkills = [{ name: "invoice", directory: "/original/.agents/skills/invoice", instructions: "Original selection." }];
    const client = { kind: "cli" as const, cwd: "/current", os: "Linux", shell: "bash", localTools: "ask" as const };
    const localContext = {
      instructions: [{ path: "/current/AGENTS.md", content: "Current rules." }],
      skills: [{ name: "current", description: "Current Skill.", scope: "project" as const }],
    };
    try {
      const first = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "test-model",
        userMessage: { role: "user", content: [{ type: "text", text: "Retry me" }] },
        runConfig: {
          kind: "chat",
          input: "Retry me",
          toolSource: { kind: "default" },
          clientToolIds: ["local_bash", ...AI_LOCAL_TOOL_NAMES, "code_open"],
          client: { ...client, cwd: "/original" },
          localContext: { instructions: [{ path: "/original/AGENTS.md", content: "Old rules." }], skills: [], selectedSkills },
        },
      });
      await sql`UPDATE ai.turns SET status='completed' WHERE id=${first.turn.id}::uuid`;
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/messages/${first.message.shortId}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" },
        body: JSON.stringify(local ? { client, localContext, clientToolIds: ["local_read", "code_secret"] } : {}),
      });
      expect(response.status).toBe(201);
      expect(submit).toHaveBeenCalledTimes(1);
      const active = await aiConversations.getActiveTurn({ conversationId: chat.id });
      expect(active).not.toBeNull();
      if (!active) throw new Error("Missing retry turn");
      const config = await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: active.turn.id });
      if (!config || config.kind !== "chat") throw new Error("Missing retry run config");
      expect(config.clientToolIds).toEqual(local ? ["local_read", "code_secret"] : ["code_open"]);
      expect(config.client).toEqual(local ? client : undefined);
      expect(config.localContext).toEqual(local ? { ...localContext, selectedSkills } : undefined);
    } finally {
      submit.mockRestore();
      model.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("assigns a Project only once even when two requests race", async () => {
    const userId = await insertUser();
    const subject = { type: "user" as const, userId };
    const first = await aiProjects.create({ subject, name: "First" });
    const second = await aiProjects.create({ subject, name: "Second" });
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const results = await Promise.all(
        [first, second].map((project) =>
          aiConversations.setConversationProject({
            conversationId: chat.id,
            ownerUserId: userId,
            projectId: project.id,
            onlyUnassigned: true,
          }),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "already_assigned" }]);
      expect(
        await aiConversations.setConversationProject({
          conversationId: chat.id,
          ownerUserId: userId,
          projectId: null,
          onlyUnassigned: true,
        }),
      ).toEqual({ ok: false, reason: "already_assigned" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM ai.projects WHERE id IN (${first.id}::uuid,${second.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("an upload storage failure produces a safe correlated diagnostic", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const upload = spyOn(aiFileStore, "createUserUpload").mockRejectedValue(new Error("storage unavailable"));
    try {
      const token = await createTestSession(userId);
      const body = new FormData();
      body.append("file", new File(["private file content"], "fixture.txt"));
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/files`, {
        method: "POST",
        body,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(400);
      const diagnostic = warning.mock.calls.find((call) => call[1] === "Conversation upload failed");
      expect(diagnostic?.[2]).toMatchObject({ code: "file_upload_failed", conversationId: chat.id });
      expect(JSON.stringify(diagnostic)).not.toContain("private file content");
    } finally {
      upload.mockRestore();
      warning.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("deletes one chat file only for its owner and reports a missing file", async () => {
    const ownerId = await insertUser();
    const otherId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: ownerId });
    const archived = await aiConversations.createConversation({ ownerUserId: ownerId });
    const file = { path: "/notes.md", bytes: new TextEncoder().encode("# Notes"), mediaType: "text/markdown" };
    try {
      await aiFileStore.createUserUpload({ conversationId: chat.id, ...file });
      await aiFileStore.createToolArtifact({ conversationId: archived.id, ...file, producerCallKey: "test:notes" });
      await aiConversations.archiveConversation({ conversationId: archived.id, ownerUserId: ownerId });
      const owner = await createTestSession(ownerId);
      const other = await createTestSession(otherId);
      const remove = (shortId: string, path: string, token: string) =>
        aiRoutes.request(`/conversations/${shortId}/files?${new URLSearchParams({ path })}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });

      const foreign = await remove(chat.shortId, file.path, other);
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toMatchObject({ message: "Conversation not found" });
      const readOnly = await remove(archived.shortId, file.path, owner);
      expect(readOnly.status).toBe(404);
      expect(await aiFileStore.stat({ conversationId: chat.id, path: file.path })).not.toBeNull();
      expect(await aiFileStore.stat({ conversationId: archived.id, path: file.path })).not.toBeNull();

      const missing = await remove(chat.shortId, "/missing.md", owner);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ message: "File not found" });

      const readable = await aiRoutes.request(`/conversations/${chat.shortId}/files/content?${new URLSearchParams({ path: file.path })}`, {
        headers: { Authorization: `Bearer ${owner}` },
      });
      expect(readable.status).toBe(200);
      expect(readable.headers.get("X-Cloud-Ai-File-Origin")).toBe("user");

      const deleted = await remove(chat.shortId, file.path, owner);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
      expect(await aiFileStore.stat({ conversationId: chat.id, path: file.path })).toBeNull();
      const content = await aiRoutes.request(`/conversations/${chat.shortId}/files/content?${new URLSearchParams({ path: file.path })}`, {
        headers: { Authorization: `Bearer ${owner}` },
      });
      expect(content.status).toBe(404);
      expect(await content.json()).toMatchObject({ message: "File not found" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${chat.id}::uuid, ${archived.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid, ${otherId}::uuid)`;
    }
  });

  test("replaces a turn waiting for action when its user message is retried", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const first = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "ja", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "ja" }] },
      });
      await sql`
        UPDATE ai.turns
        SET status = 'waiting_for_action', lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ${first.turn.id}::uuid
      `;

      expect(await __aiRoutesTest.prepareConversationForMessageRetry(chat.id)).toBe("ready");
      expect((await aiConversations.getTurn({ conversationId: chat.id, turnId: first.turn.id }))?.status).toBe("aborted");

      const retry = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "ja", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "ja" }] },
        truncateFromSeq: first.message.seq,
      });
      expect(retry.turn.status).toBe("queued");
      expect((await aiConversations.getActiveTurn({ conversationId: chat.id }))?.turn.id).toBe(retry.turn.id);
      expect(await __aiRoutesTest.prepareConversationForMessageRetry(chat.id)).toBe("busy");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("changes or removes one Project between turns but not during an active turn", async () => {
    const userId = await insertUser();
    const subject = { type: "user" as const, userId };
    const first = await aiProjects.create({ subject, name: "First Project" });
    const second = await aiProjects.create({ subject, name: "Second Project" });
    const chat = await aiConversations.createConversation({ ownerUserId: userId, projectId: first.id });
    try {
      await sql`
        INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text)
        VALUES (${createAiShortId()}, ${chat.id}::uuid, 1, 'message', 'user', '{"role":"user","content":["Hello"]}'::jsonb, 'Hello')
      `;
      expect(
        await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: second.id }),
      ).toMatchObject({ ok: true, conversation: { projectId: second.id } });
      expect(await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: null })).toMatchObject(
        { ok: true, conversation: { projectId: null } },
      );

      await sql`
        INSERT INTO ai.turns (short_id, conversation_id, status)
        VALUES (${createAiShortId()}, ${chat.id}::uuid, 'running')
      `;
      expect(await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: first.id })).toEqual({
        ok: false,
        reason: "active_turn",
      });
    } finally {
      await sql`DELETE FROM ai.projects WHERE id IN (${first.id}::uuid, ${second.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("stores one optimistic-concurrency draft and keeps identical autosaves idempotent", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({
      ownerUserId: userId,
      draft: [{ type: "text", text: "Initial" }],
    });
    try {
      const unchanged = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: chat.draft.content,
      });
      expect(unchanged).toMatchObject({ ok: true, draft: { revision: chat.draft.revision } });

      const changed = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: [{ type: "resource", ref: { type: "mail.draft", id: "Drf123" } }],
      });
      expect(changed).toMatchObject({ ok: true, draft: { revision: chat.draft.revision + 1 } });
      expect(
        await aiConversations.saveDraft({
          conversationId: chat.id,
          ownerUserId: userId,
          expectedRevision: chat.draft.revision,
          content: [],
        }),
      ).toEqual({ ok: false, reason: "conflict" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("creates a launch draft at a directly submitable revision", async () => {
    const userId = await insertUser();
    try {
      const conversation = await aiConversations.createConversation({
        ownerUserId: userId,
        draft: [
          { type: "text", text: "Help me write this email." },
          { type: "resource", ref: { type: "mail.draft", id: "Draft1" } },
        ],
      });

      expect(conversation.draft).toMatchObject({ revision: 1, content: [{ type: "text" }, { type: "resource" }] });
      const identical = await aiConversations.saveDraft({
        conversationId: conversation.id,
        ownerUserId: userId,
        expectedRevision: 1,
        content: conversation.draft.content,
      });
      expect(identical.ok && identical.draft.revision).toBe(1);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});

type StreamReader = ReadableStreamDefaultReader<Uint8Array>;

const readFirstEvent = async (reader: StreamReader): Promise<AiStreamEvent> => {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("Stream ended before its first event");
    text += decoder.decode(next.value, { stream: true });
  }
  const data = text
    .slice(0, text.indexOf("\n\n"))
    .split("\n")
    .find((line) => line.startsWith("data:"));
  return JSON.parse(data!.slice(5)) as AiStreamEvent;
};

/** Drains the stream until the server ends it or the deadline passes. */
const readUntilClosed = async (reader: StreamReader, deadlineMs: number): Promise<{ closed: boolean; bytes: number }> => {
  const deadline = Date.now() + deadlineMs;
  let bytes = 0;
  while (true) {
    const remaining = deadline - Date.now();
    const next = remaining > 0 ? await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]) : null;
    if (!next) {
      await reader.cancel().catch(() => undefined);
      return { closed: false, bytes };
    }
    if (next.done) return { closed: true, bytes };
    bytes += next.value.byteLength;
  }
};

suiteFor(
  "database",
  "nats",
  "valkey",
)("global AI conversation stream", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  const openStream = (shortId: string, token: string, signal: AbortSignal) =>
    aiRoutes.request(`/conversations/${shortId}/stream`, {
      headers: { Accept: "text/event-stream", Cookie: `session_token=${token}` },
      signal,
    });

  const openStreamWithBearer = (shortId: string, token: string, signal: AbortSignal) =>
    aiRoutes.request(`/conversations/${shortId}/stream`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
      signal,
    });

  test("ends an open stream once its session is revoked", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    try {
      const response = await openStream(chat.shortId, token, abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await readFirstEvent(reader)).type).toBe("state");

      await session.revoke(token);

      // One revalidation interval (5 s) plus slack.
      expect((await readUntilClosed(reader, 10_000)).closed).toBe(true);
      expect((await openStream(chat.shortId, token, abort.signal)).status).toBe(401);
    } finally {
      abort.abort();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);

  test("ends an open stream once its API key is revoked", async () => {
    const userId = await insertUser();
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing fixture user");
    const created = await serviceAccountCredentials.createUserApiToken({ user, name: "AI stream" });
    if (!created.ok) throw new Error(created.error.message);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    try {
      const response = await openStreamWithBearer(chat.shortId, created.data.token, abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await readFirstEvent(reader)).type).toBe("state");

      const revoked = await serviceAccountCredentials.revokeForDelegatedUser({ credentialId: created.data.credential.id, user });
      expect(revoked.ok).toBe(true);

      expect((await readUntilClosed(reader, 10_000)).closed).toBe(true);
      expect((await openStreamWithBearer(chat.shortId, created.data.token, abort.signal)).status).toBe(401);
    } finally {
      abort.abort();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);

  test("ends an open stream once its conversation is archived", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    try {
      const response = await openStream(chat.shortId, token, abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await readFirstEvent(reader)).type).toBe("state");

      // The credential stays valid; only the conversation check can end this stream.
      expect(await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: userId })).toBe(true);

      expect((await readUntilClosed(reader, 10_000)).closed).toBe(true);
      expect((await openStream(chat.shortId, token, abort.signal)).status).toBe(404);
    } finally {
      abort.abort();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);

  test("ends the stream instead of buffering without bound when the reader falls behind", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "hi", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "hi" }] },
      });
      const response = await openStream(chat.shortId, token, abort.signal);
      const reader = response.body!.getReader();
      const state = await readFirstEvent(reader);
      if (state.type !== "state" || !state.activeTurn) throw new Error("Expected the queued turn in the snapshot");
      const { attempt, seq } = state.activeTurn;

      // 48 events of 200 KiB: about 9.4 MiB the reader never takes.
      const delta = "x".repeat(200 * 1024);
      const published = 48;
      for (let i = 1; i <= published; i++) {
        await publishAiWireEvent({
          v: 1,
          type: "block_delta",
          conversationId: chat.id,
          turnId: turn.id,
          attempt,
          seq: seq + i,
          blockId: "text-1",
          blockKind: "text",
          delta,
        });
      }
      await Bun.sleep(1_500);

      const drained = await readUntilClosed(reader, 3_000);
      expect(drained.closed).toBe(true);
      // The 4 MiB bound plus the snapshot and the event that crossed it.
      expect(drained.bytes).toBeLessThan(5 * 1024 * 1024);
    } finally {
      abort.abort();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);
});

suiteFor("database", "nats")("chat and website approvals", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test("only a signed-in session marks its turn and remembers a website; an API key approves once", async () => {
    const userId = await insertUser();
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing fixture user");
    const created = await serviceAccountCredentials.createUserApiToken({ user, name: "Website approvals" });
    if (!created.ok) throw new Error(created.error.message);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const other = await aiConversations.createConversation({ ownerUserId: userId });
    const session = { Authorization: `Bearer ${await createTestSession(userId)}` };
    const apiKey = { Authorization: `Bearer ${created.data.token}` };
    const submissions: Parameters<typeof aiRuntime.submitAiChatTurn>[0][] = [];
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) => {
      submissions.push(submission);
      throw new Error("Submission stopped by test");
    });
    try {
      const saved = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: [{ type: "text", text: "Read the quotes" }],
      });
      if (!saved.ok) throw new Error("Draft save failed");
      for (const headers of [session, apiKey])
        await aiRoutes.request(`/conversations/${chat.shortId}/turns`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ draftRevision: saved.draft.revision }),
        });
      expect(submissions.map((submission) => submission.signedInSession)).toEqual([true, undefined]);
      submit.mockRestore();

      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "mock",
        runConfig: { kind: "chat", input: "Read the quotes", signedInSession: true },
        userMessage: { role: "user", content: [{ type: "text", text: "Read the quotes" }] },
      });
      const origin = "https://query1.finance.yahoo.com";
      const ask = async (
        callId: string,
        extra: Partial<Parameters<typeof aiConversations.savePendingTurnAction>[0]> = {},
        assurance: "confirm" | "standard" = "standard",
      ) => {
        const snapshot = {
          turnId: turn.id,
          conversationId: chat.id,
          callId,
          kind: "custom_approval" as const,
          status: "pending" as const,
          name: "code_run",
          args: {},
          message: `HTTP request: GET ${origin}/v7/finance/quote?symbols=NVDA`,
          approvalScope: origin,
          allowAlways: false,
          allowChat: true,
          rememberToolName: AI_WEBSITE_APPROVAL_TOOL,
          resolvedEvent: null,
          ...extra,
        };
        const record = await approvals.request({
          ...approvalScopeFromToolName(snapshot.name),
          approvalScope: snapshot.approvalScope,
          requester: { kind: "assistant_turn", ref: `${turn.id}/${callId}`, appId: "assistant", title: chat.title },
          subjectId: userId,
          approverUserId: userId,
          assurance,
          sentence: snapshot.message,
          input: snapshot.args,
          review: snapshot.review,
          expiresInMs: 60_000,
        });
        if (!record.ok) throw new Error("Expected a new approval request");
        await aiConversations.savePendingTurnAction({ ...snapshot, approvalId: record.id });
        return record.id;
      };
      const decide = (callId: string, headers: Record<string, string>, remember?: "chat" | "always") =>
        aiRoutes.request(`/conversations/${chat.shortId}/turns/${turn.shortId}/actions/${encodeURIComponent(callId)}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "approval_response", approved: true, ...(remember ? { remember } : {}) }),
        });
      const websiteRows = () =>
        sql<{ conversation_id: string | null }[]>`SELECT conversation_id FROM ai.tool_approval_preferences
          WHERE actor_user_id=${userId}::uuid AND tool_name=${AI_WEBSITE_APPROVAL_TOOL}`;

      const bridgeHeaders = { ...apiKey, [APPROVAL_CLIENT_HEADER]: APPROVAL_ACP_CLIENT };
      const bridgeConfirm = await ask(
        "bridge-confirm",
        { allowAlways: false, allowChat: false, rememberToolName: "mail.draft.send" },
        "confirm",
      );
      const bridgeDenied = await decide("bridge-confirm", bridgeHeaders);
      expect(bridgeDenied.status).toBe(403);
      expect(await bridgeDenied.json()).toMatchObject({
        code: "FORBIDDEN",
        message: "Approve this request in Cloud. An editor can only reject it.",
      });
      expect(await approvals.get(bridgeConfirm)).toMatchObject({ status: "pending" });
      expect((await decide("bridge-confirm", session)).status).toBe(200);
      const bridgeStandard = await ask("bridge-standard");
      expect((await decide("bridge-standard", bridgeHeaders)).status).toBe(200);
      expect(await approvals.get(bridgeStandard)).toMatchObject({ status: "approved", decidedVia: "acp_bridge" });
      const firstApproval = await ask("run-approval-0");
      // An API key, like `cld` or another delegated credential, may approve this one request, but never the next ones.
      expect((await decide("run-approval-0", apiKey, "chat")).status).toBe(400);
      // A website is never remembered everywhere.
      expect((await decide("run-approval-0", session, "always")).status).toBe(400);
      expect(await websiteRows()).toEqual([]);
      expect(await approvals.get(firstApproval)).toMatchObject({ status: "pending" });
      expect((await decide("run-approval-0", apiKey)).status).toBe(200);
      expect(await websiteRows()).toEqual([]);

      expect(await approvals.get(firstApproval)).toMatchObject({ status: "approved", decidedVia: "api_key" });
      const secondApproval = await ask("run-approval-1");
      expect((await decide("run-approval-1", session, "chat")).status).toBe(200);
      expect(await approvals.get(secondApproval)).toMatchObject({ status: "approved", decidedVia: "web_session" });
      expect(await websiteRows()).toEqual([{ conversation_id: chat.id }]);
      expect(
        await findRememberedAiToolApproval(
          { actorUserId: userId },
          { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: origin, conversationId: chat.id, chatOnly: true },
        ),
      ).not.toBeNull();
      expect(
        await findRememberedAiToolApproval(
          { actorUserId: userId },
          { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: origin, conversationId: other.id, chatOnly: true },
        ),
      ).toBeNull();

      // An Action remembered for the chat applies in this chat only, and both end with the chat.
      await ask("run-approval-2", {
        rememberToolName: "spaces.task.create",
        approvalScope: "space:team01",
        allowAlways: true,
        message: "Spaces: Create task",
      });
      expect((await decide("run-approval-2", apiKey, "chat")).status).toBe(200);
      const chatList = await aiApprovalList(session, chat.shortId);
      expect(chatList.map((approval) => approval.toolName).sort()).toEqual(["spaces.task.create", AI_WEBSITE_APPROVAL_TOOL]);
      expect(await aiApprovalList(session)).toEqual([]);
      expect(
        await hasRememberedAiToolApproval(
          { actorUserId: userId },
          { toolName: "spaces.task.create", approvalScope: "space:team01", conversationId: other.id },
        ),
      ).toBe(false);
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      expect((await sql`SELECT id FROM ai.tool_approval_preferences WHERE actor_user_id=${userId}::uuid`).length).toBe(0);
    } finally {
      submit.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id IN (${chat.id}::uuid, ${other.id}::uuid)`;
      await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 30_000);
});

const aiApprovalList = async (headers: Record<string, string>, conversation?: string) => {
  const routes = createAiApprovalPreferenceRoutes();
  const response = await routes.request(conversation ? `/?conversation=${conversation}` : "/", { headers });
  expect(response.status).toBe(200);
  return ((await response.json()) as { approvals: Array<{ toolName: string }> }).approvals;
};

suite("local client actions and preview", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("invalid local_list output returns 400 and leaves the action pending; valid output resolves it", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const token = await createTestSession(userId);
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "mock",
        runConfig: { kind: "chat", input: "List files" },
        userMessage: { role: "user", content: ["List files"] },
      });
      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "list-1",
        name: "local_list",
        kind: "client_tool",
        frontendMode: "client",
        status: "pending",
        args: { path: "." },
        approvalScope: "local_list",
        allowAlways: false,
        allowChat: false,
        resolvedEvent: null,
      });
      const respond = (result: unknown) =>
        aiRoutes.request(`/conversations/${chat.shortId}/turns/${turn.shortId}/actions/list-1`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "tool_result", result }),
        });
      const invalid = await respond({ status: "completed", entries: "not an array" });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).toContain("Invalid local_list result");
      expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId: "list-1" })).toMatchObject({
        status: "pending",
        resolvedEvent: null,
      });
      const result = { status: "completed", path: "/work", entries: [], nextAfter: null };
      expect((await respond(result)).status).toBe(200);
      expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId: "list-1" })).toMatchObject({
        status: "resolved",
        resolvedEvent: { type: "tool_result", result },
      });
      expect((await respond(result)).status).toBe(200);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("a pending code_secret action accepts a CodeToolFailure result", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const token = await createTestSession(userId);
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "mock",
        runConfig: { kind: "chat", input: "Store a secret" },
        userMessage: { role: "user", content: ["Store a secret"] },
      });
      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "secret-1",
        name: "code_secret",
        kind: "client_tool",
        frontendMode: "client",
        status: "pending",
        args: { name: "API_TOKEN" },
        approvalScope: "code_secret",
        allowAlways: false,
        allowChat: false,
        resolvedEvent: null,
      });
      const result = { failed: true, error: "The secret prompt was cancelled." };
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/turns/${turn.shortId}/actions/secret-1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tool_result", result }),
      });
      expect(response.status).toBe(200);
      expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId: "secret-1" })).toMatchObject({
        status: "resolved",
        resolvedEvent: { type: "tool_result", callId: "secret-1", result },
      });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("preview validates local facts and uses the same local section as a turn", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const headers = { Authorization: `Bearer ${token}` };
    const settings = spyOn(aiSettings, "readAiSettingsState").mockResolvedValue({
      ok: true,
      enabled: false,
      defaultModelId: "",
      globalInstructions: "",
      localClientInstructions: "Literal {{ cwd }}.",
      compactionInstructions: "",
      maxToolResultChars: 2000,
      firecrawlConfigured: false,
      profiles: [],
    });
    try {
      expect((await aiRoutes.request("/prefs/system-prompt?clientKind=unknown", { headers })).status).toBe(400);
      const query = new URLSearchParams({
        clientKind: "acp",
        clientName: "Editor",
        cwd: "/work",
        os: "Linux",
        shell: "bash",
        localTools: "off",
      });
      const response = await aiRoutes.request(`/prefs/system-prompt?${query}`, { headers });
      expect(response.status).toBe(200);
      const data = z.object({ prompt: z.string() }).parse(await response.json());
      const cloudUrl = (await platformSettings.get<string>("app.url")) || "";
      const turnPrompt = composeAiSystemPrompt({
        globalInstructions: "",
        localClient: {
          client: { kind: "acp", name: "Editor", cwd: "/work", os: "Linux", shell: "bash", localTools: "off" },
          cloudUrl,
          instructions: "Literal {{ cwd }}.",
        },
      });
      const section = (prompt: string) => prompt.split("# Local client\n")[1]?.split("\n\n#")[0];
      expect(section(data.prompt)).toBe(section(turnPrompt));
      expect(data.prompt).not.toContain("# Workspace instructions");
    } finally {
      settings.mockRestore();
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
});
