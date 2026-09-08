import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const settled = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Schedule UI did not settle");
};

describe("manual schedule outcome", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }
  test("uncertain acceptance retries the same intent and a pending or unreadable run never becomes successful", async () => {
    const dom = createDomTestHarness();
    const { default: RunScheduleNowButton } = await import("./RunScheduleNowButton.island");
    const { prompts } = await import("@k2b/ui");
    const confirmations = spyOn(prompts, "confirm").mockResolvedValue(true);
    const errors = spyOn(prompts, "error").mockResolvedValue(undefined);
    const requestIds: string[] = [];
    let reads = 0;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          if (init?.method === "POST") {
            const body = JSON.parse(String(init.body));
            requestIds.push(body.requestId);
            if (requestIds.length === 1) throw new Error("response lost after acceptance");
            return Response.json({ runId: "retained-run" });
          }
          reads++;
          if (reads === 2) return Response.json({ message: "temporarily unavailable" }, { status: 503 });
          return Response.json({ completed: reads > 2, error: null });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = render(
      () => createComponent(RunScheduleNowButton, { appId: "mail", schedulerId: "cleanup", scheduleId: "daily" }),
      dom.root,
    );
    try {
      const run = dom.root.querySelector("button")!;
      run.click();
      await settled(() => requestIds.length === 1 && !run.disabled);
      expect(dom.root.textContent).toContain(requestIds[0]!);
      expect(errors).toHaveBeenCalledTimes(1);
      run.click();
      await settled(() => requestIds.length === 2 && reads === 1 && !run.disabled);
      expect(requestIds[1]).toBe(requestIds[0]);
      expect(dom.root.textContent).toContain("retained-run");
      expect(dom.root.querySelector('[data-tone="running"]')).not.toBeNull();
      expect(dom.root.querySelector('[data-tone="ok"]')).toBeNull();
      const check = dom.root.querySelectorAll("button")[1]!;
      check.click();
      await settled(() => reads === 2 && !check.disabled);
      expect(dom.root.textContent).toContain("retained-run");
      expect(dom.root.querySelector('[data-tone="ok"]')).toBeNull();
      expect(requestIds).toHaveLength(2);
      check.click();
      await settled(() => reads === 3 && !check.disabled);
      expect(dom.root.querySelector('[data-tone="ok"]')).not.toBeNull();
      expect(requestIds).toHaveLength(2);
    } finally {
      dispose();
      fetchMock.mockRestore();
      confirmations.mockRestore();
      errors.mockRestore();
      dom.cleanup();
    }
  });
});
