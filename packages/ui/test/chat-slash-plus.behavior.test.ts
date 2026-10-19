import { afterEach, expect, mock, test } from "bun:test";
import { batch, createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { ChatCommand, ChatCommandOpenResult, ChatComposerProps } from "../src/chat/ChatComposer";
import type { ChatMention } from "../src/chat/types";
import { createDomTestHarness } from "./dom";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const mention = { id: "skill-1", name: "My skill", data: { ref: "skill-1" } };
const mount = async (options: Partial<ChatComposerProps> = {}, locale = "en") => {
  const dom = createDomTestHarness();
  cleanups.push(dom.cleanup);
  const opened = new WeakSet<HTMLElement>();
  const prototype = HTMLElement.prototype;
  const matches = prototype.matches;
  Object.defineProperty(prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string) {
      return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
    },
  });
  const toggle = (element: HTMLElement, newState: string) => element.dispatchEvent(Object.assign(new Event("toggle"), { newState }));
  prototype.showPopover = function () {
    opened.add(this);
    toggle(this, "open");
  };
  prototype.hidePopover = function () {
    if (opened.delete(this)) toggle(this, "closed");
  };
  delegateEvents(["click", "input", "keydown", "keyup", "beforeinput", "focusout", "compositionstart", "compositionend"]);
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const { LocaleProvider } = await import("../src/intl/locale");
  const [value, setValue] = createSignal(options.value ?? "Hello world");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>(options.mentions ?? []);
  const [draftKey, setDraftKey] = createSignal("first");
  const ran = mock(() => {});
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(ChatComposer, {
            addOpensCommands: true,
            commands: [{ name: "skill", description: "Insert a skill", mention }],
            ...options,
            get value() {
              return value();
            },
            onValueChange: setValue,
            get mentions() {
              return mentions();
            },
            onMentionsChange: setMentions,
            get draftKey() {
              return draftKey();
            },
            onSubmit: ran,
          });
        },
      }),
    dom.root,
  );
  cleanups.push(dispose);
  const textarea = dom.root.querySelector("textarea")!;
  const plus = () => dom.root.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  const search = () => dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const rows = () => [...dom.root.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const labels = () => rows().map((row) => row.querySelector("strong")?.textContent);
  const key = (key: string, modifiers: KeyboardEventInit = {}, target: HTMLElement = search()) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    target.dispatchEvent(event);
    return event;
  };
  const type = (text: string, target: HTMLInputElement | HTMLTextAreaElement = search()) =>
    batch(() => {
      target.value = text;
      target.setSelectionRange(text.length, text.length);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const open = (start = 5, end = start) => {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    textarea.click();
    plus().click();
    expect(search()).not.toBeNull();
  };
  return { ...dom, textarea, plus, search, rows, labels, key, type, open, value, setValue, mentions, setDraftKey, ran };
};

test("opt-in replaces the legacy add Dropdown and hides menuActions in both variants", async () => {
  for (const variant of ["default", "conversation"] as const) {
    const options: Partial<ChatComposerProps> = {
      variant,
      fileSelection: { onSelect() {} },
      menuActions: [{ id: "poll", label: "Poll", onSelect() {} }],
    };
    const legacy = await mount({ ...options, addOpensCommands: false });
    const trigger = legacy.root.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(trigger).not.toBeNull();
    trigger.click();
    expect(legacy.root.textContent).toContain("Attach files");
    expect(legacy.root.textContent).toContain("Poll");
    const h = await mount(options);
    expect(h.plus().getAttribute("aria-label")).toBe("Add");
    expect(h.plus().getAttribute("aria-expanded")).toBe("false");
    expect(h.plus().hasAttribute("aria-controls")).toBe(false);
    h.open();
    expect(h.plus().getAttribute("aria-expanded")).toBe("true");
    expect(h.root.textContent).not.toContain("Poll");
    expect(h.root.querySelector('[role="menu"]')).toBeNull();
  }
});

test("Plus focuses its combobox and renders sections in the declared order", async () => {
  const h = await mount({
    commandSections: [
      { id: "recent", label: "Recent" },
      { id: "insert", label: "Insert" },
      { id: "chat", label: "This chat" },
    ],
    commands: [
      { name: "chat", description: "Chat", section: "chat" },
      { name: "insert", description: "Insert", section: "insert" },
      { name: "recent", description: "Recent", section: "recent" },
    ],
  });
  h.open();
  const list = h.root.querySelector('[role="listbox"]')!;
  expect(h.document.activeElement === h.search()).toBe(true);
  expect(h.search().getAttribute("aria-label")).toBe("Search entries");
  expect(h.search().getAttribute("aria-controls")).toBe(list.id);
  expect(h.plus().getAttribute("aria-controls")).toBe(list.id);
  expect(h.search().getAttribute("aria-activedescendant")).toBe(h.rows()[0]!.id);
  expect(h.textarea.hasAttribute("role")).toBe(false);
  expect(h.textarea.hasAttribute("aria-activedescendant")).toBe(false);
  expect([...h.root.querySelectorAll(".k2b-chat-composer__command-heading span")].map((el) => el.textContent)).toEqual([
    "Recent",
    "Insert",
    "This chat",
  ]);
});

test("Plus inherits German labels", async () => {
  const h = await mount({}, "de");
  expect(h.plus().getAttribute("aria-label")).toBe("Hinzufügen");
  h.open();
  expect(h.search().getAttribute("aria-label")).toBe("Einträge durchsuchen");
  expect(h.search().placeholder).toBe("Suchen");
});

test("search filters the same command rows as typing slash", async () => {
  const commands: ChatCommand[] = [
    { name: "skill", label: "My skill", description: "Insert skill", keywords: ["recipe"] },
    { name: "search", description: "Search this chat" },
    { name: "other", description: "Other" },
  ];
  const h = await mount({ commands });
  for (const query of ["s", "skill", "recipe", "absent"]) {
    h.open();
    h.type(query);
    const plusLabels = h.labels();
    h.key("Escape");
    h.type("", h.textarea);
    h.type(`/${query}`, h.textarea);
    expect(h.labels()).toEqual(plusLabels);
    h.key("Escape", {}, h.textarea);
  }
});

test("Tab narrows a scope in the search field and preserves the textarea", async () => {
  const h = await mount({
    commandScopes: [{ id: "notes", words: ["note"], title: "Notes" }],
    commands: [
      { name: "notes", label: "All notes", description: "Narrow", scope: "notes" },
      { name: "other", description: "Other" },
    ],
    searchCommands: async (_query, _signal, context) =>
      context.scope === "notes" ? [{ name: "note-one", label: "One note", description: "Note" }] : [],
  });
  h.open();
  h.key("Tab");
  expect(h.search().value).toBe("note ");
  expect(h.value()).toBe("Hello world");
  await Bun.sleep(160);
  await flush();
  expect(h.labels()).toContain("One note");
  expect(h.labels()).not.toContain("other");
});

test.each([5, 6])("mention inserts at stored caret %s with correct offsets, focus and one-step undo", async (caret) => {
  const h = await mount();
  h.open(caret);
  h.key("Enter");
  await flush();
  const start = 6;
  expect(h.value()).toBe(caret === 5 ? "Hello My skill  world" : "Hello My skill world");
  expect(h.mentions()).toEqual([{ start, end: 14, attachment: mention }]);
  expect(h.document.activeElement === h.textarea).toBe(true);
  expect([h.textarea.selectionStart, h.textarea.selectionEnd]).toEqual([15, 15]);
  h.key("z", { ctrlKey: true }, h.textarea);
  await flush();
  expect(h.value()).toBe("Hello world");
  expect(h.mentions()).toEqual([]);
  expect(h.textarea.selectionStart).toBe(caret);
});

test("a selected range inserts at its end without replacing the selected text", async () => {
  const h = await mount();
  h.open(0, 5);
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Hello My skill  world");
  expect(h.mentions()[0]).toMatchObject({ start: 6, end: 14 });
});

test("a stored caret is clamped when the controlled draft shrinks while Plus is open", async () => {
  const h = await mount();
  h.open(11);
  h.setValue("Hi");
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Hi My skill ");
  expect(h.mentions()[0]).toMatchObject({ start: 3, end: 11 });
  expect(h.textarea.selectionStart).toBe(12);
});

test("an action returning a mention inserts at the stored caret and undoes in one step", async () => {
  const h = await mount({ commands: [{ name: "pick", description: "Pick", action: async () => ({ mention }) }] });
  h.open();
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Hello My skill  world");
  expect(h.mentions()).toEqual([{ start: 6, end: 14, attachment: mention }]);
  expect(h.document.activeElement === h.textarea).toBe(true);
  expect(h.textarea.selectionStart).toBe(15);
  h.key("z", { ctrlKey: true }, h.textarea);
  await flush();
  expect(h.value()).toBe("Hello world");
  expect(h.mentions()).toEqual([]);
});

test.each([false, true])("cancelled action restores the stored selection (range=%s) without an undo step", async (range) => {
  const h = await mount({ commands: [{ name: "pick", description: "Pick", action: async () => "cancelled" as const }] });
  h.open(range ? 1 : 5, 5);
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Hello world");
  expect(h.document.activeElement === h.textarea).toBe(true);
  expect([h.textarea.selectionStart, h.textarea.selectionEnd]).toEqual([range ? 1 : 5, 5]);
  h.key("z", { ctrlKey: true }, h.textarea);
  expect(h.value()).toBe("Hello world");
});

for (const close of ["Escape", "toggle", "mouse", "touch", "pen"]) {
  test(`${close} closes Plus, swallows outside activation and restores the selection`, async () => {
    const action = mock(() => {});
    const h = await mount({ commands: [{ name: "run", description: "Run", action }] });
    const outside = h.document.createElement("button");
    const clicked = mock(() => {});
    outside.addEventListener("click", clicked);
    h.document.body.append(outside);
    h.open(1, 5);
    if (close === "Escape") h.key("Escape");
    else if (close === "toggle") h.plus().click();
    else {
      outside.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true, cancelable: true }), { pointerType: close }));
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    expect(h.root.querySelector('[role="listbox"]')).toBeNull();
    expect(h.plus().getAttribute("aria-expanded")).toBe("false");
    expect(h.document.activeElement === h.textarea).toBe(true);
    expect([h.textarea.selectionStart, h.textarea.selectionEnd]).toEqual([1, 5]);
    expect(h.value()).toBe("Hello world");
    expect(action).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  });
}

test("closing Plus over an existing slash token does not reopen its list", async () => {
  const h = await mount({ value: "/skill" });
  h.open(6);
  h.key("Escape");
  await flush();
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  expect(h.value()).toBe("/skill");
});

test("leaving the search field closes without stealing focus", async () => {
  const h = await mount();
  h.open();
  const outside = h.document.createElement("button");
  h.document.body.append(outside);
  outside.focus();
  await flush();
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  expect(h.document.activeElement === outside).toBe(true);
});

test.each(["Enter", "Tab"])("only plain %s chooses, and IME confirmation never chooses", async (key) => {
  const action = mock(() => {});
  const h = await mount({ commands: [{ name: "run", description: "Run", action }] });
  h.open();
  for (const modifiers of [
    { shiftKey: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])
    h.key(key, modifiers);
  h.search().dispatchEvent(new Event("compositionstart", { bubbles: true }));
  h.key(key);
  expect(action).not.toHaveBeenCalled();
  h.search().dispatchEvent(new Event("compositionend", { bubbles: true }));
  h.key(key);
  await flush();
  expect(action).toHaveBeenCalledTimes(1);
  expect(h.ran).not.toHaveBeenCalled();
});

test.each([false, true])("Attach files opens choose and cancellation restores selection (range=%s)", async (range) => {
  const choose = mock(async () => [] as File[]);
  const h = await mount({
    commands: [{ name: "files", description: "Files", attachFiles: true }],
    fileSelection: { choose, onSelect() {} },
  });
  h.open(range ? 1 : 5, 5);
  h.key("Enter");
  expect(choose).toHaveBeenCalledTimes(1);
  await flush();
  expect(h.value()).toBe("Hello world");
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  expect(h.document.activeElement === h.textarea).toBe(true);
  expect([h.textarea.selectionStart, h.textarea.selectionEnd]).toEqual([range ? 1 : 5, 5]);
});

test("draftKey changes close Plus and cannot insert into the new draft", async () => {
  const h = await mount();
  h.open();
  h.setDraftKey("second");
  h.setValue("Second draft");
  await flush();
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  expect(h.plus().getAttribute("aria-expanded")).toBe("false");
  expect(h.mentions()).toEqual([]);
  expect(h.value()).toBe("Second draft");
});

test.each(["success", "failed", "cancelled", "escape"])("an open row from Plus handles %s without losing the draft", async (outcome) => {
  let resolve!: (result: ChatCommandOpenResult) => void;
  let signal!: AbortSignal;
  const open = mock((_draft: unknown, abort: AbortSignal) => {
    signal = abort;
    return new Promise<ChatCommandOpenResult>((done) => {
      resolve = done;
    });
  });
  const h = await mount({ commands: [{ id: "open", name: "open", description: "Open", open }] });
  h.open();
  h.key("Enter");
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]?.[0]).toMatchObject({ value: "Hello world", mentions: [] });
  expect(h.search().readOnly).toBe(true);
  if (outcome === "escape") h.key("Escape");
  else resolve(outcome === "success" ? undefined : outcome === "failed" ? { failed: "Unavailable" } : "cancelled");
  await flush();
  expect(h.value()).toBe("Hello world");
  if (outcome === "success" || outcome === "escape") {
    expect(h.root.querySelector('[role="listbox"]')).toBeNull();
    expect(h.document.activeElement === h.textarea).toBe(true);
    expect(h.textarea.selectionStart).toBe(5);
  } else {
    expect(h.search().readOnly).toBe(false);
    expect(h.document.activeElement === h.search()).toBe(true);
    if (outcome === "failed") expect(h.rows()[0]?.textContent).toContain("Unavailable");
  }
  expect(signal.aborted).toBe(outcome !== "success");
});

test("a new Plus session does not inherit unfinished composition from the old search field", async () => {
  const action = mock(() => {});
  const h = await mount({ commands: [{ name: "run", description: "Run", action }] });
  h.open();
  h.search().dispatchEvent(new Event("compositionstart", { bubbles: true }));
  h.plus().click();
  h.open();
  h.key("Enter");
  await flush();
  expect(action).toHaveBeenCalledTimes(1);
});

test("inserting before an existing mention shifts its range and preserves both identities through Undo", async () => {
  const existing = { id: "world", name: "world" };
  const h = await mount({ mentions: [{ start: 6, end: 11, attachment: existing }] });
  h.open();
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Hello My skill  world");
  expect(h.mentions()).toContainEqual({ start: 16, end: 21, attachment: existing });
  expect(h.mentions()).toContainEqual({ start: 6, end: 14, attachment: mention });
  h.key("z", { ctrlKey: true }, h.textarea);
  await flush();
  expect(h.mentions()).toEqual([{ start: 6, end: 11, attachment: existing }]);
});

test("an open row preserves a controlled edit while pending and restores focus on success", async () => {
  let resolve!: (result: ChatCommandOpenResult) => void;
  const h = await mount({
    commands: [
      {
        name: "open",
        description: "Open",
        open: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    ],
  });
  h.open(11);
  h.key("Enter");
  h.setValue("Hi");
  resolve(undefined);
  await flush();
  expect(h.value()).toBe("Hi");
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  expect(h.document.activeElement === h.textarea).toBe(true);
  expect([h.textarea.selectionStart, h.textarea.selectionEnd]).toEqual([2, 2]);
});

test("Plus opens its search over emoji suggestions for a shortcode at the caret", async () => {
  const h = await mount({ value: "Hi :smil", emoji: { onOpen() {} } });
  h.textarea.focus();
  h.textarea.setSelectionRange(8, 8);
  h.textarea.click();
  const deadline = Date.now() + 5_000;
  while (!h.root.querySelector('[role="listbox"][aria-label="Emoji suggestions"]') && Date.now() < deadline) await flush();
  expect(h.root.querySelector('[role="listbox"][aria-label="Emoji suggestions"]')).not.toBeNull();
  h.plus().click();
  expect(h.search()).not.toBeNull();
  expect(h.document.activeElement === h.search()).toBe(true);
  expect(h.root.querySelector('[role="listbox"][aria-label="Emoji suggestions"]')).toBeNull();
  expect(h.labels()).toEqual(["skill"]);
});
