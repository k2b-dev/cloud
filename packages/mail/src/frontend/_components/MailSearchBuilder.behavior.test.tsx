import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const userId = "11111111-1111-4111-8111-111111111111";

for (const locale of ["en", "de"] as const) {
  test.skipIf(isServer)(`${locale}: a reopened assignee filter never uses its UUID as the selected label`, async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = locale;
    const [{ openMailSearchBuilder }, { dialogCore }] = await Promise.all([import("./MailSearchBuilder"), import("@k2b/ui")]);
    try {
      const result = openMailSearchBuilder({
        mailboxId: "Box001",
        initialState: { expression: { type: "assignee", userId }, sort: "relevance" },
        initialQuery: "",
        canWrite: true,
      });
      try {
        const deadline = performance.now() + 2_000;
        while (!dom.document.querySelector("dialog") && performance.now() < deadline) await Bun.sleep(10);
        const dialog = dom.document.querySelector("dialog");
        expect(dialog).not.toBeNull();
        expect(dialog!.textContent).not.toContain(userId);
        expect(dialog!.textContent).toContain(locale === "en" ? "Assigned to a specific person" : "Einer bestimmten Person zugewiesen");
        for (const element of dialog!.querySelectorAll("[aria-label], [title]")) {
          expect(element.getAttribute("aria-label") ?? "").not.toContain(userId);
          expect(element.getAttribute("title") ?? "").not.toContain(userId);
        }
      } finally {
        dialogCore.close();
        await result;
      }
    } finally {
      dom.cleanup();
    }
  });
}
