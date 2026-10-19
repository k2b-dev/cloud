import { beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { z } from "zod";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import * as registry from "../_internal/registry";
import * as capabilities from "../api/capabilities";
import type { RequestAuthority } from "../server";
import { accounts } from "../services/accounts";
import { createTestSession } from "../services/session/session.test-fixture";
import { migrateCloudAi } from "./migrate";
import { listAiRecentResources } from "./recent-resources";
import { recentTestApp, recentTestSkill } from "./recent-resources.test-fixture";
import { aiResourceMarker } from "./resource-markers";
import { aiRoutes } from "./routes";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";

const suite = databaseSuite();
const storedTitle = "STORED PRIVATE TITLE";
const marker = (id: string, type = "demo.item") =>
  aiResourceMarker({ ref: { type, id }, title: storedTitle, icon: "ti ti-secret", href: "/stored-secret" });

const fixture = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`recent-${suffix}`}, 'local', 'user', 'Recent Test', ${`recent-${suffix}@example.test`}, 'Recent', 'Test') RETURNING id
  `;
  const userId = row!.id;
  const chat = await aiConversations.createConversation({ ownerUserId: userId });
  const user = await accounts.users.get({ id: userId });
  if (!user) throw new Error("Missing fixture user");
  const authority: RequestAuthority = {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId },
    credentialKind: "session",
    scopes: [],
  };
  let seq = 0;
  const append = async (texts: string[], options: { role?: string; kind?: string; meta?: object; content?: unknown } = {}) => {
    seq++;
    await sql`
      INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, meta, created_at)
      VALUES (${createAiShortId()}, ${chat.id}::uuid, ${seq}, ${options.kind ?? "message"}, ${options.role ?? "user"},
        ${JSON.stringify({ role: options.role ?? "user", content: options.content ?? texts.map((text) => ({ type: "text", text })) })}::text::jsonb,
        ${JSON.stringify(options.meta ?? {})}::text::jsonb,
        ${new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString()}::timestamptz)
    `;
  };
  const list = (dependencies: NonNullable<Parameters<typeof listAiRecentResources>[0]["dependencies"]> = {}) =>
    listAiRecentResources({
      ownerUserId: userId,
      authority,
      locale: "de",
      signal: new AbortController().signal,
      dependencies: {
        listRegistry: async () => [recentTestApp],
        dispatch: async ({ input }) => {
          const { id } = z.object({ id: z.string() }).parse(input);
          return Response.json({ data: {}, refs: [{ type: "demo.item", id, title: `Reader ${id}` }] });
        },
        ...dependencies,
      },
    });
  const cleanup = async () => {
    await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  };
  return { userId, chat, authority, append, list, cleanup };
};

suite("recent sent resources: real store and current reader authorization", () => {
  beforeAll(migrateCloudAi);

  test("only own sent user refs count; excludes archived chats, routines, agents, assistant/tool markers and malformed content", async () => {
    const own = await fixture(),
      other = await fixture();
    try {
      await own.append([marker("own"), marker("own")]);
      await own.append([marker("own")]);
      await own.append([marker("own")], { meta: { steerId: "steered" } });
      await own.append([marker("routine")], { meta: { scheduledTask: {} } });
      await own.append([marker("agent")], { meta: { agentMessage: {} } });
      await own.append([marker("assistant")], { role: "assistant" });
      await own.append([marker("tool")], { role: "tool_result" });
      await own.append([marker("summary")], { kind: "summary" });
      await own.append([], { content: { type: "text", text: marker("malformed") } });
      await other.append([marker("stranger")]);
      const archived = await aiConversations.createConversation({ ownerUserId: own.userId });
      await sql`INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message)
        VALUES (${createAiShortId()}, ${archived.id}::uuid, 1, 'message', 'user', ${JSON.stringify({ content: [{ type: "text", text: marker("archived") }] })}::text::jsonb)`;
      await sql`UPDATE ai.conversations SET archived_at = '2026-10-02'::timestamptz WHERE id = ${archived.id}::uuid`;
      const refs = await aiConversations.listRecentSentResourceRefs({ ownerUserId: own.userId });
      expect(refs).toEqual([
        { ref: { type: "demo.item", id: "own" }, count: 3, lastSentAt: "2026-10-01T00:00:03.000Z", conversationId: own.chat.id },
      ]);
      const resources = await own.list();
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({ title: "Reader own", count: 3 });
      expect(JSON.stringify(resources)).not.toContain(storedTitle);
      expect(JSON.stringify(resources)).not.toContain("stored-secret");
    } finally {
      await own.cleanup();
      await other.cleanup();
    }
  });

  test("a forked chat's copied messages count once", async () => {
    const f = await fixture();
    try {
      await f.append([marker("forked")]);
      await f.append([marker("forked")]);
      await aiConversations.forkConversation({ sourceConversationId: f.chat.id, ownerUserId: f.userId, throughSeq: 2 });
      expect(await aiConversations.listRecentSentResourceRefs({ ownerUserId: f.userId })).toEqual([
        expect.objectContaining({ ref: { type: "demo.item", id: "forked" }, count: 2 }),
      ]);
    } finally {
      await f.cleanup();
    }
  });

  test("a forked chat's copied messages keep their original send time and recency order", async () => {
    const f = await fixture();
    try {
      await f.append([marker("old")]);
      await f.append([marker("new")]);
      await aiConversations.forkConversation({ sourceConversationId: f.chat.id, ownerUserId: f.userId, throughSeq: 1 });
      expect(await aiConversations.listRecentSentResourceRefs({ ownerUserId: f.userId })).toEqual([
        expect.objectContaining({ ref: { type: "demo.item", id: "new" }, count: 1, lastSentAt: "2026-10-01T00:00:02.000Z" }),
        expect.objectContaining({ ref: { type: "demo.item", id: "old" }, count: 1, lastSentAt: "2026-10-01T00:00:01.000Z" }),
      ]);
    } finally {
      await f.cleanup();
    }
  });

  test("returns exactly the latest eight distinct refs with counts across messages", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 12; i++) await f.append([marker(`item-${i}`)]);
      const resources = await f.list();
      expect(resources.map((item) => item.ref.id)).toEqual([
        "item-11",
        "item-10",
        "item-9",
        "item-8",
        "item-7",
        "item-6",
        "item-5",
        "item-4",
      ]);
      expect(resources.every((item) => item.count === 1)).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  test("HTTP response removes revoked refs and all their old/current titles and metadata", async () => {
    const f = await fixture();
    const liveRegistry = spyOn(registry, "listCapabilities").mockResolvedValue([recentTestApp]);
    let revoked = false;
    const dispatch = spyOn(capabilities, "dispatchCapability").mockImplementation(async ({ input, authority }) => {
      expect(authority?.accessSubject).toEqual({ type: "user", userId: f.userId });
      const { id } = z.object({ id: z.string() }).parse(input);
      if (revoked && id === "private") return Response.json({ message: "READER PRIVATE TITLE" }, { status: 403 });
      return Response.json({
        data: {},
        refs: [{ type: "demo.item", id, title: id === "private" ? "READER PRIVATE TITLE" : "Public reader title" }],
      });
    });
    try {
      await f.append([marker("private")]);
      await f.append([marker("public")]);
      const headers = { Authorization: `Bearer ${await createTestSession(f.userId)}` };
      const first = await aiRoutes.request("/resources/recent", { headers });
      expect(first.status).toBe(200);
      expect(first.headers.get("Cache-Control")).toContain("no-store");
      const firstJson = await first.text();
      expect(firstJson).toContain("READER PRIVATE TITLE");
      expect(firstJson).not.toContain(storedTitle);
      revoked = true;
      const response = await aiRoutes.request("/resources/recent", { headers });
      expect(response.status).toBe(200);
      const json = await response.text();
      expect(JSON.parse(json).resources).toHaveLength(1);
      for (const secret of ["private", storedTitle, "READER PRIVATE TITLE", "stored-secret"]) expect(json).not.toContain(secret);
    } finally {
      liveRegistry.mockRestore();
      dispatch.mockRestore();
      await f.cleanup();
    }
  });

  test("throwing, denied and never answering readers drop only themselves under one short budget", async () => {
    const f = await fixture();
    try {
      for (const id of ["good", "throws", "hangs", "missing"]) await f.append([marker(id)]);
      const resources = await f.list({
        timeoutMs: 40,
        dispatch: async ({ input }) => {
          const { id } = z.object({ id: z.string() }).parse(input);
          if (id === "throws") throw new Error("broken");
          if (id === "hangs") return new Promise(() => {});
          if (id === "missing") return Response.json({ title: "secret" }, { status: 404 });
          return Response.json({ data: {}, refs: [{ type: "demo.item", id, title: "Good current title" }] });
        },
      });
      expect(resources.map((item) => item.ref.id)).toEqual(["good"]);
    } finally {
      await f.cleanup();
    }
  });

  test("skills use one current visibility list and drop disabled/invisible refs", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      for (const id of ["enabled", "disabled", "hidden"]) await f.append([marker(id, "core.ai.skill")]);
      const resources = await f.list({
        skills: {
          list: async (subject) => {
            calls++;
            expect(subject).toEqual(f.authority.accessSubject);
            return [recentTestSkill("enabled"), recentTestSkill("disabled", false)];
          },
        },
      });
      expect(calls).toBe(1);
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({ ref: { type: "core.ai.skill", id: "enabled" }, title: "Current enabled" });
      expect(JSON.stringify(resources)).not.toContain(storedTitle);
    } finally {
      await f.cleanup();
    }
  });

  test("Studio uses latest owned conversation and authorized read metadata; scoped credentials never widen", async () => {
    const f = await fixture();
    try {
      await f.append([marker("studio", "assistant.artifact")]);
      const resources = await f.list({
        studioReader: async (input) => {
          expect(input.conversationId).toBe(f.chat.id);
          expect(input.authority).toBe(f.authority);
          return {
            data: { id: "studio", title: "Current Studio title", icon: "ti ti-code", description: "Description\nSecond line" },
            refs: [{ type: "assistant.artifact", id: "studio" }],
            links: [{ rel: "open", href: "/app/assistant?workspace=studio" }],
          };
        },
      });
      expect(resources[0]).toMatchObject({
        title: "Current Studio title",
        kind: "Studio-App",
        preview: "Description",
        href: "/app/assistant?workspace=studio",
      });
      f.authority.scopes = ["read"];
      expect(
        await f.list({
          studioReader: async () => {
            throw new Error("Must not execute");
          },
        }),
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});
