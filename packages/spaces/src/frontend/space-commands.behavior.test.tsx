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
