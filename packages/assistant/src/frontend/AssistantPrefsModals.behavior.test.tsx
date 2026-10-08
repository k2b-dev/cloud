import { expect, spyOn, test } from "bun:test";
import type { AiMemory, AiUserPrefs } from "@k2b/cloud/ai";
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

test("searching personalization keeps the field, its focus and the previous results while the next results load", async () => {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  const { dialogCore } = await import("@k2b/ui");
  const { openAssistantPrefsModal } = await import("./AssistantPrefsModals");
  const prefs: AiUserPrefs = {
    userId: "user",
    memoryEnabled: true,
    memoryLearningEnabled: true,
    lastModelId: "",
    updatedAt: new Date(0).toISOString(),
  };
  const memory = (id: string, content: string): AiMemory => ({
    id,
    shortId: id,
    userId: "user",
    kind: "preference",
    content,
    priority: "normal",
    source: "user",
    sourceConversationId: null,
    sourceMessageId: null,
    resourceRef: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  const pending = new Map<string, (items: AiMemory[]) => void>();
  const getPrefs = spyOn(assistantApi, "getPrefs").mockResolvedValue(prefs);
  const listMemories = spyOn(assistantApi, "listMemories").mockImplementation(
    (input = {}) => new Promise<AiMemory[]>((resolve) => pending.set(input.q ?? "", resolve)),
  );
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json([]), { preconnect: globalThis.fetch.preconnect }),
  );
  const entries = () => Array.from(dom.document.querySelectorAll(".k2b-settings-collection__item"), (item) => item.textContent ?? "");
  try {
    const dialog = openAssistantPrefsModal();
    await tick();
    expect(dom.document.body.textContent).toContain("Loading personalization");
    pending.get("")!([memory("one", "Answer in German"), memory("two", "Prefer short answers")]);
    await tick();

    const search = dom.document.querySelector<HTMLInputElement>('input[aria-label="Search personalization"]')!;
    search.focus();
    search.value = "short";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    // The next results are still loading: same field, still focused, and the list keeps its rows.
    expect(listMemories.mock.calls.at(-1)?.[0]).toMatchObject({ q: "short" });
    expect(dom.document.querySelector('input[aria-label="Search personalization"]')).toBe(search);
    expect(dom.document.activeElement).toBe(search);
    expect(dom.document.body.textContent).not.toContain("Loading personalization");
    expect(entries()).toHaveLength(2);

    pending.get("short")!([memory("two", "Prefer short answers")]);
    await tick();
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toContain("Prefer short answers");
    expect(dom.document.activeElement).toBe(search);

    dialogCore.close();
    await dialog;
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    getPrefs.mockRestore();
    listMemories.mockRestore();
    fetchMock.mockRestore();
    dom.cleanup();
  }
});
