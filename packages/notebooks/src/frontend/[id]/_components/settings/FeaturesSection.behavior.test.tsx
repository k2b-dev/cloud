import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { TAB_KEY_PREFERENCE_EVENT } from "../detail/events";
import type { Notebook } from "../sidebar/types";

const notebook: Notebook = {
  id: "notes1",
  name: "Research",
  description: "Shared research notes",
  icon: "ti ti-flask",
  homepageNoteId: null,
  defaultPresentationMode: "write",
  defaultNoteTitleTemplate: "{{ date }}",
  createdBy: "user-id",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

describe("personal Tab key preference", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("saves in this browser and tells an open editor to apply it", async () => {
    const dom = createDomTestHarness();
    const { FeaturesSection } = await import("./FeaturesSection");
    const { readTabMovesFocus } = await import("./NotebookSettingsStore");
    let notified = 0;
    const onPreference = () => notified++;
    window.addEventListener(TAB_KEY_PREFERENCE_EVENT, onPreference);
    const dispose = render(() => <FeaturesSection notebook={notebook} isAdmin={false} onNotebookChange={() => undefined} />, dom.root);

    try {
      const toggle = dom.root.querySelector<HTMLInputElement>('input[role="switch"]');
      expect(toggle?.checked).toBe(false);
      expect(readTabMovesFocus()).toBe(false);

      toggle?.click();
      expect(toggle?.checked).toBe(true);
      expect(readTabMovesFocus()).toBe(true);
      expect(notified).toBe(1);

      toggle?.click();
      expect(readTabMovesFocus()).toBe(false);
      expect(notified).toBe(2);
    } finally {
      window.removeEventListener(TAB_KEY_PREFERENCE_EVENT, onPreference);
      dispose();
      dom.cleanup();
    }
  });
});
