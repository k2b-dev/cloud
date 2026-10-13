import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("calendar shortcuts dialog renders shared caps for commands and alternatives", async () => {
    const dom = createDomTestHarness();
    const { openCalendarShortcuts } = await import("../src/content/calendar-dialogs");
    const { useCalendarMessages } = await import("../src/content/calendar-messages");
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const dispose = render(
      () =>
        createComponent(() => {
          void openCalendarShortcuts(
            [{ id: "next", label: "Next", shortcut: "shift+n", description: "Next day", run() {} }],
            useCalendarMessages()(),
            { next: "arrowright" },
          );
          return null;
        }, {}),
      dom.root,
    );
    try {
      expect(dom.document.querySelectorAll(".k2b-calendar-shortcuts .k2b-kbd")).toHaveLength(2);
      expect(dom.document.querySelectorAll(".k2b-calendar-shortcuts .k2b-kbd__key")).toHaveLength(3);
      expect(dom.document.querySelector(".k2b-calendar-shortcuts__key")).toBeNull();
    } finally {
      dialogCore.close();
      dispose();
      dom.cleanup();
    }
  });
