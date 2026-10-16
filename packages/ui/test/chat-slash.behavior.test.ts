import { afterEach, expect, test } from "bun:test";
import { batch, createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { ChatCommand, ChatCommandResult, ChatComposerProps } from "../src/chat/ChatComposer";
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

const slashCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of slashCleanups.splice(0).reverse()) cleanup();
});
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
const slash = async (options: Partial<ChatComposerProps> = {}) => {
  const dom = createHarness();
  slashCleanups.push(dom.cleanup);
  const { ChatComposer } = await import("../src/chat/ChatComposer");
  const [value, setValue] = createSignal(options.value ?? "/");
  const [draftKey, setDraftKey] = createSignal("first");
  let submitted = 0;
  const errors: unknown[] = [];
  const dispose = render(
    () =>
      createComponent(ChatComposer, {
        ...options,
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

test("retains rows and safe ids through debounce, preserves arrow marking on results, resets on typing", async () => {
  const search = deferredSearch();
  const h = await slash({ ...search, value: "/q" });
  await Bun.sleep(140);
  const rows = [
    { id: 'a" ]#ü', name: "A", description: "First" },
    { id: "b", name: "B", description: "Second" },
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
    { id: "top", name: "New", description: "New top" },
    { ...rows[1]!, label: "Still B" },
  ]);
  await flush();
  expect(h.rows().map((row) => row.textContent)).toEqual(["/NewNew top", "Still BSecond"]);
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
  expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual(["Chat kompaktieren", "/unrelated"]);
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
  search.requests.at(-1)!.resolve([{ name: "retained", description: "Current" }]);
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
  h.key("Enter");
  await flush();
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
