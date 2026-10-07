import { beforeAll, expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { sql } from "bun";
import { connectTestNats, databaseSuite, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { __aiExecutorTest } from "./executor";
import { aiFileStore, loadAiConversationFileOverview } from "./files-store";
import { migrateCloudAi } from "./migrate";
import { submitAiTurnAction } from "./runtime";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();
const { indexConversationToolSource } = __aiExecutorTest;

const bytes = (text: string) => new TextEncoder().encode(text);

const fixture = async () => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-results-${suffix}`}, 'local', 'user', 'AI Results Test', ${`ai-results-${suffix}@example.test`}, 'AI', 'Results')
    RETURNING id
  `;
  const conversation = await aiConversations.createConversation({ ownerUserId: user!.id });
  let seq = 0;
  /** A finished turn whose assistant message calls `tool` and whose tool result answers it, as the store keeps them. */
  const turn = async (calls: Array<{ callId: string; name: string; args: unknown; result: unknown; isError?: boolean }>) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO ai.turns (short_id, conversation_id, model_profile_id, status, run_config)
      VALUES (${createAiShortId()}, ${conversation.id}, 'test-model', 'completed',
        ${JSON.stringify({ kind: "chat", input: "hi", toolSource: { kind: "none" } })}::text::jsonb)
      RETURNING id
    `;
    const turnId = row!.id;
    const insert = async (role: string, message: unknown) => {
      seq += 1;
      await sql`
        INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, loop_id)
        VALUES (${createAiShortId()}, ${conversation.id}, ${seq}, 'message', ${role}, ${JSON.stringify(message)}::text::jsonb, ${turnId})
      `;
      return seq;
    };
    const question = await insert("user", { role: "user", content: [{ type: "text", text: "Bitte" }] });
    const delivering = await insert("assistant", {
      role: "assistant",
      content: calls.map((call) => ({ type: "tool_call", id: call.callId, name: call.name, args: call.args })),
    });
    for (const call of calls)
      await insert("tool_result", {
        role: "tool_result",
        callId: call.callId,
        name: call.name,
        result: call.result,
        isError: call.isError ?? false,
      });
    return { turnId, question, delivering };
  };
  return {
    conversation,
    turn,
    cleanup: async () => {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    },
  };
};

suite("AI chat results integration", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test("present, code_open, and code_present become results that point at the message that delivered them", async () => {
    const chat = await fixture();
    try {
      await aiFileStore.write({
        conversationId: chat.conversation.id,
        path: "/report.pdf",
        bytes: bytes("%PDF"),
        mediaType: "application/pdf",
      });
      const present = {
        callId: "present-1",
        name: "present",
        args: { path: "/report.pdf", title: "Quarterly report", description: "The report." },
      };
      const first = await chat.turn([{ ...present, result: { path: "/report.pdf", size: 4, mediaType: "application/pdf" } }]);
      const opened = { callId: "open-1", name: "code_open", args: { id: "App001" }, result: { opened: "App001", started: false } };
      const chart = {
        callId: "chart-1",
        name: "code_present",
        args: { runId: "r", title: "Revenue chart" },
        result: { presentationId: crypto.randomUUID(), title: "Revenue chart" },
      };
      const second = await chat.turn([opened, chart]);
      for (const [turn, call] of [
        [first, { ...present, result: { path: "/report.pdf", size: 4, mediaType: "application/pdf" } }],
        [second, opened],
        [second, chart],
      ] as const)
        await indexConversationToolSource({ conversationId: chat.conversation.id, turnId: turn.turnId, isError: false, ...call });

      const page = await aiConversations.listConversationSources({ conversationId: chat.conversation.id, kinds: ["result"] });
      expect(page.total).toBe(3);
      const byKey = new Map(page.sources.map((source) => [source.key, source]));
      expect(byKey.get("/report.pdf")).toMatchObject({
        kind: "result",
        title: "Quarterly report",
        preview: "The report.",
        path: "/report.pdf",
        size: 4,
        sourceCallId: "present-1",
        sourceMessageSeq: first.delivering,
      });
      expect(byKey.get("assistant.artifact:App001")).toMatchObject({
        ref: { type: "assistant.artifact", id: "App001" },
        sourceMessageSeq: second.delivering,
      });
      expect(byKey.get("code_present:chart-1")).toMatchObject({ title: "Revenue chart", sourceMessageSeq: second.delivering });

      // A new delivery describes the file anew: without a description, the old one goes.
      await indexConversationToolSource({
        conversationId: chat.conversation.id,
        turnId: second.turnId,
        isError: false,
        callId: "present-2",
        name: "present",
        args: { path: "/report.pdf" },
        result: { path: "/report.pdf", size: 4, mediaType: "application/pdf" },
      });
      const again = await aiConversations.listConversationSources({
        conversationId: chat.conversation.id,
        kinds: ["result"],
        search: "report",
      });
      expect(again.sources.find((source) => source.key === "/report.pdf")).toMatchObject({ title: "report.pdf", preview: null });
      // Failed calls deliver nothing.
      await indexConversationToolSource({
        conversationId: chat.conversation.id,
        turnId: second.turnId,
        isError: true,
        callId: "present-3",
        name: "present",
        args: { path: "/missing.pdf" },
        result: { error: "missing" },
      });
      expect((await aiConversations.listConversationSources({ conversationId: chat.conversation.id, kinds: ["result"] })).total).toBe(3);
    } finally {
      await chat.cleanup();
    }
  });

  test("sources filter by kind, keep each web search, count all matches, and leave Project context out", async () => {
    const chat = await fixture();
    try {
      const { turnId } = await chat.turn([]);
      for (const [callId, query] of [
        ["search-1", "Umsatz Q3"],
        ["search-2", "Umsatz  q3"],
        ["search-3", "Retouren"],
      ] as const)
        await indexConversationToolSource({
          conversationId: chat.conversation.id,
          turnId,
          callId,
          name: "web_search",
          args: { query },
          result: {},
          isError: false,
        });
      await aiConversations.indexConversationResources({
        conversationId: chat.conversation.id,
        turnId,
        callId: "read-1",
        resources: [{ ref: { type: "mail.message", id: "M1" }, title: "Offer" }],
      });
      const read = (await aiConversations.listConversationSources({ conversationId: chat.conversation.id, kinds: ["resource"] }))
        .sources[0]!;
      // Project context is indexed on every turn without a call: a project-only reference, and the mail read above.
      const later = await chat.turn([]);
      await aiConversations.indexConversationResources({
        conversationId: chat.conversation.id,
        turnId: later.turnId,
        resources: [{ ref: { type: "notebooks.notebook", id: "N1" } }, { ref: { type: "mail.message", id: "M1" } }],
      });
      await aiFileStore.write({ conversationId: chat.conversation.id, path: "/upload.csv", bytes: bytes("a"), mediaType: "text/csv" });

      const sources = await aiConversations.listConversationSources({
        conversationId: chat.conversation.id,
        kinds: ["web", "activity", "resource"],
        observed: true,
        limit: 2,
      });
      expect(sources.total).toBe(3);
      expect(sources.sources).toHaveLength(2);
      expect(sources.nextCursor).toBeDefined();
      const all = [
        ...sources.sources,
        ...(
          await aiConversations.listConversationSources({
            conversationId: chat.conversation.id,
            kinds: ["web", "activity", "resource"],
            observed: true,
            before: sources.nextCursor,
          })
        ).sources,
      ];
      // Searches that differ only in spacing and case are one entry; the mail keeps the turn and time it was read.
      expect(all.map((source) => source.key).sort()).toEqual(["mail.message:M1", "web_search:retouren", "web_search:umsatz q3"]);
      expect(all.find((source) => source.key === "mail.message:M1")).toMatchObject({ lastSeenAt: read.lastSeenAt, sourceCallId: "read-1" });
      const everything = await aiConversations.listConversationSources({ conversationId: chat.conversation.id });
      expect(everything.total).toBe(5);
      expect(everything.sources.some((source) => source.key === "notebooks.notebook:N1")).toBe(true);
    } finally {
      await chat.cleanup();
    }
  });

  test("renaming a delivered file keeps it a result and its file-name title follows", async () => {
    const chat = await fixture();
    try {
      const { turnId } = await chat.turn([]);
      for (const path of ["/draft.md", "/notes.md"]) {
        await aiFileStore.write({ conversationId: chat.conversation.id, path, bytes: bytes("# x"), mediaType: "text/markdown" });
        await indexConversationToolSource({
          conversationId: chat.conversation.id,
          turnId,
          callId: `present-${path}`,
          name: "present",
          args: path === "/notes.md" ? { path, title: "Meeting notes" } : { path },
          result: { path, size: 3, mediaType: "text/markdown" },
          isError: false,
        });
      }
      expect(await aiFileStore.rename({ conversationId: chat.conversation.id, from: "/draft.md", to: "/final.md" })).toBe("renamed");
      expect(await aiFileStore.rename({ conversationId: chat.conversation.id, from: "/notes.md", to: "/2026-10-06.md" })).toBe("renamed");
      const results = await aiConversations.listConversationSources({ conversationId: chat.conversation.id, kinds: ["result"] });
      expect(results.sources.map((source) => [source.key, source.title, source.path]).sort()).toEqual([
        ["/2026-10-06.md", "Meeting notes", "/2026-10-06.md"],
        ["/final.md", "final.md", "/final.md"],
      ]);
    } finally {
      await chat.cleanup();
    }
  });

  test("the file overview groups working files by folder and pages a group literally", async () => {
    const chat = await fixture();
    const write = (path: string, text = "x", mediaType = "text/html") =>
      aiFileStore.write({ conversationId: chat.conversation.id, path, bytes: bytes(text), mediaType });
    try {
      await aiFileStore.write({
        conversationId: chat.conversation.id,
        path: "/upload.csv",
        bytes: bytes("abc"),
        mediaType: "text/csv",
        origin: "user",
      });
      await write("/report.pdf", "%PDF", "application/pdf");
      await write("/temp/umsatz_q3/part-1.html");
      await write("/temp/umsatz_q3/part-2.html");
      await write("/temp/umsatz_q3/chart.png", "png", "image/png");
      await write("/temp/umsatzXq3/other.html");
      await write("/temp/loose.txt", "t", "text/plain");

      const overview = await loadAiConversationFileOverview(chat.conversation.id);
      expect(overview.files.map((file) => file.path).sort()).toEqual(["/report.pdf", "/upload.csv"]);
      expect(overview.fileCount).toBe(2);
      expect(overview.workingCount).toBe(5);
      expect(overview.groupCount).toBe(3);
      const groups = new Map(overview.groups.map((group) => [group.folder, group]));
      expect(groups.get("umsatz_q3")).toMatchObject({ count: 3, mediaTypes: { "text/html": 2, "image/png": 1 } });
      expect(groups.get(null)).toMatchObject({ count: 1 });
      expect(overview.looseWorkingFiles.map((file) => file.path)).toEqual(["/temp/loose.txt"]);
      expect(overview.usedBytes).toBeGreaterThan(0);

      // `_` in a folder name is literal: the group does not reach into /temp/umsatzXq3/.
      const first = await aiFileStore.list({ conversationId: chat.conversation.id, prefix: "/temp/umsatz_q3/", limit: 2 });
      expect(first.map((file) => file.path)).toEqual(["/temp/umsatz_q3/chart.png", "/temp/umsatz_q3/part-1.html"]);
      const next = await aiFileStore.list({
        conversationId: chat.conversation.id,
        prefix: "/temp/umsatz_q3/",
        limit: 2,
        after: first.at(-1)!.path,
      });
      expect(next.map((file) => file.path)).toEqual(["/temp/umsatz_q3/part-2.html"]);

      expect(await aiFileStore.remove({ conversationId: chat.conversation.id, path: "/temp/umsatz_q3", recursive: true })).toBe(3);
      expect(await aiFileStore.stat({ conversationId: chat.conversation.id, path: "/temp/umsatzXq3/other.html" })).not.toBeNull();
    } finally {
      await chat.cleanup();
    }
  });

  test("the migration indexes deliveries already in chat history once", async () => {
    const chat = await fixture();
    try {
      await aiFileStore.write({
        conversationId: chat.conversation.id,
        path: "/old.pdf",
        bytes: bytes("%PDF"),
        mediaType: "application/pdf",
      });
      const history = await chat.turn([
        {
          callId: "old-present",
          name: "present",
          args: { path: "/old.pdf", title: "Old report", description: "From before the sidebar." },
          result: { path: "/old.pdf", size: 4, mediaType: "application/pdf" },
        },
        { callId: "old-open", name: "code_open", args: { id: "App009" }, result: { error: "Browser workspace disconnected" } },
        { callId: "old-fail", name: "present", args: { path: "/gone.pdf" }, result: { message: "missing" }, isError: true },
      ]);
      // The database as it was before results existed.
      await sql`DELETE FROM ai.conversation_sources WHERE kind = 'result'`;
      await sql`ALTER TABLE ai.conversation_sources DROP CONSTRAINT ai_conversation_sources_kind_check`;
      await sql`ALTER TABLE ai.conversation_sources ADD CONSTRAINT ai_conversation_sources_kind_check CHECK (kind IN ('web', 'activity'))`;

      await migrateCloudAi();
      const results = await aiConversations.listConversationSources({ conversationId: chat.conversation.id, kinds: ["result"] });
      expect(results.sources).toHaveLength(1);
      expect(results.sources[0]).toMatchObject({
        key: "/old.pdf",
        title: "Old report",
        preview: "From before the sidebar.",
        sourceCallId: "old-present",
        sourceMessageSeq: history.delivering,
      });
      // Running it again changes nothing.
      await migrateCloudAi();
      expect((await aiConversations.listConversationSources({ conversationId: chat.conversation.id, kinds: ["result"] })).total).toBe(1);
    } finally {
      await chat.cleanup();
    }
  });
});

suiteFor("database", "nats")("AI chat results reported by the browser", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test("an app the browser opened with code_open becomes a result when the browser reports back", async () => {
    const chat = await fixture();
    // Reporting back queues the turn's continuation, which needs Sync.
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const sync = createSync({
      connection,
      namespace: testSyncNamespace("chat-results"),
      application: "cloud-test",
      defaults: { replicas: 1 },
    });
    bindProcessSync(sync);
    try {
      const { turnId } = await chat.turn([]);
      for (const [callId, id] of [
        ["open-ok", "App002"],
        ["open-failed", "App003"],
      ] as const)
        await aiConversations.savePendingTurnAction({
          turnId,
          conversationId: chat.conversation.id,
          callId,
          kind: "client_tool",
          status: "pending",
          name: "code_open",
          args: { id },
          approvalScope: "code_open",
          allowAlways: false,
          resolvedEvent: null,
        });
      const submit = (callId: string, result: unknown) =>
        submitAiTurnAction({ conversationId: chat.conversation.id, turnId, callId, action: { type: "tool_result", result } });
      expect(await submit("open-ok", { opened: "App002", started: false })).toEqual({ ok: true });
      expect(await submit("open-failed", { error: "Browser workspace disconnected" })).toEqual({ ok: true });
      const results = await aiConversations.listConversationSources({ conversationId: chat.conversation.id, kinds: ["result"] });
      expect(results.sources.map((source) => source.key)).toEqual(["assistant.artifact:App002"]);
    } finally {
      await chat.cleanup();
      await sync.drain();
      for (const resource of await sync.resources())
        for (const name of resource.natsNames)
          await connection.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array(), { timeout: 5_000 });
      unbindProcessSync();
      await connection.drain();
    }
  });
});
