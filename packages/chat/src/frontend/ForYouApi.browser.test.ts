import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import type {} from "./for-you-api.browser-harness";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const id = "11111111-1111-4111-8111-111111111111";
const message = {
  id: "message001",
  conversationId: "abcdef",
  seq: 1,
  rev: 1,
  kind: "text",
  author: { type: "user", id, name: "Owner" },
  body: "😀 Mara",
  refs: [],
  reactions: [],
  thread: null,
  replyTo: null,
  system: null,
  systemText: null,
  createdAt: "2026-10-24T12:00:00.000Z",
  mentions: [{ start: 3, end: 7, accessId: id, name: "Mara" }],
};
const requests: { path: string; query: Record<string, string>; body: unknown }[] = [];
let failed = false;
beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("./for-you-api.browser-harness.ts", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "For you API harness build failed");
  const script = await bundle.outputs[0]!.text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/client.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.startsWith("/api/chat/")) {
        requests.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          body: request.method === "POST" ? await request.json() : null,
        });
        if (failed) return Response.json({ code: "BAD_INPUT", message: "Choose the person again." }, { status: 400 });
        if (url.pathname.endsWith("mention-candidates"))
          return Response.json({ items: [{ accessId: id, type: "user", name: "Mara", agent: false }] });
        if (request.method === "POST") return Response.json(message, { status: 201 });
        return Response.json({
          items: [
            {
              kind: "mention",
              conversation: { id: "abcdef", title: "Team", kind: "chat" },
              thread: { id: "general", name: "General" },
              message: { id: message.id, seq: 1, author: message.author, preview: message.body, createdAt: message.createdAt },
              unread: true,
            },
          ],
          nextCursor: "opaque_cursor",
        });
      }
      return new Response('<!doctype html><html lang="en"><body><script src="/client.js"></script></body></html>', {
        headers: { "content-type": "text/html" },
      });
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

test("typed browser transport preserves UTF-16 mentions and encodes thread searches and opaque cursors", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(String(server.url));
    const result = await page.evaluate(async (accessId) => {
      const candidates = await window.forYouApi.candidates("abcdef", "Än & %", "fedcba");
      const sent = await window.forYouApi.send("abcdef", {
        clientId: "mention-send",
        body: "😀 Mara",
        mentions: [{ start: 3, end: 7, accessId }],
      });
      const feed = await window.forYouApi.list("opaque+/=cursor");
      return { candidates, sent, feed };
    }, id);
    expect(result.sent.mentions).toEqual(message.mentions);
    expect(result.sent.body).toBe(message.body);
    expect(result.feed.items[0]?.unread).toBeTrue();
    expect(requests.find((request) => request.path.endsWith("mention-candidates"))?.query).toEqual({ q: "Än & %", thread: "fedcba" });
    expect(requests.find((request) => request.path.endsWith("for-you"))?.query.cursor).toBe("opaque+/=cursor");
    expect(requests.find((request) => request.path.endsWith("messages"))?.body).toEqual({
      clientId: "mention-send",
      body: "😀 Mara",
      mentions: [{ start: 3, end: 7, accessId: id }],
    });
    failed = true;
    const failure = await page.evaluate(async () => {
      try {
        await window.forYouApi.list();
        return null;
      } catch (error) {
        return error instanceof Error ? { name: error.name, message: error.message } : null;
      }
    });
    expect(failure).toEqual({ name: "ChatRequestError", message: "Choose the person again." });
  } finally {
    failed = false;
    await context.close();
  }
}, 30_000);
