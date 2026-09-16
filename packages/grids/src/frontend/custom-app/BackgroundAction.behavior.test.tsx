import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("accepted document work stays nonblocking and recovers its result on focus", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      return Response.json(
        init?.method === "POST"
          ? { status: "running" }
          : { status: "ready", document: { id: "DOC001", number: "RE-001", blockId: "identity" }, downloadUrl: "/document.pdf" },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: BackgroundAction } = await import("./BackgroundAction");
  let otherClicks = 0;
  const dispose = render(
    () =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Creation requested; you can keep working.",
        state: { status: "draft" },
      }),
    dom.root,
  );
  const otherButton = dom.document.createElement("button");
  otherButton.textContent = "Other work";
  otherButton.onclick = () => {
    otherClicks++;
  };
  dom.root.append(otherButton);
  try {
    const issue = dom.root.querySelector("button")!;
    issue.click();
    issue.click();
    await Bun.sleep(10);
    expect(calls).toEqual(["POST"]);
    expect(issue.disabled).toBe(true);
    expect(dom.root.textContent).toContain("Creation requested; you can keep working.");
    dom.root.querySelectorAll("button")[1]!.click();
    expect(otherClicks).toBe(1);
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(10);
    expect(calls).toEqual(["POST", "GET"]);
    expect(dom.root.querySelector('a[href="/document.pdf"]')?.textContent).toContain("RE-001");
    dispose();
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await Bun.sleep(10);
    expect(calls).toEqual(["POST", "GET"]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
