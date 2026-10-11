import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_TURN_ATTACHMENT_MAX_ITEMS } from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import {
  collectActionApproval,
  collectCapabilityApproval,
  collectSurveyResult,
  collectTextEditorResult,
  completeInteractiveLine,
  runInteractiveAssistant,
} from "./interactive";
import type { LineReader } from "./line-reader";
import * as localBash from "./local-bash";
import { discoverLocalContext } from "./local-context";
import { validateLocalAttachments } from "./turn";

test("cld describes an HTTP request in the same words as the approval card", async () => {
  const printed: string[] = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { profile: "test", server: "http://example.test", token: "test", output: "json" },
    getDefault: async (key) =>
      key === "assistant.trustedFolders" ? JSON.stringify([(await discoverLocalContext(process.cwd())).root]) : undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async () => {
      throw new Error("Unused");
    },
    readJson: (response) => response.json(),
    print: (value = "") => void printed.push(value),
    write: async () => {},
    error: () => {},
    json: () => {},
    jsonLine: () => {},
    table: () => {},
  };
  const reader = { read: async () => "n", close: () => {}, onInterrupt: () => () => {} };
  const ask = async (method: string, headers: Record<string, string>) => {
    printed.length = 0;
    const request = {
      type: "http" as const,
      name: "http.fetch:https://example.com",
      id: crypto.randomUUID(),
      url: "https://example.com/data",
    };
    expect(
      await collectCapabilityApproval(ctx, reader, { ...request, method, headers, bodyBytes: 0, bodyPreview: "", bodyTruncated: false }),
    ).toEqual({ approved: false });
    return printed.join("\n");
  };
  expect(await ask("GET", { accept: "application/json" })).toContain("This request reads data from example.com.");
  for (const [method, headers] of [
    ["GET", { "x-http-method-override": "DELETE" }],
    ["DELETE", {}],
  ] as const)
    expect(await ask(method, headers)).toContain("may change data or incur charges");
});

const approvalTest = (answers: Array<string | null>) => {
  const printed: string[] = [];
  const errors: string[] = [];
  const prompts: Array<{ prompt: string; options?: { typedOnly?: boolean } }> = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { profile: "test", server: "http://example.test", token: "test", output: "text" },
    getDefault: async (key) =>
      key === "assistant.trustedFolders" ? JSON.stringify([(await discoverLocalContext(process.cwd())).root]) : undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async () => {
      throw new Error("Unused");
    },
    readJson: (response) => response.json(),
    print: (value = "") => void printed.push(value),
    write: async () => {},
    error: (value) => void errors.push(value),
    json: () => {},
    jsonLine: () => {},
    table: () => {},
  };
  const reader: LineReader = {
    read: async (prompt: string, options?: { typedOnly?: boolean }) => {
      prompts.push({ prompt, options });
      return answers.shift() ?? null;
    },
    readMessage: async () => null,
    close: () => {},
    onInterrupt: () => () => {},
  };
  return { ctx, reader, printed, errors, prompts };
};

test("Cloud approvals offer once, chat, and always and map choice 2 to chat", async () => {
  const { ctx, reader, printed, prompts } = approvalTest(["2"]);
  expect(await collectActionApproval(ctx, reader, { allowChat: true, allowAlways: true })).toEqual({ approved: true, remember: "chat" });
  expect(printed).toEqual(["Approve?", "  1. Approve once", "  2. Approve for this chat", "  3. Always approve"]);
  expect(prompts).toEqual([{ prompt: "Choice [Enter to reject]: ", options: { typedOnly: true } }]);
});

test("website approvals are never remembered from cld", async () => {
  const { ctx, reader, printed } = approvalTest(["y"]);
  expect(await collectActionApproval(ctx, reader, { allowChat: true, allowAlways: true, website: "https://example.test" })).toEqual({
    approved: true,
  });
  expect(printed).toEqual([]);
});

test("only once keeps y/N; Enter rejects and invalid answers ask again", async () => {
  const { ctx, reader, printed, prompts } = approvalTest(["a", ""]);
  expect(await collectActionApproval(ctx, reader, { allowAlways: false })).toEqual({ approved: false });
  expect(printed).toEqual([]);
  expect(prompts).toEqual([
    { prompt: "Approve? [y/N]: ", options: { typedOnly: true } },
    { prompt: "Approve? [y/N]: ", options: { typedOnly: true } },
  ]);
  const yes = approvalTest(["y"]);
  expect(await collectActionApproval(yes.ctx, yes.reader, { allowAlways: false })).toEqual({ approved: true });
});

test("numbered approvals reject Enter, retry invalid numbers, and leave EOF pending", async () => {
  const { ctx, reader, errors, prompts } = approvalTest(["9", ""]);
  expect(await collectActionApproval(ctx, reader, { allowAlways: true })).toEqual({ approved: false });
  expect(errors).toHaveLength(1);
  expect(prompts).toHaveLength(2);
  expect(prompts.every(({ options }) => options?.typedOnly)).toBeTrue();
  for (const allowAlways of [false, true]) {
    const closed = approvalTest([null]);
    expect(await collectActionApproval(closed.ctx, closed.reader, { allowAlways })).toBeNull();
  }
});

test("capability approvals offer numbered Always approve only when allowed", async () => {
  const request = {
    status: "approval" as const,
    id: "call",
    name: "mail.draft.send",
    title: "Send draft",
    input: {},
    allowAlways: true,
    appId: "mail",
    appName: "Mail",
    appIcon: "ti ti-mail",
    localId: "draft.send",
    kind: "action" as const,
    schemaHash: "test",
    approval: "rememberable" as const,
    review: null,
    scope: null,
  };
  const always = approvalTest(["2"]);
  expect(await collectCapabilityApproval(always.ctx, always.reader, request)).toEqual({ approved: true, remember: "always" });
  expect(always.printed.slice(-3)).toEqual(["Approve?", "  1. Approve once", "  2. Always approve"]);
  const once = approvalTest(["y"]);
  expect(await collectCapabilityApproval(once.ctx, once.reader, { ...request, allowAlways: false })).toEqual({ approved: true });
  expect(once.prompts).toEqual([{ prompt: "Approve? [y/N]: ", options: { typedOnly: true } }]);
  const cancelled = approvalTest([null]);
  expect(await collectCapabilityApproval(cancelled.ctx, cancelled.reader, request)).toEqual({ approved: false });
});

test("text editor confirmation requires typed input and surveys allow pasted free text", async () => {
  const editor = approvalTest([""]);
  expect(await collectTextEditorResult(editor.ctx, editor.reader, { title: "Text", content: "Hello" })).toMatchObject({
    submitted: true,
    content: "Hello",
  });
  expect(editor.prompts[0]).toEqual({ prompt: "Use this text? [Y/e=edit/c=cancel]: ", options: { typedOnly: true } });
  const survey = approvalTest(["one\ntwo"]);
  expect(
    await collectSurveyResult(survey.ctx, survey.reader, {
      title: "Details",
      questions: [{ id: "details", type: "text", label: "Details", required: true }],
    }),
  ).toEqual({ submitted: true, answers: { details: "one\ntwo" } });
  expect(survey.prompts[0]?.options).toBeUndefined();
});

const attachmentSession = async (messages: string[], answers: Array<string | null>, attachments?: string[]) => {
  const session = approvalTest(answers);
  const uploads: string[] = [];
  const drafts: unknown[] = [];
  const conversation = { id: "chat", draft: { content: [], revision: 0 } };
  session.reader.readMessage = async () => messages.shift() ?? null;
  session.ctx.fetch = async (path, init) => {
    if (path === "/api/ai/skills") return Response.json({ skills: [] });
    if (path === "/api/ai/status") return Response.json({});
    if (path === "/api/ai/conversations") return Response.json(conversation);
    if (path === "/api/ai/conversations/chat") return Response.json({ conversation, activeTurn: null });
    if (path === "/api/ai/conversations/chat/draft") {
      drafts.push(JSON.parse(String(init?.body)));
      return Response.json({ revision: 1 });
    }
    if (path === "/api/ai/conversations/chat/files") {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error("Expected attachment form");
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("Expected file");
      uploads.push(file.name);
      return Response.json({ file: { path: `/${file.name}`, mediaType: file.type, size: file.size, version: 1 } });
    }
    if (path === "/api/ai/conversations/chat/turns") return Response.json({ turn: { id: "turn" } });
    if (path === "/api/ai/conversations/chat/stream")
      return new Response(
        `data: ${JSON.stringify({
          v: 1,
          type: "turn_finished",
          conversationId: "chat",
          turnId: "turn",
          attempt: 1,
          seq: 1,
          status: "completed",
          error: null,
          messages: [],
        })}\n\n`,
      );
    throw new Error(`Unexpected path: ${path}`);
  };
  const code = await runInteractiveAssistant(session.ctx, { attachments }, session.reader);
  return { ...session, code, uploads, drafts };
};

test("@files share attachment policy, dedupe with /attach, and preserve the message text", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  try {
    const path = join(directory, "report.txt");
    writeFileSync(path, "report");
    symlinkSync(path, join(directory, "alias"));
    const message = `Read @${path}, @${join(directory, "alias")} @team`;
    const session = await attachmentSession([`/attach ${path}`, message, "/exit"], []);
    expect(session.code).toBe(0);
    expect(session.uploads).toEqual(["report.txt"]);
    expect(session.prompts).toEqual([]);
    expect(session.drafts).toEqual([
      {
        expectedRevision: 0,
        content: [
          { type: "text", text: message },
          { type: "file", path: "/report.txt", mediaType: "text/plain;charset=utf-8", size: 6, version: 1 },
        ],
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("declining an outside @file still sends the unchanged message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-attach-"));
  try {
    const path = join(directory, "outside.txt");
    writeFileSync(path, "outside");
    const message = `Read @${path}`;
    const session = await attachmentSession([message, "/exit"], [""]);
    expect(session.uploads).toEqual([]);
    expect(session.prompts).toEqual([{ prompt: `Attach ${path}? It is outside ${process.cwd()}. [y/N]: `, options: { typedOnly: true } }]);
    expect(session.printed).toContain(`Not attached: ${path}`);
    expect(session.drafts).toEqual([{ expectedRevision: 0, content: [{ type: "text", text: message }] }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/attach asks for protected files and never attaches cld configuration", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  try {
    const secret = join(directory, ".env.local");
    writeFileSync(secret, "private");
    const configDirectory = join(directory, "cloud/cld");
    mkdirSync(configDirectory, { recursive: true });
    const config = join(configDirectory, "config.json");
    writeFileSync(config, "{}");
    process.env.XDG_CONFIG_HOME = directory;
    const message = `Read @${config}`;
    const session = await attachmentSession([`/attach ${secret}`, `/attach ${config}`, message, "/exit"], ["y"]);
    expect(session.uploads).toEqual([".env.local"]);
    expect(session.prompts).toEqual([{ prompt: `Attach ${secret}? It may contain secrets. [y/N]: `, options: { typedOnly: true } }]);
    expect(session.errors).toEqual([`Not attached: ${config} is cld's configuration.`, `Not attached: ${config} is cld's configuration.`]);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a protected @ symlink asks before attaching its ordinary target", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  try {
    const target = join(directory, "secrets.txt");
    const alias = join(directory, ".env");
    writeFileSync(target, "private");
    symlinkSync(target, alias);
    const session = await attachmentSession([`Read @${alias}`, "/exit"], [null]);
    expect(session.prompts).toEqual([{ prompt: `Attach ${alias}? It may contain secrets. [y/N]: `, options: { typedOnly: true } }]);
    expect(session.uploads).toEqual([]);
    expect(session.printed).toContain(`Not attached: ${alias}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--attach refuses cld configuration and print-mode validation rejects it too", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  try {
    const configDirectory = join(directory, "cloud/cld");
    mkdirSync(configDirectory, { recursive: true });
    const config = join(configDirectory, "config.json");
    writeFileSync(config, "{}");
    process.env.XDG_CONFIG_HOME = directory;
    const session = await attachmentSession(["hello", "/exit"], [], [config]);
    expect(session.errors).toEqual([`Not attached: ${config} is cld's configuration.`]);
    expect(session.uploads).toEqual([]);
    expect(session.prompts).toEqual([]);
    await expect(validateLocalAttachments([config])).rejects.toThrow(`Not attached: ${config} is cld's configuration.`);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--attach asks for outside files and deduplicates real files with mentions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-attach-"));
  try {
    const path = join(directory, "outside.txt");
    const alias = join(directory, "alias.txt");
    writeFileSync(path, "outside");
    symlinkSync(path, alias);
    const session = await attachmentSession([`Read @${alias}`, "/exit"], ["y"], [path, alias]);
    expect(session.uploads).toEqual(["outside.txt"]);
    expect(session.prompts).toEqual([{ prompt: `Attach ${path}? It is outside ${process.cwd()}. [y/N]: `, options: { typedOnly: true } }]);
    expect(session.errors).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing --attach file fails before opening the chat or reading messages", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  try {
    const path = join(directory, "missing.txt");
    const messages = ["/exit"];
    const session = interactiveSession(messages, [], { conversationId: "old", attachments: [path] });
    await expect(session.run()).rejects.toThrow(`Attachment not found: ${path}`);
    expect(messages).toEqual(["/exit"]);
    expect(session.requests.map((request) => request.path)).toEqual(["/api/ai/status", "/api/ai/skills"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("spaced @files print one attachment notice for each newly attached file", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  try {
    const path = join(directory, "quarterly report.pdf");
    writeFileSync(path, "report");
    const token = `@${path.replace(/\s/g, "\\$&")}`;
    const session = await attachmentSession([`Read ${token} ${token}`, "/exit"], []);
    expect(session.uploads).toEqual(["quarterly report.pdf"]);
    expect(session.printed.filter((line) => line.includes("Attached: quarterly report.pdf"))).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the attachment limit counts explicit attachments and @files together", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  try {
    const existing = Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS }, (_, index) => {
      const path = join(directory, `existing-${index}.txt`);
      writeFileSync(path, "existing");
      return path;
    });
    const added = join(directory, "added.txt");
    writeFileSync(added, "added");
    const session = await attachmentSession([`Read @${added}`, "/exit"], [], existing);
    expect(session.uploads).toEqual([]);
    expect(session.drafts).toEqual([]);
    expect(session.errors).toEqual([`At most ${AI_TURN_ATTACHMENT_MAX_ITEMS} attachments can be sent with one message.`]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const chat = (id: string, projectId: string | null = null) => ({
  id,
  shortId: id,
  title: `Chat ${id}`,
  projectId,
  draft: { content: [], revision: 0 },
  runStatus: "idle",
  unreadCompletion: false,
  updatedAt: "2026-10-10T12:00:00Z",
});
const finishedStream = (conversationId: string, turnId = "turn-1", status = "completed") =>
  new Response(
    `data: ${JSON.stringify({
      v: 1,
      type: "turn_finished",
      conversationId,
      turnId,
      attempt: 1,
      seq: 2,
      status,
      error: null,
      messages: [],
    })}\n\n`,
  );
const pendingStream = (conversationId: string, name = "local_bash", status = "awaiting_client") =>
  new Response(
    `data: ${JSON.stringify({
      type: "state",
      conversation: chat(conversationId),
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
            name,
            args: { command: "echo should-not-run" },
            status,
          },
        ],
      },
    })}\n\n`,
  );

type SessionRequest = { path: string; method: string; body: unknown };
const interactiveSession = (
  messages: string[],
  answers: Array<string | null> = [],
  options: Parameters<typeof runInteractiveAssistant>[1] = {},
  saved?: string,
  route?: (path: string, init?: RequestInit) => Response | undefined,
) => {
  const session = approvalTest(answers);
  const requests: SessionRequest[] = [];
  const defaults: Array<{ key: string; value: string | undefined }> = [];
  const chats = new Map(["old", "resumed"].map((id) => [id, chat(id)]));
  let turns = 0;
  let creations = 0;
  session.ctx.options.locale = "en-GB";
  session.ctx.getDefault = async (key) =>
    key === "assistant.trustedFolders" ? JSON.stringify([(await discoverLocalContext(process.cwd())).root]) : saved;
  session.ctx.setDefault = async (key, value) => {
    defaults.push({ key, value });
  };
  session.reader.readMessage = async () => messages.shift() ?? null;
  session.ctx.fetch = async (path, init) => {
    requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
    const response = route?.(path, init);
    if (response) return response;
    if (path === "/api/ai/skills") return Response.json({ skills: [] });
    if (path === "/api/ai/status") return Response.json({});
    if (path === "/api/ai/models") return Response.json([{ id: "model", label: "Test model", provider: "test", model: "test" }]);
    if (path === "/api/ai/projects")
      return Response.json({ projects: [{ id: "project-uuid", shortId: "proj", name: "Project", description: "Shared\nwork" }] });
    if (path === "/api/ai/conversations?limit=20") return Response.json([...chats.values()]);
    if (path === "/api/ai/conversations" && init?.method === "POST") {
      const body: { projectId?: string } = JSON.parse(String(init.body));
      const conversation = chat(`new-${++creations}`, body.projectId);
      chats.set(conversation.id, conversation);
      return Response.json(conversation);
    }
    const match = path.match(/^\/api\/ai\/conversations\/([^/]+)(.*)$/);
    if (match) {
      const [, id = "", suffix] = match;
      const conversation = chats.get(id) ?? chat(id);
      if (!suffix) return Response.json({ conversation, activeTurn: null, messages: [] });
      if (suffix === "/draft") return Response.json({ revision: 1 });
      if (suffix === "/project") {
        const body: { projectId: string | null } = JSON.parse(String(init?.body));
        const updated = { ...conversation, projectId: body.projectId };
        chats.set(id, updated);
        return Response.json(updated);
      }
      if (suffix === "/turns" || suffix?.endsWith("/retry")) return Response.json({ turn: { id: `turn-${++turns}` } });
      if (suffix === "/stream") return finishedStream(id, `turn-${turns + 1}`);
      if (suffix?.endsWith("/abort") || suffix?.includes("/actions/")) return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  };
  return { ...session, requests, defaults, chats, run: () => runInteractiveAssistant(session.ctx, options, session.reader) };
};

const submissions = (session: ReturnType<typeof interactiveSession>) =>
  session.requests.filter((request) => request.path.endsWith("/turns"));

test("Ctrl+C at /model cancels the picker and keeps reading messages", async () => {
  const messages = ["/model", "hello", "/exit"];
  const session = interactiveSession(messages);
  let interrupt: (question: boolean) => void = () => {};
  session.reader.onInterrupt = (handler) => {
    interrupt = handler;
    return () => {};
  };
  session.reader.read = async () => {
    interrupt(true);
    return null;
  };
  expect(await session.run()).toBe(0);
  expect(messages).toEqual([]);
  expect(submissions(session)).toHaveLength(1);
});

test.each(["local_bash", "server_tool"])("Ctrl+C at a %s question stops the turn and keeps the session", async (name) => {
  const messages = ["hello", "/exit"];
  const session = interactiveSession(messages, [], {}, undefined, (path) => {
    if (path.endsWith("/stream")) return pendingStream("new-1", name, name === "local_bash" ? "awaiting_client" : "awaiting_approval");
    if (path.endsWith("/pending-actions/turn-1"))
      return Response.json([
        {
          type: name === "local_bash" ? "frontend_tool" : "approval_request",
          conversationId: "new-1",
          turnId: "turn-1",
          callId: "call-1",
          name,
          args: { command: "echo should-not-run" },
          mode: "client",
        },
      ]);
  });
  let interrupt: (question: boolean) => void = () => {};
  session.reader.onInterrupt = (handler) => {
    interrupt = handler;
    return () => {};
  };
  session.reader.read = async () => {
    interrupt(true);
    return null;
  };
  expect(await session.run()).toBe(0);
  expect(messages).toEqual([]);
  expect(session.requests.find((request) => request.path.endsWith("/abort"))).toMatchObject({ method: "POST" });
  expect(session.requests.some((request) => request.path.includes("/actions/"))).toBeFalse();
  expect(session.printed.join("\n")).toContain("Turn stopped.");
});

test.each([false, true])("Ctrl+C during local Bash stops without submitting a result (throws: %s)", async (throws) => {
  const messages = ["hello", "/exit"];
  let interrupt: (question: boolean) => void = () => {};
  const session = interactiveSession(messages, ["y"], {}, undefined, (path) => {
    if (path.endsWith("/stream")) return pendingStream("new-1");
    if (path.endsWith("/pending-actions/turn-1"))
      return Response.json([
        {
          type: "frontend_tool",
          conversationId: "new-1",
          turnId: "turn-1",
          callId: "call-1",
          name: "local_bash",
          args: { command: "echo should-not-run" },
          mode: "client",
        },
      ]);
  });
  session.reader.onInterrupt = (handler) => {
    interrupt = handler;
    return () => {};
  };
  const bash = spyOn(localBash, "runLocalBash").mockImplementation(async (_command, options) => {
    interrupt(false);
    expect(options?.signal?.aborted).toBeTrue();
    if (throws) throw new DOMException("Stopped", "AbortError");
    return { status: "completed", exitCode: 0, stdout: "done", stderr: "", truncated: false };
  });
  try {
    expect(await session.run()).toBe(0);
    expect(bash).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
    expect(session.requests.some((request) => request.path.includes("/actions/"))).toBeFalse();
    expect(session.requests.find((request) => request.path.endsWith("/abort"))).toMatchObject({ method: "POST" });
    expect(session.printed.join("\n")).toContain("Turn stopped.");
  } finally {
    bash.mockRestore();
  }
});

test.each(["stream", "pending-actions"])("an interrupt during %s prevents pending questions on a resumed turn", async (stage) => {
  let interrupt: (question: boolean) => void = () => {};
  const session = interactiveSession([], [], { conversationId: "old" }, undefined, (path) => {
    if (path === "/api/ai/conversations/old")
      return Response.json({ conversation: chat("old"), activeTurn: { turnId: "turn-1", status: "waiting_for_action" } });
    if (path.endsWith("/stream")) {
      if (stage === "stream") interrupt(false);
      return pendingStream("old", "survey");
    }
    if (path.endsWith("/pending-actions/turn-1")) {
      interrupt(false);
      return Response.json([{ type: "frontend_tool", name: "local_bash", args: { command: "echo should-not-run" } }]);
    }
  });
  session.reader.onInterrupt = (handler) => {
    interrupt = handler;
    return () => {};
  };
  expect(await session.run()).toBe(130);
  expect(session.prompts).toEqual([]);
  expect(session.requests.find((request) => request.path.endsWith("/abort"))).toMatchObject({ method: "POST" });
  expect(session.requests.some((request) => request.path.includes("/actions/"))).toBeFalse();
});

test("unknown commands are explained and never sent; absolute paths remain messages", async () => {
  const session = interactiveSession(["/unknown extra", "/etc/hosts is broken", "/exit"]);
  expect(await session.run()).toBe(0);
  expect(session.errors).toContain("Unknown command /unknown. Type /help for the list.");
  expect(submissions(session)).toHaveLength(1);
  expect(session.requests.find((request) => request.path.endsWith("/draft"))?.body).toMatchObject({
    content: [{ type: "text", text: "/etc/hosts is broken" }],
  });
});

test.each([
  { saved: undefined, options: {}, mode: "ask", source: "default" },
  { saved: "off", options: {}, mode: "off", source: "profile default" },
  { saved: "ask", options: {}, mode: "ask", source: "default" },
  { saved: "always", options: {}, mode: "ask", source: "default" },
  { saved: "off", options: { allowBash: true }, mode: "ask", source: "this session" },
  { saved: undefined, options: { allowBash: true }, mode: "ask", source: "this session" },
  { saved: undefined, options: { noBash: true }, mode: "off", source: "this session" },
  { saved: "off", options: { noBash: true }, mode: "off", source: "this session" },
])("local tools mode resolves flags and saved default: %j", async ({ saved, options, mode, source }) => {
  const session = interactiveSession(["/status", "hello", "/exit"], [], options, saved);
  expect(await session.run()).toBe(0);
  const body = submissions(session)[0]?.body;
  expect(body).toHaveProperty("clientToolIds");
  if (mode === "ask") expect(body).toMatchObject({ clientToolIds: expect.arrayContaining(["local_bash"]) });
  else expect(body).toMatchObject({ clientToolIds: expect.not.arrayContaining(["local_bash"]) });
  expect(session.printed.join("\n")).toContain(`${mode} (${source}) · ${process.cwd()}`);
  expect(session.printed.join("\n")).toContain(`Local tools: ${mode}`);
});

test("conflicting Bash flags fail before a session reads its default", async () => {
  const session = interactiveSession([], [], { allowBash: true, noBash: true });
  await expect(session.run()).rejects.toThrow("Pass either --allow-bash or --no-bash.");
  expect(session.requests).toHaveLength(0);
});

test.each([
  { saved: undefined, choice: "2", value: "off", mode: "off" },
  { saved: "off", choice: "1", value: undefined, mode: "ask" },
])("/permissions saves only off and removes the key for ask: %j", async ({ saved, choice, value, mode }) => {
  const session = interactiveSession(["/permissions", "hello", "/exit"], [choice, "y"], {}, saved);
  expect(await session.run()).toBe(0);
  expect(session.defaults).toEqual([{ key: "assistant.localTools", value }]);
  expect(session.prompts).toEqual([
    { prompt: "Choice [Enter to cancel]: ", options: { typedOnly: true } },
    { prompt: 'Save as default for profile "test"? [y/N]: ', options: { typedOnly: true } },
  ]);
  expect(session.printed.join("\n")).toContain(`Local tools: ${mode} for this session.`);
  expect(session.printed).toContain("Cloud approvals: /approvals");
});

test("/permissions argument changes the next turn without touching the profile", async () => {
  const session = interactiveSession(["first", "/permissions off", "second", "/permissions ask", "third", "/exit"]);
  expect(await session.run()).toBe(0);
  const turns = submissions(session);
  expect(turns[0]?.body).toMatchObject({ clientToolIds: expect.arrayContaining(["local_bash"]) });
  expect(turns[1]?.body).toMatchObject({ clientToolIds: expect.not.arrayContaining(["local_bash"]) });
  expect(turns[2]?.body).toMatchObject({ clientToolIds: expect.arrayContaining(["local_bash"]) });
  expect(session.defaults).toEqual([]);
  expect(session.prompts).toEqual([]);
});

test("/permissions skips saving the current default, cancels on Enter, and points invalid input to Cloud approvals", async () => {
  const session = interactiveSession(["/permissions", "/permissions", "/permissions always", "/exit"], ["1", ""]);
  expect(await session.run()).toBe(0);
  expect(session.prompts).toHaveLength(2);
  expect(session.defaults).toEqual([]);
  expect(session.errors).toContain("Use /permissions, /permissions ask, or /permissions off.");
  expect(session.printed.filter((line) => line === "Cloud approvals: /approvals")).toHaveLength(3);
  expect(session.requests.map((request) => request.path)).toEqual(["/api/ai/status", "/api/ai/skills"]);
});

test("/resume switches chats, adopts the Project, and denies pending Bash while off", async () => {
  let streams = 0;
  const session = interactiveSession(["/resume resumed", "/status", "/new", "hello", "/exit"], [], { noBash: true }, undefined, (path) => {
    if (path === "/api/ai/conversations/resumed")
      return Response.json({ conversation: chat("resumed", "proj"), activeTurn: { turnId: "turn-1", status: "waiting_for_action" } });
    if (path === "/api/ai/conversations/resumed/stream") return ++streams === 1 ? pendingStream("resumed") : finishedStream("resumed");
    if (path === "/api/ai/conversations/resumed/pending-actions/turn-1")
      return Response.json([
        {
          type: "frontend_tool",
          conversationId: "resumed",
          turnId: "turn-1",
          callId: "call-1",
          name: "local_bash",
          args: { command: "echo should-not-run" },
          mode: "client",
        },
      ]);
  });
  expect(await session.run()).toBe(0);
  expect(streams).toBe(2);
  expect(session.prompts).toEqual([]);
  expect(session.requests.find((request) => request.path.endsWith("/actions/call-1"))?.body).toMatchObject({
    type: "tool_result",
    result: { status: "denied", stderr: "Local tools are off in this session." },
  });
  expect(session.printed.join("\n")).toContain("Chat: Chat resumed (resumed)");
  expect(session.printed.join("\n")).toContain("Project (proj)");
  expect(submissions(session).every((request) => !request.path.includes("resumed"))).toBeTrue();
  expect(session.requests.find((request) => request.path === "/api/ai/conversations")?.body).toEqual({ projectId: "proj" });
});

test("pending unsupported tools leave exit code 2 on both submitted and resumed turns", async () => {
  for (const conversationId of [undefined, "old"]) {
    const session = interactiveSession(conversationId ? [] : ["hello"], [], { conversationId }, undefined, (path) => {
      if (path === "/api/ai/conversations/old")
        return Response.json({ conversation: chat("old"), activeTurn: { turnId: "turn-1", status: "waiting_for_action" } });
      if (path.endsWith("/stream")) return pendingStream(conversationId ?? "new-1", "unsupported");
      if (path.endsWith("/pending-actions/turn-1"))
        return Response.json([
          {
            type: "frontend_tool",
            conversationId: conversationId ?? "new-1",
            turnId: "turn-1",
            callId: "call-1",
            name: "unsupported",
            args: {},
            mode: "client",
          },
        ]);
    });
    expect(await session.run()).toBe(2);
  }
});

test("/resume picker shows statuses, dates, and the current chat", async () => {
  const date = "2026-10-10T12:00:00Z";
  const session = interactiveSession(["/resume", "/exit"], ["2"], { conversationId: "old" }, undefined, (path) => {
    if (path === "/api/ai/conversations?limit=20")
      return Response.json([
        { ...chat("old"), runStatus: "running" },
        { ...chat("resumed"), runStatus: "needs_attention" },
        { ...chat("failed"), runStatus: "failed" },
        { ...chat("unread"), unreadCompletion: true },
        chat("idle"),
      ]);
  });
  expect(await session.run()).toBe(0);
  expect(session.printed).toContain("  1. Chat old · running [current]");
  expect(session.printed).toContain("  2. Chat resumed · needs attention");
  expect(session.printed).toContain("  3. Chat failed · failed");
  expect(session.printed).toContain("  4. Chat unread · unread");
  expect(session.printed).toContain(
    `  5. Chat idle · ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date))}`,
  );
  expect(session.printed.join("\n")).toContain("Chat: Chat resumed (resumed)");
});

test("/new forgets the chat while preserving session choices and queued attachments", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  try {
    const file = join(directory, "queued.txt");
    writeFileSync(file, "queued");
    let uploads = 0;
    const session = interactiveSession(
      [`/attach ${file}`, "/new", "/status", "hello", "/new", "again", "/exit"],
      [],
      { conversationId: "old", model: "model", noBash: true },
      undefined,
      (path) => {
        if (path.endsWith("/files")) {
          uploads++;
          return Response.json({ file: { path: "/queued.txt", mediaType: "text/plain", size: 6, version: 1 } });
        }
      },
    );
    expect(await session.run()).toBe(0);
    expect(uploads).toBe(1);
    expect(session.requests.filter((request) => request.path === "/api/ai/conversations")).toHaveLength(2);
    expect(submissions(session).map((request) => request.path)).toEqual([
      "/api/ai/conversations/new-1/turns",
      "/api/ai/conversations/new-2/turns",
    ]);
    expect(submissions(session)[0]?.body).toMatchObject({
      modelProfileId: "model",
      clientToolIds: expect.not.arrayContaining(["local_bash"]),
    });
    const output = session.printed.join("\n");
    expect(output.indexOf("cld assistant --chat old")).toBeLessThan(output.indexOf("The next message starts a new chat."));
    expect(output).toContain("none yet · the next message starts one");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/project none on an open chat sends null; a new chat uses the selected Project short ID", async () => {
  const session = interactiveSession(["/project none", "/new", "/project", "hello", "/exit"], ["1"], { conversationId: "old" });
  expect(await session.run()).toBe(0);
  expect(session.requests.find((request) => request.path.endsWith("/project"))).toMatchObject({ method: "PUT", body: { projectId: null } });
  expect(session.requests.find((request) => request.path === "/api/ai/conversations")?.body).toEqual({ projectId: "proj" });
  expect(session.printed).toContain("  0. No Project [current]");
  expect(session.printed).toContain("  1. Project · Shared work");
  expect(session.printed.join("\n")).toContain("Project: none");
});

test("Project refusal keeps the server error and session Project", async () => {
  const message = "Wait for the active turn before changing the Project.";
  const session = interactiveSession(["/project none", "/status", "/exit"], [], { conversationId: "old" }, undefined, (path) => {
    if (path === "/api/ai/conversations/old/project") return Response.json({ message }, { status: 409 });
  });
  session.ctx.readJson = async (response) => {
    if (!response.ok) throw new Error(message);
    return response.json();
  };
  expect(await session.run()).toBe(0);
  expect(session.errors).toContain(message);
});

test.each(["retry", "details", "concise"])("/retry %s posts to the last stored user message with the session model", async (mode) => {
  const session = interactiveSession([`/retry ${mode}`, "/exit"], [], { conversationId: "old", model: "model" }, undefined, (path) => {
    if (path === "/api/ai/conversations/old")
      return Response.json({
        conversation: chat("old"),
        activeTurn: null,
        messages: [
          { id: "first", kind: "message", message: { role: "user" } },
          { id: "summary", kind: "summary", message: { role: "user" } },
          { id: "last", kind: "message", message: { role: "user" } },
          { id: "answer", kind: "message", message: { role: "assistant" } },
        ],
      });
  });
  expect(await session.run()).toBe(0);
  expect(session.requests.find((request) => request.path.endsWith("/retry"))).toMatchObject({
    path: "/api/ai/conversations/old/messages/last/retry",
    method: "POST",
    body: { mode, modelProfileId: "model" },
  });
  expect(session.requests.some((request) => request.path.endsWith("/draft"))).toBeFalse();
});

test("/retry searches older history for the last user message", async () => {
  const session = interactiveSession(["/retry details", "/exit"], [], { conversationId: "old" }, undefined, (path) => {
    if (path === "/api/ai/conversations/old")
      return Response.json({
        conversation: chat("old"),
        activeTurn: null,
        hasMoreMessages: true,
        messages: [
          { id: "tool", seq: 201, kind: "message", message: { role: "tool_result" } },
          { id: "answer", seq: 202, kind: "message", message: { role: "assistant" } },
        ],
      });
    if (path === "/api/ai/conversations/old/messages?before=201&limit=200")
      return Response.json({
        hasMore: true,
        messages: [
          { id: "first", seq: 1, kind: "message", message: { role: "user" } },
          { id: "last", seq: 2, kind: "message", message: { role: "user" } },
          { id: "summary", seq: 3, kind: "summary", message: { role: "user" } },
        ],
      });
  });
  expect(await session.run()).toBe(0);
  expect(session.requests.find((request) => request.path.endsWith("/retry"))).toMatchObject({
    path: "/api/ai/conversations/old/messages/last/retry",
    method: "POST",
    body: { mode: "details" },
  });
  expect(session.requests.filter((request) => request.path.includes("/messages?"))).toHaveLength(1);
});

test("/retry picker uses the web actions and reports missing user messages", async () => {
  const session = interactiveSession(["/retry", "/exit"], [], { conversationId: "old" });
  expect(await session.run()).toBe(0);
  expect(session.printed).toContain("Nothing to answer again yet.");
  const picker = interactiveSession(["/retry", "/exit"], ["2"], { conversationId: "old" }, undefined, (path) => {
    if (path === "/api/ai/conversations/old")
      return Response.json({
        conversation: chat("old"),
        activeTurn: null,
        messages: [{ id: "last", kind: "message", message: { role: "user" } }],
      });
  });
  expect(await picker.run()).toBe(0);
  expect(picker.printed).toContain("Answer again:");
  expect(picker.printed).toContain("  1. Try again");
  expect(picker.printed).toContain("  2. More detailed");
  expect(picker.printed).toContain("  3. More concise");
  expect(picker.requests.find((request) => request.path.endsWith("/retry"))?.body).toEqual({ mode: "details" });
});

test("/web prints the URL before opening it and works without a host opener", async () => {
  const session = interactiveSession(["/web", "/resume resumed", "/web", "/exit"]);
  session.ctx.options.server = "https://cloud.example/";
  const opened: string[] = [];
  session.ctx.openUrl = async (url) => {
    expect(session.printed.at(-1)).toBe(url);
    opened.push(url);
    return true;
  };
  expect(await session.run()).toBe(0);
  expect(opened).toEqual(["https://cloud.example/app/assistant", "https://cloud.example/app/assistant?conversation=resumed"]);
  expect(session.printed.join("\n")).toContain("Opened in your browser.");
  const absent = interactiveSession(["/web", "/exit"]);
  expect(await absent.run()).toBe(0);
  expect(absent.printed).toContain("http://example.test/app/assistant");
  expect(absent.printed.join("\n")).not.toContain("Opened in your browser.");
});

test("/usage formats shares, resets, unlimited models, and unknown usage", async () => {
  const date = "2026-11-01T00:00:00Z";
  const session = interactiveSession(["/usage", "/exit"], [], {}, undefined, (path) => {
    if (path === "/api/ai/quotas")
      return Response.json({
        enabled: true,
        unlimitedModels: ["model", "other"],
        balances: [
          { scope: "*", unlimited: false, usedPercent: 42, resetsAt: date },
          { scope: "model", unlimited: true, usedPercent: null, resetsAt: null },
          { scope: "other", unlimited: false, usedPercent: null, resetsAt: null },
        ],
      });
  });
  expect(await session.run()).toBe(0);
  expect(session.printed).toContain(
    `All models  42% used · resets ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date))}`,
  );
  expect(session.printed).toContain("Test model  no limit");
  expect(session.printed).toContain("other  usage unknown");
  expect(session.printed).toContain("Not counted: Test model, other");
  const disabled = interactiveSession(["/usage", "/exit"], [], {}, undefined, (path) =>
    path === "/api/ai/quotas" ? Response.json({ enabled: false, balances: [] }) : undefined,
  );
  expect(await disabled.run()).toBe(0);
  expect(disabled.printed).toContain("No usage limits apply.");
  expect(disabled.requests.some((request) => request.path === "/api/ai/models")).toBeFalse();
});

test("/approvals lists both scopes including websites and revokes the selected exact id", async () => {
  const session = interactiveSession(["/approvals", "/exit"], ["2"], { conversationId: "old" }, undefined, (path, init) => {
    if (path === "/api/ai/approval-preferences")
      return Response.json({
        approvals: [{ id: "everywhere", title: "Create task", app: { name: "Spaces" }, website: null, conversationId: null }],
      });
    if (path === "/api/ai/approval-preferences?conversation=old")
      return Response.json({
        approvals: [
          {
            id: "website",
            title: "example.com",
            app: null,
            website: { origin: "https://example.com", resourceId: null },
            conversationId: "chat-uuid",
          },
        ],
      });
    if (path === "/api/ai/approval-preferences/website" && init?.method === "DELETE") return Response.json({ deleted: true });
  });
  expect(await session.run()).toBe(0);
  expect(session.printed).toContain("  1. Create task · Spaces · everywhere");
  expect(session.printed).toContain("  2. example.com · Website · this chat");
  expect(session.requests.filter((request) => request.method === "DELETE")).toMatchObject([
    { path: "/api/ai/approval-preferences/website" },
  ]);
  expect(session.printed.join("\n")).toContain("Revoked: example.com (this chat).");
  expect(session.prompts).toEqual([{ prompt: "Revoke [Enter to cancel]: ", options: { typedOnly: true } }]);
});

test("/approvals supports a direct id and the empty list", async () => {
  const session = interactiveSession(["/approvals preference", "/approvals", "/exit"], [], {}, undefined, (path, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    if (path === "/api/ai/approval-preferences")
      return Response.json({
        approvals: session.requests.some((request) => request.method === "DELETE")
          ? []
          : [{ id: "preference", title: "Edit note", app: { name: "Notebooks" }, conversationId: null }],
      });
  });
  expect(await session.run()).toBe(0);
  expect(session.requests.find((request) => request.method === "DELETE")?.path).toBe("/api/ai/approval-preferences/preference");
  expect(session.printed).toContain("No remembered Cloud approvals.");
  expect(session.prompts).toEqual([]);
});

test("home or above asks factually for every file and explains it at startup", async () => {
  const directory = mkdtempSync(join(import.meta.dir, ".attachment-test-"));
  const file = join(directory, "inside.txt");
  writeFileSync(file, "inside");
  const cwd = spyOn(process, "cwd").mockReturnValue("/");
  try {
    const session = interactiveSession([`/attach ${file}`, "/status", "/exit"], [""]);
    expect(await session.run()).toBe(0);
    expect(session.prompts).toEqual([
      {
        prompt: `Attach ${file}? You started cld in your home folder or above, so every file asks first. [y/N]: `,
        options: { typedOnly: true },
      },
    ]);
    expect(session.printed.join("\n")).toContain("/ is your home folder or above, so every file access asks first.");
    expect(session.printed.join("\n")).toContain("ask (default) · /");
  } finally {
    cwd.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/status aligns escaped values and falls back to inaccessible Project ids", async () => {
  const session = interactiveSession(["/status", "/exit"], [], { conversationId: "old", model: "missing-model" }, undefined, (path) => {
    if (path === "/api/ai/conversations/old")
      return Response.json({ conversation: { ...chat("old", "missing-project"), title: "Chat\u001b[2J" }, activeTurn: null });
  });
  session.ctx.options.profile = "profile\u001b[2J";
  expect(await session.run()).toBe(0);
  expect(session.printed).toContain("Profile      profile\\u001b[2J · http://example.test");
  expect(session.printed).toContain("Chat         old · Chat\\u001b[2J");
  expect(session.printed).toContain("Model        missing-model");
  expect(session.printed).toContain("Project      missing-project (missing-project)");
});

test.each([403, 503])("/status prints its rows when Cloud Skills returns %s", async (status) => {
  const session = interactiveSession(["/status", "/skills", "/exit"], [], {}, undefined, (path) => {
    if (path === "/api/ai/skills") return Response.json({ message: "Skills unavailable" }, { status });
  });
  expect(await session.run()).toBe(0);
  expect(session.printed).toContain("Profile      test · http://example.test");
  expect(session.printed).toContain("Chat         none yet · the next message starts one");
  expect(session.printed.some((line) => line.startsWith("Local tools  ask"))).toBeTrue();
  expect(session.errors).toEqual([]);
});

test("turn runner keeps failed and stopped turns interactive", async () => {
  for (const status of ["failed", "aborted"]) {
    const session = interactiveSession(["/resume resumed", "/exit"], [], {}, undefined, (path) => {
      if (path === "/api/ai/conversations/resumed")
        return Response.json({ conversation: chat("resumed"), activeTurn: { turnId: "turn-1", status: "running" } });
      if (path === "/api/ai/conversations/resumed/stream") return finishedStream("resumed", "turn-1", status);
    });
    expect(await session.run()).toBe(0);
    if (status === "failed") expect(session.errors).toContain("Assistant turn failed.");
    else expect(session.requests.find((request) => request.path.endsWith("/abort"))).toMatchObject({ method: "POST" });
  }
  const startup = interactiveSession([], [], { conversationId: "resumed" }, undefined, (path) => {
    if (path === "/api/ai/conversations/resumed")
      return Response.json({ conversation: chat("resumed"), activeTurn: { turnId: "turn-1", status: "running" } });
    if (path === "/api/ai/conversations/resumed/stream") return finishedStream("resumed", "turn-1", "aborted");
  });
  expect(await startup.run()).toBe(130);
  const submitted = interactiveSession(["hello", "/exit"], [], {}, undefined, (path) =>
    path.endsWith("/stream") ? finishedStream("new-1", "turn-1", "aborted") : undefined,
  );
  expect(await submitted.run()).toBe(0);
  expect(submitted.requests.find((request) => request.path.endsWith("/abort"))).toMatchObject({ method: "POST" });
});

test("local and Cloud Skill commands share a list, local precedence, and one-message selections", async () => {
  const previous = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "cld-skills-interactive-"));
  try {
    writeFileSync(join(directory, ".git"), "gitdir: fixture");
    writeFileSync(join(directory, "AGENTS.md"), "Work with receipts.");
    const skillFolder = join(directory, ".agents/skills/finance");
    mkdirSync(skillFolder, { recursive: true });
    writeFileSync(
      join(skillFolder, "SKILL.md"),
      "---\nname: finance\ndescription: Monthly bookkeeping\ndisable-model-invocation: true\n---\nReconcile every receipt.",
    );
    process.chdir(directory);
    const session = interactiveSession(
      ["/skills", "/finance", "First message", "Second message", "/remote Immediate", "/status", "/exit"],
      [],
      {},
      undefined,
      (path) => {
        if (path === "/api/ai/skills")
          return Response.json({
            skills: [
              { name: "finance", shortId: "fin123", description: "Cloud finance", enabled: true },
              { name: "remote", shortId: "rem123", description: "Cloud only", enabled: true },
              { name: "disabled", shortId: "dis123", description: "Disabled", enabled: false },
            ],
          });
      },
    );
    expect(await session.run()).toBe(0);
    const turns = submissions(session);
    expect(turns[0]?.body).toMatchObject({
      client: { kind: "cli", cwd: directory, localTools: "ask" },
      localContext: {
        instructions: [{ path: join(directory, "AGENTS.md"), content: "Work with receipts." }],
        skills: expect.arrayContaining([expect.objectContaining({ name: "finance", manualOnly: true })]),
        selectedSkills: [{ name: "finance", directory: skillFolder, instructions: "Reconcile every receipt." }],
      },
    });
    expect(turns[1]?.body).toMatchObject({ localContext: { selectedSkills: [] } });
    const drafts = session.requests.filter((request) => request.path.endsWith("/draft"));
    expect(drafts[2]?.body).toMatchObject({
      content: [
        { type: "text", text: "Immediate" },
        { type: "resource", ref: { type: "core.ai.skill", id: "rem123" }, title: "remote" },
      ],
    });
    expect(session.printed.join("\n")).toContain("(only with /finance)");
    expect(session.printed.join("\n")).toContain("hidden by the project Skill");
    expect(session.printed.join("\n")).toMatch(/1 project, \d+ global, 2 Cloud/);
    expect(completeInteractiveLine("/fin", directory, ["finance"])).toEqual([["/finance"], "/fin"]);
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("trust decline keeps project context out for the session, while off still sends client facts", async () => {
  const previous = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "cld-trust-interactive-"));
  try {
    writeFileSync(join(directory, ".git"), "gitdir: fixture");
    writeFileSync(join(directory, "AGENTS.md"), "Do this.");
    process.chdir(directory);
    const session = interactiveSession(["hello", "again", "/exit"], [""], { noBash: true });
    session.ctx.getDefault = async () => undefined;
    expect(await session.run()).toBe(0);
    expect(session.prompts).toEqual([{ prompt: "Choice [Enter = do not load]: ", options: { typedOnly: true } }]);
    expect(session.defaults).toEqual([]);
    for (const turn of submissions(session))
      expect(turn.body).toMatchObject({
        client: { kind: "cli", localTools: "off" },
        localContext: { instructions: [], skills: [], selectedSkills: [] },
      });
    expect(session.printed.join("\n")).toContain("Local tools: off · AGENTS.md: not loaded · /permissions to change.");
    expect(session.errors.join("\n")).toContain("can steer what it does with your Cloud data");
  } finally {
    process.chdir(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});
