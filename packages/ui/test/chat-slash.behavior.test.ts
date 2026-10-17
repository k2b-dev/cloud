import { afterEach, expect, spyOn, test } from "bun:test";
import { batch, createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { ChatCommand, ChatCommandResult, ChatComposerProps } from "../src/chat/ChatComposer";
import type { ChatMention, ChatSubmitInput } from "../src/chat/types";
import { createDomTestHarness } from "./dom";

const installPopoverStub = () => {
  const open = new WeakSet<HTMLElement>();
  const prototype = HTMLElement.prototype as HTMLElement & { showPopover: () => void; hidePopover: () => void };
  const matches = prototype.matches;
  const toggle = (element: HTMLElement, newState: "open" | "closed") =>
    element.dispatchEvent(Object.assign(new Event("toggle"), { newState, oldState: newState === "open" ? "closed" : "open" }));
  Object.defineProperty(prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string): boolean {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
  });
  prototype.showPopover = function (this: HTMLElement) {
    if (open.has(this)) return;
    open.add(this);
    toggle(this, "open");
  };
  prototype.hidePopover = function (this: HTMLElement) {
    if (open.delete(this)) toggle(this, "closed");
  };
};

const createHarness = () => {
  const dom = createDomTestHarness();
  installPopoverStub();
  delegateEvents(["click", "input", "keydown", "keyup", "beforeinput"]);
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
  expect(dom.root.querySelector('[role="option"]')?.textContent).toBe("NewCurrent");
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

const slashCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of slashCleanups.splice(0).reverse()) cleanup();
});
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const slash = async (options: Partial<ChatComposerProps> = {}, locale = "en") => {
  const dom = createHarness();
  slashCleanups.push(dom.cleanup);
  dom.document.documentElement.lang = locale;
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal(options.value ?? "/");
  const [draftKey, setDraftKey] = createSignal("first");
  let submitted = 0;
  const errors: unknown[] = [];
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        ...options,
        get commands() {
          return options.commands;
        },
        get commandSections() {
          return options.commandSections;
        },
        get state() {
          return options.state;
        },
        get value() {
          return value();
        },
        onValueChange: setValue,
        get draftKey() {
          return draftKey();
        },
        onSubmit() {
          submitted++;
        },
        onError(error) {
          errors.push(error);
        },
      }),
    dom.root,
  );
  slashCleanups.push(dispose);
  const input = dom.root.querySelector("textarea")!;
  input.setSelectionRange(value().length, value().length);
  input.click();
  const type = (text: string) => {
    // A native edit updates text and selection together before its input event.
    batch(() => {
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = (key: string, modifiers: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    input.dispatchEvent(event);
    return event;
  };
  return {
    ...dom,
    input,
    value,
    setValue,
    setDraftKey,
    type,
    key,
    errors,
    unmount: () => {
      slashCleanups.splice(slashCleanups.indexOf(dispose), 1);
      dispose();
    },
    submitted: () => submitted,
    rows: () => [...dom.root.querySelectorAll<HTMLButtonElement>('[role="option"]')],
    status: () => dom.root.querySelector(".k2b-chat-composer__status")!,
  };
};
const compactCommand: ChatCommand = {
  name: "compact",
  label: "Chat kompaktieren",
  description: "Älteren Verlauf zusammenfassen",
  keywords: ["compact", "kompaktieren", "zusammenfassen"],
};

test.each(["Ctrl+Enter", "Cmd+Enter", "send before Back", "send during Back", "desktop", "another draft", "disabled meanwhile"])(
  "%s submits only after the phone sheet's history entry has left, keeping desktop synchronous",
  async (activation) => {
    const dom = createHarness();
    slashCleanups.push(dom.cleanup);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: activation !== "desktop" && query === "(any-pointer: coarse) and (not (any-pointer: fine))" }),
    });
    slashCleanups.push(() => {
      if (descriptor) Object.defineProperty(globalThis, "matchMedia", descriptor);
      else Reflect.deleteProperty(globalThis, "matchMedia");
    });
    const historyModule = await import("../src/feedback/dialog-core");
    const core = historyModule.createDialogCore();
    // The shared core belongs to the first test window; use a core created for this window.
    const hold = spyOn(historyModule, "holdDialogHistory").mockImplementation(core.holdHistory);
    const settled = spyOn(historyModule, "dialogHistorySettled").mockImplementation(core.historySettled);
    const go = spyOn(history, "go");
    slashCleanups.push(() => {
      hold.mockRestore();
      settled.mockRestore();
      go.mockRestore();
    });
    history.replaceState({ page: "chat" }, "");
    const { ChatComposer } = await import("../src/chat/ChatComposer");
    const [value, setValue] = createSignal("/");
    const [draftKey, setDraftKey] = createSignal("first");
    const [disabled, setDisabled] = createSignal(false);
    const submissions: ChatSubmitInput[] = [];
    const submissionStates: unknown[] = [];
    let resolveSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => {
      resolveSubmitted = resolve;
    });
    const dispose = render(
      () =>
        createComponent(ChatComposer, {
          get value() {
            return value();
          },
          onValueChange: setValue,
          get draftKey() {
            return draftKey();
          },
          get disabled() {
            return disabled();
          },
          commands: [compactCommand],
          variant: "conversation",
          onSubmit(input) {
            submissionStates.push(history.state);
            submissions.push(input);
            history.pushState({ page: "sent" }, "", "/sent");
            resolveSubmitted();
          },
        }),
      dom.root,
    );
    slashCleanups.push(dispose);
    const input = dom.root.querySelector("textarea")!;
    input.setSelectionRange(1, 1);
    input.click();
    expect(dom.root.querySelector('[role="listbox"]')).not.toBeNull();
    if (activation !== "desktop") expect(history.state.k2bDialog).toBeNumber();
    if (activation.startsWith("send")) {
      const send = dom.root.querySelector<HTMLButtonElement>(".k2b-chat-composer__send")!;
      send.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(dom.root.querySelector('[role="listbox"]')).toBeNull();
      if (activation === "send during Back") {
        await flush();
        expect(go).toHaveBeenCalledTimes(1);
      } else expect(go).not.toHaveBeenCalled();
      send.click();
    } else
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: activation !== "Cmd+Enter",
          metaKey: activation === "Cmd+Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    expect(submissions).toHaveLength(activation === "desktop" ? 1 : 0);
    if (activation === "another draft" || activation === "disabled meanwhile") {
      // Another conversation's draft replaces this one, or the composer is disabled, while the sheet's Back is on its
      // way: nothing is sent.
      if (activation === "another draft") setDraftKey("second");
      else setDisabled(true);
      await core.historySettled();
      await flush();
      expect(submissions).toEqual([]);
      expect(value()).toBe("/");
      return;
    }
    // Text typed while the sheet's Back is on its way goes out with the message instead of being cleared.
    if (activation !== "desktop") setValue("/ more");
    await submitted;
    expect(submissionStates).toEqual([{ page: "chat" }]);
    expect(submissions).toEqual([{ intent: "send", text: activation === "desktop" ? "/" : "/ more", mentions: [], attachments: [] }]);
    expect(value()).toBe("");
    expect(dom.root.querySelector('[role="listbox"]')).toBeNull();
    expect(location.pathname).toBe("/sent");
    const back = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    history.back();
    await back;
    expect(location.pathname).toBe("/");
    expect(history.state).toEqual({ page: "chat" });
  },
);

test("slash discovery matches labels, names, keywords and accents", async () => {
  const h = await slash({ commands: [compactCommand] });
  for (const query of ["kompakt", "compact", "zusammenfassen", "alter"]) {
    h.type(`/${query}`);
    expect(h.rows()[0]?.querySelector("strong")?.textContent).toBe("Chat kompaktieren");
  }
});

test("a command named by the query outranks one whose description only mentions it, so Enter picks it", async () => {
  const chosen: string[] = [];
  const command = (name: string, label: string, description: string, keywords: string[]): ChatCommand => ({
    name,
    label,
    description,
    keywords,
    action: () => void chosen.push(name),
  });
  for (const [query, fork, newChat] of [
    [
      "new",
      command("fork", "Fork chat", "New chat from the latest response, with this draft", ["fork"]),
      command("new", "New chat", "Start empty", ["new"]),
    ],
    [
      "neu",
      command("fork", "Chat abzweigen", "Neuer Chat ab der letzten Antwort", ["abzweigen"]),
      command("new", "Neuer Chat", "Leer anfangen", ["neu"]),
    ],
  ] as const) {
    const h = await slash({ commands: [fork, newChat] });
    h.type(`/${query}`);
    expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual([newChat.label, fork.label]);
    h.key("Enter");
    await Promise.resolve();
    expect(chosen.pop()).toBe("new");
  }
});

test("unavailable rows explain themselves, remain reachable, and announce instead of acting or sending", async () => {
  let calls = 0;
  const h = await slash({
    commands: [
      compactCommand,
      {
        name: "fork",
        description: "Original description",
        reason: "Wait for the first response",
        action() {
          calls++;
        },
      },
    ],
  });
  const row = h.rows()[1]!;
  const reason = row.querySelector("small")!;
  expect(reason.textContent).toBe("Wait for the first response");
  expect(row.getAttribute("aria-disabled")).toBe("true");
  expect(row.getAttribute("aria-describedby")).toBe(reason.id);
  expect(row.dataset.reason).toBe("true");
  h.key("ArrowDown");
  expect(h.input.getAttribute("aria-activedescendant")).toBe(row.id);
  for (const key of ["Enter", "Tab"]) {
    expect(h.key(key).defaultPrevented).toBe(true);
    expect(h.status().textContent).toBe(reason.textContent);
    expect(h.rows()).toHaveLength(2);
  }
  row.click();
  expect(h.status().querySelector(".k2b-sr-only")?.textContent).toBe(reason.textContent);
  expect(calls).toBe(0);
  expect(h.submitted()).toBe(0);
  h.key("ArrowUp");
  expect(h.status().textContent).toBe("");
  h.key("Escape");
  expect(h.status().textContent).toBe("");
});

test("legacy disabled rows still show descriptions and never choose", async () => {
  let calls = 0;
  const h = await slash({
    commands: [
      {
        name: "legacy",
        disabled: true,
        description: "Legacy description",
        action() {
          calls++;
        },
      },
    ],
  });
  expect(h.rows()[0]?.getAttribute("aria-disabled")).toBe("true");
  expect(h.rows()[0]?.querySelector("small")?.textContent).toBe("Legacy description");
  h.key("Enter");
  h.key("Tab");
  h.rows()[0]!.click();
  expect(calls).toBe(0);
  expect(h.submitted()).toBe(0);
});

const deferredSearch = () => {
  const requests: { signal: AbortSignal; resolve: (rows: readonly ChatCommand[]) => void; reject: (error: Error) => void }[] = [];
  return {
    requests,
    searchCommands: (_query: string, signal: AbortSignal) =>
      new Promise<readonly ChatCommand[]>((resolve, reject) => {
        requests.push({ signal, resolve, reject });
      }),
  };
};

test("search completion preserves manually scrolled local options from a commands getter", async () => {
  const search = deferredSearch();
  const h = await slash({
    ...search,
    get commands() {
      return Array.from({ length: 20 }, (_, index) => ({ name: `Command ${index}`, description: "Local" }));
    },
  });
  const list = h.root.querySelector<HTMLDivElement>('[role="listbox"]')!;
  Object.defineProperty(list, "clientHeight", { value: 200 });
  // Happy DOM has no layout; options move with the list's scroll position, including after a remount.
  const geometry = spyOn(h.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = h.rows().findIndex((row) => row === this);
    return new h.window.DOMRect(0, index < 0 ? 0 : index * 40 - list.scrollTop, 320, index < 0 ? 200 : 40);
  });
  slashCleanups.push(() => geometry.mockRestore());
  await Bun.sleep(140);
  await flush();
  expect(search.requests).toHaveLength(1);
  const rows = h.rows();
  expect(rows).toHaveLength(20);
  list.scrollTop = 120;
  list.dispatchEvent(new Event("scroll"));
  search.requests[0]!.resolve([]);
  await flush();
  expect(list.scrollTop).toBe(120);
  expect(h.rows()).toHaveLength(rows.length);
  h.rows().forEach((row, index) => expect(row).toBe(rows[index]!));
});

test.each(["Enter", "Tab"])("%s chooses a static command from a getter while search is pending", async (key) => {
  let chosen = 0;
  const make = (): ChatCommand[] => [{ name: "new", label: "Neuer Chat", description: "", action: () => void chosen++ }];
  const search = deferredSearch();
  const h = await slash({
    ...search,
    get commands() {
      return make();
    },
  });
  h.type("/neu");
  await Bun.sleep(140);
  expect(search.requests).toHaveLength(1);
  expect(h.rows()).toHaveLength(1);
  expect(h.key(key).defaultPrevented).toBe(true);
  await flush();
  expect(chosen).toBe(1);
  expect(h.value()).toBe("");
});

test("settled empty sections stay hidden while searching, show Loading, and reset for another slash token", async () => {
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/a", commandSections: [{ id: "skills", label: "Skills", searched: true }] });
  expect(h.root.querySelector(".k2b-chat-composer__command-placeholder")).not.toBeNull();
  expect(h.root.querySelector(".k2b-chat-composer__loading")).toBeNull();
  await Bun.sleep(140);
  search.requests[0]!.resolve([]);
  await flush();
  h.type("/ab");
  expect(h.root.querySelectorAll('[role="listbox"] [role="group"]')).toHaveLength(0);
  expect(h.root.querySelector(".k2b-chat-composer__loading")?.textContent).toBe("Loading...");
  h.type("plain");
  h.type("/");
  expect(h.root.querySelector('[role="group"] [role="presentation"]')?.textContent).toBe("Skills");
  expect(h.root.querySelector(".k2b-chat-composer__command-placeholder")).not.toBeNull();
  expect(h.root.querySelector(".k2b-chat-composer__loading")).toBeNull();
});

test.each(["Enter", "Tab"])("%s cannot choose a retained server row until fresh results arrive", async (key) => {
  const chosen: string[] = [];
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/project inv" });
  await Bun.sleep(140);
  search.requests[0]!.resolve([
    { name: "Invoices", keywords: ["project mkt"], description: "Old project", action: () => void chosen.push("Invoices") },
  ]);
  await flush();
  const rows = h.rows();
  expect(rows).toHaveLength(1);
  h.type("/project mkt");
  const unchanged = () => {
    expect(h.key(key).defaultPrevented).toBe(true);
    expect(chosen).toEqual([]);
    expect(h.value()).toBe("/project mkt");
    expect(h.rows()).toEqual(rows);
    expect(h.status().textContent).toBe("");
    expect(h.errors).toEqual([]);
    expect(h.submitted()).toBe(0);
  };
  unchanged();
  await Bun.sleep(140);
  unchanged();
  search.requests[1]!.resolve([{ name: "Marketing", description: "Current project", action: () => void chosen.push("Marketing") }]);
  await flush();
  h.key("Enter");
  await flush();
  expect(chosen).toEqual(["Marketing"]);
  expect(h.value()).toBe("");
});

test("pending searches still allow local keyboard choices and clicks on retained rows", async () => {
  for (const choice of ["local", "pointer"]) {
    const chosen: string[] = [];
    const search = deferredSearch();
    const h = await slash({
      ...search,
      value: "/q",
      commands: [{ name: "run", description: "Local", action: () => void chosen.push("local") }],
    });
    await Bun.sleep(140);
    search.requests[0]!.resolve([
      { name: "Remote", keywords: ["run"], description: "Retained", action: () => void chosen.push("pointer") },
    ]);
    await flush();
    h.type("/run");
    if (choice === "local") h.key("Enter");
    else h.rows().at(-1)!.click();
    await flush();
    expect(chosen).toEqual([choice]);
    expect(h.value()).toBe("");
  }
});

test("a static command that the search also returns stays choosable while the next search loads", async () => {
  const chosen: string[] = [];
  const shared: ChatCommand = { name: "run", description: "Local and remote", action: () => void chosen.push("run") };
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/r", commands: [shared] });
  await Bun.sleep(140);
  search.requests[0]!.resolve([shared]);
  await flush();
  h.type("/ru");
  h.key("Enter");
  await flush();
  expect(chosen).toEqual(["run"]);
});

test("retains rows and safe ids through debounce, preserves arrow marking on results, resets on typing", async () => {
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/q" });
  await Bun.sleep(140);
  const rows = [
    { id: 'a" ]#ü', name: "A", keywords: ["que"], description: "First" },
    { id: "b", name: "B", keywords: ["que"], description: "Second" },
  ];
  search.requests[0]!.resolve(rows);
  await flush();
  const ids = h.rows().map((row) => row.id);
  expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
  h.key("ArrowDown");
  expect(h.input.getAttribute("aria-activedescendant")).toBe(ids[1]!);
  h.type("/qu");
  expect(h.rows().map((row) => row.id)).toEqual(ids);
  expect(h.input.getAttribute("aria-activedescendant")).toBe(ids[0]!);
  expect(h.root.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
  expect(h.root.querySelector(".k2b-chat-composer__loading")).toBeNull();
  h.key("ArrowDown");
  await Bun.sleep(140);
  search.requests[1]!.resolve([
    { id: "top", name: "New", keywords: ["que"], description: "New top" },
    { ...rows[1]!, label: "Still B" },
  ]);
  await flush();
  expect(h.rows().map((row) => row.textContent)).toEqual(["NewNew top", "Still BSecond"]);
  expect(h.input.getAttribute("aria-activedescendant")).toBe(ids[1]!);
  h.type("/que");
  expect(h.input.getAttribute("aria-activedescendant")).toBe(h.rows()[0]!.id);
});

test("deduplicates static then server rows by key and leaves filtering of server results to the server", async () => {
  const h = await slash({
    value: "/compact",
    commands: [compactCommand],
    searchCommands: async () => [
      { ...compactCommand, label: "Duplicate" },
      { name: "unrelated", description: "Server result" },
    ],
  });
  await Bun.sleep(140);
  await flush();
  expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual(["Chat kompaktieren", "unrelated"]);
});

test("drops retained rows on draft change, token removal and search failure", async () => {
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/q" });
  await Bun.sleep(140);
  search.requests[0]!.resolve([{ name: "old", description: "Old draft" }]);
  await flush();
  expect(h.rows()).toHaveLength(1);
  h.setDraftKey("second");
  h.input.click();
  expect(h.rows()).toHaveLength(0);
  await Bun.sleep(140);
  search.requests.at(-1)!.resolve([{ name: "next", description: "Second draft" }]);
  await flush();
  expect(h.rows()).toHaveLength(1);
  h.type("plain");
  h.type("/q");
  expect(h.rows()).toHaveLength(0);
  await Bun.sleep(140);
  search.requests.at(-1)!.resolve([{ name: "retained", keywords: ["qu"], description: "Current" }]);
  await flush();
  h.type("/qu");
  expect(h.rows()).toHaveLength(1);
  await Bun.sleep(140);
  search.requests.at(-1)!.reject(new Error("Search failed"));
  await flush();
  expect(h.rows()).toHaveLength(0);
  expect(h.root.querySelector('[role="listbox"]')?.textContent).toContain("Error");
});

test("cancel restores the exact token with the caret after it and stays closed until editing", async () => {
  const h = await slash({
    value: "/notiz q3",
    commands: [{ name: "notiz", description: "Note", keywords: ["notiz q3"], action: async (): Promise<ChatCommandResult> => "cancelled" }],
  });
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("/notiz q3");
  expect(h.input.selectionStart).toBe(9);
  expect(h.rows()).toHaveLength(0);
  expect(h.status().textContent).toBe("");
  h.type("/notiz q3x");
  expect(h.root.querySelector('[role="listbox"]')).not.toBeNull();
});

test("a cancelled or failed command leaves no undo step: undo goes back to the edit before it", async () => {
  for (const action of [async (): Promise<ChatCommandResult> => "cancelled", async () => Promise.reject(new Error("No"))]) {
    const h = await slash({ value: "Before", commands: [{ name: "cancel", description: "Cancel", action }] });
    h.type("Before /cancel after");
    h.input.setSelectionRange(14, 14);
    h.input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    h.key("Enter");
    await flush();
    expect(h.value()).toBe("Before /cancel after");
    h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(h.value()).toBe("Before");
    h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(h.value()).toBe("Before /cancel after");
  }
});

test("rejection restores token, announces once in the persistent status, and clears error on edit", async () => {
  const h = await slash({
    value: "/fail",
    commands: [
      {
        name: "fail",
        description: "Fails",
        action() {
          throw new Error("Try again later");
        },
      },
    ],
  });
  const status = h.status();
  const timer = spyOn(globalThis, "setTimeout");
  try {
    h.key("Enter");
    await flush();
    // No expiry timer means the error survives both the 3 s done window and the former 6 s error window, without sleeping.
    expect(timer).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
  }
  expect(h.value()).toBe("/fail");
  expect(h.input.selectionStart).toBe(5);
  expect(h.rows()).toHaveLength(0);
  expect(h.status()).toBe(status);
  expect(status.getAttribute("role")).toBe("status");
  expect(status.querySelector('[data-tone="error"]')?.textContent).toBe("Try again later");
  expect(h.errors).toEqual([]);
  h.type("/failx");
  expect(status.textContent).toBe("");
});

test("a failure after the composer unmounted reaches onError instead of disappearing", async () => {
  let reject!: (error: Error) => void;
  const h = await slash({
    value: "/fail",
    commands: [
      {
        name: "fail",
        description: "Fails",
        action: () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      },
    ],
  });
  h.key("Enter");
  h.unmount();
  const failure = new Error("Gone");
  reject(failure);
  await flush();
  expect(h.errors).toEqual([failure]);
});

test("arrow marking does not carry over to another draft with the same slash query", async () => {
  const h = await slash({ value: "/", commands: [compactCommand, { name: "fork", description: "Fork" }] });
  h.key("ArrowDown");
  expect(h.rows()[1]!.getAttribute("aria-selected")).toBe("true");
  h.setDraftKey("second");
  h.type("/");
  expect(h.rows()[0]!.getAttribute("aria-selected")).toBe("true");
});

test("a failure stays with its draft: switching drafts clears it, a later failure still shows", async () => {
  let reject!: (error: Error) => void;
  const h = await slash({
    value: "/fail",
    commands: [
      {
        name: "fail",
        description: "Fails",
        action: () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      },
    ],
  });
  h.key("Enter");
  reject(new Error("First failure"));
  await flush();
  expect(h.status().querySelector('[data-tone="error"]')?.textContent).toBe("First failure");
  h.setDraftKey("second");
  await flush();
  expect(h.status().textContent).toBe("");
  h.type("/fail");
  h.key("Enter");
  h.setDraftKey("third");
  reject(new Error("Late failure"));
  await flush();
  // Reported where the person is now rather than lost; the draft it came from is not restored.
  expect(h.status().querySelector('[data-tone="error"]')?.textContent).toBe("Late failure");
});

test("a rejected command never overwrites an edited draft or a different draft", async () => {
  for (const change of ["edit", "draft"] as const) {
    let reject!: (error: Error) => void;
    const h = await slash({
      value: "/fail",
      commands: [
        {
          name: "fail",
          description: "Fails",
          action: () =>
            new Promise<void>((_, fail) => {
              reject = fail;
            }),
        },
      ],
    });
    h.key("Enter");
    h.setValue("New work");
    if (change === "draft") {
      h.setValue("");
      h.setDraftKey("elsewhere");
    }
    reject(new Error("Failure"));
    await flush();
    expect(h.value()).toBe(change === "edit" ? "New work" : "");
    expect(h.errors).toEqual([]);
  }
});

test("only plain Enter and Tab choose; Shift keys fall through and Ctrl+Enter sends", async () => {
  let calls = 0;
  const h = await slash({
    value: "/run",
    commands: [
      {
        name: "run",
        description: "Run",
        action() {
          calls++;
        },
      },
    ],
  });
  expect(h.key("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
  expect(h.key("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
  h.key("Tab", { altKey: true });
  h.key("Tab", { ctrlKey: true });
  h.key("Tab", { metaKey: true });
  expect(calls).toBe(0);
  expect(h.submitted()).toBe(0);
  h.key("Enter", { ctrlKey: true });
  await flush();
  expect(h.submitted()).toBe(1);
  expect(calls).toBe(0);
});

test("Escape closes this slash through more typing; another slash opens", async () => {
  let ran = 0;
  const h = await slash({ value: "/c", commands: [{ ...compactCommand, action: () => void ran++ }] });
  h.key("Escape");
  h.type("/com");
  expect(Boolean(h.root.querySelector('[role="listbox"]'))).toBe(false);
  // Moving the caret inside the same token keeps it closed, so Enter cannot run the dismissed command.
  h.input.setSelectionRange(2, 2);
  h.input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
  expect(Boolean(h.root.querySelector('[role="listbox"]'))).toBe(false);
  // A selection, or leaving the token and coming back, does not reopen it either.
  h.input.setSelectionRange(1, 4);
  h.input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
  h.input.setSelectionRange(4, 4);
  h.input.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
  expect(Boolean(h.root.querySelector('[role="listbox"]'))).toBe(false);
  // Tab would choose if the list had reopened; Enter would also send the draft here.
  h.key("Tab");
  expect(ran).toBe(0);
  h.type("/com /c");
  expect(h.rows()).toHaveLength(1);
});

test("busy and done use the status line; done survives draft switching and hides behind suggestions", async () => {
  let resolve!: (result: ChatCommandResult) => void;
  const h = await slash({
    value: "/done",
    commands: [
      {
        name: "done",
        description: "Done",
        busyLabel: "Working",
        action: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    ],
  });
  h.key("Enter");
  expect(h.status().querySelector('[data-tone="busy"]')?.textContent).toBe("Working");
  h.setDraftKey("next");
  resolve({ done: "Finished" });
  await flush();
  expect(h.status().querySelector('[data-tone="done"]')?.textContent).toBe("Finished");
  h.type("/done");
  expect(h.status().querySelector(".k2b-chat-composer__status-line")).toBeNull();
  h.key("Escape");
  expect(h.status().textContent).toBe("Finished");
});

test("cancel restores surrounding text and mention ranges as well as the token", async () => {
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>([{ start: 0, end: 3, attachment: { id: "doc", name: "Doc" } }]);
  const h = await slash({
    value: "Doc /cancel suffix",
    get mentions() {
      return mentions();
    },
    onMentionsChange: setMentions,
    commands: [{ name: "cancel", description: "Cancel", action: () => "cancelled" }],
  });
  h.input.setSelectionRange(11, 11);
  h.input.click();
  const previous = [...mentions()];
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Doc /cancel suffix");
  expect(mentions()).toEqual(previous);
  expect(h.input.selectionStart).toBe(11);
  expect(h.rows()).toHaveLength(0);
});

test("non-Error rejection uses the localized fallback and cancelling after edits never restores", async () => {
  const h = await slash({ value: "/fail", commands: [{ name: "fail", description: "Fail", action: () => Promise.reject(null) }] });
  h.key("Enter");
  await flush();
  expect(h.status().textContent).toBe("That did not work.");
  expect(h.errors).toEqual([]);
  let resolve!: (result: ChatCommandResult) => void;
  const cancelled = await slash({
    value: "/cancel",
    commands: [
      {
        name: "cancel",
        description: "Cancel",
        action: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    ],
  });
  cancelled.key("Enter");
  cancelled.setValue("Edited draft");
  resolve("cancelled");
  await flush();
  expect(cancelled.value()).toBe("Edited draft");
  expect(cancelled.status().textContent).toBe("");
});

test("sections keep prop order across keystrokes with labelled groups, deduplication, bold matches and wrapping arrows", async () => {
  const h = await slash({
    commandSections: [
      { id: "skills", label: "Skills" },
      { id: "chat", label: "This chat" },
    ],
    commands: [
      { id: "chat", name: "Rechnung", description: "Chat action", section: "chat" },
      { id: "same", name: "Rechnungen", description: "Skill", section: "skills" },
      { id: "same", name: "Duplicate", description: "Ignored", section: "chat" },
      { name: "Rechner", description: "Trailing", section: "unknown" },
    ],
  });
  for (const query of ["/", "/rech", "/rechn", "/rech"]) {
    h.type(query);
    const groups = [...h.root.querySelectorAll('[role="listbox"] [role="group"]')];
    expect(groups.map((group) => group.querySelector('[role="presentation"]')?.textContent)).toEqual(["Skills", "This chat"]);
    groups.forEach((group) =>
      expect(group.getAttribute("aria-labelledby")).toBe(group.querySelector('[role="presentation"]')?.id ?? "missing"),
    );
    expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual(["Rechnungen", "Rechnung", "Rechner"]);
    expect(h.rows().at(-1)?.parentElement?.getAttribute("role")).toBe("listbox");
  }
  expect(h.rows()[0]?.querySelector("b")?.textContent).toBe("Rech");
  h.key("ArrowUp");
  expect(h.input.getAttribute("aria-activedescendant")).toBe(h.rows()[2]!.id);
  h.key("ArrowDown");
  expect(h.input.getAttribute("aria-activedescendant")).toBe(h.rows()[0]!.id);
});

const skillScopes = [{ id: "skill", title: "Skills", words: ["skill", "skills"] }];

test("a command opens its model chip, resolves after change, and cancellation restores the token", async () => {
  let chosen: string | null | undefined;
  const changes: string[] = [];
  const h = await slash({
    value: "/model",
    models: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
    selectedModelId: "a",
    onModelChange(id) {
      changes.push(id);
    },
    commands: [
      {
        name: "model",
        description: "",
        action: async (ctx) => {
          chosen = await ctx.openModelSelection();
          if (chosen) expect(changes.at(-1)).toBe(chosen);
          return chosen ? { done: `Chosen ${chosen}` } : "cancelled";
        },
      },
    ],
  });
  const chip = () => h.root.querySelector<HTMLButtonElement>(".k2b-chat-composer__model button")!;
  h.key("Enter");
  await flush();
  expect(chip().disabled).toBe(false);
  const menu = h.root.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu.matches(":popover-open")).toBe(true);
  expect(h.document.activeElement).toBe(menu.querySelector('[role="menuitemradio"]'));
  menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[1]!.click();
  await flush();
  expect(chosen).toBe("b");
  expect(changes).toEqual(["b"]);
  expect(h.value()).toBe("");
  expect(h.status().textContent).toBe("Chosen b");
  expect(h.document.activeElement).toBe(h.input);
  h.type("/model");
  h.key("Enter");
  await flush();
  h.document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();
  expect(chosen).toBeNull();
  expect(h.value()).toBe("/model");
  expect(h.document.activeElement).toBe(h.input);
  chip().click();
  await flush();
  expect(menu.matches(":popover-open")).toBe(true);
  expect(h.document.activeElement).toBe(menu.querySelector('[role="menuitemradio"]'));
  menu.hidePopover();
  await flush();
  chip().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  await flush();
  expect(h.document.activeElement).toBe(menu.querySelectorAll('[role="menuitemradio"]')[1]!);
  menu.hidePopover();
  await flush();
  h.type("/model");
  h.key("Enter");
  await flush();
  menu.hidePopover();
  await flush();
  expect(chosen).toBeNull();
  expect(h.value()).toBe("/model");
});

test("model selection is unavailable without a usable control and while running", async () => {
  const cases: Partial<ChatComposerProps>[] = [
    {},
    { onModelChange() {} },
    { models: [{ id: "a", label: "Alpha" }] },
    { models: [{ id: "a", label: "Alpha" }], onModelChange() {}, state: "running" },
  ];
  for (const options of cases) {
    let chosen: string | null | undefined;
    const h = await slash({
      ...options,
      commands: [
        {
          name: "model",
          description: "",
          action: async (ctx) => {
            chosen = await ctx.openModelSelection();
            return "cancelled" as const;
          },
        },
      ],
      value: "/model",
    });
    h.key("Enter");
    await flush();
    expect(chosen).toBeNull();
    expect(h.value()).toBe("/model");
    if (options.state === "running")
      expect(h.root.querySelector<HTMLButtonElement>(".k2b-chat-composer__model button")!.disabled).toBe(true);
  }
});

test("footer content creates one component across run changes and cancels model selection", async () => {
  const dom = createHarness();
  slashCleanups.push(dom.cleanup);
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal("/model");
  const [state, setState] = createSignal<ChatComposerProps["state"]>("idle");
  let created = 0;
  let chosen: string | null | undefined;
  const Footer = () => {
    created++;
    const content = dom.document.createElement("div");
    content.textContent = "Recording";
    return content;
  };
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        get value() {
          return value();
        },
        onValueChange: setValue,
        onSubmit() {},
        get state() {
          return state();
        },
        get footerContent() {
          return createComponent(Footer, {});
        },
        models: [{ id: "a", label: "Alpha" }],
        onModelChange() {
          throw new Error("Must not change model during recording");
        },
        commands: [
          {
            name: "model",
            description: "",
            action: async (ctx) => {
              chosen = await ctx.openModelSelection();
              return "cancelled" as const;
            },
          },
        ],
      }),
    dom.root,
  );
  slashCleanups.push(dispose);
  const footer = dom.root.querySelector(".k2b-chat-composer__footer")!;
  const content = footer.firstElementChild;
  expect(created).toBe(1);
  expect(footer.textContent).toBe("Recording");
  for (const next of ["running", "idle", "running", "idle"] as const) {
    setState(next);
    await flush();
    expect(created).toBe(1);
    expect(footer.firstElementChild).toBe(content);
  }
  const input = dom.root.querySelector("textarea")!;
  input.setSelectionRange(value().length, value().length);
  input.click();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await flush();
  expect(chosen).toBeNull();
  expect(value()).toBe("/model");
  expect(dom.root.querySelector(".k2b-chat-composer__model")).toBeNull();
  expect(created).toBe(1);
});

test("a model command cancels when a run starts while its control is open", async () => {
  const [state, setState] = createSignal<ChatComposerProps["state"]>("idle");
  let chosen: string | null | undefined;
  const h = await slash({
    get state() {
      return state();
    },
    value: "/model",
    models: [{ id: "a", label: "Alpha" }],
    onModelChange() {},
    commands: [
      {
        name: "model",
        description: "",
        action: async (ctx) => {
          chosen = await ctx.openModelSelection();
          return "cancelled" as const;
        },
      },
    ],
  });
  h.key("Enter");
  await flush();
  setState("running");
  await flush();
  expect(chosen).toBeNull();
  expect(h.value()).toBe("/model");
  expect(h.root.querySelector<HTMLElement>('[role="menu"]')!.matches(":popover-open")).toBe(false);
  expect(h.root.querySelector<HTMLButtonElement>(".k2b-chat-composer__model button")!.disabled).toBe(true);
});

test.each(["submitting", "stopping"] as const)("a model command cancels when the composer becomes %s", async (nextState) => {
  const [state, setState] = createSignal<ChatComposerProps["state"]>("idle");
  let chosen: string | null | undefined;
  let result: "cancelled" | undefined;
  const changes: string[] = [];
  const h = await slash({
    get state() {
      return state();
    },
    value: "/model",
    models: [{ id: "a", label: "Alpha" }],
    onModelChange(id) {
      changes.push(id);
    },
    commands: [
      {
        name: "model",
        description: "",
        action: async (ctx) => {
          chosen = await ctx.openModelSelection();
          result = "cancelled";
          return result;
        },
      },
    ],
  });
  h.key("Enter");
  await flush();
  const menu = h.root.querySelector<HTMLElement>('[role="menu"]')!;
  const chip = h.root.querySelector<HTMLButtonElement>(".k2b-chat-composer__model button")!;
  expect(menu.matches(":popover-open")).toBe(true);
  expect(chip.disabled).toBe(false);
  expect(chosen).toBeUndefined();
  expect(h.value()).toBe("");
  setState(nextState);
  await flush();
  expect(chosen).toBeNull();
  expect(result).toBe("cancelled");
  expect(h.value()).toBe("/model");
  expect(menu.matches(":popover-open")).toBe(false);
  expect(chip.disabled).toBe(true);
  expect(changes).toEqual([]);
});

test.each(["en", "de"])("selected rows show a check and accessible %s selected text", async (locale) => {
  const h = await slash(
    {
      commands: [
        { name: "Alpha", description: "", selected: true },
        { name: "Beta", description: "" },
      ],
    },
    locale,
  );

  expect(h.rows()[0]?.querySelector(".k2b-chat-composer__command-end .ti-check")).not.toBeNull();
  expect(h.rows()[0]?.querySelector(".k2b-sr-only")?.textContent).toBe(locale === "de" ? "gewählt" : "selected");
  expect(h.rows()[1]?.querySelector(".k2b-chat-composer__command-end")).toBeNull();
});

test("running changes refresh open server rows in the same opening and retain rows while loading", async () => {
  const [state, setState] = createSignal<ChatComposerProps["state"]>("idle");
  const calls: { opening: number; query: string; scope?: string; state: ChatComposerProps["state"] }[] = [];
  let resolve!: (rows: ChatCommand[]) => void;
  const h = await slash({
    value: "/model ",
    commandScopes: [{ id: "model", title: "Models", words: ["model"] }],
    get state() {
      return state();
    },
    searchCommands: (query, _signal, search) => {
      calls.push({ ...search, query, state: state() });
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  await Bun.sleep(140);
  resolve([{ id: "model:a", name: "Idle model", description: "" }]);
  await flush();
  const opening = calls[0]!.opening;
  let previous = "Idle model";
  for (const next of ["running", "idle"] as const) {
    setState(next);
    await Bun.sleep(140);
    await flush();
    expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual([previous]);
    expect(calls.at(-1)).toEqual({ opening, query: "", scope: "model", state: next });
    const name = `${next} model`;
    resolve([{ id: "model:a", name, description: "", reason: next === "running" ? "Wait for the response" : undefined }]);
    await flush();
    expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual([name]);
    expect(h.rows()[0]?.querySelector("small")?.textContent ?? "").toBe(next === "running" ? "Wait for the response" : "");
    expect(h.value()).toBe("/model ");
    previous = name;
  }
  expect(calls).toHaveLength(3);
});

test("replacing an open or escaped slash at the same position starts another opening", async () => {
  const openings: number[] = [];
  const h = await slash({
    searchCommands: async (_query, _signal, search) => {
      openings.push(search.opening);
      return [{ name: "One", description: "" }];
    },
  });
  await Bun.sleep(140);
  await flush();
  for (const escape of [false, true]) {
    const previous = openings.at(-1);
    if (escape) h.key("Escape");
    h.input.setSelectionRange(0, h.value().length);
    h.input.dispatchEvent(new Event("beforeinput", { bubbles: true }));
    h.type("/");
    await Bun.sleep(140);
    await flush();
    expect(openings.at(-1)).not.toBe(previous);
  }
  expect(openings).toHaveLength(3);
});

test.each(["Enter", "Tab", "click"])("openings survive typing and %s retries retain the query and rows", async (activation) => {
  const calls: { opening: number; query: string; scope?: string }[] = [];
  let resolveRetry!: (rows: ChatCommand[]) => void;
  const retry: ChatCommand = {
    name: "Try again",
    description: "",
    searchAgain: true,
    action: () => {
      throw new Error("Must not execute");
    },
  };
  const h = await slash({
    value: "/skill ",
    commandScopes: skillScopes,
    searchCommands: async (query, _signal, search) => {
      calls.push({ ...search, query });
      if (calls.length === 3)
        return new Promise<ChatCommand[]>((resolve) => {
          resolveRetry = resolve;
        });
      return [retry];
    },
  });
  await Bun.sleep(140);
  await flush();
  h.type("/skill a");
  await Bun.sleep(140);
  await flush();
  expect(calls[0]?.opening).toBe(calls[1]?.opening);
  if (activation === "click") h.rows()[0]!.click();
  else h.key(activation);
  await Bun.sleep(10);
  await flush();
  expect(calls).toHaveLength(3);
  expect(calls[2]).toMatchObject({ query: "a", scope: "skill" });
  expect(calls[2]?.opening).not.toBe(calls[1]?.opening);
  expect(h.value()).toBe("/skill a");
  expect(h.rows()).toHaveLength(1);
  resolveRetry([retry]);
  await flush();
  h.key("Escape");
  h.type("");
  h.type("/");
  await Bun.sleep(140);
  await flush();
  expect(calls[3]?.opening).not.toBe(calls[2]?.opening);
  h.setDraftKey("another");
  h.type("/");
  await Bun.sleep(140);
  await flush();
  expect(calls.at(-1)?.opening).not.toBe(calls[3]?.opening);
});

test("first-word scope passes the rest and scope id to search, hides static rows and labels its group", async () => {
  const calls: { query: string; signal: AbortSignal; scope?: string }[] = [];
  const h = await slash({
    value: "/skill rech",
    commandScopes: skillScopes,
    commands: [{ name: "Rechnung", description: "Static" }],
    searchCommands: async (query, signal, search) => {
      calls.push({ query, signal, ...search });
      return [{ name: "Rechnungen", description: "Skill" }];
    },
  });
  await Bun.sleep(140);
  await flush();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ query: "rech", scope: "skill" });
  expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(h.root.querySelector('[role="group"] [role="presentation"]')?.textContent).toBe("Skills");
  expect(h.rows().map((row) => row.textContent)).toEqual(["RechnungenSkill"]);
});

test("Tab writes a scope through undoable editing; Enter runs an action, and scope-only Enter narrows", async () => {
  let actions = 0;
  const row: ChatCommand = {
    name: "skill",
    label: "Choose skills",
    description: "Narrow",
    scope: "skill",
    action: () => {
      actions++;
    },
  };
  const h = await slash({ commandScopes: skillScopes, commands: [row] });
  h.key("Tab");
  await flush();
  expect(h.value()).toBe("/skill ");
  expect(h.rows()).toHaveLength(0);
  expect(h.root.querySelector('[role="listbox"]')).not.toBeNull();
  expect(actions).toBe(0);
  h.key("z", { ctrlKey: true });
  expect(h.value()).toBe("/");
  await flush();
  h.key("Enter");
  await flush();
  expect(actions).toBe(1);
  expect(h.value()).toBe("");
  const only = await slash({ commands: [{ ...row, action: undefined }], commandScopes: skillScopes });
  only.key("Enter");
  await flush();
  expect(only.value()).toBe("/skill ");
});

test("arithmetic opens nothing; a settled unmatched word followed by a space closes only this slash", async () => {
  const h = await slash({ value: "50 / 2", commands: [compactCommand] });
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  h.type("/xylo");
  expect(h.root.querySelector('[role="listbox"]')?.textContent).toBe("Nothing found for “xylo”");
  h.type("/xylo ");
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  expect(h.value()).toBe("/xylo ");
  h.type("/xylo more");
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  h.type("/xylo more /");
  expect(h.rows()).toHaveLength(1);
});

test("space before search settles closes on empty results, but a resolved scope stays open", async () => {
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/xylo ", commandScopes: skillScopes });
  await Bun.sleep(140);
  expect(h.root.querySelector('[role="listbox"]')).not.toBeNull();
  search.requests[0]!.resolve([]);
  await flush();
  expect(h.value()).toBe("/xylo ");
  expect(h.root.querySelector('[role="listbox"]')).toBeNull();
  h.type("plain");
  h.type("/skill ");
  await Bun.sleep(140);
  search.requests[1]!.resolve([]);
  await flush();
  expect(h.root.querySelector('[role="listbox"]')).not.toBeNull();
  expect(h.root.querySelector('[role="listbox"]')?.textContent).toContain("No results");
});

test("not applicable rows are absent from overview and searched rows announce reasons instead of narrowing", async () => {
  const h = await slash({
    commandScopes: skillScopes,
    commands: [{ name: "skill", description: "Choose skills", scope: "skill", hiddenUntilSearch: true, reason: "Needs a chat" }],
  });
  expect(h.rows()).toHaveLength(0);
  h.type("/skill");
  expect(h.rows()).toHaveLength(1);
  expect(h.rows()[0]?.querySelector("small")?.textContent).toBe("Needs a chat");
  h.key("Tab");
  h.key("Enter");
  expect(h.value()).toBe("/skill");
  expect(h.status().textContent).toBe("Needs a chat");
});

test("scope changes immediately drop retained rows, abort the old request and never restore another scope's rows", async () => {
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/skill a", commandScopes: [...skillScopes, { id: "file", title: "Files", words: ["file"] }] });
  await Bun.sleep(140);
  search.requests[0]!.resolve([{ name: "Alpha", description: "Skill" }]);
  await flush();
  expect(h.rows()).toHaveLength(1);
  h.type("/file a");
  expect(h.rows()).toHaveLength(0);
  expect(search.requests[0]?.signal.aborted).toBe(true);
  expect(h.root.querySelector(".k2b-chat-composer__command-placeholder")).not.toBeNull();
  h.type("/skill a");
  expect(h.rows()).toHaveLength(0);
});

test("suggestion counts debounce in a separate polite region, wait for loading, and count deduplicated rows", async () => {
  const search = deferredSearch();
  const h = await slash({ ...search, commands: [{ id: "one", name: "Alpha", description: "Local" }] });
  const live = () => h.root.querySelector('[role="status"][aria-live="polite"]')!;
  await Bun.sleep(370);
  expect(live().textContent).toBe("");
  search.requests[0]!.resolve([
    { id: "one", name: "Duplicate", description: "Ignored" },
    { name: "Beta", description: "Remote" },
  ]);
  await flush();
  expect(live().textContent).toBe("");
  await Bun.sleep(370);
  expect(live().textContent).toBe("2 suggestions");
  expect(h.status().textContent).toBe("");
  h.type("/alph");
  await Bun.sleep(140);
  search.requests[1]!.resolve([]);
  await flush();
  await Bun.sleep(370);
  expect(live().textContent).toBe("1 suggestion");
  h.type("/xylo");
  await Bun.sleep(140);
  search.requests[2]!.resolve([]);
  await flush();
  await Bun.sleep(370);
  expect(live().textContent).toBe("No suggestions");
  h.key("Escape");
  expect(h.input.getAttribute("aria-activedescendant")).toBeNull();
  expect(live().textContent).toBe("");
});

test("a new query announces an unchanged count again; the same query does not repeat it", async () => {
  const h = await slash({ value: "/rech", commands: [{ name: "Rechnung", description: "Invoice" }] });
  const live = h.root.querySelector('[aria-live="polite"]')!;
  await Bun.sleep(370);
  expect(live.textContent).toBe("1 suggestion");
  let changes = 0;
  const observer = new MutationObserver(() => {
    changes++;
  });
  observer.observe(live, { childList: true, subtree: true, characterData: true });
  slashCleanups.push(() => observer.disconnect());
  h.type("/rechn");
  await Bun.sleep(370);
  expect(live.textContent).toBe("1 suggestion");
  expect(changes).toBeGreaterThan(0);
  changes = 0;
  h.type("/rechn");
  await Bun.sleep(370);
  expect(changes).toBe(0);
});

test.each(["Enter", "Tab"])(
  "%s guards a stale scoped server row even when the consumer also declared that object statically",
  async (key) => {
    let chosen = 0;
    const row: ChatCommand = {
      name: "Alpha",
      description: "Skill",
      action: () => {
        chosen++;
      },
    };
    const search = deferredSearch();
    const h = await slash({ ...search, commandScopes: skillScopes, commands: [row], value: "/skill a" });
    await Bun.sleep(140);
    search.requests[0]!.resolve([row]);
    await flush();
    h.type("/skill al");
    expect(h.rows()).toHaveLength(1);
    expect(h.key(key).defaultPrevented).toBe(true);
    await flush();
    expect(chosen).toBe(0);
    expect(h.value()).toBe("/skill al");
  },
);

test("an action's mention replaces its token in one undo step; cancellation keeps the token", async () => {
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>([]);
  const attachment = { id: "resource:note:one", name: "Quarter three" };
  const h = await slash({
    value: "Before /x",
    get mentions() {
      return mentions();
    },
    onMentionsChange: setMentions,
    commands: [{ name: "x", description: "Choose", action: async () => ({ mention: attachment }) }],
  });
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Before Quarter three ");
  expect(mentions()).toEqual([{ start: 7, end: 20, attachment }]);
  h.key("z", { ctrlKey: true });
  expect(h.value()).toBe("Before /x");
  expect(mentions()).toEqual([]);
  const cancelled = await slash({
    value: "/x",
    commands: [{ name: "x", description: "Choose", action: async () => "cancelled" as const }],
  });
  cancelled.key("Enter");
  await flush();
  expect(cancelled.value()).toBe("/x");
});

test("attachFiles chooses within Enter activation, removes the token, and restores an empty selection", async () => {
  let inActivation = false;
  let calls = 0;
  let resolve!: (files: readonly File[]) => void;
  const h = await slash({
    value: "/attach",
    commands: [{ name: "attach", description: "Choose", attachFiles: true }],
    fileSelection: {
      choose: () => {
        expect(inActivation).toBe(true);
        calls++;
        return new Promise((done) => {
          resolve = done;
        });
      },
      onSelect: () => {
        throw new Error("No files selected");
      },
    },
  });
  inActivation = true;
  h.key("Enter");
  inActivation = false;
  expect(calls).toBe(1);
  expect(h.value()).toBe("");
  resolve([]);
  await flush();
  expect(h.value()).toBe("/attach");
});

test("a reasoned attachFiles row cannot choose files", async () => {
  let calls = 0;
  const h = await slash({
    value: "/attach",
    commands: [{ name: "attach", description: "Choose", attachFiles: true, reason: "Full" }],
    fileSelection: {
      choose: async () => {
        calls++;
        return [];
      },
      onSelect() {},
    },
  });
  h.key("Enter");
  await flush();
  expect(calls).toBe(0);
  expect(h.value()).toBe("/attach");
});

test("unscoped fallback follows Nothing found, runs on Enter, and does not prevent closing with a space", async () => {
  let calls = 0;
  const fallback = () => ({
    name: "fallback",
    label: "Search Cloud",
    description: "All apps",
    action: () => {
      calls++;
    },
  });
  const h = await slash({ value: "/xylo", commandFallback: fallback });
  const list = h.root.querySelector('[role="listbox"]')!;
  expect(list.textContent).toContain("Nothing found for “xylo”");
  expect(list.textContent!.indexOf("Nothing found")).toBeLessThan(list.textContent!.indexOf("Search Cloud"));
  h.key("Enter");
  await flush();
  expect(calls).toBe(1);
  const next = await slash({ value: "/xylo", commandFallback: fallback });
  next.type("/xylo ");
  expect(next.root.querySelector('[role="listbox"]')).toBeNull();
});

test("the fallback row follows the query as it is typed and stays marked", async () => {
  const h = await slash({
    value: "/x",
    commandFallback: ({ query }) => ({ id: "cloud", name: "cloud", label: `Search Cloud for “${query}”`, description: "All apps" }),
  });
  h.type("/xy");
  h.type("/xylo");
  const row = h.root.querySelector<HTMLElement>('[role="listbox"] [role="option"]')!;
  expect(row.querySelector("strong")?.textContent).toBe("Search Cloud for “xylo”");
  expect(row.getAttribute("aria-selected")).toBe("true");
});

test("a scoped fallback ends its group without Nothing found", async () => {
  const h = await slash({
    value: "/note q3",
    commandScopes: [{ id: "note", title: "Notes from Notebooks", words: ["note"] }],
    searchCommands: async () => [{ name: "q3", label: "Q3 plan", description: "Note" }],
    commandFallback: () => ({ name: "fallback", label: "Search Notes", description: "With preview" }),
  });
  await Bun.sleep(160);
  await flush();
  const group = h.root.querySelector('[role="group"]')!;
  expect(group.textContent).toContain("Notes from Notebooks");
  expect([...group.querySelectorAll('[role="option"] strong')].map((node) => node.textContent)).toEqual(["Q3 plan", "Search Notes"]);
  expect(h.root.textContent).not.toContain("Nothing found");
});

test("a pending picker never replaces a draft edited in the meantime", async () => {
  let resolve!: (result: ChatCommandResult) => void;
  const h = await slash({
    value: "/x",
    commands: [
      {
        name: "x",
        description: "Choose",
        action: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    ],
  });
  h.key("Enter");
  h.setValue("Changed while choosing");
  resolve({ mention: { id: "one", name: "Note" } });
  await flush();
  expect(h.value()).toBe("Changed while choosing");
  expect(h.status().textContent).toContain("The text changed in the meantime, so nothing was inserted.");
});

test("a pick that returns after the draft moved to another key says that nothing was inserted", async () => {
  let resolve!: (result: ChatCommandResult) => void;
  const h = await slash({
    value: "Hello /x",
    commands: [
      {
        name: "x",
        description: "Choose",
        action: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    ],
  });
  h.key("Enter");
  // As when a new chat is saved while the picker is open: the draft continues under another key.
  h.setDraftKey("moved");
  resolve({ mention: { id: "one", name: "Note" } });
  await flush();
  expect(h.value()).toBe("Hello ");
  expect(h.status().textContent).toContain("The text changed in the meantime, so nothing was inserted.");
});

test("a synchronous file chooser failure restores the token and reaches onError", async () => {
  const error = new Error("Cannot open selection");
  const h = await slash({
    value: "/attach",
    commands: [{ name: "attach", description: "Choose", attachFiles: true }],
    fileSelection: {
      choose: () => {
        throw error;
      },
      onSelect() {},
    },
  });
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("/attach");
  expect(h.errors).toEqual([error]);
});

test("a pending last section ends with three placeholders in the overview, one while searching, and holds Nothing found", async () => {
  const [pending, setPending] = createSignal(true);
  const [apps, setApps] = createSignal<ChatCommand[]>([]);
  const h = await slash({
    value: "/",
    get commandSections() {
      return [
        { id: "chat", label: "This chat" },
        { id: "apps", label: "Open in apps", pending: pending() },
      ];
    },
    get commands() {
      return [{ name: "compact", section: "chat", description: "Summarize" }, ...apps()];
    },
  });
  const groups = () => [...h.root.querySelectorAll(".k2b-chat-composer__command-group")];
  const placeholders = () => groups().at(-1)!.querySelectorAll(".k2b-chat-composer__command-placeholder").length;
  expect(groups().map((group) => group.querySelector(".k2b-chat-composer__command-heading")?.textContent)).toEqual([
    "This chat",
    "Open in apps",
  ]);
  expect(placeholders()).toBe(3);
  expect(groups().at(-1)!.querySelector(".k2b-chat-composer__command-heading .k2b-spin")).not.toBeNull();
  // Placeholders are no options: the keyboard never lands on them.
  expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual(["compact"]);
  h.type("/xylo");
  await flush();
  expect(placeholders()).toBe(1);
  expect(h.root.textContent).not.toContain("Nothing found");
  batch(() => {
    setApps([{ name: "xylophone", section: "apps", description: "Play" }]);
    setPending(false);
  });
  await flush();
  expect(placeholders()).toBe(0);
  expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual(["xylophone"]);
});

test("an open row keeps the token and the list while it runs, then removes the token in one undo step", async () => {
  let resolve!: () => void;
  let openSignal: AbortSignal | undefined;
  const drafts: { value: string; mentions: readonly ChatMention[] }[] = [];
  let pasted = 0;
  const h = await slash({
    value: "Price /tas",
    onPaste: () => {
      pasted++;
    },
    commands: [
      {
        name: "task",
        label: "New task",
        description: "Spaces · Create a task",
        open: (draft, signal) => {
          drafts.push(draft);
          openSignal = signal;
          return new Promise<void>((done) => {
            resolve = done;
          });
        },
      },
    ],
  });
  const detail = () => h.rows()[0]!.querySelector(".k2b-chat-composer__command-detail")!;
  // One typed step, so there is something to undo.
  h.type("Price /task");
  await flush();
  h.key("Enter");
  await flush();
  expect(drafts).toEqual([{ value: "Price ", mentions: [] }]);
  expect(h.value()).toBe("Price /task");
  expect(h.rows()).toHaveLength(1);
  expect(h.rows()[0]!.getAttribute("aria-busy")).toBe("true");
  expect(detail().getAttribute("data-state")).toBe("busy");
  // The description keeps its place, hidden, so the row's height does not change.
  expect(detail().children[0]!.textContent).toBe("Spaces · Create a task");
  expect(detail().children[1]!.textContent).toBe("Opening …");
  // The field stays enabled and focused, only read-only: a disabled field would lose focus and close the list.
  expect(h.input.disabled).toBe(false);
  expect(h.input.readOnly).toBe(true);
  // Choosing again or undoing while it runs does nothing, so the saved draft stays the visible one.
  h.key("Enter");
  h.key("z", { ctrlKey: true });
  h.input.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
  await flush();
  expect(drafts).toHaveLength(1);
  expect(pasted).toBe(0);
  expect(h.value()).toBe("Price /task");
  resolve();
  await flush();
  expect(h.input.readOnly).toBe(false);
  expect(h.value()).toBe("Price ");
  // A successful opening leaves, so its signal stays quiet.
  expect(openSignal?.aborted).toBe(false);
  expect(h.rows()).toHaveLength(0);
  h.key("z", { ctrlKey: true });
  await flush();
  expect(h.value()).toBe("Price /task");
});

test("an open row that fails says why in its place, keeps the list and the draft, and tries again when chosen", async () => {
  let calls = 0;
  const signals: AbortSignal[] = [];
  const h = await slash(
    {
      value: "/task",
      commands: [
        {
          name: "task",
          label: "Neue Aufgabe",
          description: "Spaces · Aufgabe anlegen",
          open: async (_draft, signal) => {
            signals.push(signal);
            return ++calls === 1 ? { failed: "Spaces ist gerade nicht erreichbar." } : "cancelled";
          },
        },
      ],
    },
    "de",
  );
  h.key("Enter");
  await flush();
  const detail = () => h.rows()[0]!.querySelector(".k2b-chat-composer__command-detail")!;
  expect(h.value()).toBe("/task");
  expect(h.rows()).toHaveLength(1);
  expect(detail().getAttribute("data-state")).toBe("failed");
  expect(detail().children[0]!.textContent).toBe("Spaces ist gerade nicht erreichbar.");
  expect(detail().children[1]!.textContent).toBe("Wird geöffnet …");
  // Announced once, not shown as a status line: the row already says it.
  expect(h.status().querySelector('[data-tone="error"]')).toBeNull();
  // The opening ended without leaving, so its signal tells the opener to put the token back into what it saved.
  expect(signals[0]?.aborted).toBe(true);
  h.key("Enter");
  await flush();
  expect(calls).toBe(2);
  expect(detail().getAttribute("data-state")).toBeNull();
  expect(detail().children[0]!.textContent).toBe("Spaces · Aufgabe anlegen");
  expect(h.value()).toBe("/task");
});

test("an open row that rejects keeps the token, closes the list and names the reason in the status line", async () => {
  const h = await slash({
    value: "/task",
    commands: [
      {
        name: "task",
        description: "Opens Spaces",
        open: async () => {
          throw new Error("The draft changed elsewhere.");
        },
      },
    ],
  });
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("/task");
  expect(h.rows()).toHaveLength(0);
  expect(h.status().querySelector('[data-tone="error"]')?.textContent).toBe("The draft changed elsewhere.");
});

test("an open row's failure after its draft moved goes to the status line", async () => {
  let resolve!: (result: { failed: string }) => void;
  const h = await slash({
    value: "/task",
    commands: [
      {
        name: "task",
        description: "Opens Spaces",
        open: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
    ],
  });
  h.key("Enter");
  await flush();
  h.setDraftKey("second");
  resolve({ failed: "Spaces is not reachable right now." });
  await flush();
  expect(h.status().querySelector('[data-tone="error"]')?.textContent).toBe("Spaces is not reachable right now.");
});

test("Escape while an open row runs cancels it: the signal aborts, editing returns, and a late success changes nothing", async () => {
  let resolve!: () => void;
  let signal: AbortSignal | undefined;
  const h = await slash({
    value: "Plan /task",
    commands: [
      {
        name: "task",
        description: "Opens Spaces",
        open: (_draft, abort) => {
          signal = abort;
          return new Promise<void>((done) => {
            resolve = done;
          });
        },
      },
    ],
  });
  h.key("Enter");
  await flush();
  expect(h.input.readOnly).toBe(true);
  expect(signal?.aborted).toBe(false);
  h.key("Escape");
  await flush();
  expect(signal?.aborted).toBe(true);
  expect(h.rows()).toHaveLength(0);
  expect(h.input.readOnly).toBe(false);
  expect(h.value()).toBe("Plan /task");
  resolve();
  await flush();
  // The person backed out: the token stays where they left it, with no status line.
  expect(h.value()).toBe("Plan /task");
  expect(h.status().querySelector('[data-tone="error"]')).toBeNull();
});

test("an open row whose draft moved to a new key shows its busy line in the status line, and Escape still cancels it", async () => {
  let signal: AbortSignal | undefined;
  const h = await slash({
    value: "Plan /task",
    commands: [
      {
        name: "task",
        description: "Opens Spaces",
        open: (_draft, abort) => {
          signal = abort;
          return new Promise<void>(() => {});
        },
      },
    ],
  });
  h.key("Enter");
  await flush();
  // The opener saved into a chat it created: the composer now shows that chat's draft, without the token.
  h.setDraftKey("created");
  await flush();
  expect(signal?.aborted).toBe(false);
  expect(h.rows()).toHaveLength(0);
  expect(h.status().querySelector('[data-tone="busy"]')?.textContent).toBe("Opening …");
  h.key("Escape");
  await flush();
  expect(signal?.aborted).toBe(true);
  expect(h.input.readOnly).toBe(false);
  expect(h.status().querySelector('[data-tone="busy"]')).toBeNull();
});
