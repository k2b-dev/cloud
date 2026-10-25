import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import type { AiConversation } from "@k2b/cloud/ai";
import * as ai from "@k2b/cloud/ai";
import * as capabilityClient from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities } from "@k2b/cloud/contracts";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import * as bun from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { createArtifactServiceRoutes } from "./api";
import { runtimeCapabilities } from "./capability-runtime";
import { requireToolChat } from "./chat-access";
import { chatPresentations } from "./chat-presentations";
import { codeToolRoutes } from "./code-tool-routes";
import * as frameAssets from "./html/assets";
import { appChecks } from "./html/check-service";
import * as service from "./service";
import { testIdentity } from "./test-identity";

const identity = testIdentity("00000000-0000-4000-8000-000000000001");
const conversation: AiConversation = {
  id: "00000000-0000-4000-8000-000000000002",
  shortId: "Chat23",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "",
  archivedAt: null,
  runStatus: "running",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: identity.user.id,
  createdAt: "",
  updatedAt: "",
};
const presentationId = "00000000-0000-4000-8000-000000000003";
const files = [{ path: "index.html", content: "<button>Run</button>" }];
const source = { entry: "index.html", files };
const bundle: service.ArtifactBundle = {
  id: "App234",
  kind: "app",
  title: "App",
  revision: 1,
  permission: "admin",
  updatedAt: "2026-10-20T00:00:00Z",
  publishedRevision: null,
  forkedFromId: null,
  forkedFromRevision: null,
  source,
  sourceRevision: 1,
};
const report = { passed: false, hash: "a".repeat(64), height: 0, issues: [], calls: [], downloads: [], screenshots: [], aria: "" };
const router = () =>
  new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", identity.actor);
      c.set("accessSubject", identity.accessSubject);
      await next();
    })
    .route("/tools", codeToolRoutes)
    .route("/", createArtifactServiceRoutes());
const request = (path: string, body?: unknown) =>
  router().request(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );

function setup() {
  // Stub requireInvocation's registered middleware, leaving the actual tool handler and errors intact.
  const invocation = codeToolRoutes.routes.find(
    (route) => route.path === "/code_list" && route.method === "POST" && route.handler !== auth.readOnly,
  );
  if (!invocation) throw new Error("Missing code_list invocation middleware");
  const transport = spyOn(invocation, "handler").mockImplementation(async (_c, next) => next());
  const queries: { query: string; values: unknown[] }[] = [];
  const client = Object.assign(new bun.SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const db = new Proxy(client, {
    apply(_target, _receiver, [strings, ...values]) {
      const query = strings.join("?");
      queries.push({ query, values });
      if (query.includes("count(*)")) return Promise.resolve([{ count: 0 }]);
      if (query.includes("sum(bytes)")) return Promise.resolve([{ bytes: 0 }]);
      if (query.includes("SELECT p.id,p.title")) return Promise.resolve([{ id: presentationId, title: "App", files, artifactId: null }]);
      if (
        query.includes("pg_advisory_xact_lock") ||
        query.includes("SELECT id FROM ai.conversations") ||
        query.includes("SELECT id,title FROM assistant.chat_presentations") ||
        query.includes("SELECT id FROM assistant.artifacts WHERE check_scratch") ||
        query.startsWith("INSERT INTO assistant.chat_presentations") ||
        query.startsWith("UPDATE assistant.artifacts SET check_conversation_id=") ||
        query.startsWith("INSERT INTO assistant.artifact_checks") ||
        query.startsWith("DELETE FROM assistant.artifact_checks")
      )
        return Promise.resolve([]);
      throw new Error(`Unexpected SQL: ${query}`);
    },
  });
  const begin = spyOn(bun.sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return run(db);
  });
  const short = spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(conversation);
  const uuid = spyOn(ai.aiConversations, "getConversation").mockResolvedValue(conversation);
  const project = spyOn(ai.aiProjects, "get").mockResolvedValue(null);
  const assets = spyOn(frameAssets, "checkFrameAssets").mockResolvedValue({ prelude: "", preludeHash: "", baseCss: "" });
  const resolved = mock((_operation: string, _conversationId: string) => {});
  const start = spyOn(appChecks, "start").mockImplementation(async (_input, reference, viewer) => {
    const chat = await requireToolChat(reference, viewer, "code_check");
    resolved("start", chat.id);
    return { artifactId: undefined, scopeId: "Scp234", source, steps: [], hash: report.hash, warnings: [] };
  });
  const record = spyOn(appChecks, "record").mockImplementation(async (_report, _input, reference, viewer) => {
    const chat = await requireToolChat(reference, viewer, "code_check");
    resolved("record", chat.id);
  });
  const presentationRead = spyOn(chatPresentations, "read").mockImplementation(async (id, reference, viewer) => {
    const chat = await requireToolChat(reference, viewer, "code_present");
    resolved("presentation", chat.id);
    return { id, conversationId: chat.shortId, title: "App", files, artifactId: null };
  });
  const list = spyOn(service.artifacts, "list").mockResolvedValue({ items: [], page: 1, hasNext: false });
  const requireArtifact = spyOn(service, "requireArtifact").mockResolvedValue({
    row: {
      id: bundle.id,
      short_id: bundle.id,
      kind: "app",
      title: "App",
      icon: "",
      storage_revision: 0,
      published_icon: null,
      published_version: null,
      revision: 1,
      updated_at: new Date("2026-10-20T00:00:00Z"),
      published_revision: null,
      published_title: null,
      published_description: null,
      forked_from_id: null,
      forked_from_revision: null,
    },
    permission: "admin",
  });
  const read = spyOn(service, "readArtifactRevision").mockResolvedValue(bundle);
  const assert = spyOn(appChecks, "assert").mockResolvedValue();
  const view = spyOn(ai, "createAiConversationView").mockResolvedValue({
    path: "/views/table.view.json",
    view: "table",
    title: "Rows",
    rows: 1,
    columns: 1,
    footer: false,
  });
  const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
    ok: true,
    data: {
      appId: "demo",
      appName: "Demo",
      appDescription: "",
      appIcon: "",
      manifest: compileCapabilityManifest(
        "demo",
        defineCapabilities({
          protocolVersion: 2,
          queries: {
            read: {
              title: "Read",
              description: "Read rows.",
              openWorld: false,
              input: z.object({}).strict(),
              data: z.object({}).strict(),
              run: async () => ok({ data: {} }),
            },
          },
        }),
      ),
    },
  });
  const prepare = spyOn(runtimeCapabilities, "prepare").mockResolvedValue({ status: "completed", result: { ok: true, data: {} } });
  return {
    queries,
    short,
    uuid,
    project,
    list,
    assert,
    view,
    prepare,
    resolved,
    start,
    record,
    async close() {
      for (const spy of [
        prepare,
        catalog,
        view,
        assert,
        read,
        requireArtifact,
        list,
        presentationRead,
        record,
        start,
        assets,
        project,
        uuid,
        short,
        begin,
        transport,
      ])
        spy.mockRestore();
      await client.close();
    },
  };
}
let state: ReturnType<typeof setup>;
beforeEach(() => {
  state = setup();
});
afterEach(async () => {
  await state.close();
});

// Single route list: every new Assistant endpoint accepting a chat reference must join this table.
const routes = [
  { path: "/runtime/check/start", body: { input: { files } }, resolved: "start" },
  { path: "/runtime/views", body: { turnId: presentationId, runId: "call", index: 0, view: { view: "table" } }, downstream: "view" },
  { path: "/runtime/check/record", body: { input: { files }, report }, resolved: "record" },
  { path: "/runtime/check/gate", body: { id: bundle.id }, downstream: "assert" },
  { path: "/runtime/check/capability", body: { name: "demo.read", input: {} }, downstream: "prepare" },
  { path: "/presentations", body: { callId: "call", title: "App", files }, downstream: "assert" },
  { path: `/presentations/${presentationId}`, resolved: "presentation" },
  { path: "/tools/code_list", body: { input: {} }, downstream: "list" },
];
for (const reference of [conversation.shortId, conversation.id]) {
  for (const route of routes) {
    test(`${route.path} accepts ${reference} and resolves its owner and internal UUID`, async () => {
      const response = await (route.body
        ? request(route.path, { ...route.body, conversationId: reference })
        : request(`${route.path}?conversationId=${reference}`));
      expect(response.status).toBe(200);
      expect(reference === conversation.shortId ? state.short : state.uuid).toHaveBeenCalledWith(
        reference === conversation.shortId
          ? { shortId: reference, ownerUserId: identity.user.id }
          : { conversationId: reference, ownerUserId: identity.user.id },
      );
      if (route.resolved) expect(state.resolved).toHaveBeenCalledWith(route.resolved, conversation.id);
      if (route.downstream === "view")
        expect(state.view).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId: conversation.id, ownerUserId: identity.user.id }),
        );
      if (route.downstream === "assert")
        expect(state.assert).toHaveBeenCalledWith(
          source,
          route.path === "/presentations" ? undefined : bundle.id,
          expect.anything(),
          conversation.id,
          expect.anything(),
        );
      // Capability authorization already supports both references; the existing prepare path resolves again.
      if (route.downstream === "prepare")
        expect(state.prepare).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId: reference }),
          expect.anything(),
          expect.anything(),
        );
      if (route.downstream === "list")
        expect(state.list).toHaveBeenCalledWith(expect.objectContaining({ conversationId: conversation.id }), expect.anything(), undefined);
      for (const { values } of state.queries) expect(values).not.toContain(conversation.shortId);
    });
  }
}
for (const reference of [conversation.shortId, conversation.id]) {
  for (const denied of [
    null,
    { ...conversation, archivedAt: "2026-01-01" },
    { ...conversation, allowedTools: ["chart"] },
    { ...conversation, projectId: "project" },
  ]) {
    for (const path of ["/runtime/check/start", "/runtime/check/capability", "/tools/code_list"]) {
      test(`${path} denies ${reference}: ${denied === null ? "missing" : denied.archivedAt ? "archived" : denied.projectId ? "unreadable Project" : "tool excluded"}`, async () => {
        state.start.mockRestore();
        state.short.mockResolvedValue(denied);
        state.uuid.mockResolvedValue(denied);
        const response = await request(path, {
          conversationId: reference,
          input: path.endsWith("start") ? { files } : {},
          ...(path.endsWith("capability") ? { name: "demo.read" } : {}),
        });
        expect(response.status).toBe(403);
        if (path.includes("/tools/"))
          expect(await response.json()).toEqual({ ok: false, error: { code: "ACCESS_DENIED", message: "Conversation access denied." } });
        if (denied?.projectId) expect(state.project).toHaveBeenCalledWith("project", identity.accessSubject, "read");
        expect(state.queries).toHaveLength(0);
        expect(state.list).not.toHaveBeenCalled();
      });
    }
  }
}

for (const reference of [conversation.shortId, conversation.id]) {
  test(`real check services authorize ${reference} before storage work`, async () => {
    state.start.mockRestore();
    state.record.mockRestore();
    const cleanup = spyOn(appChecks, "cleanup").mockResolvedValue();
    const controller = new AbortController();
    const cancelled = new Error("Check cancelled");
    controller.abort(cancelled);
    try {
      await expect(appChecks.start({ files }, reference, identity, controller.signal)).rejects.toBe(cancelled);
      // A passing report without screenshots fails after chat authorization, before SQL.
      await expect(appChecks.record({ ...report, passed: true }, { files }, reference, identity)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(reference === conversation.shortId ? state.short : state.uuid).toHaveBeenCalledTimes(2);
      expect(state.queries).toHaveLength(0);
    } finally {
      cleanup.mockRestore();
    }
  });
}

test("Assistant chat inputs never narrow public references to UUIDs", async () => {
  const root = new URL("../", import.meta.url);
  async function scan(directory: URL): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) await scan(file);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        const source = await readFile(file, "utf8");
        const schema = /conversationId\s*:\s*z\s*\.\s*(?:uuid\s*\(|string\s*\(\s*\)\s*\.\s*uuid\s*\()/;
        const parse = /z\s*\.\s*uuid\s*\(\s*\)\s*\.\s*parse\s*\(\s*[^;\n]*(?:conversationId|chatId)/i;
        const chatParser = /(?:async\s+)?function\s+(?:chat|conversation)\s*\([^)]*\)\s*\{[^}]*z\.uuid\(\)\.parse\(\s*id\s*\)/s;
        expect(
          schema.test(source) || parse.test(source) || chatParser.test(source),
          `${file.pathname}: use ChatReference + requireToolChat for public chat inputs`,
        ).toBe(false);
      }
    }
  }
  await scan(root);
});

test("check gate follows the code_open grant, not code_run", async () => {
  for (const [allowedTools, status] of [
    [["code_check", "code_open"], 200],
    [["code_check", "code_run"], 403],
  ] as const) {
    state.short.mockResolvedValue({ ...conversation, allowedTools: [...allowedTools] });
    expect((await request("/runtime/check/gate", { id: bundle.id, conversationId: conversation.shortId })).status).toBe(status);
  }
});
