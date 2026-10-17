import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// A file of its own: Solid binds its delegated click handler to the document of the first test in a process.
if (isServer) test.skip("requires browser conditions", () => {});
else
  test("a focused person keeps their row when someone above them leaves", async () => {
    const dom = createDomTestHarness();
    const { AvatarStack } = await import("../src/surfaces/AvatarStack");
    const chosen: string[] = [];
    const person = (id: string, name: string) => ({ id, name, onSelect: () => chosen.push(id) });
    const [people, setPeople] = createSignal([person("alice", "Alice"), person("bob", "Bob"), person("carol", "Carol")]);
    const dispose = render(() => <AvatarStack people={people()} title="Here now" label="Here now" />, dom.root);
    try {
      const bob = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-avatar-stack__rows button")).find((row) =>
        row.textContent?.includes("Bob"),
      )!;
      bob.focus();
      setPeople([person("bob", "Bob"), person("carol", "Carol")]);
      await Promise.resolve();
      // The focused button still stands for Bob, so activating it chooses Bob, not whoever moved into the slot.
      expect(dom.document.activeElement).toBe(bob);
      expect(bob.textContent).toContain("Bob");
      bob.click();
      expect(chosen.at(-1)).toBe("bob");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
