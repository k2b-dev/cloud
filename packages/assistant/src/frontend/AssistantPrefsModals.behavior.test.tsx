import { expect, spyOn, test } from "bun:test";
import type { AiUserPrefs } from "@k2b/cloud/ai";
import { createDomTestHarness } from "../../../ui/test/dom";
import { assistantApi } from "../api/client";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const saveButton = () => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Save changes")!;

test("saving one personalization switch does not record a choice for learning", async () => {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  const { dialogCore, toast } = await import("@k2b/ui");
  const { openAssistantPrefsModal } = await import("./AssistantPrefsModals");
  const prefs: AiUserPrefs = {
    userId: "user",
    memoryEnabled: true,
    memoryLearningEnabled: true,
    lastModelId: "",
    updatedAt: new Date(0).toISOString(),
  };
  const getPrefs = spyOn(assistantApi, "getPrefs").mockResolvedValue(prefs);
  const listMemories = spyOn(assistantApi, "listMemories").mockResolvedValue([]);
  const updatePrefs = spyOn(assistantApi, "updatePrefs").mockImplementation(async (input) => ({ ...prefs, ...input }));
  const saved = spyOn(toast, "success").mockReturnValue({ dismiss() {}, update() {} });
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: globalThis.fetch.preconnect }),
  );
  try {
    const dialog = openAssistantPrefsModal();
    await tick();
    expect(dom.document.body.textContent).toContain("On by default.");
    const switches = Array.from(dom.document.querySelectorAll<HTMLInputElement>('input[role="switch"]'));
    expect(switches.map((input) => input.checked)).toEqual([true, true]);

    switches[0]!.click();
    await tick();
    saveButton().click();
    await tick();
    expect(updatePrefs.mock.calls).toEqual([[{ memoryEnabled: false }]]);

    switches[1]!.click();
    await tick();
    saveButton().click();
    await tick();
    expect(updatePrefs.mock.calls[1]).toEqual([{ memoryLearningEnabled: false }]);

    dialogCore.close();
    await dialog;
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    getPrefs.mockRestore();
    listMemories.mockRestore();
    updatePrefs.mockRestore();
    saved.mockRestore();
    fetchMock.mockRestore();
    dom.cleanup();
  }
});
