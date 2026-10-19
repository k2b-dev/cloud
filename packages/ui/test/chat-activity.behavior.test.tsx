import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("tool details render only on expansion and survive title updates", async () => {
    const dom = createDomTestHarness();
    const { ChatActivity } = await import("../src/chat/ChatPrimitives");
    const [title, setTitle] = createSignal("Reading");
    let renders = 0;
    const dispose = render(
      () =>
        createComponent(ChatActivity, {
          get label() {
            return title();
          },
          renderBody: () => {
            renders++;
            return "Large diagnostic output";
          },
        }),
      dom.root,
    );
    try {
      const details = dom.root.querySelector("details")!;
      expect(renders).toBe(0);
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      expect(renders).toBe(1);
      expect(dom.root.textContent).toContain("Large diagnostic output");
      setTitle("Read files");
      expect(dom.root.textContent).toContain("Read files");
      expect(dom.root.querySelector("details")).toBe(details);
      expect(details.open).toBe(true);
      expect(renders).toBe(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

if (!isServer)
  test("a controlled row shows its body when it opens, before the host passes its new state back", async () => {
    const dom = createDomTestHarness();
    const { ChatActivity } = await import("../src/chat/ChatPrimitives");
    const [open, setOpen] = createSignal<boolean | undefined>(false);
    const changes: boolean[] = [];
    const dispose = render(
      () =>
        createComponent(ChatActivity, {
          label: "Worked 3 min",
          get open() {
            return open();
          },
          onOpenChange: (next: boolean) => void changes.push(next),
          renderBody: () => "Steps",
        }),
      dom.root,
    );
    try {
      const details = dom.root.querySelector("details")!;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      expect(changes.at(-1)).toBe(true);
      expect(dom.root.textContent).toContain("Steps");
      // The host's state wins once it changes.
      setOpen(true);
      setOpen(false);
      expect(details.open).toBe(false);
      expect(dom.root.textContent).not.toContain("Steps");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

if (!isServer) {
  test("the activity toggle reports changes and follows controlled open", async () => {
    const dom = createDomTestHarness();
    // Each test owns a new document; cached Solid modules delegated to the previous one.
    delegateEvents(["click"], dom.document);
    const { Chat } = await import("../src/chat");
    const [open, setOpen] = createSignal(false);
    const changes: boolean[] = [];
    const dispose = render(
      () =>
        createComponent(Chat.Activity, {
          get label() {
            return createComponent(Chat.Activity.Toggle, { children: "3 of 4 tasks" });
          },
          get open() {
            return open();
          },
          onOpenChange: (next) => {
            changes.push(next);
            setOpen(next);
          },
          children: "Task list",
        }),
      dom.root,
    );
    try {
      const button = dom.root.querySelector("button")!;
      const body = dom.root.querySelector<HTMLElement>(".k2b-chat-activity__body")!;
      expect(body.hidden).toBe(true);
      button.click();
      expect(changes).toEqual([true]);
      expect(open()).toBe(true);
      expect(body.hidden).toBe(false);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      button.click();
      expect(changes).toEqual([true, false]);
      expect(body.hidden).toBe(true);
      setOpen(true);
      expect(body.hidden).toBe(false);
      setOpen(false);
      expect(body.hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(changes).toEqual([true, false]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("toggle renderBody mounts only while open and removes its content on close", async () => {
    const dom = createDomTestHarness();
    // Each test owns a new document; cached Solid modules delegated to the previous one.
    delegateEvents(["click"], dom.document);
    const { Chat } = await import("../src/chat");
    let mounts = 0;
    const dispose = render(
      () =>
        createComponent(Chat.Activity, {
          get label() {
            return createComponent(Chat.Activity.Toggle, { children: "3 of 4 tasks" });
          },
          renderBody: () => {
            mounts++;
            return "Lazy task list";
          },
        }),
      dom.root,
    );
    try {
      const button = dom.root.querySelector("button")!;
      expect(mounts).toBe(0);
      expect(dom.root.textContent).not.toContain("Lazy task list");
      button.click();
      expect(mounts).toBe(1);
      expect(dom.root.textContent).toContain("Lazy task list");
      button.click();
      expect(dom.root.textContent).not.toContain("Lazy task list");
      button.click();
      expect(mounts).toBe(2);
      expect(dom.root.textContent).toContain("Lazy task list");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
