import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { submitAssistantTurn, uploadAttachment, validateLocalAttachments } from "./turn";

test("chat file uploads accept images larger than the turn attachment limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cld-upload-test-"));
  const path = join(directory, "photo.png");
  const size = 11 * 1024 * 1024;
  try {
    await writeFile(path, Buffer.alloc(size));
    const { ctx } = setup();
    let fetched = false;
    ctx.fetch = async (url, init) => {
      fetched = true;
      expect(url).toEndWith("/conversations/chat/files");
      expect(init?.body).toBeInstanceOf(FormData);
      if (!(init?.body instanceof FormData)) throw new Error("Expected upload form");
      const file = init.body.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("Expected uploaded file");
      expect(file.size).toBe(size);
      return Response.json({ file: { path: "/photo.png", mediaType: "image/png", size, version: 1 } });
    };
    expect(await uploadAttachment(ctx, "chat", path)).toEqual({
      type: "attachment",
      path: "/photo.png",
      mediaType: "image/png",
      size,
      version: 1,
    });
    expect(fetched).toBeTrue();
    await expect(validateLocalAttachments([path])).rejects.toThrow("Image attachment exceeds the 10 MB limit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const setup = () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { server: "https://example.test", token: "test", profile: "test", output: "text" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async (path, init) => {
      requests.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (path.endsWith("/stream"))
        return new Response(
          `data: ${JSON.stringify({ v: 1, type: "turn_finished", conversationId: "chat", turnId: "turn", attempt: 1, seq: 1, status: "completed", error: null, messages: [] })}\n\n`,
        );
      if (path.endsWith("/draft")) return Response.json({ revision: 1 });
      if (path.endsWith("/turns")) return Response.json({ turn: { id: "turn", status: "queued", modelId: null } });
      return Response.json({ conversation: { draft: { content: [], revision: 0 } } });
    },
    readJson: (response) => response.json(),
    print: () => {},
    error: () => {},
    write: async () => {},
    json: () => {},
    jsonLine: () => {},
    table: () => {},
  };
  return { ctx, requests };
};

test("draft submit carries local context and Skill resources, registering only client-owned code tools", async () => {
  const { ctx, requests } = setup();
  const client = { kind: "cli", cwd: "/work", os: "Linux", shell: "/bin/bash", localTools: "ask" };
  const localContext = {
    instructions: [{ path: "/work/AGENTS.md", content: "Work carefully." }],
    skills: [{ name: "finance", description: "Bookkeeping", scope: "project" }],
    selectedSkills: [],
  };
  const resource = { type: "resource", ref: { type: "core.ai.skill", id: "skill1" }, title: "finance" };
  await submitAssistantTurn({
    ctx,
    conversationId: "chat",
    path: "/conversations/chat/turns",
    watch: true,
    body: { message: "Organize", client, localContext, content: [resource], clientToolIds: ["local_read"] },
  });
  expect(requests.find((request) => request.path.endsWith("/draft"))?.body).toEqual({
    expectedRevision: 0,
    content: [{ type: "text", text: "Organize" }, resource],
  });
  expect(requests.find((request) => request.path.endsWith("/turns"))?.body).toEqual({
    draftRevision: 1,
    client,
    localContext,
    clientToolIds: ["local_read", "code_open", "code_secret"],
  });
});

test("print submission sends no local client or context and notifies after acceptance", async () => {
  const { ctx, requests } = setup();
  let submitted = false;
  await submitAssistantTurn({
    ctx,
    conversationId: "chat",
    path: "/conversations/chat/turns",
    watch: false,
    body: { message: "Hello" },
    onSubmitted: () => {
      submitted = true;
    },
  });
  expect(submitted).toBeTrue();
  expect(requests.find((request) => request.path.endsWith("/turns"))?.body).toEqual({ draftRevision: 1, clientToolIds: [] });
});
