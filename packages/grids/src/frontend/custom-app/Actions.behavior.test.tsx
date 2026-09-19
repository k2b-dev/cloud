import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("issuing an invoice blocks mutating siblings through running and ambiguous outcomes", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let responseStatus = 202;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      return Response.json(init?.method === "POST" ? { status: "running" } : { status: "failed", finalized: false }, {
        status: init?.method === "POST" ? responseStatus : 200,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: Actions } = await import("./Actions.island");
  const dispose = render(
    () =>
      createComponent(Actions, {
        actions: [
          {
            id: "issue",
            label: "Issue invoice",
            kind: "workflow",
            endpoint: "/issue",
            launcherId: "ISSUE1",
            background: { acceptedMessage: "Requested", state: { status: "draft" } },
          },
          { id: "discard", label: "Discard", kind: "workflow", endpoint: "/discard", launcherId: "DELETE1", variant: "danger" },
        ],
      }),
    dom.root,
  );
  const discard = () =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Discard")!;
  try {
    dom.root.querySelector("button")!.click();
    expect(discard().disabled).toBe(true);
    await Bun.sleep(5);
    discard().click();
    expect(calls).toEqual(["POST /issue"]);
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(5);
    expect(discard().disabled).toBe(false);
    responseStatus = 500;
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(discard().disabled).toBe(true);
    discard().click();
    expect(calls).not.toContain("POST /discard");
    expect(dom.root.querySelector("button")!.disabled).toBe(false);
    dom.root.querySelector("button")!.click();
    await Bun.sleep(5);
    expect(discard().disabled).toBe(false);
    expect(calls).toEqual(["POST /issue", "GET /issue", "POST /issue", "GET /issue"]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
