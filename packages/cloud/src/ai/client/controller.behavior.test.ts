import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { AI_TURN_LEASE_MS, type AiStreamSseEvent, type AiTurnBlock, type AiTurnSnapshot } from "../protocol";
import type { AiConversation, AiStoredMessage } from "../types";
import { __aiControllerTest, createAiChatController } from "./controller";
import type { AiChatProjection } from "./projection";
import type { AiConversationStreamTransport } from "./transport";

const {
  claimFrontendCall,
  conversationRunError,
  failSteerBlock,
  isActiveConversationLoading,
  isCurrentStreamSession,
  newestTurnShowsError,
  projectionForConversationOpen,
  reconcileSteerBlocks,
  runErrorFromEvent,
  settleFrontendCall,
  isComposerDraftSendable,
} = __aiControllerTest;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AI controller draft submission", () => {
  test("sends a draft containing only a Cloud resource", () => {
    expect(isComposerDraftSendable({ resources: [{ ref: { type: "mail.message", id: "m1" } }] })).toBe(true);
  });

  test("sends a draft containing only an already uploaded file", () => {
    expect(isComposerDraftSendable({ storedFiles: [{ path: "/notes.txt", mediaType: "text/plain", size: 5, version: 1 }] })).toBe(true);
  });

  test("shares one conversation creation across concurrent draft saves", async () => {
    let resolveCreate!: (response: Response) => void;
    const createResponse = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    let createCalls = 0;
    let draftRevision = 0;
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        if (path === "/api/ai/conversations" && init?.method === "POST") {
          createCalls += 1;
          return createResponse;
        }
        if (init?.headers && new Headers(init.headers).get("Accept") === "text/event-stream") {
          return new Response(new ReadableStream());
        }
        if (path.endsWith("/draft") && init?.method === "PUT") {
          draftRevision += 1;
          const body = JSON.parse(String(init.body)) as { content: AiConversation["draft"]["content"] };
          return Response.json({ content: body.content, revision: draftRevision, updatedAt: null });
        }
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );

    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({ baseUrl: "/api/ai" });
    });
    const first = controller.saveDraft({ message: "First" });
    const second = controller.saveDraft({ message: "Second" });
    await Promise.resolve();
    expect(createCalls).toBe(1);

    resolveCreate(Response.json(conversation("created"), { status: 201 }));
    expect((await first)?.conversationId).toBe("created");
    expect((await second)?.conversationId).toBe("created");
    expect(createCalls).toBe(1);
    dispose();
  });

  test("keeps the submitted draft and turn POST ahead of a queued empty autosave", async () => {
    const requests: string[] = [];
    let revision = 0;
    let resolveTurn!: (response: Response) => void;
    const turnResponse = new Promise<Response>((resolve) => {
      resolveTurn = resolve;
    });
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        if (init?.headers && new Headers(init.headers).get("Accept") === "text/event-stream") {
          return new Response(new ReadableStream());
        }
        if (path.endsWith("/draft") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { content: AiConversation["draft"]["content"] };
          requests.push(`PUT:${body.content.find((part) => part.type === "text")?.text ?? "empty"}`);
          revision += 1;
          return Response.json({ content: body.content, revision, updatedAt: null });
        }
        if (path.endsWith("/turns") && init?.method === "POST") {
          requests.push("POST");
          return turnResponse;
        }
        if (path.endsWith("/timeline")) return Response.json([]);
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );

    let dispose!: () => void;
    const current = conversation("current");
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: null },
      });
    });
    const sending = controller.send({ message: "Sent" });
    const emptyAutosave = controller.saveDraft({});

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toEqual(["PUT:Sent", "POST"]);

    resolveTurn(
      Response.json({
        turn: {
          id: "turn-1",
          shortId: "tRn234",
          conversationId: current.id,
          status: "running",
          attempt: 0,
          modelProfileId: null,
          createdAt: "2026-07-11T00:00:00.000Z",
          completedAt: null,
          error: null,
        },
        message: {
          id: "message-1",
          shortId: "mSg234",
          conversationId: current.id,
          seq: 1,
          kind: "message",
          message: { role: "user", content: [{ type: "text", text: "Sent" }] },
          loopId: null,
          modelProfileId: null,
          providerModel: null,
          usage: null,
          stopReason: null,
          loopAggregate: null,
          loopDoneReason: null,
          compactedAt: null,
          meta: null,
          createdAt: "2026-07-11T00:00:00.000Z",
        },
      }),
    );
    expect(await sending).toBe(true);
    await emptyAutosave;
    expect(requests).toEqual(["PUT:Sent", "POST", "PUT:empty"]);
    dispose();
  });

  for (const finishBeforeAck of [false, true])
    test.skipIf(isServer)(`keeps a first send visible through upload and confirmation (early finish: ${finishBeforeAck})`, async () => {
      const current = conversation("new-chat");
      let emit!: Parameters<AiConversationStreamTransport["subscribe"]>[0]["onEvent"];
      let finishUpload!: (response: Response) => void;
      let finishTurn!: (response: Response) => void;
      const upload = new Promise<Response>((resolve) => {
        finishUpload = resolve;
      });
      const turn = new Promise<Response>((resolve) => {
        finishTurn = resolve;
      });
      globalThis.fetch = Object.assign(
        async (request: RequestInfo | URL, init?: RequestInit) => {
          const path = String(request);
          if (path.endsWith("/files") && init?.method === "POST") return upload;
          if (path.endsWith("/draft") && init?.method === "PUT") return Response.json({ content: [], revision: 1, updatedAt: null });
          if (path.endsWith("/turns") && init?.method === "POST") return turn;
          if (path.endsWith("/timeline")) return Response.json([]);
          return Response.json({});
        },
        { preconnect: originalFetch.preconnect },
      );
      let dispose!: () => void;
      const controller = createRoot((cleanup) => {
        dispose = cleanup;
        return createAiChatController({
          baseUrl: "/api/ai",
          initialConversationId: current.id,
          initialDetail: { conversation: current, messages: [], activeTurn: null },
          streamTransport: {
            subscribe: (input) => {
              emit = input.onEvent;
              return { close() {} };
            },
          },
        });
      });
      const sending = controller.send({ message: "Analyze", files: [new File(["a,b"], "demo.csv", { type: "text/csv" })] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.messages()).toHaveLength(1);
      emit({ type: "state", conversation: current, messages: [], activeTurn: null });
      expect(controller.messages()).toHaveLength(1);
      finishUpload(Response.json({ file: { path: "/demo.csv", size: 3, mediaType: "text/csv", version: 1 } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const pending = controller.messages()[0]!;
      const saved = { ...pending, id: "saved", shortId: "saved", loopId: "turn-1", meta: { submittedDraftRevision: 1 } };
      emit({ type: "state", conversation: current, messages: [saved], activeTurn: null });
      expect(controller.messages()).toHaveLength(1);
      if (finishBeforeAck)
        emit({
          v: 1,
          type: "turn_finished",
          conversationId: current.id,
          turnId: "turn-1",
          attempt: 1,
          seq: 1,
          status: "completed",
          error: null,
        });
      finishTurn(Response.json({ message: saved, turn: { id: "turn-1", modelProfileId: null } }));
      expect(await sending).toBe(true);
      expect(controller.activeTurn()?.status ?? null).toBe(finishBeforeAck ? null : "running");
      emit({ type: "state", conversation: current, messages: finishBeforeAck ? [saved] : [], activeTurn: null });
      expect(controller.messages().map((message) => message.id)).toEqual(["saved"]);
      dispose();
    });

  test("submits a Cloud resource without leaking the draft discriminator into its marker", async () => {
    let savedContent: AiConversation["draft"]["content"] = [];
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        if (init?.headers && new Headers(init.headers).get("Accept") === "text/event-stream") {
          return new Response(new ReadableStream());
        }
        if (path.endsWith("/draft") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { content: AiConversation["draft"]["content"] };
          savedContent = body.content;
          return Response.json({ content: body.content, revision: 1, updatedAt: null });
        }
        if (path.endsWith("/turns") && init?.method === "POST") {
          return Response.json({
            turn: {
              id: "turn-resource",
              shortId: "tRn234",
              conversationId: "resource-chat",
              status: "running",
              attempt: 0,
              modelProfileId: null,
              createdAt: "2026-07-11T00:00:00.000Z",
              completedAt: null,
              error: null,
            },
            message: {
              id: "message-resource",
              shortId: "mSg234",
              conversationId: "resource-chat",
              seq: 1,
              kind: "message",
              message: { role: "user", content: [{ type: "text", text: "Resource attached" }] },
              loopId: null,
              modelProfileId: null,
              providerModel: null,
              usage: null,
              stopReason: null,
              loopAggregate: null,
              loopDoneReason: null,
              compactedAt: null,
              meta: null,
              createdAt: "2026-07-11T00:00:00.000Z",
            },
          });
        }
        if (path.endsWith("/timeline")) return Response.json([]);
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );

    let dispose!: () => void;
    const current = conversation("resource-chat");
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: null },
      });
    });

    expect(
      await controller.send({
        resources: [
          {
            ref: { type: "mail.draft", id: "qw273Q" },
            title: "Draft",
            icon: "ti ti-file-pencil",
            href: "/app/mail/5guDsC/compose/qw273Q",
          },
        ],
      }),
    ).toBe(true);
    expect(savedContent).toEqual([
      {
        type: "resource",
        ref: { type: "mail.draft", id: "qw273Q" },
        title: "Draft",
        icon: "ti ti-file-pencil",
        href: "/app/mail/5guDsC/compose/qw273Q",
      },
    ]);
    dispose();
  });
});

const conversation = (id: string): AiConversation => ({
  id,
  shortId: "cNv234",
  title: id,
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-09-14T00:00:00.000Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user-1",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
});

describe("AI controller conversation transitions", () => {
  test("queues full content during a run and reuses the receipt after a lost response", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let fail = true;
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        requests.push({ path, body });
        if (path.endsWith("/draft")) return Response.json({ content: body.content, revision: 1, updatedAt: null });
        if (path.endsWith("/turns")) {
          if (fail) {
            fail = false;
            throw new Error("lost response");
          }
          return Response.json({ queued: true });
        }
        return Response.json([]);
      },
      { preconnect: originalFetch.preconnect },
    );
    let dispose!: () => void;
    const current = conversation("queued-chat");
    const controller = createRoot((cleanup) => {
      dispose = cleanup;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: {
          conversation: current,
          messages: [],
          activeTurn: {
            turnId: "running",
            attempt: 1,
            seq: 1,
            status: "running",
            blocks: [],
            modelProfileId: null,
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        },
      });
    });
    const input = {
      conversationId: current.id,
      message: "Follow up",
      storedFiles: [{ path: "/source.csv", mediaType: "text/csv", size: 12, version: 3 }],
    };
    expect(await controller.queueMessage(input)).toBe(false);
    expect(await controller.queueMessage(input)).toBe(true);
    expect(controller.error()).toBeNull();
    const submissions = requests.filter((request) => request.path.endsWith("/turns"));
    expect(submissions).toHaveLength(2);
    expect(submissions[0]!.body.queueId).toBe(submissions[1]!.body.queueId);
    const drafts = requests.filter((request) => request.path.endsWith("/draft"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.body.content).toEqual([
      { type: "text", text: "Follow up" },
      { type: "file", path: "/source.csv", mediaType: "text/csv", size: 12, version: 3 },
    ]);
    expect(controller.messages()).toHaveLength(0);
    expect(controller.activeTurn()?.turnId).toBe("running");
    dispose();
  });

  test("ignores an older refresh arriving after the latest draft", async () => {
    const pending: Array<(response: Response) => void> = [];
    globalThis.fetch = Object.assign(
      (request: RequestInfo | URL) =>
        String(request).endsWith("/conversations/refresh-chat")
          ? new Promise<Response>((resolve) => pending.push(resolve))
          : Promise.resolve(Response.json([])),
      {
        preconnect: originalFetch.preconnect,
      },
    );
    let dispose!: () => void;
    const current = conversation("refresh-chat");
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: null },
      });
    });
    const older = controller.refreshActiveConversation();
    const newer = controller.refreshActiveConversation();
    const reply = (revision: number) =>
      Response.json({
        conversation: { ...current, draft: { content: [{ type: "text", text: `Draft ${revision}` }], revision, updatedAt: null } },
        messages: [],
        activeTurn: null,
      });
    pending[1]!(reply(2));
    await newer;
    pending[0]!(reply(1));
    await older;
    expect(controller.conversation()?.draft.revision).toBe(2);
    dispose();
  });

  test("does not report an idle controller without a conversation as loading", () => {
    expect(isActiveConversationLoading(null, null)).toBe(false);
    expect(isActiveConversationLoading("chat", null)).toBe(false);
    expect(isActiveConversationLoading("chat", "chat")).toBe(true);
  });

  test("never carries messages from the previous chat into an uncached target", () => {
    const target = conversation("target");
    expect(projectionForConversationOpen(undefined, target)).toEqual({ conversation: target, messages: [], activeTurn: null });
  });

  test("reuses an exact cached projection without an empty transition", () => {
    const cached: AiChatProjection = { conversation: conversation("cached"), messages: [], activeTurn: null };
    expect(projectionForConversationOpen(cached, cached.conversation)).toBe(cached);
  });

  test("retries a user message while its turn waits for an action", async () => {
    let retryCalls = 0;
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        if (init?.headers && new Headers(init.headers).get("Accept") === "text/event-stream") {
          return new Response(new ReadableStream());
        }
        if (path.endsWith("/messages/message-ja/retry") && init?.method === "POST") {
          retryCalls += 1;
          return Response.json({
            turn: {
              id: "turn-retry",
              shortId: "tRn234",
              conversationId: "waiting",
              status: "queued",
              attempt: 0,
              modelProfileId: null,
              createdAt: "2026-07-11T00:00:00.000Z",
              completedAt: null,
              error: null,
            },
            message: {
              id: "message-retry",
              shortId: "mSg234",
              conversationId: "waiting",
              seq: 1,
              kind: "message",
              message: { role: "user", content: [{ type: "text", text: "ja" }] },
              loopId: "turn-retry",
              modelProfileId: null,
              providerModel: null,
              usage: null,
              stopReason: null,
              loopAggregate: null,
              loopDoneReason: null,
              compactedAt: null,
              meta: null,
              createdAt: "2026-07-11T00:00:00.000Z",
            },
          });
        }
        if (path.endsWith("/timeline")) return Response.json([]);
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );

    let dispose!: () => void;
    const current = conversation("waiting");
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: {
          conversation: current,
          messages: [],
          activeTurn: {
            turnId: "turn-waiting",
            attempt: 1,
            status: "waiting_for_action",
            seq: 1,
            blocks: [],
            modelProfileId: null,
            createdAt: "2026-07-11T00:00:00.000Z",
          },
        },
      });
    });

    expect(await controller.retryUserMessage("message-ja")).toBe(true);
    expect(retryCalls).toBe(1);
    dispose();
  });
});

describe("AI controller message feedback", () => {
  test("persists and clears feedback while updating the active transcript", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = String(request);
        if (init?.headers && new Headers(init.headers).get("Accept") === "text/event-stream") {
          return new Response(new ReadableStream());
        }
        requests.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (init?.method === "PUT") {
          return Response.json({
            feedback: { rating: "down", reasons: ["incorrect"], comment: "Wrong date", updatedAt: "2026-08-23T10:00:00.000Z" },
          });
        }
        return Response.json({ deleted: true });
      },
      { preconnect: originalFetch.preconnect },
    );

    const current = conversation("feedback-chat");
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: {
          conversation: current,
          activeTurn: null,
          messages: [
            {
              id: "mSg234",
              shortId: "mSg234",
              conversationId: current.id,
              seq: 1,
              kind: "message",
              message: { role: "assistant", content: [{ type: "text", text: "It happened on Tuesday." }] },
              loopId: "turn-1",
              modelProfileId: "fast",
              providerModel: "model-fast",
              usage: null,
              stopReason: "stop",
              loopAggregate: null,
              loopDoneReason: "stop",
              compactedAt: null,
              meta: null,
              feedback: null,
              createdAt: "2026-08-23T09:00:00.000Z",
            },
          ],
        },
      });
    });

    expect(await controller.setMessageFeedback("mSg234", { rating: "down", reasons: ["incorrect"], comment: "Wrong date" })).toBe(true);
    expect(controller.messages()[0]?.feedback?.rating).toBe("down");
    expect(await controller.clearMessageFeedback("mSg234")).toBe(true);
    expect(controller.messages()[0]?.feedback).toBeNull();
    expect(requests).toEqual([
      {
        method: "PUT",
        path: "/api/ai/conversations/feedback-chat/messages/mSg234/feedback",
        body: { rating: "down", reasons: ["incorrect"], comment: "Wrong date" },
      },
      { method: "DELETE", path: "/api/ai/conversations/feedback-chat/messages/mSg234/feedback", body: null },
    ]);
    dispose();
  });
});

describe("AI controller stream sessions", () => {
  test("uses an injected stream transport and closes it with the controller owner", () => {
    const calls: string[] = [];
    const transport: AiConversationStreamTransport = {
      subscribe: ({ conversationId }) => {
        calls.push(`subscribe:${conversationId}`);
        return { close: () => calls.push(`close:${conversationId}`) };
      },
    };
    const current = conversation("Chat01");
    let dispose!: () => void;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: null },
        streamTransport: transport,
      });
    });

    expect(calls).toEqual(["subscribe:Chat01"]);
    dispose();
    expect(calls).toEqual(["subscribe:Chat01", "close:Chat01"]);
  });

  test.each([
    ["en", 403, "You no longer have access to this chat."],
    ["de", 404, "Dieser Chat ist nicht mehr verfügbar."],
    ["de", 401, "Deine Sitzung ist abgelaufen. Melde dich erneut an, um diesen Chat fortzusetzen."],
  ] as const)("in %s, a %d from the default stream stops it and shows the reason in the page's language", async (locale, status, text) => {
    const streamRequests: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://cloud.test").pathname;
        if (path.endsWith("/stream")) {
          streamRequests.push(path);
          return Response.json({ message: "Conversation access changed" }, { status });
        }
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
    const current = conversation("Chat01");
    let dispose!: () => void;
    let controller!: ReturnType<typeof createAiChatController>;
    // The server renders the request's locale into `<html lang>`.
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = locale;
    createRoot((rootDispose) => {
      dispose = rootDispose;
      controller = createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: null },
      });
    });

    for (let i = 0; i < 20 && controller.error() === null; i++) await Bun.sleep(1);

    expect(controller.error()).toBe(text);
    expect(controller.streamStatus()).toBe("idle");
    await Bun.sleep(700);
    expect(streamRequests).toEqual(["/api/ai/conversations/Chat01/stream"]);
    dispose();
    dom.cleanup();
  });

  test("over the default SSE stream, a frontend tool runs once across a reconnect, and switching chats closes the old stream", async () => {
    const encoder = new TextEncoder();
    const streams: { path: string; signal: AbortSignal }[] = [];
    const actions: string[] = [];
    const waiting = {
      turnId: "turn-tool",
      attempt: 1,
      status: "waiting_for_action" as const,
      seq: 3,
      blocks: [
        {
          id: "tool-block",
          kind: "tool" as const,
          callId: "call-1",
          name: "browser_tool",
          args: { n: 1 },
          status: "awaiting_client" as const,
        },
      ],
      modelProfileId: null,
      createdAt: "2026-10-05T10:00:00.000Z",
    };
    const sse = (event: unknown, end: boolean) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(event)}\n\n`));
            if (end) controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "http://cloud.test").pathname;
        if (path.endsWith("/stream")) {
          streams.push({ path, signal: init?.signal as AbortSignal });
          const id = path.split("/").at(-2) as string;
          // The first stream of Chat01 ends, as when a server restarts; its reconnect gets the same snapshot.
          const first = streams.filter((stream) => stream.path === path).length === 1;
          return sse({ type: "state", conversation: conversation(id), messages: [], activeTurn: id === "Chat01" ? waiting : null }, first);
        }
        if (path.includes("/actions/")) {
          actions.push(path);
          return Response.json({});
        }
        if (path === "/api/ai/conversations/Chat02")
          return Response.json({ conversation: conversation("Chat02"), messages: [], activeTurn: null });
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
    const runs: unknown[] = [];
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: "Chat01",
        initialDetail: { conversation: conversation("Chat01"), messages: [], activeTurn: null },
        frontendTools: {
          browser_tool: async ({ args }) => {
            runs.push(args);
            return { ok: true };
          },
        },
      });
    });

    for (let i = 0; i < 200 && streams.length < 2; i++) await Bun.sleep(10);
    await Bun.sleep(20);
    expect(streams.map((stream) => stream.path)).toEqual(["/api/ai/conversations/Chat01/stream", "/api/ai/conversations/Chat01/stream"]);
    expect(runs).toEqual([{ n: 1 }]);
    expect(actions).toEqual(["/api/ai/conversations/Chat01/turns/turn-tool/actions/call-1"]);

    expect(await controller.openConversation("Chat02")).toBe("opened");
    expect(streams[1]?.signal.aborted).toBe(true);
    expect(streams.at(-1)?.path).toBe("/api/ai/conversations/Chat02/stream");
    expect(streams.at(-1)?.signal.aborted).toBe(false);
    dispose();
    expect(streams.at(-1)?.signal.aborted).toBe(true);
  });

  test("refreshing a chat that is gone ends it with the reason instead of failing", async () => {
    const calls: string[] = [];
    const transport: AiConversationStreamTransport = {
      subscribe: ({ conversationId }) => {
        calls.push(`subscribe:${conversationId}`);
        return { close: () => calls.push(`close:${conversationId}`) };
      },
    };
    let status = 200;
    globalThis.fetch = Object.assign(
      async () =>
        status === 200
          ? Response.json({ conversation: conversation("Chat01"), messages: [], activeTurn: null })
          : Response.json({ message: "Not found" }, { status }),
      { preconnect: originalFetch.preconnect },
    );
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: "Chat01",
        initialDetail: { conversation: conversation("Chat01"), messages: [], activeTurn: null },
        streamTransport: transport,
      });
    });

    expect(await controller.refreshActiveConversation()).toBe(true);
    expect(controller.error()).toBeNull();
    status = 404;
    expect(await controller.refreshActiveConversation()).toBe(false);
    expect(controller.error()).toBe("This chat is no longer available.");
    expect(controller.streamStatus()).toBe("idle");
    expect(calls).toEqual(["subscribe:Chat01", "close:Chat01"]);

    // Any other failure may heal: it rejects, and the caller retries.
    status = 503;
    await expect(controller.refreshActiveConversation()).rejects.toThrow("Not found");
    dispose();
    dom.cleanup();
  });

  test.each([
    ["a newer refresh", (controller: ReturnType<typeof createAiChatController>) => controller.refreshActiveConversation()],
    [
      "leaving and reopening the chat",
      async (controller: ReturnType<typeof createAiChatController>) => {
        await controller.openConversation("Chat02");
        await controller.openConversation("Chat01");
      },
    ],
  ])("a refresh that fails late after %s does not end the chat", async (_case, overtake) => {
    const calls: string[] = [];
    const transport: AiConversationStreamTransport = {
      subscribe: ({ conversationId }) => {
        calls.push(`subscribe:${conversationId}`);
        return { close: () => calls.push(`close:${conversationId}`) };
      },
    };
    // The first load of Chat01 waits; every later load finds the chat.
    let failLate!: () => void;
    let chat01Loads = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const id = /^\/api\/ai\/conversations\/(Chat0\d)$/.exec(new URL(String(input), "http://cloud.test").pathname)?.[1];
        if (!id) return Response.json({});
        if (id === "Chat01" && ++chat01Loads === 1)
          return new Promise<Response>((resolve) => {
            failLate = () => resolve(Response.json({ message: "Not found" }, { status: 404 }));
          });
        return Response.json({ conversation: conversation(id), messages: [], activeTurn: null });
      },
      { preconnect: originalFetch.preconnect },
    );
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: "Chat01",
        initialDetail: { conversation: conversation("Chat01"), messages: [], activeTurn: null },
        streamTransport: transport,
      });
    });

    const late = controller.refreshActiveConversation();
    await overtake(controller);
    failLate();

    expect(await late).toBe(true);
    expect(controller.error()).toBeNull();
    expect(calls.at(-1)).toBe("subscribe:Chat01");
    dispose();
  });

  test("opening a chat that is gone shows the reason in the page's language", async () => {
    globalThis.fetch = Object.assign(async () => Response.json({ message: "Conversation not found" }, { status: 404 }), {
      preconnect: originalFetch.preconnect,
    });
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "de";
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: "Chat01",
        initialDetail: { conversation: conversation("Chat01"), messages: [], activeTurn: null },
        streamTransport: { subscribe: () => ({ close() {} }) },
      });
    });

    expect(await controller.openConversation("Chat02")).toBe("failed");
    expect(controller.error()).toBe("Dieser Chat ist nicht mehr verfügbar.");
    dispose();
    dom.cleanup();
  });

  test("subscribes again after a stream ended with an error once the person returns to the chat", async () => {
    type Subscription = Parameters<AiConversationStreamTransport["subscribe"]>[0];
    const subscriptions: Subscription[] = [];
    const transport: AiConversationStreamTransport = {
      subscribe: (input) => {
        subscriptions.push(input);
        return { close: () => undefined };
      },
    };
    const current = conversation("Chat01");
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) =>
        new URL(String(input), "http://cloud.test").pathname === "/api/ai/conversations/Chat01"
          ? Response.json({ conversation: current, messages: [], activeTurn: null })
          : Response.json({}),
      { preconnect: originalFetch.preconnect },
    );
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: null },
        streamTransport: transport,
      });
    });
    const endStream = (index: number) => {
      subscriptions[index]!.onStatus?.("open");
      subscriptions[index]!.onError?.(new Error("Authentication required"));
      expect(controller.error()).toBe("Authentication required");
      expect(controller.streamStatus()).toBe("idle");
    };

    endStream(0);
    expect(await controller.openConversation("Chat01")).toBe("current");
    expect(subscriptions).toHaveLength(2);
    // Opening the same chat again keeps the live stream.
    await controller.openConversation("Chat01");
    expect(subscriptions).toHaveLength(2);
    // The new stream connecting resolves the error its predecessor left; the old one stays ignored.
    subscriptions[1]!.onStatus?.("open");
    expect(controller.error()).toBeNull();
    expect(controller.streamStatus()).toBe("open");
    subscriptions[0]!.onError?.(new Error("stale"));
    expect(controller.error()).toBeNull();

    endStream(1);
    await controller.refreshActiveConversation();
    expect(subscriptions).toHaveLength(3);

    endStream(2);
    expect(await controller.compactConversation()).toBe(true);
    expect(subscriptions.map((subscription) => subscription.conversationId)).toEqual(["Chat01", "Chat01", "Chat01", "Chat01"]);
    dispose();
  });

  test("rejects an earlier session after leaving and reopening the same conversation", () => {
    const firstA = { conversationId: "a", generation: 1 };
    const b = { conversationId: "b", generation: 2 };
    const secondA = { conversationId: "a", generation: 3 };

    expect(isCurrentStreamSession(firstA, firstA)).toBe(true);
    expect(isCurrentStreamSession(b, firstA)).toBe(false);
    expect(isCurrentStreamSession(secondA, firstA)).toBe(false);
    expect(isCurrentStreamSession(secondA, secondA)).toBe(true);
  });
});

describe("AI controller turn failures", () => {
  test("restores the durable latest-turn error from a state snapshot", () => {
    const failed = { ...conversation("failed"), runStatus: "failed" as const, runError: "Provider unavailable" };
    const event: AiStreamSseEvent = { type: "state", conversation: failed, messages: [], activeTurn: null };

    expect(conversationRunError(failed)).toBe("Provider unavailable");
    expect(runErrorFromEvent(event, null)).toBe("Provider unavailable");
  });

  test("uses the current finished turn and ignores stale turn events", () => {
    const failed: AiStreamSseEvent = {
      v: 1,
      type: "turn_finished",
      conversationId: "chat",
      turnId: "turn-1",
      attempt: 1,
      seq: 2,
      status: "failed",
      error: "Unauthorized",
    };

    expect(runErrorFromEvent(failed, "turn-1")).toBe("Unauthorized");
    expect(runErrorFromEvent(failed, "older-turn")).toBeUndefined();
    expect(runErrorFromEvent({ ...failed, status: "completed", error: null }, "turn-1")).toBeNull();
  });

  test("a failure the newest turn shows in its notice stays out of the composer", () => {
    const message = (seq: number, loopId: string | null, meta: AiStoredMessage["meta"] = null): AiStoredMessage => ({
      id: `m${seq}`,
      shortId: `m${seq}`,
      conversationId: "chat",
      seq,
      kind: "message",
      message: { role: "user", content: [{ type: "text", text: "Hi" }] },
      loopId,
      modelProfileId: null,
      providerModel: null,
      usage: null,
      stopReason: null,
      loopAggregate: null,
      loopDoneReason: null,
      compactedAt: null,
      meta,
      createdAt: "2026-10-07T10:00:00.000Z",
    });
    const failed = message(1, "turn-1", { turnError: { code: "model_unavailable" } });
    expect(newestTurnShowsError([failed])).toBe(true);
    // An older notice does not cover a newer failure, such as a turn from an earlier release without a reason.
    expect(newestTurnShowsError([failed, message(2, "turn-2")])).toBe(false);
    expect(newestTurnShowsError([])).toBe(false);
  });

  test("falls back to stable user-facing copy when no error was persisted", () => {
    const failed = { ...conversation("failed"), runStatus: "failed" as const, runError: null };
    expect(conversationRunError(failed)).toBe("Assistant response failed.");
  });
});

describe("AI controller frontend tool deduplication", () => {
  test("does not start the same call twice while it is in flight", () => {
    const handled = new Set<string>();
    const inFlight = new Set<string>();

    expect(claimFrontendCall(handled, inFlight, "turn:call")).toBe(true);
    expect(claimFrontendCall(handled, inFlight, "turn:call")).toBe(false);
  });

  test("keeps submitted calls handled and releases failed submissions for retry", () => {
    const handled = new Set<string>();
    const inFlight = new Set<string>();

    claimFrontendCall(handled, inFlight, "turn:success");
    settleFrontendCall(handled, inFlight, "turn:success", true);
    expect(claimFrontendCall(handled, inFlight, "turn:success")).toBe(false);

    claimFrontendCall(handled, inFlight, "turn:retry");
    settleFrontendCall(handled, inFlight, "turn:retry", false);
    expect(claimFrontendCall(handled, inFlight, "turn:retry")).toBe(true);
  });

  test("keeps an accepted survey answer visible while the assistant continues", () => {
    const result = { submitted: true, answers: { timing: "tomorrow" } };
    expect(
      __aiControllerTest.completeFrontendToolBlock(
        [
          {
            id: "survey-call",
            kind: "tool",
            callId: "call-1",
            name: "survey",
            args: { title: "When?" },
            status: "awaiting_client",
            frontendMode: "client_interaction",
          },
        ],
        "call-1",
        result,
      ),
    ).toEqual([
      {
        id: "survey-call",
        kind: "tool",
        callId: "call-1",
        name: "survey",
        args: { title: "When?" },
        status: "completed",
        frontendMode: "client_interaction",
        result,
      },
    ]);
  });
});

describe("AI controller steering reconciliation", () => {
  test("replaces an optimistic block with the durable steer id", () => {
    const blocks: AiTurnBlock[] = [
      { id: "text", kind: "text", text: "working" },
      { id: "local", kind: "steer_message", steerId: "request-1", text: "change", status: "pending" },
    ];
    expect(
      reconcileSteerBlocks(blocks, "local", {
        id: "steer-1",
        conversationId: "conversation-1",
        turnId: "turn-1",
        seq: 1,
        clientRequestId: "request-1",
        text: "change",
        status: "pending",
        messageId: null,
        createdAt: "2026-07-11T00:00:00.000Z",
        consumedAt: null,
      }),
    ).toEqual([
      { id: "text", kind: "text", text: "working" },
      { id: "steer-message-steer-1", kind: "steer_message", steerId: "steer-1", text: "change", status: "pending" },
    ]);
  });

  test("keeps the bubble and exposes a retry state when the request fails", () => {
    const blocks: AiTurnBlock[] = [{ id: "local", kind: "steer_message", steerId: "request-1", text: "change", status: "pending" }];
    expect(failSteerBlock(blocks, "local")).toEqual([
      { id: "local", kind: "steer_message", steerId: "request-1", text: "change", status: "failed" },
    ]);
  });
});

for (const recovery of ["snapshot", "refresh"] as const)
  test.skipIf(isServer)(`unlocks the composer after abort completes through ${recovery}`, async () => {
    const current = conversation("Chat01");
    const runningTurn: AiTurnSnapshot = {
      turnId: "running",
      attempt: 1,
      seq: 1,
      status: "waiting_for_action",
      blocks: [],
      modelProfileId: null,
      createdAt: "2026-09-20T00:00:00Z",
    };
    let emit!: Parameters<AiConversationStreamTransport["subscribe"]>[0]["onEvent"];
    globalThis.fetch = Object.assign(async () => Response.json({ conversation: current, messages: [], activeTurn: null }), {
      preconnect: originalFetch.preconnect,
    });
    let dispose!: () => void;
    const controller = createRoot((cleanup) => {
      dispose = cleanup;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: runningTurn },
        streamTransport: {
          subscribe: (input) => {
            emit = input.onEvent;
            return { close() {} };
          },
        },
      });
    });
    try {
      expect(await controller.abort()).toBe(true);
      expect(controller.runStatus()).toBe("stopping");
      emit({ type: "state", conversation: current, messages: [], activeTurn: runningTurn });
      expect(controller.runStatus()).toBe("stopping");
      if (recovery === "snapshot") emit({ type: "state", conversation: current, messages: [], activeTurn: null });
      else await controller.refreshActiveConversation();
      expect(controller.activeTurn()).toBeNull();
      expect(controller.runStatus()).toBe("idle");
      expect(controller.running()).toBe(false);
    } finally {
      dispose();
    }
  });

describe("AI controller silence", () => {
  const turn = (status: AiTurnSnapshot["status"], blocks: AiTurnBlock[] = []): AiTurnSnapshot => ({
    turnId: "turn",
    attempt: 1,
    seq: 3,
    status,
    blocks,
    modelProfileId: null,
    createdAt: "2026-10-07T00:00:00Z",
  });
  const delta = (seq: number): AiStreamSseEvent => ({
    v: 1,
    type: "block_delta",
    conversationId: "Chat01",
    turnId: "turn",
    attempt: 1,
    seq,
    blockId: "t",
    blockKind: "text",
    delta: "Hi",
  });
  const state = (activeTurn: AiTurnSnapshot): AiStreamSseEvent => ({
    type: "state",
    conversation: conversation("Chat01"),
    messages: [],
    activeTurn,
  });

  const follow = (activeTurn: AiTurnSnapshot, options: Pick<Parameters<typeof createAiChatController>[0], "frontendTools"> = {}) => {
    const current = conversation("Chat01");
    const calls: string[] = [];
    let input!: Parameters<AiConversationStreamTransport["subscribe"]>[0];
    let dispose!: () => void;
    const controller = createRoot((rootDispose) => {
      dispose = rootDispose;
      return createAiChatController({
        baseUrl: "/api/ai",
        initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn },
        ...options,
        streamTransport: {
          subscribe: (subscription) => {
            calls.push("subscribe");
            input = subscription;
            return { close: () => calls.push("close") };
          },
        },
      });
    });
    return {
      calls,
      controller,
      emit: (event: AiStreamSseEvent) => input.onEvent(event),
      status: (status: "connecting" | "open" | "reconnecting") => input.onStatus?.(status),
      dispose,
    };
  };

  (isServer ? test.skip : test)("a running turn that sends nothing for a worker lease starts the stream again from its saved state", () => {
    jest.useFakeTimers();
    const stream = follow(turn("running"));
    try {
      stream.status("open");
      stream.emit(state(turn("running")));
      // Each event restarts the wait.
      jest.advanceTimersByTime(AI_TURN_LEASE_MS - 1);
      stream.emit(delta(4));
      jest.advanceTimersByTime(AI_TURN_LEASE_MS - 1);
      expect(stream.calls).toEqual(["subscribe"]);
      jest.advanceTimersByTime(1);
      expect(stream.calls).toEqual(["subscribe", "close", "subscribe"]);
    } finally {
      stream.dispose();
      jest.useRealTimers();
    }
  });

  (isServer ? test.skip : test)("a stream that reconnects keeps saying so, and a slow first state is not cut off", () => {
    jest.useFakeTimers();
    const stream = follow(turn("running"));
    try {
      // The first state takes longer than a lease to arrive.
      stream.status("connecting");
      jest.advanceTimersByTime(AI_TURN_LEASE_MS * 2);
      expect(stream.calls).toEqual(["subscribe"]);
      stream.status("open");
      stream.emit(state(turn("running")));

      // The connection drops: the transport reconnects and brings a fresh state once it is back.
      stream.status("reconnecting");
      jest.advanceTimersByTime(AI_TURN_LEASE_MS * 3);
      expect(stream.calls).toEqual(["subscribe"]);
      expect(stream.controller.streamStatus()).toBe("reconnecting");
      stream.status("open");
      stream.emit(state(turn("running")));
      jest.advanceTimersByTime(AI_TURN_LEASE_MS);
      expect(stream.calls).toEqual(["subscribe", "close", "subscribe"]);
    } finally {
      stream.dispose();
      jest.useRealTimers();
    }
  });

  (isServer ? test.skip : test)("a turn that waits for the person is not silent, and a turn that runs again is watched again", () => {
    const approval: AiTurnBlock = {
      id: "tool-send",
      kind: "tool",
      callId: "send",
      name: "mail_send",
      args: {},
      status: "awaiting_approval",
      approval: { allowAlways: false },
    };
    jest.useFakeTimers();
    const stream = follow(turn("waiting_for_action", [approval]));
    try {
      stream.status("open");
      stream.emit(state(turn("waiting_for_action", [approval])));
      jest.advanceTimersByTime(AI_TURN_LEASE_MS * 3);
      expect(stream.calls).toEqual(["subscribe"]);
      stream.emit(state({ ...turn("running"), attempt: 2, seq: 1 }));
      jest.advanceTimersByTime(AI_TURN_LEASE_MS);
      expect(stream.calls).toEqual(["subscribe", "close", "subscribe"]);
    } finally {
      stream.dispose();
      jest.useRealTimers();
    }
  });

  (isServer ? test.skip : test)("a browser tool the controller ran is watched again once the server accepts its result", async () => {
    const actions: string[] = [];
    globalThis.fetch = Object.assign(
      async (request: RequestInfo | URL) => {
        actions.push(new URL(String(request), "http://cloud.test").pathname);
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
    const tool: AiTurnBlock = {
      id: "tool-run",
      kind: "tool",
      callId: "run",
      name: "code_run",
      args: { title: "Report" },
      status: "awaiting_client",
      frontendMode: "client",
    };
    jest.useFakeTimers();
    const stream = follow(turn("waiting_for_action", [tool]), { frontendTools: { code_run: async () => ({ ok: true }) } });
    try {
      stream.status("open");
      stream.emit(state(turn("waiting_for_action", [tool])));
      for (
        let i = 0;
        i < 20 && !stream.controller.activeTurn()?.blocks.some((block) => block.kind === "tool" && block.status === "completed");
        i++
      )
        await Promise.resolve();
      expect(actions).toEqual(["/api/ai/conversations/Chat01/turns/turn/actions/run"]);
      expect(JSON.parse(JSON.stringify(stream.controller.activeTurn()))).toMatchObject({
        status: "running",
        blocks: [{ status: "completed", result: { ok: true } }],
      });

      // The turn's next events never arrive.
      jest.advanceTimersByTime(AI_TURN_LEASE_MS);
      expect(stream.calls).toEqual(["subscribe", "close", "subscribe"]);
    } finally {
      stream.dispose();
      jest.useRealTimers();
    }
  });
});
