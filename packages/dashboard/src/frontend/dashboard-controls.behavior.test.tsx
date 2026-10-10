import { expect, spyOn, test } from "bun:test";
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

domTest("moving a widget acts on the list as shown while widgets still arrive or leave", async () => {
  const dom = createDomTestHarness();
  const { render } = await import("solid-js/web");
  const { createSignal } = await import("solid-js");
  const { DashboardEditButton } = await import("./dashboard-controls");
  const { DEFAULT_DASHBOARD_SETTINGS } = await import("../shared");
  const { dialogCore } = await import("@k2b/ui");
  const widget = (key: string) => ({ key, title: key.toUpperCase(), icon: "ti ti-box" });
  const [available, setAvailable] = createSignal(["a", "b", "c"].map(widget));
  const shown = () =>
    Array.from(dom.document.querySelectorAll(".dashboard-widget-setting .text-primary")).map((entry) => entry.textContent?.trim());
  const press = (label: string) => dom.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  const dispose = render(
    () => <DashboardEditButton apps={[]} legalLinks={[]} settings={DEFAULT_DASHBOARD_SETTINGS} available={available()} inaccessible={[]} />,
    dom.root,
  );
  try {
    Array.from(dom.document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "Edit dashboard")!
      .click();
    expect(shown()).toEqual(["A", "B", "C"]);
    // B answers 403 after the dialog opened: moving C up passes A, the widget shown above it.
    setAvailable(["a", "c"].map(widget));
    press("Move C up");
    expect(shown()).toEqual(["C", "A"]);
    // D answers with content after the dialog opened: it can be moved like the others.
    setAvailable(["a", "c", "d"].map(widget));
    expect(shown()).toEqual(["C", "A", "D"]);
    press("Move D up");
    expect(shown()).toEqual(["C", "D", "A"]);
  } finally {
    dialogCore.close();
    dispose();
    dom.cleanup();
  }
});

domTest("the Apps shortcut opens the app grid with each app's badge route, like the shell's", async () => {
  const dom = createDomTestHarness();
  const { render } = await import("solid-js/web");
  const islands = await import("@k2b/cloud/ssr/islands");
  const open = spyOn(islands, "openAppLaunchpad").mockImplementation(() => {});
  const { default: DashboardControls } = await import("./dashboard-controls");
  const { DEFAULT_DASHBOARD_SETTINGS } = await import("../shared");
  const apps = [
    { id: "chat", name: "Chat", icon: "ti ti-message", href: "/app/chat", description: "Talk", badge: "/api/chat/badge" },
    { id: "mail", name: "Mail", icon: "ti ti-mail", href: "/app/mail", description: "Write" },
  ];
  const dispose = render(() => <DashboardControls apps={apps} legalLinks={[]} settings={DEFAULT_DASHBOARD_SETTINGS} />, dom.root);
  try {
    Array.from(dom.document.querySelectorAll("button"))
      .find((entry) => entry.textContent?.trim() === "Apps")!
      .click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]?.map((app) => [app.id, app.badge])).toEqual([
      ["chat", "/api/chat/badge"],
      ["mail", undefined],
    ]);
  } finally {
    open.mockRestore();
    dispose();
    dom.cleanup();
  }
});
