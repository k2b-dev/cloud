import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

describe("the notebook the Notebooks entry opens next", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const setup = async () => {
    const dom = createDomTestHarness();
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
    const { default: RememberNotebook } = await import("./RememberNotebook.island");
    const { parseLastNotebookId, setLastNotebookId } = await import("./settings/NotebookSettingsStore");
    const tabs: Array<() => void> = [];
    return {
      open: (notebookId: string) => tabs.push(render(() => <RememberNotebook notebookId={notebookId} />, dom.root)),
      setVisibility: (next: DocumentVisibilityState, event: "visibilitychange" | "pageshow" | "focus" = "visibilitychange") => {
        visibility = next;
        if (event !== "visibilitychange") dom.window.dispatchEvent(new dom.window.Event(event));
        else dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
      },
      otherTabOpens: (notebookId: string) => setLastNotebookId(notebookId),
      last: () => parseLastNotebookId(dom.document.cookie),
      cleanup: () => {
        for (const dispose of tabs) dispose();
        dom.cleanup();
      },
    };
  };

  test("is the notebook shown last, however it was reached", async () => {
    const page = await setup();
    try {
      expect(page.last()).toBeNull();
      page.open("bookAA");
      expect(page.last()).toBe("bookAA");
      page.open("bookBB");
      expect(page.last()).toBe("bookBB");
    } finally {
      page.cleanup();
    }
  });

  test("ignores a notebook opened in a background tab until it is looked at", async () => {
    const page = await setup();
    try {
      page.otherTabOpens("bookAA");
      page.setVisibility("hidden");
      page.open("bookBB");
      expect(page.last()).toBe("bookAA");
      page.setVisibility("visible");
      expect(page.last()).toBe("bookBB");
    } finally {
      page.cleanup();
    }
  });

  test.each(["visibilitychange", "pageshow", "focus"] as const)(
    "takes over again when its page is shown or focused again (%s)",
    async (event) => {
      const page = await setup();
      try {
        page.open("bookAA");
        page.setVisibility("hidden");
        // Meanwhile another tab, or the page left by going back, records its notebook.
        page.otherTabOpens("bookBB");
        expect(page.last()).toBe("bookBB");
        page.setVisibility("visible", event);
        expect(page.last()).toBe("bookAA");
      } finally {
        page.cleanup();
      }
    },
  );
});
