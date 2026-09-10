import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { AppStorage } from "../src/runtime/storage";

(isServer ? test.skip : test)("local explorer confirms deletion, stops the run first and refreshes individual and all data", async () => {
  const dom = createDomTestHarness();
  const { LocalFiles } = await import("../src/frontend/LocalFiles");
  const { prompts } = await import("@k2b/ui");
  const events: string[] = [];
  let confirmed = false;
  let paths = ["exports/one.csv"];
  const confirm = spyOn(prompts, "confirm").mockImplementation(async () => confirmed);
  const call = spyOn(AppStorage.prototype, "call").mockImplementation(async (method, args) => {
    if (method === "opfs.list") return paths;
    if (method === "store.keys") return ["history"];
    events.push(`${method}:${args[0]}`);
    paths = [];
    return null;
  });
  const clear = spyOn(AppStorage.prototype, "clear").mockImplementation(async () => {
    events.push("clear");
  });
  const dispose = render(
    () =>
      createComponent(LocalFiles, {
        appId: "test",
        userId: "user",
        beforeDelete: async () => {
          events.push("stop");
        },
      }),
    dom.root,
  );
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  try {
    await settle();
    const remove = dom.root.querySelector<HTMLButtonElement>('[aria-label="Delete: exports/one.csv"]')!;
    expect(remove).not.toBeNull();
    remove.click();
    await settle();
    expect(events).toEqual([]);
    confirmed = true;
    remove.click();
    await settle();
    expect(events).toEqual(["stop", "opfs.delete:exports/one.csv"]);
    expect(dom.root.textContent).not.toContain("exports/one.csv");
    expect(dom.root.textContent).toContain("history");
    const all = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Delete local data"),
    )!;
    all.click();
    await settle();
    expect(events).toEqual(["stop", "opfs.delete:exports/one.csv", "stop", "clear"]);
  } finally {
    dispose();
    call.mockRestore();
    clear.mockRestore();
    confirm.mockRestore();
    dom.cleanup();
  }
});
