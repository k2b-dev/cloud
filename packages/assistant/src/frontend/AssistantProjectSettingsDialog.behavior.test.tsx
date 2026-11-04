import { expect, test } from "bun:test";
import type { AiProject } from "@k2b/cloud/ai";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { createDomTestHarness } from "../../../ui/test/dom";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("Project settings count unsaved changes in the page's language and discard them in place", async () => {
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = "de";
  dom.root.className = "k2b-ui";
  const { dialogCore } = await import("@k2b/ui");
  const { openAssistantProjectSettingsDialog } = await import("./AssistantProjectSettingsDialog");
  const { createAssistantLiveHub } = await import("./assistant-live");
  const project: AiProject = {
    id: "project123",
    shortId: "project123",
    name: "Vertrieb",
    description: "Angebote und Wochenberichte",
    icon: "ti ti-folder",
    instructions: "Schreibe kurz.",
    defaultModel: null,
    // Write access keeps the dialog to its General tab, without loading Project access.
    permission: "write",
    revision: 1,
    createdAt: "2026-08-12T08:00:00.000Z",
    updatedAt: "2026-08-12T08:00:00.000Z",
  };
  const status = () => dom.document.querySelector(".k2b-settings-panel-footer__status")?.textContent;
  const button = (label: string) =>
    Array.from(dom.document.querySelectorAll("button")).find((element) => element.textContent?.trim() === label)!;
  try {
    const dialog = openAssistantProjectSettingsDialog(project, createAssistantLiveHub());
    await tick();
    expect(status()).toBe("Keine ungespeicherten Änderungen");
    expect(dom.document.querySelector(".k2b-markdown-editor__stats")?.textContent).toBe("1 Zeile2 Wörter14 Zeichen");

    const name = dom.document.querySelector<HTMLInputElement>('input[maxlength="120"]')!;
    name.value = "Vertrieb Nord";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(status()).toBe("1 ungespeicherte Änderung");

    button("Verwerfen").click();
    await tick();
    expect(name.value).toBe("Vertrieb");
    expect(status()).toBe("Keine ungespeicherten Änderungen");

    dialogCore.close();
    await dialog;
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    dom.cleanup();
  }
});

test("Project access is edited in the access dialog: changes save on Save and the list reads the result once", async () => {
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = "en";
  dom.root.className = "k2b-ui";
  const { delegateEvents } = await import("solid-js/web");
  delegateEvents(["click", "input"], dom.document);
  const entry = (id: string, name: string, permission: AccessEntry["permission"]): AccessEntry => ({
    id,
    principal: { type: "user", userId: `user-${id}` },
    permission,
    displayName: name,
    createdAt: "2026-08-12T08:00:00.000Z",
  });
  let stored = [entry("mia", "Mia Hoffmann", "admin"), entry("lea", "Lea Schmitt", "read")];
  const writes: string[] = [];
  let reads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      if (!url.includes("/access")) return Response.json({ message: "not part of this test" }, { status: 503 });
      if (method === "GET") {
        reads += 1;
        return Response.json({ access: stored });
      }
      const accessId = url.split("/access/")[1];
      writes.push(`${method} ${accessId}`);
      const { permission } = JSON.parse(String(init?.body)) as { permission: AccessEntry["permission"] };
      stored = stored.map((item) => (item.id === accessId ? { ...item, permission } : item));
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
  const { dialogCore } = await import("@k2b/ui");
  const { openAssistantProjectSettingsDialog } = await import("./AssistantProjectSettingsDialog");
  const { createAssistantLiveHub } = await import("./assistant-live");
  const project: AiProject = {
    id: "project123",
    shortId: "project123",
    name: "Sales",
    description: "",
    icon: "ti ti-folder",
    instructions: "",
    defaultModel: null,
    permission: "admin",
    revision: 1,
    createdAt: "2026-08-12T08:00:00.000Z",
    updatedAt: "2026-08-12T08:00:00.000Z",
  };
  const until = async (condition: () => boolean) => {
    while (!condition()) await tick();
  };
  const button = (label: string) =>
    Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === label);
  // The settings and the access dialog share one dialog element; the access panel is the visible top layer.
  const accessPanel = () =>
    Array.from(dom.document.querySelectorAll<HTMLElement>("dialog > *")).find(
      (item) => item.style.display !== "none" && item.textContent?.includes("Access to Sales"),
    );
  try {
    const dialog = openAssistantProjectSettingsDialog(project, createAssistantLiveHub());
    await until(() => !!Array.from(dom.document.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent?.trim() === "Access"));
    Array.from(dom.document.querySelectorAll<HTMLElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === "Access")!
      .click();
    await until(() => button("Edit access")?.disabled === false);
    expect(button("Remove Lea Schmitt")).toBeUndefined();
    button("Edit access")!.click();
    await until(() => accessPanel()?.textContent?.includes("Lea Schmitt") === true);
    const row = Array.from(accessPanel()!.querySelectorAll("li")).find((item) => item.textContent?.includes("Lea Schmitt"))!;
    Array.from(row.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Edit"))!
      .click();
    await until(() => accessPanel()?.textContent?.includes("1 change") === true);
    expect(writes).toEqual([]);
    const readsBefore = reads;
    Array.from(accessPanel()!.querySelectorAll<HTMLButtonElement>("button"))
      .find((element) => element.textContent?.trim() === "Save")!
      .click();
    await until(() => !accessPanel() && reads === readsBefore + 1);
    expect(writes).toEqual(["PATCH lea"]);
    dialogCore.close();
    await dialog;
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
