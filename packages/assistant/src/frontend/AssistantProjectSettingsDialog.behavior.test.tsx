import { expect, test } from "bun:test";
import type { AiProject } from "@k2b/cloud/ai";
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
    defaultModelProfileId: null,
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
