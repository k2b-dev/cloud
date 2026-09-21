import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { ChatCommand } from "../src/chat/ChatComposer";
import type { ChatMention, ChatSubmitInput } from "../src/chat/types";
import { createDomTestHarness } from "./dom";

const createHarness = () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "input", "keydown", "keyup"]);
  return dom;
};

test("selects a mention in the middle, restores Todos, submits its identity and undoes it", async () => {
  const dom = createHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal("Use /sk please");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>([]);
  const submitted: ChatSubmitInput[] = [];
  const todo = dom.document.createElement("div");
  todo.textContent = "Current task";
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        get value() {
          return value();
        },
        onValueChange: setValue,
        get mentions() {
          return mentions();
        },
        onMentionsChange: setMentions,
        accessory: todo,
        commands: [{ name: "skill", description: "Skill", mention: { id: "one", name: "My skill", data: { ref: "one" } } }],
        onSubmit(input) {
          submitted.push(input);
        },
      }),
    dom.root,
  );
  const textarea = dom.root.querySelector("textarea")!;
  textarea.setSelectionRange(7, 7);
  textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(dom.root.querySelector('[role="option"]')).not.toBeNull();
  expect(textarea.getAttribute("role")).toBe("combobox");
  expect(textarea.getAttribute("aria-controls")).toBe(dom.root.querySelector('[role="listbox"]')?.id ?? null);
  expect(textarea.getAttribute("aria-activedescendant")).toBe(dom.root.querySelector('[role="option"]')?.id ?? null);
  expect(todo.parentElement?.style.visibility).toBe("hidden");
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  expect(value()).toBe("Use My skill  please");
  expect(mentions()).toHaveLength(1);
  expect(submitted).toHaveLength(0);
  expect(todo.parentElement?.style.visibility).not.toBe("hidden");
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  expect(value()).toBe("Use /sk please");
  expect(mentions()).toHaveLength(0);
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  expect(mentions()).toHaveLength(1);
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(submitted[0]?.mentions?.[0]?.attachment.id).toBe("one");
  dispose();
  dom.cleanup();
});

test("Escape preserves the complete draft and IME Enter never executes a command", async () => {
  const dom = createHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal("Before /compact after");
  let calls = 0;
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        get value() {
          return value();
        },
        onValueChange: setValue,
        onSubmit() {
          calls++;
        },
        commands: [
          {
            name: "compact",
            description: "Compact",
            action() {
              calls++;
            },
          },
        ],
      }),
    dom.root,
  );
  const input = dom.root.querySelector("textarea")!;
  input.setSelectionRange(15, 15);
  input.click();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  expect(calls).toBe(0);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(value()).toBe("Before /compact after");
  expect(dom.root.querySelector('[role="option"]')).toBeNull();
  dispose();
  dom.cleanup();
});

test("shows a labelled loading row and ignores results from an aborted search", async () => {
  const dom = createHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal("/old");
  const pending: { signal: AbortSignal; resolve: (items: readonly ChatCommand[]) => void }[] = [];
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        get value() {
          return value();
        },
        onValueChange: setValue,
        onSubmit() {},
        searchCommands: (_query, signal) =>
          new Promise((resolve) => {
            pending.push({ signal, resolve });
          }),
      }),
    dom.root,
  );
  const input = dom.root.querySelector("textarea")!;
  input.setSelectionRange(4, 4);
  input.click();
  expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Loading...");
  expect(dom.root.querySelector('[role="status"] .k2b-spin')).not.toBeNull();
  await Bun.sleep(140);
  input.value = "/new";
  input.setSelectionRange(4, 4);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await Bun.sleep(140);
  expect(pending[0]?.signal.aborted).toBe(true);
  pending[1]!.resolve([{ name: "New", description: "Current", action() {} }]);
  await Promise.resolve();
  await Promise.resolve();
  pending[0]!.resolve([{ name: "Old", description: "Stale", action() {} }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(dom.root.querySelector('[role="option"]')?.textContent).toBe("/NewCurrent");
  dispose();
  expect(pending[1]?.signal.aborted).toBe(true);
  dom.cleanup();
});

test("a command can replace the draft and request submission after its action completes", async () => {
  const dom = createHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal("/send");
  const submitted: string[] = [];
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        get value() {
          return value();
        },
        onValueChange: setValue,
        commands: [
          {
            name: "send",
            description: "Send",
            action({ setValue, submit }) {
              setValue("Hello");
              submit();
            },
          },
        ],
        onSubmit(input) {
          submitted.push(input.text);
        },
      }),
    dom.root,
  );
  const input = dom.root.querySelector("textarea")!;
  input.setSelectionRange(5, 5);
  input.click();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  expect(submitted).toEqual(["Hello"]);
  dispose();
  dom.cleanup();
});

test("an empty reactive accessory does not add a composer row after hydration", async () => {
  const dom = createHarness();
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [visible, setVisible] = createSignal(false);
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        value: "",
        onValueChange() {},
        onSubmit() {},
        get accessory() {
          return visible() ? "Tasks" : null;
        },
      }),
    dom.root,
  );
  try {
    expect(dom.root.querySelector(".k2b-chat-composer-slot")).toBeNull();
    setVisible(true);
    expect(dom.root.querySelector(".k2b-chat-composer-slot")?.textContent).toBe("Tasks");
    setVisible(false);
    expect(dom.root.querySelector(".k2b-chat-composer-slot")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});
