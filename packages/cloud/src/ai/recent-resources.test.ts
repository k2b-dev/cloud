import { expect, test } from "bun:test";
import { z } from "zod";
import { LOCALE_HEADER } from "../shared/locale";
import { type AiRecentResourceDependencies, listAiRecentResources, recentResourcePreview } from "./recent-resources";
import { recentTestApp, recentTestAuthority, recentTestSkill } from "./recent-resources.test-fixture";

const sent = (id: string, type = "demo.item") => ({
  ref: { type, id },
  count: 3,
  conversationId: "internal-only",
  lastSentAt: "2026-10-01T00:00:00.000Z",
});
const run = (dependencies: AiRecentResourceDependencies, signal = new AbortController().signal) =>
  listAiRecentResources({
    ownerUserId: "owner",
    authority: recentTestAuthority,
    locale: "de-DE",
    signal,
    dependencies: { listRegistry: async () => [recentTestApp], ...dependencies },
  });

test("preview uses only first line, omits blanks, clips at a word boundary within 160 characters", () => {
  expect(recentResourcePreview("  First line  \r\nSecret second line")).toBe("First line");
  expect(recentResourcePreview("  \nsecond")).toBeUndefined();
  expect(recentResourcePreview(undefined)).toBeUndefined();
  expect(recentResourcePreview("a".repeat(160))).toHaveLength(160);
  expect(recentResourcePreview(`${"word ".repeat(40)}`)).toBe(`${"word ".repeat(31).trim()}…`);
  expect(recentResourcePreview("a".repeat(200))).toHaveLength(160);
});

test("uses matching reader ref, current presentation and exact request authority through audited dispatch", async () => {
  const resources = await run({
    store: { listRecentSentResourceRefs: async () => [sent("one")] },
    dispatch: async (params) => {
      expect(params.authority).toBe(recentTestAuthority);
      expect(params).toMatchObject({
        kind: "queries",
        origin: "assistant",
        appId: "demo",
        capabilityId: "item.read",
        input: { id: "one" },
      });
      expect(params.request.method).toBe("POST");
      expect(params.request.headers.get(LOCALE_HEADER)).toBe("de-DE");
      expect(params.request.headers.get("x-request-id")).toBeTruthy();
      return Response.json({
        data: { title: "Wrong data title" },
        refs: [
          { type: "demo.item", id: "other", title: "Wrong ref" },
          { type: "demo.item", id: "one", title: "Reader title", preview: " First line\nSecond", icon: "ti ti-user" },
        ],
      });
    },
  });
  expect(resources).toEqual([
    {
      ref: { type: "demo.item", id: "one" },
      count: 3,
      title: "Reader title",
      icon: "ti ti-user",
      kind: "Eintrag",
      appName: "Beispiel",
      preview: "First line",
      href: "/open/demo.item/~one",
    },
  ]);
  expect(JSON.stringify(resources)).not.toContain("internal-only");
});

test("denial, throw, invalid answer and hung reader fail independently under one signal and budget", async () => {
  const signals: AbortSignal[] = [];
  const resources = await run({
    timeoutMs: 30,
    store: {
      listRecentSentResourceRefs: async () => ["ok", "denied", "throws", "hung", "invalid", "wrong-ref", "no-title"].map((id) => sent(id)),
    },
    dispatch: async ({ input, request }) => {
      signals.push(request.signal);
      const id = z.object({ id: z.string() }).parse(input).id;
      if (id === "denied") return Response.json({ title: "Denied secret" }, { status: 403 });
      if (id === "throws") throw new Error("broken");
      if (id === "hung") return new Promise(() => {});
      if (id === "invalid") return Response.json({ invalid: true });
      return Response.json({
        data: {},
        refs: [{ type: "demo.item", id: id === "wrong-ref" ? "other" : id, ...(id === "no-title" ? {} : { title: "Allowed" }) }],
      });
    },
  });
  expect(resources.map((item) => item.ref.id)).toEqual(["ok"]);
  expect(signals).toHaveLength(7);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test("lists skills once by accessSubject and never calls readers for disabled, invisible, unsupported or scoped Studio refs", async () => {
  let calls = 0;
  const resources = await run({
    store: {
      listRecentSentResourceRefs: async () => [
        sent("enabled", "core.ai.skill"),
        sent("disabled", "core.ai.skill"),
        sent("invisible", "core.ai.skill"),
        sent("unknown", "unknown.item"),
        sent("no-reader", "demo.other"),
        sent("studio", "assistant.artifact"),
      ],
    },
    skills: {
      list: async (subject, options) => {
        calls++;
        expect(subject).toBe(recentTestAuthority.accessSubject);
        // Only the sent Skills, never a page of the whole catalog.
        expect(options).toEqual({ shortIds: ["enabled", "disabled", "invisible"] });
        return [recentTestSkill("enabled"), recentTestSkill("disabled", false)];
      },
    },
    dispatch: async () => {
      throw new Error("No dispatch expected");
    },
    studioReader: async () => {
      throw new Error("No Studio read expected");
    },
  });
  expect(calls).toBe(1);
  expect(resources).toEqual([
    {
      ref: { type: "core.ai.skill", id: "enabled" },
      count: 3,
      title: "Current enabled",
      icon: "ti ti-sparkles",
      kind: "Skill",
      preview: "Current description",
      appName: "Assistent",
    },
  ]);
});

test("bounds dispatch calls to eight and does not start readers after request cancellation", async () => {
  let calls = 0;
  const deps: AiRecentResourceDependencies = {
    store: { listRecentSentResourceRefs: async () => Array.from({ length: 10 }, (_, i) => sent(String(i))) },
    dispatch: async ({ input }) => {
      calls++;
      return Response.json({ data: {}, refs: [{ type: "demo.item", id: z.object({ id: z.string() }).parse(input).id, title: "Current" }] });
    },
  };
  expect(await run(deps)).toHaveLength(8);
  expect(calls).toBe(8);
  // A cancelled request ends before any reader starts.
  await expect(run(deps, AbortSignal.abort())).rejects.toBeDefined();
  expect(calls).toBe(8);
});

test("a hung skills list drops skills without holding back successful app readers", async () => {
  expect(
    (
      await run({
        timeoutMs: 30,
        store: { listRecentSentResourceRefs: async () => [sent("ok"), sent("hung", "core.ai.skill")] },
        skills: { list: async () => new Promise(() => {}) },
        dispatch: async () => Response.json({ data: {}, refs: [{ type: "demo.item", id: "ok", title: "Current" }] }),
      })
    ).map((item) => item.ref.id),
  ).toEqual(["ok"]);
});

test("the Core OpenAPI generator covers the route and documents the bounded response", async () => {
  const { generateSpecs } = await import("hono-openapi");
  const { aiRoutes } = await import("./routes");
  const spec = await generateSpecs(aiRoutes);
  const operation = spec.paths?.["/resources/recent"]?.get;
  expect(operation?.summary).toBe("List recently sent resources");
  expect(operation?.responses?.["200"]).toBeDefined();
  expect(operation?.security).toBeDefined();
});

test("a hung registry does not discard skills whose visibility already succeeded", async () => {
  expect(
    (
      await run({
        timeoutMs: 30,
        store: { listRecentSentResourceRefs: async () => [sent("unknown"), sent("enabled", "core.ai.skill")] },
        listRegistry: async () => new Promise(() => {}),
        skills: { list: async () => [recentTestSkill("enabled")] },
      })
    ).map((item) => item.ref.id),
  ).toEqual(["enabled"]);
});

test("unreadable history fails the request instead of answering with no history", async () => {
  await expect(
    run({
      store: {
        listRecentSentResourceRefs: async () => {
          throw new Error("database unavailable");
        },
      },
    }),
  ).rejects.toThrow("database unavailable");
  await expect(run({ timeoutMs: 30, store: { listRecentSentResourceRefs: async () => new Promise(() => {}) } })).rejects.toBeDefined();
});
