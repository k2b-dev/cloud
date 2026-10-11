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
import type { AiConversation, AiPendingTurnAction, AiPublicModelProfile, AiStreamSseEvent, AiTurnBlock } from "@k2b/cloud/ai";
import type { CloudCliContext } from "@k2b/cloud/cli";
import module from "../cli";
import { createAcpAgent, runAcpConnection } from "./acp";

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
const profile: AiPublicModelProfile = {
  id: "model",
  label: "Model",
  provider: "openai",
  model: "example",
  image: "",
  capabilities: ["tools", "streaming"],
  dataBoundary: "hosted",
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
    post403?: boolean;
    permission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
    form?: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse> | CreateElicitationResponse;
    hold?: boolean;
    activeTurn?: boolean;
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
      if (path.endsWith("/models")) return Response.json([profile]);
      if (path.endsWith("/skills")) return Response.json({ skills: [] });
      if (path.endsWith("/projects")) return Response.json({ projects: [{ shortId: "project", name: "Project", description: "Work" }] });
      if (path.includes("/approval-preferences/")) return Response.json({});
      if (path.includes("/approval-preferences?"))
        return Response.json({ approvals: [{ id: "remembered", title: "Read notes", conversationId: "chat", app: { name: "Notes" } }] });
      if (path.endsWith("/approval-preferences"))
        return Response.json({ approvals: [{ id: "everywhere", title: "Create tasks", conversationId: null, app: { name: "Spaces" } }] });
      if (path.endsWith("/quotas")) return Response.json({ enabled: false });
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
        return Response.json({ turn: { id: "turn", status: "running", modelProfileId: null } });
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
      if (path.includes("/pending-actions/")) return Response.json(options.action ? [options.action] : []);
      if (path.includes("/actions/"))
        return options.post403 ? Response.json({ error: "Approve this request in Cloud." }, { status: 403 }) : Response.json({});
      if (path.endsWith("/abort")) return Response.json({});
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
  const bridge = createAcpAgent(ctx);
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
        loadSession: false,
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
          { value: "model", name: "Model", description: "openai · example" },
        ],
      },
    ]);
    await h.acp.request("session/set_config_option", { sessionId: h.session.sessionId, configId: "model", value: "model" });
    expect(await h.send("Hello")).toEqual({ stopReason: "end_turn" });
    const turn = h.requests.find((r) => r.path.endsWith("/turns"));
    expect(turn?.body).toMatchObject({
      modelProfileId: "model",
      client: { kind: "acp", name: "Test Editor", cwd: h.cwd, shell: "/bin/bash", localTools: "ask" },
    });
    expect(turn?.body).not.toMatchObject({ clientToolIds: expect.arrayContaining(["code_open"]) });
    expect(turn?.body).not.toMatchObject({ clientToolIds: expect.arrayContaining(["code_secret"]) });
    expect(h.text()).toContain("Hello world");
    expect(h.updates).toContainEqual({
      sessionId: h.session.sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    });
    expect(h.updates.some((u) => u.update.sessionUpdate === "session_info_update")).toBe(true);
    expect(JSON.parse(h.defaults.get("assistant.acpSessions") ?? "[]")).toEqual([{ session: h.session.sessionId, chat: "chat" }]);
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
    h.streams.push([h.block(tool("local_write", "awaiting_client", { path: "notes.md", mode: "replace", content: "new" })), h.done()]);
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
  test("session list preserves ACP ids and resume accepts ACP and Cloud ids without replay", async () => {
    const h = await harness();
    await h.send("Hello");
    const list = await h.acp.request("session/list", { cwd: h.cwd });
    expect(list.sessions).toEqual([{ sessionId: h.session.sessionId, cwd: h.cwd, title: "Chat", updatedAt: "2026-10-11T00:00:00Z" }]);
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
    const h = await harness({ activeTurn: true });
    h.streams.push([h.delta("Previous"), h.done()], [h.delta("Next"), h.done()]);
    await h.send("Continue");
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
      permission: (request) => ({
        outcome: { outcome: "selected", optionId: request.options.some((o) => o.optionId === "session") ? "session" : "once" },
      }),
    });
    const { mkdir } = await import("node:fs/promises");
    await writeFile(join(h.cwd, "AGENTS.md"), "Use these instructions.");
    await mkdir(join(h.cwd, ".agents/skills/work"), { recursive: true });
    await writeFile(join(h.cwd, ".agents/skills/work/SKILL.md"), "---\nname: work\ndescription: Work here\n---\nFollow this Skill.");
    await h.send("/skills");
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
