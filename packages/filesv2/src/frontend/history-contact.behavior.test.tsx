import { expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { z } from "zod";
import { createDomTestHarness } from "../../../ui/test/dom";
import { entry, gone, hidden, page } from "../../test/history-fixtures";

if (!isServer) {
  test("Message actor reports unavailable Chat and retries with only the UUID through the public command", async () => {
    setSystemTime(new Date("2026-10-20T12:30:00.000Z"));
    const dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    const source = "/app/filesv2?view=activity&q=Angebote+2025";
    history.replaceState(null, "", source);
    const userId = "22222222-2222-4222-8222-222222222222";
    const originalFetch = globalThis.fetch;
    const requests: { path: string; body: unknown }[] = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
        requests.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
        if (path !== "/api/capabilities/v1/commands/chat/conversation.compose") throw new Error(`Unexpected request: ${path}`);
        return Response.json({ code: "UNAVAILABLE", message: "Chat is unavailable" }, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    let dispose = () => {};
    let unregister = () => {};
    try {
      const { toast } = await import("@k2b/ui");
      const { registerCommandHandler } = await import("@k2b/cloud/browser/commands");
      const { default: Workspace } = await import("./Workspace.island");
      const failed = Promise.withResolvers<string>();
      const error = spyOn(toast, "error").mockImplementation((message) => {
        failed.resolve(message);
        return { dismiss() {}, update() {} };
      });
      dispose = render(
        () =>
          createComponent(Workspace, {
            cloudUrl: "https://cloud.test",
            timeZone: "UTC",
            retentionDays: 365,
            initial: {
              source,
              bases: { items: [], issues: [], editor: null },
              selectedId: null,
              directory: null,
              errorCode: null,
              now: "2026-10-20T12:30:00.000Z",
              activity: {
                filters: { q: "Angebote 2025" },
                page: page([
                  entry({
                    action: "item.move",
                    before: gone("vertrieb/Kunden/Angebote 2025"),
                    after: hidden,
                    actor: { kind: "user", userId, name: "Lukas Pohl" },
                  }),
                ]),
              },
            },
          }),
        dom.root,
      );
      const button = () =>
        [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "Message Lukas Pohl")!;
      await Bun.sleep(30);
      button().click();
      expect(await failed.promise).toContain("Chat is unavailable");
      expect(error).toHaveBeenCalledTimes(1);
      expect(`${location.pathname}${location.search}`).toBe(source);
      const opened = Promise.withResolvers<unknown>();
      unregister = registerCommandHandler("chat.conversation.compose", z.strictObject({ userId: z.uuid() }), (input) => {
        opened.resolve(input);
      });
      button().click();
      expect(await opened.promise).toEqual({ userId });
      expect(requests).toEqual([
        {
          path: "/api/capabilities/v1/commands/chat/conversation.compose",
          body: { input: { userId } },
        },
      ]);
    } finally {
      unregister();
      dispose();
      mock.restore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
      setSystemTime();
    }
  });
}
