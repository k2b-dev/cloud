import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

if (!isServer)
  test("cancelling the Space chooser returns to the explicit source; a read-only target is not silently replaced", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const { createSpaceCommands } = await import("./space-commands");
    const search = spyOn(prompts, "search").mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL) => {
        requests.push(String(url));
        return Response.json({ permission: "read" });
      },
      { preconnect: originalFetch.preconnect },
    );
    const dispose = render(() => {
      createSpaceCommands({});
      return null;
    }, dom.root);
    try {
      await openCommand("spaces.task.compose", {}, { returnTo: "/app/mail?view=waiting&conversation=Conv01" });
      expect(window.location.pathname + window.location.search).toBe("/app/mail?view=waiting&conversation=Conv01");
      expect(requests).toEqual([]);
      await expect(openCommand("spaces.task.compose", { spaceId: "Space1" })).rejects.toThrow("You cannot create items in this Space.");
      expect(search).toHaveBeenCalledTimes(1);
      expect(requests).toEqual(["/api/spaces/Space1/settings-context"]);
    } finally {
      dispose();
      search.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

if (!isServer)
  test("event invitation Command authorizes the current event and opens a form without a write", async () => {
    const dom = createDomTestHarness();
    const { dialogCore } = await import("@k2b/ui");
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const { createSpaceCommands } = await import("./space-commands");
    const open = spyOn(dialogCore, "open").mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    let denied = false;
    const requests: { url: string; method: string }[] = [];
    globalThis.fetch = Object.assign(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET" });
        if (String(url).endsWith("/spaces/item.read"))
          return denied
            ? Response.json({ code: "FORBIDDEN", message: "No access" }, { status: 403 })
            : Response.json({ data: { kind: "event", spaceId: "Space1", title: "Review" } });
        if (String(url).endsWith("/invitation-context")) return Response.json({ mailboxes: [{ id: "Box001" }], canCancel: false });
        throw new Error(`Unexpected request ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const dispose = render(() => {
      createSpaceCommands({});
      return null;
    }, dom.root);
    try {
      await openCommand("spaces.event.invite", { itemId: "Event1" });
      expect(open).toHaveBeenCalledTimes(1);
      expect(requests.map((request) => request.url)).toEqual([
        "/api/capabilities/v1/queries/spaces/item.read",
        "/api/spaces/Space1/items/Event1/invitation-context",
      ]);
      await expect(openCommand("spaces.event.invite", { itemId: "Event1", method: "cancel" })).rejects.toThrow("invitation");
      expect(open).toHaveBeenCalledTimes(1);
      denied = true;
      await expect(openCommand("spaces.event.invite", { itemId: "Event1" })).rejects.toThrow("No access");
      expect(open).toHaveBeenCalledTimes(1);
      expect(requests.filter((request) => !request.url.includes("/queries/")).every((request) => request.method === "GET")).toBe(true);
    } finally {
      dispose();
      open.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
