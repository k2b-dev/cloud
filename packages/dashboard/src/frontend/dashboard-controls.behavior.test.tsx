import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("adding a shortcut asks before discarding pending dashboard edits", async () => {
  const dom = createDomTestHarness();
  const { render } = await import("solid-js/web");
  const { DashboardEditButton } = await import("./dashboard-controls");
  const { DEFAULT_DASHBOARD_SETTINGS } = await import("../shared");
  const { dialogCore } = await import("@k2b/ui");
  const button = (text: string) => Array.from(dom.document.querySelectorAll("button")).find((entry) => entry.textContent?.trim() === text)!;
  const dispose = render(
    () => <DashboardEditButton apps={[]} legalLinks={[]} settings={DEFAULT_DASHBOARD_SETTINGS} available={[]} inaccessible={[]} />,
    dom.root,
  );
  try {
    button("Edit dashboard").click();
    dom.document.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click();
    button("Add").click();
    await Bun.sleep(10);
    expect(dom.document.body.textContent).toContain("Discard unsaved changes?");
    button("Cancel").click();
    await Bun.sleep(10);
    expect(dom.document.querySelectorAll("dialog")).toHaveLength(1);
    expect(dom.document.body.textContent).toContain("Edit dashboard");
    button("Add").click();
    await Bun.sleep(10);
    button("Discard").click();
    await Bun.sleep(10);
    expect(dom.document.querySelectorAll("dialog")).toHaveLength(1);
    expect(dom.document.body.textContent).toContain("Add shortcut");
  } finally {
    dialogCore.close();
    dispose();
    dom.cleanup();
  }
});
