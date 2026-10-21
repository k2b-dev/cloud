import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MailWorkflowCatalogSnapshot } from "../../workflows/catalog";

for (const locale of ["en", "de"] as const) {
  test.skipIf(isServer)(`${locale}: saved automation assignees keep a human label when no longer eligible`, async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = locale;
    const userId = "11111111-1111-4111-8111-111111111111";
    const [catalog, setCatalog] = createSignal<MailWorkflowCatalogSnapshot>({ folders: [], assignableUsers: [] });
    const { MailAutomationActionEditor } = await import("./MailAutomationFields");
    const dispose = render(
      () =>
        createComponent(MailAutomationActionEditor, {
          action: { kind: "assign_user", userId },
          otherActions: [],
          get catalog() {
            return catalog();
          },
          onChange: () => {},
        }),
      dom.root,
    );
    try {
      expect(dom.root.textContent).not.toContain(userId);
      expect(dom.root.textContent).toContain(locale === "en" ? "Assigned to a specific person" : "Einer bestimmten Person zugewiesen");
      setCatalog({ folders: [], assignableUsers: [{ id: userId, name: "Quentin Dorn" }] });
      expect(dom.root.textContent).toContain("Quentin Dorn");
      expect(dom.root.textContent).not.toContain(userId);
      setCatalog({ folders: [], assignableUsers: [] });
      expect(dom.root.textContent).not.toContain(userId);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
