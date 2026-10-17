import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("focus stays in the list when a focused person can no longer be chosen or leaves", async () => {
    const dom = createDomTestHarness();
    const { AvatarStack } = await import("../src/surfaces/AvatarStack");
    type Person = { id: string; name: string; onSelect?: () => void };
    const choosable = (id: string, name: string): Person => ({ id, name, onSelect: () => {} });
    const [people, setPeople] = createSignal<Person[]>([choosable("alice", "Alice"), choosable("bob", "Bob"), choosable("carol", "Carol")]);
    const dispose = render(() => <AvatarStack people={people()} title="Here now" label="Here now" />, dom.root);
    const row = (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-avatar-stack__rows button")).find((button) =>
        button.textContent?.includes(name),
      );
    const settle = () => new Promise((done) => setTimeout(done, 0));
    try {
      // Bob's cursor goes idle: his row is no longer a button, and focus moves on to the next person who is.
      row("Bob")!.focus();
      setPeople([choosable("alice", "Alice"), { id: "bob", name: "Bob" }, choosable("carol", "Carol")]);
      await settle();
      expect(row("Bob")).toBeUndefined();
      expect(dom.document.activeElement).toBe(row("Carol")!);

      // Carol leaves: the nearest row before her takes focus.
      setPeople([choosable("alice", "Alice"), { id: "bob", name: "Bob" }]);
      await settle();
      expect(dom.document.activeElement).toBe(row("Alice")!);

      // Nobody can be chosen any more: the list itself keeps focus.
      setPeople([
        { id: "alice", name: "Alice" },
        { id: "bob", name: "Bob" },
      ]);
      await settle();
      expect(dom.document.activeElement).toBe(dom.root.querySelector(".k2b-avatar-stack__rows"));
    } finally {
      dispose();
      dom.cleanup();
    }
  });
