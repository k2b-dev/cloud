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

const longMail = `${"maria.kolb.with.a.very.long.address".repeat(3)}@example.com`;

describe("EntitySearch result rows", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("fill the width with start-aligned labels, truncating text, and a trailing add action", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          items: [
            {
              kind: "user",
              user: { id: "user-1", uid: "irc", displayName: "Maria Kolb", avatarHash: null, mail: longMail, provider: "local" },
            },
            { kind: "group", group: { id: "group-1", provider: "local", name: "Board", description: null } },
          ],
        }),
      { preconnect: originalFetch.preconnect },
    );

    const { default: EntitySearch } = await import("./EntitySearch");
    delegateEvents(["input", "click"]);
    let selected: EntitySearchPrincipal | undefined;
    const dispose = render(
      () => (
        <EntitySearch
          includeUsers
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
      input.value = "ma";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(() => dom.root.textContent?.includes("Maria Kolb") ?? false, "the search results");

      const rows = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button.k2b-button"));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.dataset.align).toBe("start");
        expect(row.classList.contains("w-full")).toBe(true);

        const label = row.querySelector(":scope > .k2b-button__label")!;
        const [leading, text, action] = Array.from(label.children);
        expect(label.children).toHaveLength(3);
        expect(leading!.classList.contains("shrink-0") || leading!.classList.contains("k2b-avatar")).toBe(true);
        expect(text!.classList.contains("flex-1")).toBe(true);
        expect(text!.classList.contains("min-w-0")).toBe(true);
        for (const line of Array.from(text!.children)) expect(line.classList.contains("truncate")).toBe(true);
        expect(action!.classList.contains("ti-plus")).toBe(true);
        expect(label.lastElementChild).toBe(action!);
      }
      expect(rows[0]!.textContent).toContain(`irc · ${longMail}`);

      rows[0]!.click();
      expect(selected).toMatchObject({ type: "user", userId: "user-1" });
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
