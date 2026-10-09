import { afterEach, expect, test } from "bun:test";
import { createComponent, createSignal, mergeProps } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { ChatComposerProps } from "../src/chat/ChatComposer";
import type { ChatDictationState, ChatSubmitInput } from "../src/chat/types";
import { createDomTestHarness } from "./dom";

let touchOnly = false;
const globals = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
  touchOnly = false;
  delete globals.matchMedia;
});

/** A composer with a controlled draft; `extra` adds or overrides props. */
const mount = async (initial: string, extra: Partial<ChatComposerProps> = {}) => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "input", "keydown", "keyup", "mousedown", "pointerdown", "pointerup"]);
  globals.matchMedia = (query: string) => ({
    matches: touchOnly && query.includes("coarse"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal(initial);
  const submitted: ChatSubmitInput[] = [];
  const dispose = render(
    () =>
      createComponent(
        ChatComposer,
        // mergeProps keeps getters in `extra` reactive.
        mergeProps(
          {
            get value() {
              return value();
            },
            onValueChange: setValue,
            onSubmit(input: ChatSubmitInput) {
              submitted.push(input);
            },
            variant: "conversation" as const,
          },
          extra,
        ),
      ),
    dom.root,
  );
  const textarea = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    textarea.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    dom,
    textarea,
    value,
    setValue,
    submitted,
    press,
    settle,
    button: (label: string) => dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    done: () => {
      dispose();
      dom.cleanup();
    },
  };
};

test("Enter sends and Shift+Enter, IME input and an open code block break the line", async () => {
  const composer = await mount("Hello");
  expect(composer.press({ shiftKey: true })).toBe(false);
  expect(composer.press({ isComposing: true })).toBe(false);
  expect(composer.submitted).toHaveLength(0);

  composer.setValue("Look:\n```ts\nconst a = 1;");
  composer.textarea.value = composer.value();
  composer.textarea.setSelectionRange(composer.value().length, composer.value().length);
  expect(composer.press({})).toBe(false);
  expect(composer.submitted).toHaveLength(0);
  // Ctrl/⌘+Enter sends even inside a code block.
  expect(composer.press({ ctrlKey: true })).toBe(true);
  await composer.settle();
  expect(composer.submitted.map((input) => input.text)).toEqual(["Look:\n```ts\nconst a = 1;"]);

  // A closed block no longer keeps Enter.
  composer.setValue("```\nx\n```");
  composer.textarea.value = composer.value();
  composer.textarea.setSelectionRange(composer.value().length, composer.value().length);
  expect(composer.press({})).toBe(true);
  await composer.settle();
  expect(composer.submitted).toHaveLength(2);
  composer.done();
});

test("with sendKey mod-enter, Enter breaks the line and Ctrl/⌘+Enter sends", async () => {
  const composer = await mount("Hello", { sendKey: "mod-enter" });
  expect(composer.press({})).toBe(false);
  expect(composer.submitted).toHaveLength(0);
  expect(composer.press({ metaKey: true })).toBe(true);
  await composer.settle();
  expect(composer.submitted.map((input) => input.text)).toEqual(["Hello"]);
  composer.done();
});

test("on a touch-only device Enter breaks the line and Send sends while the field keeps focus", async () => {
  touchOnly = true;
  const composer = await mount("Hello");
  expect(composer.textarea.getAttribute("enterkeyhint")).toBe("enter");
  expect(composer.press({})).toBe(false);
  expect(composer.submitted).toHaveLength(0);
  const send = composer.button("Send message")!;
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  send.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  send.click();
  await composer.settle();
  expect(composer.submitted.map((input) => input.text)).toEqual(["Hello"]);
  composer.done();
});

test("the default composer keeps sending on Enter, also on touch-only devices, and has no hint line", async () => {
  touchOnly = true;
  const composer = await mount("Hello", { variant: "default" });
  expect(composer.dom.root.querySelector(".k2b-chat-composer__hint")).toBeNull();
  expect(composer.dom.root.querySelectorAll("textarea")).toHaveLength(1);
  expect(composer.textarea.hasAttribute("enterkeyhint")).toBe(false);
  composer.setValue("```\nstill sends");
  composer.textarea.value = composer.value();
  expect(composer.press({})).toBe(true);
  await composer.settle();
  expect(composer.submitted).toHaveLength(1);
  composer.done();
});

test("a tap on the microphone dictates and holding it asks for a voice message", async () => {
  const calls: string[] = [];
  const composer = await mount("", {
    microphone: { onDictate: () => calls.push("dictate"), onVoiceMessage: () => calls.push("voice") },
  });
  const microphone = composer.dom.root.querySelector<HTMLButtonElement>(".k2b-chat-composer__microphone-button")!;
  expect(microphone.getAttribute("aria-label")).toBe("Dictate");
  // A mouse event carries the same button; happy-dom's PointerEvent type is not the DOM one.
  const pointer = (type: string) => microphone.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  // A click from a pointer counts its presses in `detail`; one from Enter or Space has 0.
  const click = (detail: number) => microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  const hold = async () => {
    pointer("pointerdown");
    await new Promise((resolve) => setTimeout(resolve, 600));
  };

  pointer("pointerdown");
  pointer("pointerup");
  click(1);
  expect(calls).toEqual(["dictate"]);

  await hold();
  expect(calls).toEqual(["dictate", "voice"]);
  pointer("pointerup");
  // The click that ends the hold does not dictate as well.
  click(1);
  expect(calls).toEqual(["dictate", "voice"]);

  // A hold released outside the button has no click; the next key press still dictates.
  await hold();
  pointer("pointerleave");
  click(0);
  expect(calls).toEqual(["dictate", "voice", "voice", "dictate"]);

  // The menu next to the microphone offers both.
  composer.dom.root.querySelector<HTMLButtonElement>('button[aria-label="Microphone options"]')!.click();
  await composer.settle();
  const items = Array.from(composer.dom.document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
  expect(items).toEqual(["Dictate", "Record voice message"]);
  composer.done();
});

test("without live dictation a tap opens the microphone menu", async () => {
  const calls: string[] = [];
  const composer = await mount("", { microphone: { onVoiceMessage: () => calls.push("voice") } });
  const microphone = composer.dom.root.querySelector<HTMLButtonElement>(".k2b-chat-composer__microphone-button")!;
  expect(microphone.getAttribute("aria-haspopup")).toBe("menu");
  microphone.click();
  await composer.settle();
  const item = composer.dom.document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(item.textContent?.trim()).toBe("Record voice message");
  item.click();
  expect(calls).toEqual(["voice"]);
  composer.done();
});

test("the hint line shows the dictation state at its fixed place and offers to restore the original", async () => {
  const [state, setState] = createSignal<ChatDictationState | null>(null);
  let restored = 0;
  const composer = await mount("", {
    hint: "Everyone in the chat sees the reference.",
    get microphone() {
      return { onDictate: () => {}, dictation: state(), onRestoreOriginal: () => restored++ };
    },
  });
  const hint = () => composer.dom.root.querySelector(".k2b-chat-composer__hint")!;
  expect(hint().textContent).toBe("Everyone in the chat sees the reference.");
  setState("listening");
  expect(hint().textContent).toBe("Dictating …");
  const microphone = composer.button("Dictate")!;
  expect(microphone.getAttribute("aria-pressed")).toBe("true");
  expect(microphone.querySelector("i")?.className).toBe("ti ti-player-stop");
  setState("refined");
  expect(hint().textContent).toBe("Text refinedRestore original");
  hint().querySelector("button")!.click();
  expect(restored).toBe(1);
  setState("interrupted");
  expect(hint().textContent).toBe("Dictation interrupted");
  setState(null);
  expect(hint().textContent).toBe("Everyone in the chat sees the reference.");
  composer.done();
});

test("Aa shows the formatting buttons, which format the selection like their shortcuts", async () => {
  const composer = await mount("make this bold", { formatting: true });
  const toggle = composer.button("Formatting")!;
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(composer.dom.root.querySelector(".k2b-chat-composer__format")).toBeNull();
  toggle.click();
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  const group = composer.dom.root.querySelector(".k2b-chat-composer__format")!;
  expect(toggle.getAttribute("aria-controls")).toBe(group.id);
  expect(Array.from(group.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"))).toEqual([
    "Bold (Ctrl/Cmd+B)",
    "Italic (Ctrl/Cmd+I)",
    "Strikethrough (Ctrl/Cmd+Shift+X)",
    "Inline code (Ctrl/Cmd+E)",
    "Code block",
    "Bullet list (Ctrl/Cmd+Shift+8)",
    "Quote",
    "Link",
  ]);

  composer.textarea.setSelectionRange(10, 14);
  composer.button("Bold (Ctrl/Cmd+B)")!.click();
  expect(composer.value()).toBe("make this **bold**");

  composer.textarea.setSelectionRange(0, 4);
  composer.press({ key: "i", ctrlKey: true });
  expect(composer.value()).toBe("_make_ this **bold**");

  composer.textarea.setSelectionRange(0, 0);
  composer.button("Quote")!.click();
  expect(composer.value()).toBe("> _make_ this **bold**");

  toggle.click();
  expect(composer.dom.root.querySelector(".k2b-chat-composer__format")).toBeNull();
  composer.done();
});

test("formatting shortcuts stay off without formatting", async () => {
  const composer = await mount("plain");
  composer.textarea.setSelectionRange(0, 5);
  expect(composer.press({ key: "b", ctrlKey: true })).toBe(false);
  expect(composer.value()).toBe("plain");
  composer.done();
});

test("the emoji button inserts at the caret", async () => {
  const composer = await mount("Good morning", {
    emoji: {
      onOpen: ({ anchor, insert }) => {
        expect(anchor.getAttribute("aria-label")).toBe("Insert emoji");
        insert(" ☀️");
      },
    },
  });
  composer.textarea.setSelectionRange(12, 12);
  composer.button("Insert emoji")!.click();
  expect(composer.value()).toBe("Good morning ☀️");
  composer.done();
});
