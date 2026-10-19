import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

test.skipIf(isServer)("a New task that fails says why and offers Retry, which tries again", async () => {
  const dom = createDomTestHarness();
  const commands = await import("@k2b/cloud/browser/commands");
  const open = spyOn(commands, "openCommand").mockImplementation(() => Promise.reject(new Error("You cannot add tasks to this Space.")));
  const { default: SpacesOverview } = await import("./SpacesOverview.island");
  const dispose = render(
    () =>
      createComponent(SpacesOverview, {
        spaces: [],
        initialView: "mine",
        initialWork: { view: "mine", counts: { mine: 0, today: 0, upcoming: 0 }, items: [] },
        initialPinnedSpaceIds: [],
        initialActivity: { items: [], nextCursor: null },
        initialActivityError: null,
        dateConfig: { locale: "en", timeZone: "UTC" },
      }),
    dom.root,
  );
  const button = (label: string) =>
    Array.from(dom.document.querySelectorAll<HTMLElement>("button, a")).find((element) => element.textContent?.trim() === label);
  try {
    button("New task")!.click();
    await Bun.sleep(30);
    expect(open).toHaveBeenCalledTimes(1);
    expect(dom.document.body.textContent).toContain("You cannot add tasks to this Space.");
    button("Retry")!.click();
    await Bun.sleep(30);
    expect(open).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
    open.mockRestore();
    dom.cleanup();
  }
});
