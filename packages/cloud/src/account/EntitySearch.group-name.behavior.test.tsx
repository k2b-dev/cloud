import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { EntitySearchPrincipal } from "./EntitySearch";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

describe("EntitySearch group names", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  for (const [locale, shown] of [
    ["de", "Buchhaltung"],
    ["en", "buchhaltung"],
  ] as const) {
    test(`${locale}: shows the display name and selects the stored name`, async () => {
      const dom = createDomTestHarness();
      dom.document.documentElement.lang = locale;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () =>
          Response.json({
            items: [{ kind: "group", group: { id: "group-1", provider: "local", name: "buchhaltung", description: null } }],
          }),
        { preconnect: originalFetch.preconnect },
      );
      const { default: EntitySearch } = await import("./EntitySearch");
      delegateEvents(["input", "click"]);
      let selected: EntitySearchPrincipal | undefined;
      const dispose = render(
        () => (
          <EntitySearch
            includeGroups
            onSelect={(principal) => {
              selected = principal;
            }}
          />
        ),
        dom.root,
      );
      try {
        const input = dom.root.querySelector<HTMLInputElement>("input")!;
        input.value = "bu";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await waitFor(() => dom.root.querySelector("button.k2b-button") !== null, "the search result");
        const row = dom.root.querySelector<HTMLButtonElement>("button.k2b-button")!;
        expect(row.textContent).toContain(shown);
        row.click();
        expect(selected).toMatchObject({ type: "group", groupId: "group-1", name: "buchhaltung" });
      } finally {
        dispose();
        globalThis.fetch = originalFetch;
        dom.cleanup();
      }
    });
  }
});
