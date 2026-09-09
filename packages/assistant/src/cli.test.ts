import { describe, expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import assistantCli from "./cli";
import { collectSurveyResult, collectTextEditorResult, runInteractiveAssistant } from "./cli/interactive";
import { streamAssistantTurn } from "./cli/stream";

const json = (value: unknown, status = 200) => Response.json(value, { status });

const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });

const createContext = (
  args: string[],
  fetcher: CloudCliContext["fetch"],
  output: CloudCliContext["options"]["output"] = "text",
): { ctx: CloudCliContext; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const draftRevisions = new Map<string, number>();
  const fetchWithDraftFallback: CloudCliContext["fetch"] = async (path, init) => {
    const response = await fetcher(path, init);
    if (response.status !== 404) return response;
    const url = String(path);
    const detail = url.match(/^\/api\/ai\/conversations\/([^/]+)$/u);
    if (detail && (init?.method ?? "GET") === "GET") {
      const revision = draftRevisions.get(detail[1]!) ?? 0;
      return json({ conversation: { id: detail[1], draft: { content: [], revision, updatedAt: null } }, activeTurn: null });
    }
    const draft = url.match(/^\/api\/ai\/conversations\/([^/]+)\/draft$/u);
    if (draft && init?.method === "PUT") {
      const revision = (draftRevisions.get(draft[1]!) ?? 0) + 1;
      draftRevisions.set(draft[1]!, revision);
      return json({ content: [], revision, updatedAt: "2026-08-18T00:00:00.000Z" });
    }
    return response;
  };
  const ctx: CloudCliContext = {
    args,
    flags: {},
    options: { profile: "test", server: "https://cloud.example", token: "test", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: fetchWithDraftFallback,
    readJson: async <T>(response: Response) => {
      if (!response.ok)
        throw new Error(`${response.status} ${((await response.json()) as { message?: string }).message ?? response.statusText}`);
      return (await response.json()) as T;
    },
    print: (value = "") => stdout.push(`${value}\n`),
    write: async (value) => void stdout.push(value),
    error: (value) => stderr.push(value),
    json: (value) => stdout.push(`${JSON.stringify(value)}\n`),
    jsonLine: (value) => stdout.push(`${JSON.stringify(value)}\n`),
    table: () => undefined,
  };
  return { ctx, stdout, stderr };
};

describe("assistant CLI", () => {
  test("documents the one-shot and management surface", () => {
    const help = assistantCli.help?.() ?? "";
    expect(help).toContain("cld assistant -p");
    expect(help).not.toContain(" ask ");
    expect(help).toContain("chats");
    expect(help).toContain("actions");
    expect(help).toContain("files");
    expect(help).toContain("personalization");
    expect(help).toContain("prefs");
    expect(help).toContain("resources");
    expect(help).toContain("tasks");
    expect(help).toContain("Create, inspect, and manage Assistant chats");
    expect(help).toContain("Review and resolve pending turn actions");
    expect(help).toContain("Manage personal facts, preferences, and learning");
    expect(help).toContain("Find structured Cloud resources used in Assistant chats");
    expect(help).toContain("Manage one-time and recurring chat tasks");
    expect(help).not.toMatch(/^\s+\w+\s+Commands$/m);
  });

  test("creates and manually runs chat-bound scheduled tasks", async () => {
    const requests: Array<{ path: string; method: string; body: unknown; idempotencyKey: string | null }> = [];
    const task = {
      id: "tSk234",
      chatId: "cHt234",
      chatTitle: "Release planning",
      conversationId: "22222222-2222-4222-8222-222222222222",
      sponsorUserId: "33333333-3333-4333-8333-333333333333",
      prompt: "Check the release.",
      schedule: { kind: "once", runAt: "2099-06-15T07:30:00.000Z" },
      timezone: "Europe/Berlin",
      state: "active",
      lastError: null,
      createdAt: "2026-08-11T10:00:00.000Z",
      updatedAt: "2026-08-11T10:00:00.000Z",
    };
    const fetcher: CloudCliContext["fetch"] = async (path, init) => {
      requests.push({
        path: String(path),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      });
      return json(String(path).endsWith("/run") ? { id: "oCc234", taskId: "tSk234", state: "queued" } : task);
    };

    const create = createContext(["tasks", "create"], fetcher);
    create.ctx.flags.chat = "cHt234";
    create.ctx.flags.prompt = "Check the release.";
    create.ctx.flags.at = "2099-06-15T09:30";
    await assistantCli.run(create.ctx);

    const run = createContext(["tasks", "run", "tSk234"], fetcher);
    await assistantCli.run(run.ctx);

    expect(requests.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
      {
        path: "/api/ai/tasks",
        method: "POST",
        body: { chatId: "cHt234", prompt: "Check the release.", schedule: { kind: "once", localAt: "2099-06-15T09:30" } },
      },
      { path: "/api/ai/tasks/tSk234/run", method: "POST", body: null },
    ]);
    expect(requests.every((request) => Boolean(request.idempotencyKey))).toBe(true);
  });

  test("shows the task scheduling timezone", async () => {
    const request = createContext(["tasks", "status"], async (path) => {
      expect(String(path)).toBe("/api/ai/tasks/status");
      return json({ timezone: "Europe/Berlin" });
    });
    await assistantCli.run(request.ctx);
    expect(request.stdout.join("")).toContain("Europe/Berlin");
  });

  test("searches chat messages and structured resources with readable IDs", async () => {
    const requests: string[] = [];
    const fetcher: CloudCliContext["fetch"] = async (path) => {
      requests.push(String(path));
      if (String(path).includes("messages/search")) return json({ messages: [], nextCursor: "12" });
      if (String(path).startsWith("/api/ai/resources")) return json({ resources: [] });
      return json({ resources: [] });
    };

    const messages = createContext(["messages", "search", "cHt234", "release date"], fetcher, "json");
    messages.ctx.flags.limit = "10";
    expect(await assistantCli.run(messages.ctx)).toBeUndefined();

    const local = createContext(["resources", "list", "cHt234"], fetcher, "json");
    local.ctx.flags.search = "nT1234";
    local.ctx.flags.limit = "20";
    expect(await assistantCli.run(local.ctx)).toBeUndefined();

    const across = createContext(["resources", "search", "release notes"], fetcher, "json");
    across.ctx.flags.limit = "20";
    expect(await assistantCli.run(across.ctx)).toBeUndefined();

    expect(requests).toEqual([
      "/api/ai/conversations/cHt234/messages/search?q=release+date&limit=10",
      "/api/ai/conversations/cHt234/resources?q=nT1234&limit=20",
      "/api/ai/resources?q=release+notes&limit=20",
    ]);
  });

  test("prints continuation cursors in text mode", async () => {
    const messages = createContext(["messages", "search", "cHt234", "release"], async () => json({ messages: [], nextCursor: "12" }));
    await assistantCli.run(messages.ctx);
    expect(messages.stdout.join("")).toContain("Continue with --before 12");

    const resources = createContext(["resources", "search", "release"], async () => json({ resources: [], nextCursor: "opaque" }));
    await assistantCli.run(resources.ctx);
    expect(resources.stdout.join("")).toContain("Continue with --cursor opaque");
  });

  test("lists and searches personalization with stable JSON output", async () => {
    const memory = {
      id: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      kind: "preference",
      content: "Answer in concise German",
      priority: "pinned",
      source: "user",
      sourceConversationId: null,
      sourceMessageId: null,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    };
    const requests: string[] = [];
    const { ctx, stdout } = createContext(
      ["personalization", "list"],
      async (path) => {
        requests.push(String(path));
        return json([memory]);
      },
      "json",
    );
    ctx.flags.search = "German";
    ctx.flags.limit = "5";

    expect(await assistantCli.run(ctx)).toBeUndefined();
    expect(requests).toEqual(["/api/ai/memories?q=German&limit=5"]);
    expect(JSON.parse(stdout.join(""))).toEqual([memory]);
  });

  test("adds and updates personalization through input flags", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const fetcher: CloudCliContext["fetch"] = async (path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: String(path), method: init?.method ?? "GET", body });
      return json({
        id,
        kind: body && typeof body === "object" && "kind" in body ? body.kind : "preference",
        content: body && typeof body === "object" && "content" in body ? body.content : "Answer in German",
        priority: "pinned",
        source: "user",
        updatedAt: "2026-08-11T00:00:00.000Z",
      });
    };

    const help = createContext(["personalization", "add", "help"], fetcher);
    expect(await assistantCli.run(help.ctx)).toBe(0);
    expect(help.stdout.join("")).toContain("--content-file");
    expect(help.stdout.join("")).toContain("--stdin");

    const add = createContext(["personalization", "add", "preference"], fetcher);
    add.ctx.flags.content = "Answer in German";
    expect(await assistantCli.run(add.ctx)).toBeUndefined();

    const update = createContext(["personalization", "update", id], fetcher);
    update.ctx.flags.kind = "fact";
    update.ctx.flags.content = "Timezone is Europe/Berlin";
    expect(await assistantCli.run(update.ctx)).toBeUndefined();

    expect(requests).toEqual([
      { path: "/api/ai/memories", method: "POST", body: { kind: "preference", content: "Answer in German" } },
      {
        path: `/api/ai/memories/${id}`,
        method: "PATCH",
        body: { kind: "fact", content: "Timezone is Europe/Berlin" },
      },
    ]);
  });

  test("pins, unpins, and explicitly confirms forgetting personalization", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const requests: Array<{ method: string; body: unknown }> = [];
    const fetcher: CloudCliContext["fetch"] = async (_path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method: init?.method ?? "GET", body });
      return json(init?.method === "DELETE" ? { deleted: true } : { id, content: "Answer in German" });
    };

    for (const action of ["pin", "unpin"] as const) {
      const command = createContext(["personalization", action, id], fetcher);
      expect(await assistantCli.run(command.ctx)).toBeUndefined();
    }

    const unconfirmed = createContext(["personalization", "forget", id], fetcher);
    expect(assistantCli.run(unconfirmed.ctx)).rejects.toThrow("requires --yes");

    const confirmed = createContext(["personalization", "forget", id], fetcher);
    confirmed.ctx.flags.yes = true;
    expect(await assistantCli.run(confirmed.ctx)).toBeUndefined();

    expect(requests).toEqual([
      { method: "PATCH", body: { priority: "pinned" } },
      { method: "PATCH", body: { priority: "normal" } },
      { method: "DELETE", body: null },
    ]);
  });

  test("reads and configures personalization use and learning", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    const fetcher: CloudCliContext["fetch"] = async (_path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method: init?.method ?? "GET", body });
      return json({
        userId: "22222222-2222-4222-8222-222222222222",
        memoryEnabled: body && typeof body === "object" && "memoryEnabled" in body ? body.memoryEnabled : true,
        memoryLearningEnabled: body && typeof body === "object" && "memoryLearningEnabled" in body ? body.memoryLearningEnabled : false,
        lastModelId: "model-1",
      });
    };

    const status = createContext(["personalization", "status"], fetcher, "json");
    expect(await assistantCli.run(status.ctx)).toBeUndefined();
    expect(JSON.parse(status.stdout.join(""))).toEqual({ memoryEnabled: true, memoryLearningEnabled: false });

    const configure = createContext(["personalization", "configure"], fetcher, "json");
    configure.ctx.flags.use = "off";
    configure.ctx.flags.learning = "on";
    expect(await assistantCli.run(configure.ctx)).toBeUndefined();
    expect(JSON.parse(configure.stdout.join(""))).toEqual({ memoryEnabled: false, memoryLearningEnabled: true });
    expect(requests).toEqual([
      { method: "GET", body: null },
      { method: "PUT", body: { memoryEnabled: false, memoryLearningEnabled: true } },
    ]);
  });

  test("creates a chat and writes only streamed assistant text to stdout", async () => {
    const requests: string[] = [];
    const stream = sse(
      { type: "state", conversation: { id: "chat-1" }, messages: [], activeTurn: null },
      {
        v: 1,
        type: "turn_started",
        conversationId: "chat-1",
        turnId: "turn-1",
        attempt: 1,
        seq: 1,
        modelProfileId: "model-1",
        providerModel: "provider/model",
      },
      {
        v: 1,
        type: "block_delta",
        conversationId: "chat-1",
        turnId: "turn-1",
        attempt: 1,
        seq: 2,
        blockId: "text-1",
        blockKind: "text",
        delta: "Hello",
      },
      {
        v: 1,
        type: "turn_finished",
        conversationId: "chat-1",
        turnId: "turn-1",
        attempt: 1,
        seq: 3,
        status: "completed",
        error: null,
        messages: [
          {
            id: "message-1",
            loopId: "turn-1",
            kind: "message",
            message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          },
        ],
      },
    );
    const { ctx, stdout, stderr } = createContext(["hello"], async (path, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(path)}`);
      if (path === "/api/ai/conversations") return json({ id: "chat-1", title: "New chat" }, 201);
      if (path === "/api/ai/conversations/chat-1/stream") return stream;
      if (path === "/api/ai/conversations/chat-1/turns") return json({ turn: { id: "turn-1", status: "queued" } }, 201);
      return json({ message: "Not found" }, 404);
    });
    ctx.flags.print = true;

    expect(await assistantCli.run(ctx)).toBe(0);
    expect(stdout.join("")).toBe("Hello\n");
    expect(stderr).toEqual([]);
    expect(requests).toEqual([
      "POST /api/ai/conversations",
      "GET /api/ai/conversations/chat-1/stream",
      "GET /api/ai/conversations/chat-1",
      "PUT /api/ai/conversations/chat-1/draft",
      "POST /api/ai/conversations/chat-1/turns",
    ]);
  });

  test("keeps one conversation across interactive messages", async () => {
    let streamIndex = 0;
    let turnIndex = 0;
    const requests: string[] = [];
    const streams = [
      sse(
        { type: "state", conversation: { id: "chat-1" }, messages: [], activeTurn: null },
        {
          v: 1,
          type: "block_delta",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 1,
          blockId: "text-1",
          blockKind: "text",
          delta: "First",
        },
        {
          v: 1,
          type: "turn_finished",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 2,
          status: "completed",
          error: null,
          messages: [],
        },
      ),
      sse(
        { type: "state", conversation: { id: "chat-1" }, messages: [], activeTurn: null },
        {
          v: 1,
          type: "block_delta",
          conversationId: "chat-1",
          turnId: "turn-2",
          attempt: 1,
          seq: 1,
          blockId: "text-2",
          blockKind: "text",
          delta: "Second",
        },
        {
          v: 1,
          type: "turn_finished",
          conversationId: "chat-1",
          turnId: "turn-2",
          attempt: 1,
          seq: 2,
          status: "completed",
          error: null,
          messages: [],
        },
      ),
    ];
    const { ctx, stdout, stderr } = createContext([], async (path, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(path)}`);
      if (path === "/api/ai/conversations") return json({ id: "chat-1", title: "New chat" }, 201);
      if (path === "/api/ai/conversations/chat-1/stream") return streams[streamIndex++]!;
      if (path === "/api/ai/conversations/chat-1/turns") {
        turnIndex += 1;
        return json({ turn: { id: `turn-${turnIndex}`, status: "queued" } }, 201);
      }
      return json({ message: "Not found" }, 404);
    });
    const lines = ["hello", "again", "/exit"];
    const prompts: string[] = [];
    const reader = {
      read: async (prompt: string) => {
        prompts.push(prompt);
        return lines.shift() ?? null;
      },
      close: () => undefined,
      onInterrupt: () => () => undefined,
    };

    expect(await runInteractiveAssistant(ctx, {}, reader)).toBe(0);
    const output = stdout.join("");
    expect(output).toContain("\u001b[34mInfo:\u001b[0m New chat created. Resume this chat later with:\n      cld assistant --chat chat-1");
    expect(output).toContain("\u001b[34mInfo:\u001b[0m Resume this chat later with:\n      cld assistant --chat chat-1");
    expect(output.match(/cld assistant --chat chat-1/g)).toHaveLength(2);
    expect(output).toContain("First\nSecond\n");
    expect(stderr).not.toContain("Chat: chat-1");
    expect(prompts).toEqual(["> ", "> ", "> "]);
    expect(requests.filter((request) => request === "POST /api/ai/conversations")).toHaveLength(1);
    expect(requests.filter((request) => request === "POST /api/ai/conversations/chat-1/turns")).toHaveLength(2);
  });

  test("selects a model through the numbered picker", async () => {
    const turnBodies: unknown[] = [];
    let streamIndex = 0;
    let turnIndex = 0;
    const streams = ["turn-1", "turn-2"].map((turnId) =>
      sse(
        { type: "state", conversation: { id: "chat-1" }, messages: [], activeTurn: null },
        {
          v: 1,
          type: "turn_finished",
          conversationId: "chat-1",
          turnId,
          attempt: 1,
          seq: 1,
          status: "completed",
          error: null,
          messages: [],
        },
      ),
    );
    const { ctx, stdout } = createContext([], async (path, init) => {
      if (path === "/api/ai/status") {
        return json({
          defaultModelId: "model-1",
          models: [
            { id: "model-1", label: "Model One", provider: "provider", model: "one", capabilities: [] },
            { id: "model-2", label: "Model Two", provider: "provider", model: "two", capabilities: [] },
          ],
        });
      }
      if (path === "/api/ai/models") {
        return json([
          { id: "model-1", label: "Model One", provider: "provider", model: "one", capabilities: [] },
          { id: "model-2", label: "Model Two", provider: "provider", model: "two", capabilities: [] },
        ]);
      }
      if (path === "/api/ai/conversations") return json({ id: "chat-1", title: "New chat" }, 201);
      if (path === "/api/ai/conversations/chat-1/stream") return streams[streamIndex++]!;
      if (path === "/api/ai/conversations/chat-1/turns") {
        turnBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        turnIndex += 1;
        return json({ turn: { id: `turn-${turnIndex}`, status: "queued" } }, 201);
      }
      return json({ message: "Not found" }, 404);
    });
    const lines = ["/model", "2", "Summarize this", "Continue", "/exit"];
    const reader = {
      read: async () => lines.shift() ?? null,
      close: () => undefined,
      onInterrupt: () => () => undefined,
    };

    expect(await runInteractiveAssistant(ctx, {}, reader)).toBe(0);
    expect(turnBodies).toEqual([
      { draftRevision: 1, modelProfileId: "model-2" },
      { draftRevision: 2, modelProfileId: "model-2" },
    ]);
    const output = stdout.join("");
    expect(output).toContain("Assistant · Model One · /help for commands");
    expect(output).toContain("Select a model:");
    expect(output).toContain("2. Model Two · provider · two");
  });

  test("recognizes an approval already present in the initial stream state", async () => {
    const { ctx } = createContext([], async () => json({ message: "unused" }, 500));
    const initialResponse = sse({
      type: "state",
      conversation: { id: "chat-1" },
      messages: [],
      activeTurn: {
        turnId: "turn-1",
        attempt: 1,
        status: "waiting_for_action",
        blocks: [
          {
            id: "tool-1",
            kind: "tool",
            callId: "call-1",
            name: "mail.createDraft",
            args: { subject: "Hello" },
            status: "awaiting_approval",
            approval: { allowAlways: false },
          },
        ],
      },
    });

    const result = await streamAssistantTurn({ ctx, conversationId: "chat-1", turnId: "turn-1", initialResponse });
    expect(result.status).toBe("needs_attention");
    expect(result.pending).toEqual({ type: "approval", callId: "call-1", name: "mail.createDraft" });
  });

  test("resolves an approval inline and resumes the same turn", async () => {
    let streamIndex = 0;
    let approvalBody: unknown;
    const streams = [
      sse(
        { type: "state", conversation: { id: "chat-1" }, messages: [], activeTurn: null },
        {
          v: 1,
          type: "block_set",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 1,
          block: {
            id: "tool-1",
            kind: "tool",
            callId: "call-1",
            name: "mail.createDraft",
            args: { subject: "Hello" },
            status: "awaiting_approval",
            approval: { allowAlways: false },
          },
        },
      ),
      sse(
        {
          v: 1,
          type: "block_delta",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 2,
          blockId: "text-1",
          blockKind: "text",
          delta: "Done",
        },
        {
          v: 1,
          type: "turn_finished",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 3,
          status: "completed",
          error: null,
          messages: [],
        },
      ),
    ];
    const { ctx, stdout } = createContext([], async (path, init) => {
      if (path === "/api/ai/conversations") return json({ id: "chat-1", title: "New chat" }, 201);
      if (path === "/api/ai/conversations/chat-1/stream") return streams[streamIndex++]!;
      if (path === "/api/ai/conversations/chat-1/turns") {
        return json({ turn: { id: "turn-1", status: "queued" } }, 201);
      }
      if (path === "/api/ai/conversations/chat-1/pending-actions/turn-1") {
        return json([
          {
            type: "approval_request",
            conversationId: "chat-1",
            turnId: "turn-1",
            callId: "call-1",
            name: "mail.createDraft",
            args: { subject: "Hello" },
            message: "Create draft",
            allowAlways: true,
          },
        ]);
      }
      if (path === "/api/ai/conversations/chat-1/turns/turn-1/actions/call-1") {
        approvalBody = JSON.parse(String(init?.body));
        return json({ ok: true });
      }
      return json({ message: "Not found" }, 404);
    });
    const lines = ["hello", "a", "/exit"];
    const reader = {
      read: async () => lines.shift() ?? null,
      close: () => undefined,
      onInterrupt: () => () => undefined,
    };

    expect(await runInteractiveAssistant(ctx, {}, reader)).toBe(0);
    expect(approvalBody).toEqual({ type: "approval_response", approved: true, remember: "always" });
    expect(stdout.join("")).toContain("Done\n");
  });

  test("offers local Bash only for opted-in turns and persists a denial", async () => {
    let streamIndex = 0;
    let turnBody: Record<string, unknown> | undefined;
    let actionBody: unknown;
    const streams = [
      sse(
        { type: "state", conversation: { id: "chat-1" }, messages: [], activeTurn: null },
        {
          v: 1,
          type: "block_set",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 1,
          block: {
            id: "tool-1",
            kind: "tool",
            callId: "call-1",
            name: "local_bash",
            args: { command: "touch should-not-exist" },
            status: "awaiting_client",
          },
        },
      ),
      sse(
        {
          v: 1,
          type: "block_delta",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 2,
          blockId: "text-1",
          blockKind: "text",
          delta: "Command was not run.",
        },
        {
          v: 1,
          type: "turn_finished",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 1,
          seq: 3,
          status: "completed",
          error: null,
          messages: [],
        },
      ),
    ];
    const { ctx, stdout, stderr } = createContext([], async (path, init) => {
      if (path === "/api/ai/conversations") return json({ id: "chat-1", title: "New chat" }, 201);
      if (path === "/api/ai/conversations/chat-1/stream") return streams[streamIndex++]!;
      if (path === "/api/ai/conversations/chat-1/turns") {
        turnBody = JSON.parse(String(init?.body));
        return json({ turn: { id: "turn-1", status: "queued" } }, 201);
      }
      if (path === "/api/ai/conversations/chat-1/pending-actions/turn-1") {
        return json([
          {
            type: "frontend_tool",
            conversationId: "chat-1",
            turnId: "turn-1",
            callId: "call-1",
            name: "local_bash",
            args: { command: "touch should-not-exist" },
            mode: "client",
          },
        ]);
      }
      if (path === "/api/ai/conversations/chat-1/turns/turn-1/actions/call-1") {
        actionBody = JSON.parse(String(init?.body));
        return json({ ok: true });
      }
      return json({ message: "Not found" }, 404);
    });
    const lines = ["inspect this checkout", "", "/exit"];
    const reader = {
      read: async () => lines.shift() ?? null,
      close: () => undefined,
      onInterrupt: () => () => undefined,
    };

    expect(await runInteractiveAssistant(ctx, { allowBash: true }, reader)).toBe(0);
    expect(turnBody?.clientToolIds).toEqual(["local_bash"]);
    expect(actionBody).toEqual({
      type: "tool_result",
      result: {
        status: "denied",
        exitCode: null,
        stdout: "",
        stderr: "User denied this command.",
        truncated: false,
      },
    });
    expect(stdout.join("")).toContain("Command was not run.");
    expect(stderr.join("\n")).toContain("Bash wants to run");
  });

  test("resumes a pending local Bash call without submitting a new turn", async () => {
    let streamIndex = 0;
    let actionBody: unknown;
    let submittedTurns = 0;
    const streams = [
      sse({
        type: "state",
        conversation: { id: "chat-1" },
        messages: [],
        activeTurn: {
          turnId: "turn-1",
          attempt: 1,
          status: "waiting_for_action",
          blocks: [
            {
              id: "tool-1",
              kind: "tool",
              callId: "call-1",
              name: "local_bash",
              args: { command: "touch should-not-exist" },
              status: "awaiting_client",
            },
          ],
        },
      }),
      sse(
        {
          v: 1,
          type: "block_delta",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 2,
          seq: 2,
          blockId: "text-1",
          blockKind: "text",
          delta: "Still safe.",
        },
        {
          v: 1,
          type: "turn_finished",
          conversationId: "chat-1",
          turnId: "turn-1",
          attempt: 2,
          seq: 3,
          status: "completed",
          error: null,
          messages: [],
        },
      ),
    ];
    const { ctx, stdout } = createContext([], async (path, init) => {
      if (path === "/api/ai/conversations/chat-1") {
        return json({ conversation: { id: "chat-1", title: "Existing" }, activeTurn: { turnId: "turn-1", status: "waiting_for_action" } });
      }
      if (path === "/api/ai/conversations/chat-1/stream") return streams[streamIndex++]!;
      if (path === "/api/ai/conversations/chat-1/pending-actions/turn-1") {
        return json([
          {
            type: "frontend_tool",
            conversationId: "chat-1",
            turnId: "turn-1",
            callId: "call-1",
            name: "local_bash",
            args: { command: "touch should-not-exist" },
            mode: "client",
          },
        ]);
      }
      if (path === "/api/ai/conversations/chat-1/turns/turn-1/actions/call-1") {
        actionBody = JSON.parse(String(init?.body));
        return json({ ok: true });
      }
      if (path === "/api/ai/conversations/chat-1/turns") {
        submittedTurns += 1;
        return json({ turn: { id: "unexpected", status: "queued" } }, 201);
      }
      return json({ message: "Not found" }, 404);
    });
    const lines = ["n", "/exit"];
    const reader = {
      read: async () => lines.shift() ?? null,
      close: () => undefined,
      onInterrupt: () => () => undefined,
    };

    expect(await runInteractiveAssistant(ctx, { conversationId: "chat-1", allowBash: true }, reader)).toBe(0);
    expect(submittedTurns).toBe(0);
    expect(actionBody).toMatchObject({ type: "tool_result", result: { status: "denied" } });
    expect(stdout.join("")).toContain("Still safe.");
  });

  test("collects the built-in survey with terminal-native answers", async () => {
    const { ctx } = createContext([], async () => json({}));
    const lines = ["2", "1,3", "Looks good", "4"];
    const reader = {
      read: async () => lines.shift() ?? null,
      close: () => undefined,
      onInterrupt: () => () => undefined,
    };

    const result = await collectSurveyResult(ctx, reader, {
      title: "Review",
      questions: [
        {
          type: "single",
          id: "priority",
          label: "Priority",
          required: true,
          options: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
        },
        {
          type: "multiple",
          id: "areas",
          label: "Areas",
          required: true,
          options: [
            { value: "api", label: "API" },
            { value: "ui", label: "UI" },
            { value: "docs", label: "Docs" },
          ],
        },
        { type: "text", id: "note", label: "Note" },
        { type: "rating", id: "rating", label: "Rating", min: 1, max: 5, required: true },
      ],
    });

    expect(result).toEqual({
      submitted: true,
      answers: { priority: "high", areas: ["api", "docs"], note: "Looks good", rating: 4 },
    });
  });

  test("accepts the proposed long-form text without opening an editor", async () => {
    const { ctx, stdout } = createContext([], async () => json({}));
    const lines = [""];
    const result = await collectTextEditorResult(
      ctx,
      {
        read: async () => lines.shift() ?? null,
        close: () => undefined,
        onInterrupt: () => () => undefined,
      },
      { title: "Review mail", content: "Hello Ada", format: "plain" },
    );

    expect(result).toEqual({ submitted: true, content: "Hello Ada", format: "plain" });
    expect(stdout.join("")).toContain("Review mail");
    expect(stdout.join("")).toContain("Hello Ada");
  });

  test("edits and explicitly accepts long-form text", async () => {
    const { ctx } = createContext([], async () => json({}));
    const lines = ["e", "y"];
    const lifecycle: string[] = [];
    const result = await collectTextEditorResult(
      ctx,
      {
        read: async () => lines.shift() ?? null,
        close: () => undefined,
        onInterrupt: () => () => undefined,
        pause: () => lifecycle.push("pause"),
        resume: () => lifecycle.push("resume"),
      },
      { title: "Review mail", content: "Initial", format: "markdown" },
      async () => ({ submitted: true, content: "Edited", format: "markdown" }),
    );

    expect(result).toEqual({ submitted: true, content: "Edited", format: "markdown" });
    expect(lifecycle).toEqual(["pause", "resume"]);
  });

  test("leaves a cancelled text edit pending", async () => {
    const { ctx } = createContext([], async () => json({}));
    const result = await collectTextEditorResult(
      ctx,
      {
        read: async () => "c",
        close: () => undefined,
        onInterrupt: () => () => undefined,
      },
      { title: "Review mail", content: "Initial" },
    );

    expect(result).toBeNull();
  });

  test("creates a Project", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const { ctx, stdout } = createContext(["projects", "create", "Release notes"], async (path, init) => {
      requests.push({ path: String(path), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return json({
        project: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Release notes",
          description: "Summarize releases",
          instructions: "List user-visible changes.",
          icon: "ti ti-folders",
          permission: "admin",
          revision: 1,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        },
      });
    });
    ctx.flags.description = "Summarize releases";
    ctx.flags.instructions = "List user-visible changes.";

    expect(await assistantCli.run(ctx)).toBeUndefined();
    expect(requests).toEqual([
      {
        path: "/api/ai/projects/",
        method: "POST",
        body: {
          name: "Release notes",
          description: "Summarize releases",
          icon: "ti ti-folders",
          instructions: "List user-visible changes.",
        },
      },
    ]);
    expect(stdout.join("")).toContain("Release notes");
  });

  test("rejects ambiguous Project display names", async () => {
    const project = (shortId: string) => ({
      id: shortId,
      shortId,
      name: "Release notes",
      description: "",
      instructions: "",
      icon: "ti ti-folders",
      permission: "admin",
      revision: 1,
      defaultModelProfileId: null,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    });
    const { ctx } = createContext(["projects", "get", "Release notes"], async () =>
      json({ projects: [project("pRk234"), project("pRk235")] }),
    );

    await expect(assistantCli.run(ctx)).rejects.toThrow('Multiple Projects are named "Release notes"');
  });

  test("resolves Project display names exactly", async () => {
    const project = (shortId: string, name: string) => ({
      id: shortId,
      shortId,
      name,
      description: "",
      instructions: "",
      icon: "ti ti-folders",
      permission: "admin",
      revision: 1,
      defaultModelProfileId: null,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    });
    const requests: string[] = [];
    const { ctx } = createContext(["projects", "get", "release notes"], async (path) => {
      requests.push(String(path));
      if (path === "/api/ai/projects/") return json({ projects: [project("pRk234", "Release notes"), project("pRk235", "release notes")] });
      return json({ project: project("pRk235", "release notes") });
    });

    await assistantCli.run(ctx);
    expect(requests).toEqual(["/api/ai/projects/", "/api/ai/projects/pRk235"]);
  });

  test("creates a detached chat inside a Project", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const { ctx } = createContext(["Summarize this"], async (path, init) => {
      requests.push({ path: String(path), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === "/api/ai/conversations") return json({ id: "chat-1", title: "Project chat", projectId }, 201);
      if (path === "/api/ai/conversations/chat-1/turns") {
        return json({ turn: { id: "turn-1", status: "queued" } }, 201);
      }
      return json({ message: "Not found" }, 404);
    });
    ctx.flags.project = projectId;
    ctx.flags.print = true;
    ctx.flags.detach = true;

    expect(await assistantCli.run(ctx)).toBe(0);
    expect(requests[0]).toEqual({
      path: "/api/ai/conversations",
      method: "POST",
      body: { projectId },
    });
  });
});
