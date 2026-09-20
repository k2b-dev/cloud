import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import type { AiStreamSseEvent, AiTurnBlock, AiTurnSnapshot } from "../protocol";
import type { AiConversation } from "../types";
import { __aiControllerTest, createAiChatController } from "./controller";
import type { AiChatProjection } from "./projection";
import type { AiConversationStreamTransport } from "./transport";

const {
  claimFrontendCall,
  conversationRunError,
  failSteerBlock,
  isActiveConversationLoading,
  isCurrentStreamSession,
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

  for (const finishBeforeAck of [false, true]) test.skipIf(isServer)(`keeps a first send visible through upload and confirmation (early finish: ${finishBeforeAck})`, async () => {
    const current = conversation("new-chat");
    let emit!: Parameters<AiConversationStreamTransport["subscribe"]>[0]["onEvent"];
    let finishUpload!: (response: Response) => void;
    let finishTurn!: (response: Response) => void;
    const upload = new Promise<Response>(resolve => { finishUpload = resolve; });
    const turn = new Promise<Response>(resolve => { finishTurn = resolve; });
    globalThis.fetch = Object.assign(async (request: RequestInfo | URL, init?: RequestInit) => {
      const path = String(request);
      if (path.endsWith("/files") && init?.method === "POST") return upload;
      if (path.endsWith("/draft") && init?.method === "PUT") return Response.json({ content: [], revision: 1, updatedAt: null });
      if (path.endsWith("/turns") && init?.method === "POST") return turn;
      if (path.endsWith("/timeline")) return Response.json([]);
      return Response.json({});
    }, { preconnect: originalFetch.preconnect });
    let dispose!: () => void;
    const controller = createRoot(cleanup => {
      dispose = cleanup;
      return createAiChatController({ baseUrl: "/api/ai", initialConversationId: current.id,
        initialDetail: { conversation: current, messages: [], activeTurn: null },
        streamTransport: { subscribe: input => { emit = input.onEvent; return { close() {} }; } },
      });
    });
    const sending = controller.send({ message: "Analyze", files: [new File(["a,b"], "demo.csv", { type: "text/csv" })] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.messages()).toHaveLength(1);
    emit({ type: "state", conversation: current, messages: [], activeTurn: null });
    expect(controller.messages()).toHaveLength(1);
    finishUpload(Response.json({ file: { path: "/demo.csv", size: 3, mediaType: "text/csv", version: 1 } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = controller.messages()[0]!;
    const saved = { ...pending, id: "saved", shortId: "saved", loopId: "turn-1", meta: { submittedDraftRevision: 1 } };
    emit({ type: "state", conversation: current, messages: [saved], activeTurn: null });
    expect(controller.messages()).toHaveLength(1);
    if (finishBeforeAck) emit({v:1,type:"turn_finished",conversationId:current.id,turnId:"turn-1",attempt:1,seq:1,status:"completed",error:null});
    finishTurn(Response.json({ message: saved, turn: { id: "turn-1", modelProfileId: null } }));
    expect(await sending).toBe(true);
    expect(controller.activeTurn()?.status ?? null).toBe(finishBeforeAck ? null : "running");
    emit({ type: "state", conversation: current, messages: finishBeforeAck ? [saved] : [], activeTurn: null });
    expect(controller.messages().map(message => message.id)).toEqual(["saved"]);
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
  done: null, isDone: false, lastUsedAt: "2026-09-14T00:00:00.000Z", archivedAt: null,
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
    const requests:Array<{path:string;body:Record<string,unknown>}>=[];
    let fail=true;
    globalThis.fetch = Object.assign(async (request:RequestInfo | URL, init?:RequestInit) => {
      const path=String(request);
      const body=typeof init?.body === "string" ? JSON.parse(init.body) : {};
      requests.push({path,body});
      if (path.endsWith("/draft")) return Response.json({content:body.content,revision:1,updatedAt:null});
      if (path.endsWith("/turns")) {
        if (fail) { fail=false; throw new Error("lost response"); }
        return Response.json({queued:true});
      }
      return Response.json([]);
    }, {preconnect:originalFetch.preconnect});
    let dispose!:()=>void;
    const current=conversation("queued-chat");
    const controller=createRoot(cleanup=>{dispose=cleanup;return createAiChatController({
      baseUrl:"/api/ai",initialConversationId:current.id,
      initialDetail:{conversation:current,messages:[],activeTurn:{turnId:"running",attempt:1,seq:1,status:"running",blocks:[],modelProfileId:null,createdAt:"2026-09-14T00:00:00.000Z"}},
    });});
    const input={conversationId:current.id,message:"Follow up",storedFiles:[{path:"/source.csv",mediaType:"text/csv",size:12,version:3}]};
    expect(await controller.queueMessage(input)).toBe(false);
    expect(await controller.queueMessage(input)).toBe(true);
    expect(controller.error()).toBeNull();
    const submissions=requests.filter(request=>request.path.endsWith("/turns"));
    expect(submissions).toHaveLength(2);
    expect(submissions[0]!.body.queueId).toBe(submissions[1]!.body.queueId);
    const drafts=requests.filter(request=>request.path.endsWith("/draft"));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.body.content).toEqual([{type:"text",text:"Follow up"},{type:"file",path:"/source.csv",mediaType:"text/csv",size:12,version:3}]);
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

for (const recovery of ["snapshot", "refresh"] as const) test.skipIf(isServer)(`unlocks the composer after abort completes through ${recovery}`, async () => {
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
  globalThis.fetch = Object.assign(async () => Response.json({ conversation: current, messages: [], activeTurn: null }), { preconnect: originalFetch.preconnect });
  let dispose!: () => void;
  const controller = createRoot(cleanup => {
    dispose = cleanup;
    return createAiChatController({
      baseUrl: "/api/ai", initialConversationId: current.id,
      initialDetail: { conversation: current, messages: [], activeTurn: runningTurn },
      streamTransport: { subscribe: input => { emit = input.onEvent; return { close() {} }; } },
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
  } finally { dispose(); }
});
