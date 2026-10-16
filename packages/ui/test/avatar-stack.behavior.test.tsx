import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("a focused person keeps focus while the people here move between sections", async () => {
    const dom = createDomTestHarness();
    const { AvatarStack } = await import("../src/surfaces/AvatarStack");
    const person = (section: string) => ({ id: "jana", name: "Jana Berger", detail: `writing · ${section}`, onSelect: () => {} });
    const [people, setPeople] = createSignal([person("Intake"), { id: "paul", name: "Paul Wagner", onSelect: () => {} }]);
    const dispose = render(() => <AvatarStack people={people()} title="Here now" label="Here now" />, dom.root);
    try {
      const row = () => dom.root.querySelector<HTMLButtonElement>(".k2b-avatar-stack__rows button");
      const focused = row()!;
      focused.focus();
      expect(dom.document.activeElement).toBe(focused);

      // A live update brings new objects for the same people.
      setPeople([person("Counting"), { id: "paul", name: "Paul Wagner", onSelect: () => {} }]);
      await Promise.resolve();

      expect(row()).toBe(focused);
      expect(focused.isConnected).toBe(true);
      expect(dom.document.activeElement).toBe(focused);
      expect(focused.textContent).toContain("Counting");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
