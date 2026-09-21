import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const browserTest = isServer ? test.skip : test;
browserTest("collection has no initial fetch, verifies writes and recovers from failed saves", async () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  let fail = true;
  let saved = false;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(typeof input === "string" ? new URL(input, location.origin) : input, init);
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === "PUT") {
          if (fail) return Response.json({ message: "failure" }, { status: 503 });
          saved = (await request.json()).updates["observability.web_vitals.enabled"];
          return Response.json({ ok: true });
        }
        return Response.json({ enabled: saved });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const { default: Controls } = await import("./Controls.island");
  const dispose = render(
    () => createComponent(Controls, { filter: { range: "24h", appId: "", route: "", page: 1 }, apps: [], enabled: false }),
    dom.root,
  );
  const tick = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  try {
    expect(calls).toEqual([]);
    dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
    await tick();
    expect(dom.root.querySelector('[role="alert"]')).not.toBeNull();
    fail = false;
    const retry = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("Retry"))!;
    retry.click();
    await tick();
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toBeUndefined();
    expect(dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(1);
    dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
    await tick();
    expect(saved).toBe(false);
  } finally {
    dispose();
    fetchSpy.mockRestore();
    dom.cleanup();
  }
});

browserTest("leaving the page aborts a pending save and prevents duplicate writes", async () => {
  const dom = createDomTestHarness();
  let requestSignal: AbortSignal | undefined;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) =>
          requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const { default: Controls } = await import("./Controls.island");
  const dispose = render(
    () => createComponent(Controls, { filter: { range: "24h", appId: "", route: "", page: 1 }, apps: [], enabled: false }),
    dom.root,
  );
  try {
    const control = dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!;
    control.click();
    expect(control.disabled).toBe(true);
    control.click();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    dispose();
    expect(requestSignal?.aborted).toBe(true);
    await Promise.resolve();
  } finally {
    dispose();
    fetchSpy.mockRestore();
    dom.cleanup();
  }
});
