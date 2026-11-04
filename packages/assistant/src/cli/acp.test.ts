import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientContext,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AiConversation, AiPendingTurnAction, AiPeopleModels, AiStoredMessage, AiStreamSseEvent, AiTurnBlock } from "@k2b/cloud/ai";
import type { CloudCliContext } from "@k2b/cloud/cli";
import module from "../cli";
import { createAcpAgent, runAcpConnection } from "./acp";
import { createAcpSessionStore } from "./acp-sessions";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});
const initialConversation = (): AiConversation => ({
  id: "chat",
  shortId: "chat",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-10-11T00:00:00Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user",
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
});
const profile: AiPeopleModels["options"][number] = {
  id: "model",
  label: "Model",
  description: "For everyday work",
  icon: { kind: "mark", text: "AI", color: "0" },
  classes: ["balanced"],
};

const approval = (confirm = false): AiPendingTurnAction => ({
  type: "approval_request",
  conversationId: "chat",
  turnId: "turn",
  callId: "call",
  name: "mail.send",
  args: { text: "Hello" },
  message: "Send mail?",
  allowChat: !confirm,
  allowAlways: !confirm,
});
const tool = (
  name: string,
  status: Extract<AiTurnBlock, { kind: "tool" }>["status"],
  args?: unknown,
): Extract<AiTurnBlock, { kind: "tool" }> => ({ id: "block", kind: "tool", callId: "call", name, status, args });
const harness = async (
  options: {
    forms?: boolean;
    streams?: AiStreamSseEvent[][];
    action?: AiPendingTurnAction;
    actions?: AiPendingTurnAction[];
    conversations?: AiConversation[];
    post403?: boolean;
    permission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
    form?: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse> | CreateElicitationResponse;
    hold?: boolean;
    activeTurn?: boolean;
    manualSkill?: boolean;
    /** Answers a request before the fake Cloud does; undefined falls through. */
    intercept?: (path: string, method: string, init?: RequestInit) => Promise<Response | undefined> | Response | undefined;
  } = {},
) => {
  const cwd = await mkdtemp(join(tmpdir(), "cld-acp-test-"));
  resources.push(() => rm(cwd, { recursive: true, force: true }));
  let conversation = initialConversation();
  let sequence = 0;
  const wire = () => ({ v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1, seq: ++sequence });
  const block = (value: AiTurnBlock): AiStreamSseEvent => ({ ...wire(), type: "block_set", block: value });
  const done = (): Extract<AiStreamSseEvent, { type: "turn_finished" }> => ({
    ...wire(),
    type: "turn_finished",
    status: "completed",
    error: null,
    messages: [],
  });
  const delta = (text: string, thinking = false): AiStreamSseEvent => ({
    ...wire(),
    type: "block_delta",
    blockId: thinking ? "thought" : "text",
    blockKind: thinking ? "thinking" : "text",
    delta: text,
  });
  const streams = options.streams ?? [];
  const requests: Array<{ path: string; method: string; body: unknown; headers: Headers }> = [];
  const defaults = new Map<string, string>();
  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const forms: CreateElicitationRequest[] = [];
  const uploads: File[] = [];
  let active = options.activeTurn ?? false;
  let created = false;
  let submission: () => void = () => {};
  const submitted = new Promise<void>((resolve) => {
    submission = resolve;
  });
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { profile: "test", server: "https://cloud.test", token: "test", output: "json" },
    getDefault: async (key) => defaults.get(key),
    setDefault: async (key, value) => {
      if (value === undefined) defaults.delete(key);
      else defaults.set(key, value);
    },
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ path, method, body, headers: new Headers(init?.headers) });
      const intercepted = await options.intercept?.(path, method, init);
      if (intercepted) return intercepted;
      if (path.endsWith("/models"))
        return Response.json({
          status: "ok",
          selection: null,
          effectiveDefault: { class: "balanced" },
          classes: [{ class: "balanced", variantId: profile.id }],
          options: [profile],
        } satisfies AiPeopleModels);
      if (path.endsWith("/skills"))
        return Response.json({
          skills: options.manualSkill
            ? [{ id: "Sk2345", shortId: "Sk2345", name: "remote", description: "Cloud selected workflow", enabled: true, manualOnly: true }]
            : [],
        });
      if (path.endsWith("/projects")) return Response.json({ projects: [{ shortId: "project", name: "Project", description: "Work" }] });
      if (path.includes("/approval-preferences/")) return Response.json({});
      if (path.includes("/approval-preferences?"))
        return Response.json({ approvals: [{ id: "remembered", title: "Read notes", conversationId: "chat", app: { name: "Notes" } }] });
      if (path.endsWith("/approval-preferences"))
        return Response.json({ approvals: [{ id: "everywhere", title: "Create tasks", conversationId: null, app: { name: "Spaces" } }] });
      if (path.endsWith("/quotas")) return Response.json({ enabled: false });
      if (path.includes("/conversations/page?")) {
        const query = new URL(path, "https://cloud.test").searchParams;
        const page = Number(query.get("page"));
        const perPage = Number(query.get("perPage"));
        const status = query.get("status");
        const conversations = (options.conversations ?? (created ? [conversation] : [])).filter(
          (chat) =>
            !status ||
            (status === "running" && ["queued", "running", "waiting_for_browser"].includes(chat.runStatus)) ||
            (status === "needs_attention" && chat.runStatus === "needs_attention") ||
            (status === "unread" && chat.unreadCompletion),
        );
        return Response.json({
          items: conversations.slice((page - 1) * perPage, page * perPage),
          total: conversations.length,
          page,
          perPage,
          hasNext: page * perPage < conversations.length,
        });
      }
      if (path.includes("/conversations?")) return Response.json(created ? [conversation] : []);
      if (path.endsWith("/conversations") && method === "POST") {
        created = true;
        const projectId =
          body && typeof body === "object" && "projectId" in body && typeof body.projectId === "string" ? body.projectId : null;
        conversation = { ...conversation, projectId };
        return Response.json(conversation);
      }
      if (path.endsWith("/draft")) {
        if (!body || typeof body !== "object" || !("content" in body) || !Array.isArray(body.content))
          throw new Error("Missing draft content");
        conversation.draft = { ...conversation.draft, content: body.content, revision: conversation.draft.revision + 1 };
        return Response.json(conversation.draft);
      }
      if (path.endsWith("/turns") && method === "POST") {
        conversation.draft = { ...conversation.draft, content: [] };
        submission();
        return Response.json({ turn: { id: "turn", status: "running", modelId: null } });
      }
      if (path.endsWith("/stream")) {
        const events = streams.shift();
        if (events) return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
        if (options.hold)
          return new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Cancelled", "AbortError")), {
                  once: true,
                });
              },
            }),
          );
        return new Response(
          [delta("Hello "), delta("thinking", true), delta("world"), done()].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        );
      }
      if (path.includes("/pending-actions/")) return Response.json(options.actions ?? (options.action ? [options.action] : []));
      if (path.includes("/actions/"))
        return options.post403 ? Response.json({ error: "Approve this request in Cloud." }, { status: 403 }) : Response.json({});
      if (path.endsWith("/abort") || path.endsWith("/viewed")) return Response.json({});
      if (path.endsWith("/files") && init?.body instanceof FormData) {
        const file = init.body.get("file");
        if (!(file instanceof File)) throw new Error("Missing upload");
        uploads.push(file);
        return Response.json({ file: { path: `/${file.name}`, mediaType: file.type, size: file.size, version: 1 } });
      }
      if (path.endsWith("/project")) return Response.json(conversation);
      if (path.endsWith("/conversations/chat")) {
        const result = { conversation, activeTurn: active ? { turnId: "turn", status: "running" } : null };
        active = false;
        return Response.json(result);
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    readJson: async <T>(response: Pick<Response, "json" | "text" | "ok" | "status" | "statusText">): Promise<T> => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    print: () => {
      throw new Error("Host stdout used");
    },
    write: async () => {
      throw new Error("Host stdout used");
    },
    json: () => {
      throw new Error("Host stdout used");
    },
    jsonLine: () => {
      throw new Error("Host stdout used");
    },
    table: () => {
      throw new Error("Host stdout used");
    },
    error: () => {
      throw new Error("Host diagnostic used");
    },
  };
  const app = client()
    .onNotification("session/update", ({ params }) => {
      updates.push(params);
    })
    .onRequest("session/request_permission", ({ params }) => {
      permissions.push(params);
      return options.permission?.(params) ?? { outcome: { outcome: "selected", optionId: "once" } };
    })
    .onRequest("elicitation/create", ({ params }) => {
      forms.push(params);
      return options.form?.(params) ?? { action: "accept", content: { decision: "yes" } };
    });
  const state = await mkdtemp(join(tmpdir(), "cld-acp-state-"));
  resources.push(() => rm(state, { recursive: true, force: true }));
  const store = createAcpSessionStore(ctx.options, state);
  const bridge = createAcpAgent(ctx, { sessions: store });
  const connection = app.connect(bridge.app);
  resources.push(async () => {
    connection.close();
    await connection.closed;
    await bridge.close();
  });
  const acp: ClientContext = connection.agent;
  const initialize = await acp.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "Test Editor", version: "1" },
    clientCapabilities: options.forms ? { elicitation: { form: {} } } : {},
  });
  const initializeRequests = requests.length;
  const session = await acp.request("session/new", { cwd, mcpServers: [] });
  const send = (text: string, attachments: ContentBlock[] = []) =>
    acp.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text }, ...attachments] });
  const text = () =>
    updates
      .flatMap(({ update }) =>
        update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : [],
      )
      .join("");
  return {
    acp,
    ctx,
    session,
    initialize,
    initializeRequests,
    cwd,
    requests,
    updates,
    permissions,
    forms,
    uploads,
    defaults,
    send,
    text,
    block,
    delta,
    done,
    streams,
    submitted,
    connection,
    bridge,
    store,
  };
};

describe("Assistant ACP", () => {
  test("initialize, lazy chat creation, model picker and ACP local fields", async () => {
    const h = await harness();
    expect(h.initializeRequests).toBe(0);
    expect(h.initialize).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "cld", title: "Cloud Assistant" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [],
    });
    expect(h.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(h.session.configOptions).toMatchObject([
      {
        id: "model",
        currentValue: "default",
        options: [
          { value: "default", name: "Cloud default" },
          { value: "model", name: "Model", description: "For everyday work" },
        ],
      },
    ]);
    await h.acp.request("session/set_config_option", { sessionId: h.session.sessionId, configId: "model", value: "model" });
    expect(await h.send("Hello")).toEqual({ stopReason: "end_turn" });
    const turn = h.requests.find((r) => r.path.endsWith("/turns"));
    expect(turn?.body).toMatchObject({
      model: { id: "model" },
      client: { kind: "acp", name: "Test Editor", cwd: h.cwd, shell: "/bin/bash", localTools: "ask" },
    });
    expect(turn?.body).not.toMatchObject({ clientToolIds: expect.arrayContaining(["code_open"]) });
    expect(turn?.body).not.toMatchObject({ clientToolIds: expect.arrayContaining(["code_secret"]) });
    expect(h.text()).toContain("Hello world");
    expect(h.updates).toContainEqual({
      sessionId: h.session.sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    });
    // A new chat's title follows the response.
    while (!h.updates.some((u) => u.update.sessionUpdate === "session_info_update")) await Bun.sleep(5);
    expect(await h.store.chat(h.session.sessionId)).toBe("chat");
    expect(await h.store.sessions()).toEqual(new Map([["chat", h.session.sessionId]]));
    expect([...h.defaults.keys()].filter((key) => key.startsWith("assistant.acp"))).toEqual([]);
  });
  test("standard approvals offer chat memory and carry the ACP header", async () => {
    const h = await harness({ action: approval(), permission: () => ({ outcome: { outcome: "selected", optionId: "chat" } }) });
    h.streams.push([h.block(tool("mail.send", "awaiting_approval"))], [h.block(tool("mail.send", "completed")), h.done()]);
    expect(await h.send("Send")).toEqual({ stopReason: "end_turn" });
    expect(h.permissions[0]?.options.map((o) => o.optionId)).toEqual(["once", "chat", "reject"]);
    const posted = h.requests.find((r) => r.path.includes("/actions/"));
    expect(posted?.body).toEqual({ type: "approval_response", approved: true, remember: "chat" });
    expect(posted?.headers.get("x-cloud-client")).toBe("acp");
  });
  test("a waiting confirm approval does not hide a later approval", async () => {
    const h = await harness({
      actions: [
        { ...approval(true), callId: "a" },
        { ...approval(), callId: "b" },
      ],
      permission: (request) => ({
        outcome: { outcome: "selected", optionId: request.toolCall.toolCallId === "tool-a" ? "cloud" : "once" },
      }),
    });
    const a = { ...tool("mail.send", "awaiting_approval"), id: "tool-a", callId: "a" };
    const b = { ...tool("mail.send", "awaiting_approval"), id: "tool-b", callId: "b" };
    h.streams.push(
      [h.block(a)],
      [h.block(a), h.block(b)],
      [h.block({ ...a, status: "completed" }), h.block({ ...b, status: "completed" }), h.done()],
    );
    expect(await h.send("Send")).toEqual({ stopReason: "end_turn" });
    expect(h.permissions.map((p) => p.toolCall.toolCallId)).toEqual(["tool-a", "tool-b"]);
    expect(h.requests.filter((r) => r.method === "POST" && r.path.endsWith("/actions/b"))).toHaveLength(1);
    expect(h.requests.filter((r) => r.path.endsWith("/actions/a"))).toHaveLength(0);
    expect(h.updates).toContainEqual({
      sessionId: h.session.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-a",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Waiting for your confirmation in Cloud or Cloud Login: https://cloud.test/app/assistant?conversation=chat",
            },
          },
        ],
      },
    });
  });
  test("all waiting approvals keep streaming without asking again", async () => {
    const h = await harness({ action: approval(true), permission: () => ({ outcome: { outcome: "selected", optionId: "cloud" } }) });
    h.streams.push(
      [h.block(tool("mail.send", "awaiting_approval"))],
      [h.block(tool("mail.send", "awaiting_approval"))],
      [h.block(tool("mail.send", "completed")), h.done()],
    );
    expect(await h.send("Send")).toEqual({ stopReason: "end_turn" });
    expect(h.permissions).toHaveLength(1);
    expect(h.requests.filter((r) => r.path.endsWith("/stream"))).toHaveLength(3);
  });
  test("nested approval updates its parent's display row", async () => {
    const h = await harness({ action: { ...approval(), callId: "x-approval-0" } });
    const parent = { ...tool("code_run", "running"), id: "tool-x", callId: "x" };
    h.streams.push(
      [h.block(parent), h.block({ ...parent, callId: "x-approval-0", status: "awaiting_approval" })],
      [h.block({ ...parent, status: "completed" }), h.done()],
    );
    expect(await h.send("Run")).toEqual({ stopReason: "end_turn" });
    const updates = h.updates.flatMap(({ update }) =>
      update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update" ? [update] : [],
    );
    expect(updates.filter((u) => u.sessionUpdate === "tool_call")).toHaveLength(1);
    expect(updates.every((u) => u.toolCallId === "tool-x")).toBe(true);
    expect(updates.at(-1)).toMatchObject({ toolCallId: "tool-x", status: "completed" });
    expect(h.permissions).toHaveLength(1);
    expect(h.permissions[0]?.toolCall.toolCallId).toBe("tool-x");
    expect(h.requests.filter((r) => r.method === "POST" && r.path.endsWith("/actions/x-approval-0"))).toHaveLength(1);
  });
  for (const fallback of [false, true])
    test(fallback ? "403 falls back to waiting in Cloud" : "confirm allow waits for the person in Cloud", async () => {
      const h = await harness({
        action: approval(!fallback),
        post403: fallback,
        permission: () => ({ outcome: { outcome: "selected", optionId: fallback ? "once" : "cloud" } }),
      });
      h.streams.push(
        [h.block(tool("mail.send", "awaiting_approval"))],
        [h.block(tool("mail.send", "awaiting_approval")), h.block(tool("mail.send", "completed")), h.done()],
      );
      expect(await h.send("Send")).toEqual({ stopReason: "end_turn" });
      if (!fallback) expect(h.permissions[0]?.options.map((o) => o.name)).toEqual(["Confirm in Cloud", "Reject"]);
      expect(h.requests.filter((r) => r.path.includes("/actions/"))).toHaveLength(fallback ? 1 : 0);
      expect(h.text().match(/Waiting for your confirmation in Cloud or Cloud Login:/g)).toHaveLength(1);
      expect(h.text()).toContain("https://cloud.test/app/assistant?conversation=chat");
      expect(h.updates.some((u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed")).toBe(true);
    });
  for (const forms of [false, true])
    for (const name of ["survey", "text_editor"])
      test(`${name} ${forms ? "with" : "without"} forms`, async () => {
        const args =
          name === "survey"
            ? { title: "Survey", questions: [{ type: "text", id: "q", label: "Question", required: true }] }
            : { title: "Draft", content: "old", format: "markdown" };
        const h = await harness({
          forms,
          action: { type: "frontend_tool", mode: "client_interaction", conversationId: "chat", turnId: "turn", callId: "call", name, args },
          form: () => ({ action: "accept", content: name === "survey" ? { q: "answer" } : { content: "new" } }),
        });
        h.streams.push([h.block(tool(name, "awaiting_client", args))], [h.done()]);
        await h.send("Help");
        expect(h.forms).toHaveLength(forms ? 1 : 0);
        expect(h.permissions).toHaveLength(0);
        const result = h.requests.find((r) => r.path.includes("/actions/"))?.body;
        expect(result).toEqual({
          type: "tool_result",
          result:
            name === "survey"
              ? { submitted: forms, answers: forms ? { q: "answer" } : {} }
              : forms
                ? { submitted: true, content: "new", format: "markdown" }
                : { submitted: false, feedback: "This client cannot show drafts. Put the draft in your reply and ask the user there." },
        });
      });
  for (const forms of [false, true])
    test(`Bash uses ${forms ? "a person-facing form" : "execute permission"}`, async () => {
      const h = await harness({ forms });
      h.streams.push([
        h.block(tool("local_bash", "awaiting_client", { command: "printf acp-test" })),
        h.block({ ...tool("local_bash", "completed"), result: { stdout: "acp-test" } }),
        h.done(),
      ]);
      await h.send("Run");
      if (forms)
        expect(h.forms[0]).toMatchObject({
          mode: "form",
          requestedSchema: {
            required: ["decision"],
            properties: {
              decision: {
                oneOf: [
                  { const: "yes", title: "Run" },
                  { const: "no", title: "Reject" },
                ],
              },
            },
          },
        });
      else expect(h.permissions[0]?.toolCall.kind).toBe("execute");
      expect(h.requests.find((r) => r.path.includes("/actions/"))?.body).toMatchObject({
        type: "tool_result",
        result: { stdout: "acp-test", status: "completed" },
      });
      expect(h.text()).not.toContain("acp-test");
    });
  test("append is an edit, replacement uses a form", async () => {
    const h = await harness({ forms: true });
    await writeFile(join(h.cwd, "notes.md"), "old");
    h.streams.push([h.block(tool("local_write", "awaiting_client", { path: "notes.md", mode: "append", content: "more" })), h.done()]);
    await h.send("Append");
    expect(h.permissions[0]?.toolCall.kind).toBe("edit");
    expect(h.forms).toHaveLength(0);
    // Every turn has its own calls.
    h.streams.push([
      h.block({ ...tool("local_write", "awaiting_client", { path: "notes.md", mode: "replace", content: "new" }), callId: "call-2" }),
      h.done(),
    ]);
    await h.send("Replace");
    expect(h.forms[0]).toMatchObject({
      requestedSchema: {
        properties: {
          decision: {
            oneOf: [
              { const: "yes", title: "Replace" },
              { const: "no", title: "Keep the current file" },
            ],
          },
        },
      },
    });
    expect(await Bun.file(join(h.cwd, "notes.md")).text()).toBe("new");
  });
  for (const forms of [false, true])
    for (const move of [false, true])
      test(`${move ? "moving into .agents" : "appending to AGENTS.md"} uses ${forms ? "a person-facing form" : "other permission"}`, async () => {
        const h = await harness({ forms });
        h.defaults.set("assistant.trustedFolders", JSON.stringify([h.cwd]));
        await writeFile(join(h.cwd, move ? "draft.md" : "AGENTS.md"), "old");
        const name = move ? "local_move" : "local_write";
        const args = move
          ? { moves: [{ from: "draft.md", to: ".agents/skills/x/SKILL.md" }] }
          : { path: "AGENTS.md", mode: "append", content: "more" };
        h.streams.push([h.block(tool(name, "awaiting_client", args)), h.done()]);
        expect(await h.send("Write")).toEqual({ stopReason: "end_turn" });
        expect(h.forms).toHaveLength(forms ? 1 : 0);
        expect(h.permissions).toHaveLength(forms ? 0 : 1);
        if (forms)
          expect(h.forms[0]).toMatchObject({
            toolCallId: "block",
            requestedSchema: {
              properties: {
                decision: {
                  oneOf: [
                    { const: "yes", title: "Allow" },
                    { const: "no", title: "Reject" },
                  ],
                },
              },
            },
          });
        else expect(h.permissions[0]?.toolCall).toMatchObject({ toolCallId: "block", kind: "other" });
        expect(await Bun.file(join(h.cwd, move ? ".agents/skills/x/SKILL.md" : "AGENTS.md")).text()).toBe(move ? "old" : "oldmore");
      });
  test("todo_write sends the editor plan", async () => {
    const h = await harness();
    h.streams.push([
      h.block(
        tool("todo_write", "completed", {
          todos: [
            { id: "a", content: "Work", status: "in_progress" },
            { id: "b", content: "Skip", status: "cancelled" },
          ],
        }),
      ),
      h.done(),
    ]);
    await h.send("Plan");
    expect(
      h.updates.some((u) => u.update.sessionUpdate === "plan" && u.update.entries.length === 1 && u.update.entries[0]?.content === "Work"),
    ).toBe(true);
  });
  test("Project before first message, approvals revocation, web and unknown slash text", async () => {
    const h = await harness();
    await h.send("/web");
    expect(h.text()).toContain("No chat yet. Your first message starts one.");
    await h.send("/project");
    expect(h.text()).toContain("1. Project — Work");
    await h.send("/project 1");
    expect(h.text()).toContain("Your first message starts the chat there.");
    expect(h.requests.filter((r) => r.path.endsWith("/conversations") && r.method === "POST")).toHaveLength(0);
    await h.send("/path is unknown");
    expect(h.requests.find((r) => r.path.endsWith("/conversations") && r.method === "POST")?.body).toEqual({ projectId: "project" });
    expect(h.requests.find((r) => r.path.endsWith("/draft"))?.body).toMatchObject({
      content: [{ type: "text", text: "/path is unknown" }],
    });
    await h.send("/approvals");
    expect(h.text()).toContain("1. Create tasks · Spaces · everywhere\n2. Read notes · Notes · this chat");
    await h.send("/approvals 2");
    expect(h.requests.some((r) => r.path.endsWith("/approval-preferences/remembered") && r.method === "DELETE")).toBe(true);
    await h.send("/web");
    expect(h.text()).toContain("Open this chat in Cloud: https://cloud.test/app/assistant?conversation=chat");
  });
  test("resume accepts ACP and Cloud ids without replay", async () => {
    const h = await harness();
    await h.send("Hello");
    const count = h.text().match(/Hello world/g)?.length;
    for (const sessionId of [h.session.sessionId, "chat"])
      expect(await h.acp.request("session/resume", { sessionId, cwd: h.cwd, mcpServers: [] })).toMatchObject({
        configOptions: [{ id: "model", currentValue: "default" }],
      });
    expect(h.text().match(/Hello world/g)?.length).toBe(count);
    await expect(h.acp.request("session/resume", { sessionId: "missing", cwd: h.cwd, mcpServers: [] })).rejects.toMatchObject({
      code: -32002,
    });
  });
  test("session list pages through every open chat, never stopping early", async () => {
    // Unrelated open chats come first; the folder's chat is on the third page of one state.
    const conversations = [
      ...Array.from({ length: 120 }, (_, i) => ({ ...initialConversation(), id: `other-${i}`, unreadCompletion: true })),
      { ...initialConversation(), id: "mine", unreadCompletion: true },
    ];
    const h = await harness({ conversations });
    await h.store.set("session-mine", "mine", h.cwd);
    const found: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const list = await h.acp.request("session/list", { cwd: h.cwd, ...(cursor ? { cursor } : {}) });
      found.push(...list.sessions.map((s) => s.sessionId));
      cursor = list.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(found).toEqual(["session-mine"]);
    expect(pages).toBe(3);
    expect(h.requests.filter((r) => r.path.includes("status=unread")).map((r) => r.path)).toEqual([
      "/api/ai/conversations/page?status=unread&page=1&perPage=50",
      "/api/ai/conversations/page?status=unread&page=2&perPage=50",
      "/api/ai/conversations/page?status=unread&page=3&perPage=50",
    ]);
  });
  test.each(["x", "0", "-1", "1.5", "", " 2", "1e2", "9007199254740992"])("session list rejects invalid cursor %s", async (cursor) => {
    const h = await harness();
    await expect(h.acp.request("session/list", { cursor })).rejects.toMatchObject({
      code: -32602,
      message: "Invalid params: Unknown session list cursor.",
    });
    expect(h.requests.some((r) => r.path.includes("/conversations/page?"))).toBe(false);
  });
  for (const activeTurn of [false, true])
    test(`resume ${activeTurn ? "reports a running turn" : "does not report a running turn when idle"}`, async () => {
      const h = await harness({ activeTurn });
      await h.acp.request("session/resume", { sessionId: "chat", cwd: h.cwd, mcpServers: [] });
      // The title follows the optional notice in the deferred updates.
      while (!h.updates.some((u) => u.sessionId === "chat" && u.update.sessionUpdate === "session_info_update")) await Bun.sleep(5);
      if (activeTurn)
        expect(h.text()).toBe(
          "A turn in this chat is still running. Send a message to follow it here, or open it in Cloud: https://cloud.test/app/assistant?conversation=chat\n",
        );
      else expect(h.text()).not.toContain("A turn in this chat is still running");
      expect(h.requests.some((r) => r.path.endsWith("/stream"))).toBe(false);
      expect(h.requests.some((r) => r.path.endsWith("/turns"))).toBe(false);
    });
  test("cancel posts abort and returns cancelled", async () => {
    const h = await harness({ hold: true });
    const pending = h.send("Wait");
    await h.submitted;
    await h.acp.notify("session/cancel", { sessionId: h.session.sessionId });
    expect(await pending).toEqual({ stopReason: "cancelled" });
    expect(h.requests.filter((r) => r.path.endsWith("/abort"))).toHaveLength(1);
  });
  test("cancelled permission stops the turn instead of rejecting it", async () => {
    const h = await harness({ action: approval(), permission: () => ({ outcome: { outcome: "cancelled" } }) });
    h.streams.push([h.block(tool("mail.send", "awaiting_approval"))]);
    expect(await h.send("Approve")).toEqual({ stopReason: "cancelled" });
    expect(h.requests.some((r) => r.path.includes("/actions/"))).toBe(false);
    expect(h.requests.some((r) => r.path.endsWith("/abort"))).toBe(true);
  });
  test("disconnect leaves server turns running", async () => {
    const h = await harness({ hold: true });
    const pending = h.send("Wait");
    void pending.catch(() => {});
    await h.submitted;
    h.connection.close();
    await h.connection.closed;
    expect(h.requests.some((r) => r.path.endsWith("/abort"))).toBe(false);
  });
  test("editor image and embedded files use the common upload path", async () => {
    const h = await harness();
    await h.send("Read", [
      { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///notes.md", text: "notes", mimeType: "text/markdown" } },
    ]);
    expect(h.uploads.map((f) => f.name)).toEqual(["image-1.png", "notes.md"]);
    expect(h.requests.find((r) => r.path.endsWith("/draft"))?.body).toMatchObject({
      content: [
        { type: "text", text: "Read" },
        { type: "file", path: "/image-1.png" },
        { type: "file", path: "/notes.md" },
      ],
    });
  });
  test("running Cloud turn is followed before submitting the next message", async () => {
    let running = false;
    const h = await harness({
      intercept: (path, method) => {
        if (!running || method !== "GET" || !path.endsWith("/conversations/chat")) return undefined;
        running = false;
        return Response.json({ conversation: initialConversation(), activeTurn: { turnId: "turn", status: "running" } });
      },
    });
    await h.send("Start");
    running = true;
    const before = h.requests.length;
    h.streams.push([h.delta("Previous"), h.done()], [h.delta("Next"), h.done()]);
    await h.send("Continue");
    h.requests.splice(0, before);
    expect(h.text()).toContain("Previous");
    expect(h.text()).toContain("Next");
    const streamIndices = h.requests.flatMap((r, i) => (r.path.endsWith("/stream") ? [i] : []));
    const postIndex = h.requests.findIndex((r) => r.path.endsWith("/turns"));
    expect(streamIndices[0]).toBeLessThan(postIndex);
  });
  test("missing login and a 401 become ACP authRequired", async () => {
    const h = await harness();
    for (const token of ["", "expired"]) {
      const app = client();
      const ctx = { ...h.ctx, options: { ...h.ctx.options, token }, fetch: async () => Response.json({}, { status: 401 }) };
      const bridge = createAcpAgent(ctx);
      const connection = app.connect(bridge.app);
      try {
        await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        await expect(connection.agent.request("session/new", { cwd: h.cwd, mcpServers: [] })).rejects.toThrow(
          "Sign in first: run `cld login` in a terminal, then start a new thread.",
        );
      } finally {
        connection.close();
        await connection.closed;
        await bridge.close();
      }
    }
  });
  test("one prompt per session and model reset", async () => {
    const h = await harness({ hold: true });
    await h.acp.request("session/set_config_option", { sessionId: h.session.sessionId, configId: "model", value: "model" });
    expect(
      await h.acp.request("session/set_config_option", { sessionId: h.session.sessionId, configId: "model", value: "default" }),
    ).toMatchObject({ configOptions: [{ currentValue: "default" }] });
    const pending = h.send("Wait");
    await h.submitted;
    await expect(h.send("Another")).rejects.toThrow("This session already has a running prompt.");
    await h.acp.notify("session/cancel", { sessionId: h.session.sessionId });
    await pending;
  });
  test("usage limits preserve the Cloud error and unknown frontend steps link to Cloud", async () => {
    const h = await harness();
    h.streams.push([{ ...h.done(), status: "failed", error: "Usage limit reached." }]);
    await expect(h.send("Work")).rejects.toThrow("Usage limit reached.");
    const other = await harness({
      action: {
        type: "frontend_tool",
        mode: "client_interaction",
        conversationId: "chat",
        turnId: "turn",
        callId: "call",
        name: "unknown",
        args: {},
      },
    });
    other.streams.push([other.block(tool("unknown", "awaiting_client"))]);
    expect(await other.send("Work")).toEqual({ stopReason: "end_turn" });
    expect(other.text()).toContain("This step needs the web chat: https://cloud.test/app/assistant?conversation=chat");
  });
  test("local folder trust and selected Skills use the terminal contract", async () => {
    const h = await harness({
      manualSkill: true,
      permission: (request) => ({
        outcome: { outcome: "selected", optionId: request.options.some((o) => o.optionId === "session") ? "session" : "once" },
      }),
    });
    const { mkdir } = await import("node:fs/promises");
    await writeFile(join(h.cwd, "AGENTS.md"), "Use these instructions.");
    await mkdir(join(h.cwd, ".agents/skills/work"), { recursive: true });
    await writeFile(join(h.cwd, ".agents/skills/work/SKILL.md"), "---\nname: work\ndescription: Work here\n---\nFollow this Skill.");
    await h.send("/skills");
    expect(h.text()).toContain("remote · Cloud · Cloud selected workflow (only with /remote)");
    expect(h.permissions[0]?.options.map((o) => o.optionId)).toEqual(["session", "folder", "reject"]);
    await h.send("/work message");
    expect(h.requests.find((r) => r.path.endsWith("/turns"))?.body).toMatchObject({
      localContext: {
        instructions: [{ content: "Use these instructions." }],
        selectedSkills: [{ name: "work", instructions: "Follow this Skill." }],
      },
    });
    await h.send("Next");
    expect(h.requests.filter((r) => r.path.endsWith("/turns"))[1]?.body).toMatchObject({ localContext: { selectedSkills: [] } });
  });
  test("file links, attachment count and editor cancellation preserve path policy", async () => {
    const h = await harness();
    await writeFile(join(h.cwd, "file.txt"), "file");
    const { pathToFileURL } = await import("node:url");
    await h.send("Read", [
      { type: "resource_link", uri: pathToFileURL(join(h.cwd, "file.txt")).href, name: "file" },
      { type: "resource_link", uri: "https://example.test/page", name: "page" },
    ]);
    expect(h.uploads.map((f) => f.name)).toEqual(["file.txt"]);
    expect(h.requests.find((r) => r.path.endsWith("/draft"))?.body).toMatchObject({
      content: [
        { type: "text", text: "Read\nhttps://example.test/page" },
        { type: "file", path: "/file.txt" },
      ],
    });
    await expect(
      h.send(
        "Read",
        Array.from(
          { length: 17 },
          (_, i): ContentBlock => ({ type: "resource", resource: { uri: `file:///file-${i}.txt`, text: "file" } }),
        ),
      ),
    ).rejects.toThrow("At most 16 attachments can be sent with one message.");
  });
  test("injected command stream writes only JSON-RPC to stdout", async () => {
    const h = await harness();
    const chunks: string[] = [];
    const encoder = new TextEncoder();
    const input = new TransformStream<Uint8Array>();
    const writer = input.writable.getWriter();
    let received: () => void = () => {};
    const response = new Promise<void>((resolve) => {
      received = resolve;
    });
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new TextDecoder().decode(chunk));
        received();
      },
    });
    const running = runAcpConnection(h.ctx, input.readable, output);
    await writer.write(
      encoder.encode(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }) + "\n",
      ),
    );
    await response;
    await writer.close();
    await running;
    expect(chunks.flatMap((chunk) => chunk.trim().split("\n")).map((line) => JSON.parse(line))).toMatchObject([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
    ]);
    expect(module.shortcuts).toEqual({ acp: "acp" });
  });
});

test("sends supplied resource permalinks as full Cloud addresses in ACP updates", async () => {
  const text = "[Draft](/open/mail.draft/AbC123)";
  const wire = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const h = await harness({
    streams: [
      [
        { ...wire, seq: 1, type: "block_delta", blockId: "draft", blockKind: "text", delta: "[Draft](/open/" },
        { ...wire, seq: 2, type: "block_delta", blockId: "draft", blockKind: "text", delta: "mail.draft/AbC123)" },
        { ...wire, seq: 3, type: "turn_finished", status: "completed", error: null, messages: [] },
      ],
    ],
  });
  await h.send("Show the draft");
  expect(h.text()).toContain("[Draft](https://cloud.test/open/mail.draft/AbC123)");
  expect(h.text()).not.toContain(text);
});

describe("ACP turn outcome and cancellation", () => {
  const waitFor = async (condition: () => boolean) => {
    while (!condition()) await Bun.sleep(5);
  };
  const statuses = (h: Awaited<ReturnType<typeof harness>>) =>
    h.updates.flatMap(({ update }) =>
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") && update.status ? [update.status] : [],
    );

  test("a failing title refresh keeps end_turn and cancelled", async () => {
    let turns = 0;
    const h = await harness({
      intercept: (path, method) => {
        if (method === "POST" && path.endsWith("/turns")) turns++;
        if (turns > 0 && method === "GET" && path.endsWith("/conversations/chat")) return Response.json({}, { status: 500 });
      },
    });
    expect(await h.send("Hello")).toEqual({ stopReason: "end_turn" });
    let submitted = false;
    const held = await harness({
      hold: true,
      intercept: (path, method) => {
        if (method === "GET" && path.endsWith("/conversations/chat") && submitted) return Response.json({}, { status: 500 });
      },
    });
    const pending = held.send("Wait");
    await held.submitted;
    submitted = true;
    await held.acp.notify("session/cancel", { sessionId: held.session.sessionId });
    expect(await pending).toEqual({ stopReason: "cancelled" });
  });

  test("Stop while offline still answers cancelled", async () => {
    const h = await harness({
      hold: true,
      intercept: (path) => {
        if (path.endsWith("/abort")) throw new TypeError("fetch failed");
      },
    });
    const pending = h.send("Wait");
    await h.submitted;
    await h.acp.notify("session/cancel", { sessionId: h.session.sessionId });
    expect(await pending).toEqual({ stopReason: "cancelled" });
  });

  test("Stop during the draft write starts no turn and empties the draft", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let drafts = 0;
    const h = await harness({
      intercept: async (path, method) => {
        if (method === "PUT" && path.endsWith("/draft") && drafts++ === 0) {
          await gate;
          return undefined;
        }
      },
    });
    const pending = h.send("Hello");
    await waitFor(() => drafts > 0);
    await h.acp.notify("session/cancel", { sessionId: h.session.sessionId });
    release();
    expect(await pending).toEqual({ stopReason: "cancelled" });
    expect(h.requests.some((r) => r.method === "POST" && r.path.endsWith("/turns"))).toBe(false);
    expect(h.requests.filter((r) => r.path.endsWith("/draft")).map((r) => r.body)).toMatchObject([
      { content: [{ type: "text", text: "Hello" }] },
      { content: [] },
    ]);
  });

  for (const [label, text, read] of [
    ["the chat read", "Hello", "/api/ai/conversations/chat"],
    ["a command read", "/usage", "/api/ai/quotas"],
  ] as const)
    test(`Stop ends ${label} that hangs`, async () => {
      let waiting = false;
      let armed = false;
      const h = await harness({
        intercept: (path, method, init) => {
          if (!armed || method !== "GET" || path !== read) return undefined;
          waiting = true;
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }),
          );
        },
      });
      if (read === "/api/ai/conversations/chat") await h.send("Start");
      armed = true;
      const pending = h.send(text);
      await waitFor(() => waiting);
      await h.acp.notify("session/cancel", { sessionId: h.session.sessionId });
      const sent = h.requests.length;
      expect(await pending).toEqual({ stopReason: "cancelled" });
      expect(h.requests.slice(sent).some((r) => r.path.endsWith("/draft") || r.path.endsWith("/turns"))).toBe(false);
    });

  test("a request paused after the editor leaves cannot keep cld running", async () => {
    let paused = false;
    const h = await harness({
      intercept: (path, method, init) => {
        if (method !== "PUT" || !path.endsWith("/draft")) return undefined;
        paused = true;
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }),
        );
      },
    });
    void h.send("Hello").catch(() => undefined);
    await waitFor(() => paused);
    h.connection.close();
    await h.connection.closed;
    const started = performance.now();
    const outcome = await Promise.race([h.bridge.close().then(() => "closed"), Bun.sleep(5_000).then(() => "stuck")]);
    expect(outcome).toBe("closed");
    expect(performance.now() - started).toBeLessThan(4_000);
  });

  test("a replayed running status never moves a finished call back", async () => {
    const h = await harness();
    const call = tool("read_file", "running");
    h.streams.push([h.block(call), h.block({ ...call, status: "completed" }), h.block(call), h.done()]);
    expect(await h.send("Read")).toEqual({ stopReason: "end_turn" });
    expect(statuses(h)).toEqual(["in_progress", "completed"]);
  });

  test("a 401 in prompt, list and resume asks to sign in again", async () => {
    let expired = false;
    const h = await harness({
      intercept: (path) => (expired && !path.endsWith("/models") ? Response.json({}, { status: 401 }) : undefined),
    });
    expired = true;
    await expect(h.send("Hello")).rejects.toMatchObject({ code: -32000, message: expect.stringContaining("cld login") });
    await expect(h.acp.request("session/list", {})).rejects.toMatchObject({ code: -32000 });
    await expect(h.acp.request("session/resume", { sessionId: "chat", cwd: h.cwd, mcpServers: [] })).rejects.toMatchObject({
      code: -32000,
    });
  });

  test("a sign-in refresh that fails asks to sign in again, a network failure does not", async () => {
    let failure: Error | undefined;
    const h = await harness({
      intercept: () => {
        if (failure) throw failure;
      },
    });
    failure = new Error("Login expired, sign in again: cld login");
    await expect(h.send("Hello")).rejects.toMatchObject({ code: -32000 });
    failure = new TypeError("Unable to connect.");
    await expect(h.send("Hello")).rejects.toMatchObject({ code: -32603 });
  });

  test("a new thread reads the profile again, so a later cld login counts", async () => {
    const h = await harness();
    const reloads: string[] = [];
    const options = { ...h.ctx.options, token: "" };
    const reloading = createAcpAgent({
      ...h.ctx,
      options,
      reloadCredentials: async () => {
        reloads.push(options.token);
        if (reloads.length === 1) throw new Error("No login configured.");
        options.token = "fresh";
      },
    });
    const connection = client().connect(reloading.app);
    resources.push(async () => {
      connection.close();
      await connection.closed;
      await reloading.close();
    });
    await connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await expect(connection.agent.request("session/new", { cwd: h.cwd, mcpServers: [] })).rejects.toMatchObject({ code: -32000 });
    expect(await connection.agent.request("session/new", { cwd: h.cwd, mcpServers: [] })).toHaveProperty("sessionId");
    expect(reloads).toEqual(["", ""]);
  });
});

test("a local append whose result did not reach Cloud is sent again after resume, never run twice", async () => {
  let failDelivery = true;
  let followAgain = false;
  const h = await harness({
    activeTurn: true,
    intercept: (path, method) => {
      if (method === "POST" && path.includes("/actions/") && failDelivery) {
        failDelivery = false;
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      if (method === "GET" && path.endsWith("/conversations/chat") && followAgain)
        return Response.json({ conversation: initialConversation(), activeTurn: { turnId: "turn", status: "waiting_for_action" } });
    },
  });
  await writeFile(join(h.cwd, "notes.md"), "");
  const append = tool("local_write", "awaiting_client", { path: "notes.md", mode: "append", content: "X" });
  h.streams.push([h.block(append)]);
  await expect(h.send("Append")).rejects.toThrow("503");
  expect(await Bun.file(join(h.cwd, "notes.md")).text()).toBe("X");

  followAgain = true;
  await h.acp.request("session/resume", { sessionId: h.session.sessionId, cwd: h.cwd, mcpServers: [] });
  h.streams.push([h.block(append), h.block({ ...append, status: "completed" }), h.done()]);
  expect(await h.acp.request("session/prompt", { sessionId: h.session.sessionId, prompt: [{ type: "text", text: "Again" }] })).toEqual({
    stopReason: "end_turn",
  });
  expect(await Bun.file(join(h.cwd, "notes.md")).text()).toBe("X");
  const delivered = h.requests.filter((r) => r.method === "POST" && r.path.includes("/actions/"));
  expect(delivered).toHaveLength(2);
  expect(delivered[1]?.body).toEqual(delivered[0]?.body);
  expect(h.permissions.filter((p) => p.toolCall.kind === "edit")).toHaveLength(1);
});

describe("ACP round trips and bounded state", () => {
  test("a message in an existing chat waits for four requests: chat, stream, draft, turn", async () => {
    const h = await harness();
    await h.send("First");
    await Bun.sleep(20);
    const before = h.requests.length;
    expect(await h.send("Second")).toEqual({ stopReason: "end_turn" });
    await Bun.sleep(20);
    expect(h.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/ai/conversations/chat",
      "GET /api/ai/conversations/chat/stream",
      "PUT /api/ai/conversations/chat/draft",
      "POST /api/ai/conversations/chat/turns",
      // After the reply: the person saw it in the editor.
      "POST /api/ai/conversations/chat/viewed",
    ]);
  });

  test("session list reads no profile defaults and the session store stays bounded", async () => {
    const h = await harness({
      conversations: Array.from({ length: 50 }, (_, i) => ({ ...initialConversation(), id: `chat-${i}`, runStatus: "running" as const })),
    });
    let reads = 0;
    const getDefault = h.ctx.getDefault;
    h.ctx.getDefault = async (key) => {
      reads++;
      return getDefault(key);
    };
    await h.store.set("known", "chat-7", h.cwd);
    const list = await h.acp.request("session/list", {});
    expect(list.sessions.map((s) => s.sessionId)).toEqual(["known"]);
    expect(reads).toBe(0);

    const state = await mkdtemp(join(tmpdir(), "cld-acp-bound-"));
    resources.push(() => rm(state, { recursive: true, force: true }));
    const small = createAcpSessionStore(h.ctx.options, state, 3);
    for (const [i, chat] of ["a", "b", "c", "d"].entries()) {
      await small.set(`session-${chat}`, chat);
      await Bun.sleep(i === 0 ? 20 : 5);
    }
    expect([...(await small.sessions()).keys()].sort()).toEqual(["b", "c", "d"]);
  });

  test("resuming a session whose chat is gone forgets it", async () => {
    const h = await harness();
    await h.store.set("gone-session", "gone");
    await expect(h.acp.request("session/resume", { sessionId: "gone-session", cwd: h.cwd, mcpServers: [] })).rejects.toMatchObject({
      code: -32002,
    });
    expect(await h.store.chat("gone-session")).toBeUndefined();
  });

  test("a session from the profile defaults resumes once and moves to the store", async () => {
    const h = await harness();
    h.defaults.set("assistant.acpSession.old-session", "chat");
    h.defaults.set("assistant.acpChat.chat", "old-session");
    await h.acp.request("session/resume", { sessionId: "old-session", cwd: h.cwd, mcpServers: [] });
    expect(await h.store.chat("old-session")).toBe("chat");
    expect([...h.defaults.keys()].filter((key) => key.startsWith("assistant.acp"))).toEqual([]);
  });

  test("Stop reaches Cloud while the editor has stopped reading updates", async () => {
    const state = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "cld-acp-xdg-"));
    const xdg = process.env.XDG_STATE_HOME;
    resources.push(async () => {
      if (state === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = state;
      await rm(xdg, { recursive: true, force: true });
    });
    const h = await harness({ hold: true });
    // Distinct calls never coalesce, so the queue passes its high-water mark.
    h.streams.push(
      Array.from({ length: 100 }, (_, i) => h.block({ ...tool("read_file", "running"), id: `block-${i}`, callId: `call-${i}` })),
    );
    let holding = false;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replies: Array<{ id?: number; result?: { sessionId?: string } }> = [];
    let pending = "";
    const output = new WritableStream<Uint8Array>({
      async write(chunk) {
        if (holding) await released;
        pending += new TextDecoder().decode(chunk);
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const part of parts) if (part.trim()) replies.push(JSON.parse(part));
      },
    });
    const input = new TransformStream<Uint8Array>();
    const writer = input.writable.getWriter();
    const running = runAcpConnection(h.ctx, input.readable, output);
    const send = (value: object) => writer.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`));
    const waitFor = async (condition: () => boolean, ms = 3_000) => {
      const end = performance.now() + ms;
      while (!condition() && performance.now() < end) await Bun.sleep(5);
      return condition();
    };
    await send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await waitFor(() => replies.some((r) => r.id === 1));
    await send({ id: 2, method: "session/new", params: { cwd: h.cwd, mcpServers: [] } });
    await waitFor(() => replies.some((r) => r.id === 2));
    const sessionId = replies.find((r) => r.id === 2)?.result?.sessionId;
    holding = true;
    await send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Read" }] } });
    await waitFor(() => h.requests.some((r) => r.path.endsWith("/turns")));
    await Bun.sleep(100);
    await send({ method: "session/cancel", params: { sessionId } });
    expect(await waitFor(() => h.requests.some((r) => r.path.endsWith("/abort")))).toBe(true);
    release();
    await writer.close();
    await running;
  });

  test("a slow editor gets adjacent text coalesced instead of one update per delta", async () => {
    const state = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "cld-acp-xdg-"));
    const xdg = process.env.XDG_STATE_HOME;
    resources.push(async () => {
      if (state === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = state;
      await rm(xdg, { recursive: true, force: true });
    });
    const h = await harness();
    h.streams.push([...Array.from({ length: 300 }, () => h.delta("x")), h.done()]);
    const lines: Array<{ id?: number; method?: string; params?: SessionNotification; result?: { sessionId?: string } }> = [];
    let pending = "";
    const waiters: Array<() => void> = [];
    const output = new WritableStream<Uint8Array>({
      async write(chunk) {
        await Bun.sleep(2);
        pending += new TextDecoder().decode(chunk);
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const part of parts) if (part.trim()) lines.push(JSON.parse(part));
        for (const wake of waiters.splice(0)) wake();
      },
    });
    const input = new TransformStream<Uint8Array>();
    const writer = input.writable.getWriter();
    const running = runAcpConnection(h.ctx, input.readable, output);
    const call = async (id: number, method: string, params: unknown) => {
      await writer.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
      while (!lines.some((line) => line.id === id)) await new Promise<void>((resolve) => waiters.push(resolve));
      return lines.find((line) => line.id === id)!;
    };
    await call(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await call(2, "session/new", { cwd: h.cwd, mcpServers: [] });
    const sessionId = session.result?.sessionId;
    await call(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "Write" }] });
    await writer.close();
    await running;
    const chunks = lines.flatMap((line) =>
      line.method === "session/update" &&
      line.params?.update.sessionUpdate === "agent_message_chunk" &&
      line.params.update.content.type === "text"
        ? [line.params.update.content.text]
        : [],
    );
    expect(chunks.join("")).toContain("x".repeat(300));
    expect(chunks.length).toBeLessThan(100);
  });
});

describe("ACP attachments, sessions and cleanup", () => {
  test("a folder link becomes a path in the message and a relative resource URI keeps its name", async () => {
    const h = await harness();
    const { mkdir } = await import("node:fs/promises");
    const { pathToFileURL } = await import("node:url");
    await mkdir(join(h.cwd, "src"));
    expect(
      await h.send("Look", [
        { type: "resource_link", uri: pathToFileURL(join(h.cwd, "src")).href, name: "src" },
        { type: "resource", resource: { uri: "notes/today.md", text: "notes" } },
      ]),
    ).toEqual({ stopReason: "end_turn" });
    expect(h.uploads.map((f) => f.name)).toEqual(["today.md"]);
    expect(h.requests.find((r) => r.path.endsWith("/draft"))?.body).toMatchObject({
      content: [
        { type: "text", text: `Look\n${join(h.cwd, "src")}` },
        { type: "file", path: "/today.md" },
      ],
    });
  });

  test("a close while a resume waits keeps the session closed", async () => {
    let hold: (() => void) | undefined;
    const h = await harness({
      intercept: async (path, method) => {
        if (method !== "GET" || !path.endsWith("/conversations/chat") || hold) return undefined;
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
        return undefined;
      },
    });
    const resumed = h.acp.request("session/resume", { sessionId: "chat", cwd: h.cwd, mcpServers: [] });
    while (!hold) await Bun.sleep(5);
    await h.acp.request("session/close", { sessionId: "chat" });
    hold();
    await expect(resumed).rejects.toMatchObject({ message: expect.stringContaining("This session was closed.") });
    await expect(h.acp.request("session/prompt", { sessionId: "chat", prompt: [{ type: "text", text: "Hi" }] })).rejects.toMatchObject({
      code: -32002,
    });
  });

  test("session list shows only open chats an editor used in this folder", async () => {
    const chat = (id: string, change: Partial<AiConversation>) => ({ ...initialConversation(), id, ...change });
    const h = await harness({
      conversations: [
        chat("running", { runStatus: "running", updatedAt: "2026-10-11T00:00:05Z" }),
        chat("asking", { runStatus: "needs_attention", updatedAt: "2026-10-11T00:00:04Z" }),
        chat("answered", { unreadCompletion: true, updatedAt: "2026-10-11T00:00:03Z" }),
        chat("finished", { updatedAt: "2026-10-11T00:00:02Z" }),
        chat("elsewhere", { runStatus: "running", updatedAt: "2026-10-11T00:00:01Z" }),
        chat("web", { runStatus: "running", updatedAt: "2026-10-11T00:00:00Z" }),
      ],
    });
    for (const id of ["running", "asking", "answered", "finished"]) await h.store.set(`session-${id}`, id, h.cwd);
    await h.store.set("session-elsewhere", "elsewhere", "/elsewhere");
    const here = await h.acp.request("session/list", { cwd: h.cwd });
    expect(here.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
      ["session-running", h.cwd],
      ["session-asking", h.cwd],
      ["session-answered", h.cwd],
    ]);
    // A second thread on one chat lists in its own folder.
    await h.store.set("session-running-there", "running", "/elsewhere");
    expect((await h.acp.request("session/list", { cwd: "/elsewhere" })).sessions.map((s) => s.sessionId)).toEqual([
      "session-running-there",
      "session-elsewhere",
    ]);
    // Without a folder: open chats of any editor folder, never a chat no editor used.
    expect((await h.acp.request("session/list", {})).sessions.map((s) => s.sessionId)).not.toContain("web");
  });

  test("closing a session ends its prompt, keeps the Cloud turn and forgets the session", async () => {
    const h = await harness({ hold: true });
    expect(h.initialize.agentCapabilities?.sessionCapabilities).toMatchObject({ close: {} });
    const pending = h.send("Wait");
    await h.submitted;
    await h.acp.request("session/close", { sessionId: h.session.sessionId });
    expect(await pending).toEqual({ stopReason: "cancelled" });
    expect(h.requests.some((r) => r.path.endsWith("/abort"))).toBe(false);
    await expect(h.send("Again")).rejects.toMatchObject({ code: -32002 });
    expect(await h.acp.request("session/close", { sessionId: "missing" })).toEqual({});
  });

  test.skipIf(process.platform === "win32")(
    "SIGTERM removes the temporary session folders before cld exits",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cld-acp-sigterm-"));
      resources.push(() => rm(dir, { recursive: true, force: true }));
      const script = join(dir, "child.ts");
      await writeFile(
        script,
        `import { runAcpConnection } from ${JSON.stringify(join(import.meta.dir, "acp.ts"))};
let seq = 0;
const wire = () => ({ v: 1, conversationId: "chat", turnId: "turn", attempt: 1, seq: ++seq });
const conversation = { id: "chat", shortId: "chat", title: "Chat", draft: { content: [], revision: 0, updatedAt: null } };
const bash = { id: "block", kind: "tool", callId: "call", name: "local_bash", status: "awaiting_client", args: { command: "head -c 70000 /dev/zero | tr '\\\\0' x" } };
const ctx = {
  args: [], flags: {}, options: { profile: "test", server: "https://cloud.test", token: "test", output: "json" },
  getDefault: async () => undefined, setDefault: async () => {},
  fetch: async (path, init) => {
    const method = init?.method ?? "GET";
    if (path.endsWith("/models")) return Response.json({ options: [] });
    if (path.endsWith("/skills")) return Response.json({ skills: [] });
    if (path.endsWith("/conversations") && method === "POST") return Response.json(conversation);
    if (path.endsWith("/draft")) return Response.json({ content: [], revision: 1, updatedAt: null });
    if (path.endsWith("/turns")) return Response.json({ turn: { id: "turn", status: "running", modelId: null } });
    if (path.endsWith("/stream")) return new Response("data: " + JSON.stringify({ ...wire(), type: "block_set", block: bash }) + "\\n\\n" + ": open\\n\\n");
    if (path.includes("/actions/")) {
      process.stderr.write("RESULT" + JSON.parse(init.body).result.outputPath + "\\n");
      return new Promise(() => {});
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  readJson: async (response) => response.json(),
  print() {}, write: async () => {}, error() {}, json() {}, jsonLine() {}, table() {}, createApiClient() { throw new Error("Unused"); },
};
await runAcpConnection(ctx, Bun.stdin.stream(), new WritableStream({ write: (chunk) => void process.stdout.write(chunk) }));
`,
      );
      const env: Record<string, string | undefined> = { ...process.env, XDG_STATE_HOME: dir };
      for (const key of Object.keys(env)) if (key.startsWith("CLOUD_TEST_")) delete env[key];
      const child = Bun.spawn([process.execPath, script], { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const send = (value: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(value as object) })}\n`);
      const decoder = new TextDecoder();
      const stdout = child.stdout.getReader();
      let buffered = "";
      const next = async (match: (line: { id?: number; method?: string; result?: { sessionId?: string } }) => boolean) => {
        for (;;) {
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const [i, line] of lines.entries()) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line);
            if (match(parsed)) {
              buffered = [...lines.slice(i + 1), buffered].join("\n");
              return parsed;
            }
          }
          const { value, done } = await stdout.read();
          if (done) throw new Error("cld acp ended early");
          buffered += decoder.decode(value, { stream: true });
        }
      };
      send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
      await next((line) => line.id === 1);
      send({ id: 2, method: "session/new", params: { cwd: dir, mcpServers: [] } });
      const sessionId = (await next((line) => line.id === 2)).result?.sessionId;
      send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "Run" }] } });
      const permission = await next((line) => line.method === "session/request_permission");
      send({ id: (permission as { id: number }).id, result: { outcome: { outcome: "selected", optionId: "once" } } });
      const stderr = child.stderr.getReader();
      let errors = "";
      while (!errors.includes("RESULT")) errors += decoder.decode((await stderr.read()).value);
      const outputPath = /RESULT(\S+)/.exec(errors)?.[1] ?? "";
      expect(await Bun.file(outputPath).exists()).toBe(true);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      expect(await Bun.file(outputPath).exists()).toBe(false);
    },
    20_000,
  );
});

describe("ACP session/load", () => {
  let seq = 0;
  const stored = (message: AiStoredMessage["message"], loopId: string | null = "old-turn"): AiStoredMessage => ({
    id: `m-${++seq}`,
    shortId: `m-${seq}`,
    conversationId: "chat",
    seq,
    kind: "message",
    message,
    loopId,
    modelId: null,
    providerModel: null,
    usage: null,
    stopReason: null,
    loopAggregate: null,
    loopDoneReason: null,
    compactedAt: null,
    meta: null,
    createdAt: "2026-10-11T00:00:00Z",
  });
  const state = (
    messages: AiStoredMessage[],
    extra: Partial<Extract<AiStreamSseEvent, { type: "state" }>> = {},
  ): Extract<AiStreamSseEvent, { type: "state" }> => ({
    type: "state",
    conversation: { ...initialConversation(), title: "Old chat" },
    messages,
    activeTurn: null,
    ...extra,
  });
  const load = (h: Awaited<ReturnType<typeof harness>>, sessionId = "chat") =>
    h.acp.request("session/load", { sessionId, cwd: h.cwd, mcpServers: [] });
  const of = (h: Awaited<ReturnType<typeof harness>>, sessionId = "chat") =>
    h.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update);
  const said = (updates: ReturnType<typeof of>, kind: "user_message_chunk" | "agent_message_chunk") =>
    updates.flatMap((u) => (u.sessionUpdate === kind && u.content.type === "text" ? [u.content.text] : [])).join("");

  test("a chat that is not listed opens by its ID and replays its history before the response", async () => {
    const h = await harness();
    h.streams.push([
      state([
        stored({ role: "user", content: ["Plan the week"] }),
        stored({ role: "assistant", content: [{ type: "text", text: "See [the draft](/open/mail.draft/Ab12)." }] }),
      ]),
    ]);
    expect(await load(h)).toMatchObject({ configOptions: [{ id: "model" }] });
    const updates = of(h);
    expect(said(updates, "user_message_chunk")).toBe("Plan the week");
    expect(said(updates, "agent_message_chunk")).toBe("See [the draft](https://cloud.test/open/mail.draft/Ab12).\n\n");
    expect(updates).toContainEqual({ sessionUpdate: "session_info_update", title: "Old chat" });
    expect(h.requests.filter((r) => r.path.includes("/conversations/chat")).map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/ai/conversations/chat/stream",
    ]);
    expect(await h.store.chat("chat")).toBe("chat");
    // The chat now belongs to this folder and a message continues it.
    expect(await h.acp.request("session/prompt", { sessionId: "chat", prompt: [{ type: "text", text: "Go on" }] })).toEqual({
      stopReason: "end_turn",
    });
  });

  test("a long chat replays only the saved window and links the rest", async () => {
    const h = await harness();
    const messages = Array.from({ length: 100 }, (_, i) =>
      stored(
        i % 2 ? { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } : { role: "user", content: [`question ${i}`] },
      ),
    );
    h.streams.push([state(messages, { hasMoreMessages: true })]);
    await load(h);
    const updates = of(h);
    expect(said(updates, "agent_message_chunk")).toStartWith(
      "Earlier messages of this chat are in the web chat: https://cloud.test/app/assistant?conversation=chat\n\n",
    );
    expect(updates.filter((u) => u.sessionUpdate === "user_message_chunk")).toHaveLength(50);
    expect(h.requests.some((r) => r.path.includes("/messages"))).toBe(false);
  });

  test("stored tool calls render through the tool mapping", async () => {
    const h = await harness();
    h.streams.push([
      state([
        stored({ role: "user", content: ["Read and send"] }),
        stored({
          role: "assistant",
          content: [
            { type: "tool_call", id: "read", name: "read_file", args: { path: "/notes.md" } },
            { type: "tool_call", id: "send", name: "mail.send", args: { to: "a@b.test" } },
            { type: "tool_call", id: "lost", name: "local_bash", args: { command: "make" } },
          ],
        }),
        stored({ role: "tool_result", callId: "read", name: "read_file", result: "notes" }),
        stored({ role: "tool_result", callId: "send", name: "mail.send", result: { error: "Denied" }, isError: true }),
      ]),
    ]);
    await load(h);
    const calls = of(h).flatMap((u) => (u.sessionUpdate === "tool_call" ? [u] : []));
    expect(calls).toMatchObject([
      { toolCallId: "tool-read", title: "read_file /notes.md", kind: "read", status: "completed", rawOutput: "notes" },
      { toolCallId: "tool-send", title: "mail.send", status: "failed", content: [{ content: { text: "Denied" } }] },
      {
        toolCallId: "tool-lost",
        kind: "execute",
        status: "failed",
        content: [{ content: { text: "No result was saved for this call." } }],
      },
    ]);
    expect(calls[0]?.content).toEqual([{ type: "content", content: { type: "text", text: "```\nnotes\n```" } }]);
  });

  test("a running turn shows once after load, and its local call never runs twice", async () => {
    let failDelivery = true;
    const h = await harness({
      activeTurn: true,
      intercept: (path, method) => {
        if (method === "POST" && path.includes("/actions/") && failDelivery) {
          failDelivery = false;
          return Response.json({ error: "Unavailable" }, { status: 503 });
        }
        if (method === "GET" && path.endsWith("/conversations/chat"))
          return Response.json({ conversation: initialConversation(), activeTurn: { turnId: "turn", status: "waiting_for_action" } });
      },
    });
    await writeFile(join(h.cwd, "notes.md"), "");
    const append = tool("local_write", "awaiting_client", { path: "notes.md", mode: "append", content: "X" });
    // The first prompt runs the append; its result does not reach Cloud.
    h.streams.push([h.block(append)]);
    await expect(h.send("Append")).rejects.toThrow("503");
    const working = { id: "text", kind: "text" as const, text: "Working on it" };
    h.streams.push(
      [
        state(
          [
            stored({ role: "user", content: ["Earlier"] }),
            stored({ role: "user", content: ["Append"] }, "turn"),
            stored({ role: "assistant", content: [{ type: "text", text: "Working on it" }] }, "turn"),
          ],
          {
            activeTurn: {
              turnId: "turn",
              attempt: 1,
              status: "waiting_for_action",
              seq: 3,
              blocks: [working, append],
              modelId: null,
              createdAt: "2026-10-11T00:00:00Z",
              actionWaitMs: 0,
              waitingSince: null,
            },
          },
        ),
      ],
      [h.block(working), h.block(append), h.block({ ...append, status: "completed" }), h.done()],
    );
    await load(h);
    const loaded = of(h);
    expect(said(loaded, "user_message_chunk")).toBe("EarlierAppend");
    expect(said(loaded, "agent_message_chunk")).not.toContain("Working on it");
    expect(said(loaded, "agent_message_chunk")).toContain("A turn in this chat is still running.");
    const before = h.updates.length;
    expect(await h.acp.request("session/prompt", { sessionId: "chat", prompt: [{ type: "text", text: "Next" }] })).toEqual({
      stopReason: "end_turn",
    });
    const after = h.updates
      .slice(before)
      .filter((u) => u.sessionId === "chat")
      .map((u) => u.update);
    expect(said([...loaded, ...after], "agent_message_chunk").match(/Working on it/g)).toHaveLength(1);
    expect(await Bun.file(join(h.cwd, "notes.md")).text()).toBe("X");
    const delivered = h.requests.filter((r) => r.method === "POST" && r.path.includes("/actions/"));
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.body).toEqual(delivered[0]?.body);
  });

  test("a running turn that finishes before the next message still shows, and only then counts as seen", async () => {
    let finished = false;
    const h = await harness({
      intercept: (path, method) => {
        if (method === "GET" && path.endsWith("/conversations/chat"))
          return Response.json({
            conversation: initialConversation(),
            activeTurn: finished ? null : { turnId: "turn", status: "running" },
          });
      },
    });
    const running = {
      turnId: "turn",
      attempt: 1,
      status: "running" as const,
      seq: 1,
      blocks: [],
      modelId: null,
      createdAt: "2026-10-11T00:00:00Z",
    };
    h.streams.push([state([stored({ role: "user", content: ["Question"] }, "turn")], { activeTurn: running })]);
    await load(h);
    await Bun.sleep(20);
    expect(h.requests.some((r) => r.path.endsWith("/viewed"))).toBe(false);
    // The turn ends before the person writes again.
    finished = true;
    h.streams.push([
      state([
        stored({ role: "user", content: ["Question"] }, "turn"),
        stored({ role: "assistant", content: [{ type: "text", text: "The answer" }] }, "turn"),
      ]),
    ]);
    await h.acp.request("session/prompt", { sessionId: "chat", prompt: [{ type: "text", text: "Next" }] });
    await Bun.sleep(20);
    expect(said(of(h), "agent_message_chunk").match(/The answer/g)).toHaveLength(1);
    expect(h.requests.filter((r) => r.path.endsWith("/viewed"))).toHaveLength(1);
  });

  test("loading a chat that is gone forgets it", async () => {
    const h = await harness({ intercept: (path) => (path.endsWith("/gone/stream") ? Response.json({}, { status: 404 }) : undefined) });
    await h.store.set("gone-session", "gone", h.cwd);
    await expect(load(h, "gone-session")).rejects.toMatchObject({ code: -32002 });
    expect(await h.store.chat("gone-session")).toBeUndefined();
  });
});
