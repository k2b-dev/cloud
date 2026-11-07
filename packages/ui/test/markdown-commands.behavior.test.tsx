import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { CommandItem } from "../src/actions/command-items";
import type { Completion } from "../src/inputs/completion";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// The slash commands of MarkdownEditor: groups, unavailable entries, actions, snippets, a second list, and the keys of
// a combobox whose field is the text itself. The old `completions` path keeps working beside them.

let dom: DomTestHarness;
let dispose: (() => void) | undefined;

beforeEach(() => {
  dom = createDomTestHarness();
  const prototype = dom.window.HTMLElement.prototype as unknown as { showPopover?: () => void; hidePopover?: () => void };
  prototype.showPopover ??= () => undefined;
  prototype.hidePopover ??= () => undefined;
  // Each test has its own document; Solid's delegated handlers listen on the one they are given.
  delegateEvents(["keydown", "input", "click", "mousedown", "pointermove"], dom.document);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  dom.cleanup();
});

const mount = async (props: { commands?: readonly CommandItem[]; completions?: readonly Completion[] }) => {
  const { MarkdownEditor } = await import("../src/inputs/markdown/MarkdownEditor");
  const changes: string[] = [];
  const [value, setValue] = createSignal("");
  dispose = render(
    () =>
      createComponent(MarkdownEditor, {
        label: "Message",
        value,
        onValueChange: (next: string) => {
          changes.push(next);
          setValue(next);
        },
        ...props,
      }),
    dom.root,
  );
  const textarea = dom.root.querySelector("textarea")!;
  textarea.focus();
  return { textarea, changes, value };
};

const type = async (textarea: HTMLTextAreaElement, text: string) => {
  const start = textarea.selectionStart;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(textarea.selectionEnd);
  textarea.setSelectionRange(start + text.length, start + text.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
};
const key = (textarea: HTMLTextAreaElement, name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  textarea.dispatchEvent(event);
  return event.defaultPrevented;
};
const options = () => Array.from(dom.document.querySelectorAll<HTMLElement>(".k2b-command-list [role='option']"));
const active = (textarea: HTMLTextAreaElement) => {
  const id = textarea.getAttribute("aria-activedescendant");
  return id ? dom.document.getElementById(id)?.textContent : null;
};

const fixture = () => {
  const log: string[] = [];
  const people = ["Mara Brandt", "Jonas Öztürk", "Lea Krüger"];
  const commands: CommandItem[] = [
    { group: "Kinds", label: "Phone call", hint: "/telefonat", icon: "ti ti-phone", keywords: ["anruf"], onSelect: () => log.push("call") },
    {
      group: "Kinds",
      label: "Confirm appointment",
      hint: "/termin",
      disabled: "Only with an announcement",
      onSelect: () => log.push("never"),
    },
    { group: "Snippets", label: "Photos requested", icon: "ti ti-template", text: "Please send us a few photos." },
    {
      group: "Actions",
      label: "Assign",
      icon: "ti ti-user-plus",
      next: {
        label: "Search person",
        items: people.map((name) => ({ label: name, leading: () => <span class="dot" />, onSelect: () => log.push(`assign:${name}`) })),
      },
    },
  ];
  return { log, commands };
};

describe("MarkdownEditor slash commands", () => {
  test("/ opens grouped commands as the field's list box with an active descendant", async () => {
    const { commands } = fixture();
    const { textarea } = await mount({ commands });
    await type(textarea, "/");
    const listbox = dom.document.querySelector<HTMLElement>(".k2b-command-list")!;
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(textarea.getAttribute("aria-controls")).toBe(listbox.id);
    const groups = Array.from(listbox.querySelectorAll<HTMLElement>("[role='group']"));
    expect(groups.map((group) => dom.document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent)).toEqual([
      "Kinds",
      "Snippets",
      "Actions",
    ]);
    expect(options().map((option) => option.querySelector(".k2b-dropdown__copy > span")?.textContent)).toEqual([
      "Phone call",
      "Confirm appointment",
      "Photos requested",
      "Assign",
    ]);
    const unavailable = options()[1]!;
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.textContent).toContain("Only with an announcement");
    expect(active(textarea)).toContain("Phone call");
  });

  test("arrows, Home, and End mark entries, unavailable ones included, and wrap", async () => {
    const { commands } = fixture();
    const { textarea } = await mount({ commands });
    await type(textarea, "/");
    expect(key(textarea, "ArrowDown")).toBe(true);
    expect(active(textarea)).toContain("Confirm appointment");
    expect(key(textarea, "End")).toBe(true);
    expect(active(textarea)).toContain("Assign");
    key(textarea, "ArrowDown");
    expect(active(textarea)).toContain("Phone call");
    key(textarea, "ArrowUp");
    expect(active(textarea)).toContain("Assign");
    expect(key(textarea, "Home")).toBe(true);
    expect(active(textarea)).toContain("Phone call");
  });

  test("the marked row scrolls into view, since the focus stays in the text", async () => {
    const scrolled: string[] = [];
    (dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? "");
    };
    const { commands } = fixture();
    const { textarea } = await mount({ commands });
    await type(textarea, "/");
    key(textarea, "End");
    expect(scrolled.at(-1)).toContain("Assign");
  });

  test("Enter on an action removes the typed /query and then runs it; keywords and accents match", async () => {
    const { commands, log } = fixture();
    const { textarea, value } = await mount({ commands });
    await type(textarea, "Hello /anruf");
    expect(options()).toHaveLength(1);
    expect(key(textarea, "Enter")).toBe(true);
    expect(log).toEqual(["call"]);
    expect(value()).toBe("Hello ");
    expect(options()).toHaveLength(0);
  });

  test("an unavailable entry stays open and does nothing", async () => {
    const { commands, log } = fixture();
    const { textarea, value } = await mount({ commands });
    await type(textarea, "/termin");
    expect(key(textarea, "Enter")).toBe(true);
    options()[0]!.click();
    expect(log).toEqual([]);
    expect(value()).toBe("/termin");
    expect(options()).toHaveLength(1);
  });

  test("Tab on a snippet puts its text in place of the /query", async () => {
    const { commands } = fixture();
    const { textarea, value } = await mount({ commands });
    await type(textarea, "/photos");
    expect(key(textarea, "Tab")).toBe(true);
    expect(value()).toBe("Please send us a few photos.");
  });

  test("a second list filters by the typed word and goes back with Backspace or Escape", async () => {
    const { commands, log } = fixture();
    const { textarea, value } = await mount({ commands });
    await type(textarea, "/assi");
    key(textarea, "Enter");
    await Promise.resolve();
    expect(value()).toBe("/");
    expect(dom.document.querySelector(".k2b-command-list")?.getAttribute("aria-label")).toBe("Search person");
    expect(dom.document.querySelector(".k2b-command-list__step-hint")?.textContent).toBe("Search person");
    expect(options()).toHaveLength(3);
    await type(textarea, "ozt");
    expect(options().map((option) => option.textContent)).toEqual(["Jonas Öztürk"]);
    // Backspace with a query edits the query.
    expect(key(textarea, "Backspace")).toBe(false);
    textarea.value = "/";
    textarea.setSelectionRange(1, 1);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(key(textarea, "Backspace")).toBe(true);
    expect(dom.document.querySelector(".k2b-command-list__step")).toBeNull();
    expect(options()).toHaveLength(4);
    // Into the list again by pointer, back with Escape, and in once more to pick a person.
    options()[3]!.click();
    await Promise.resolve();
    expect(key(textarea, "Escape")).toBe(true);
    expect(options()).toHaveLength(4);
    options()[3]!.click();
    await Promise.resolve();
    await type(textarea, "lea");
    key(textarea, "Enter");
    expect(log).toEqual(["assign:Lea Krüger"]);
    expect(value()).toBe("");
  });

  test("Escape closes the commands, keeps the text, and they stay closed for that word", async () => {
    const { commands } = fixture();
    const { textarea, value } = await mount({ commands });
    await type(textarea, "/ph");
    expect(key(textarea, "Escape")).toBe(true);
    expect(options()).toHaveLength(0);
    await type(textarea, "o");
    expect(value()).toBe("/pho");
    expect(options()).toHaveLength(0);
    // A new `/` opens them again.
    await type(textarea, " /");
    expect(options().length).toBeGreaterThan(0);
  });

  test("a query without matches closes the list and leaves Enter to the text", async () => {
    const { commands } = fixture();
    const { textarea } = await mount({ commands });
    await type(textarea, "/2024");
    expect(dom.document.querySelector(".k2b-command-list")).toBeNull();
    expect(key(textarea, "Enter")).toBe(false);
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("/ inside a word is no command, as in a path or a date", async () => {
    const { commands } = fixture();
    const { textarea } = await mount({ commands });
    await type(textarea, "and/or");
    expect(options()).toHaveLength(0);
  });

  test("/ after punctuation is no command either, as in a URL or a bracket", async () => {
    const { commands, log } = fixture();
    const { textarea, value } = await mount({ commands });
    await type(textarea, "https://");
    expect(options()).toHaveLength(0);
    expect(key(textarea, "Enter")).toBe(false);
    await type(textarea, " (/");
    expect(options()).toHaveLength(0);
    expect(log).toEqual([]);
    expect(value()).toBe("https:// (/");
  });

  test("entries that arrive while the / waits open the list", async () => {
    const { commands } = fixture();
    const { MarkdownEditor } = await import("../src/inputs/markdown/MarkdownEditor");
    const [source, setSource] = createSignal<readonly CommandItem[]>([]);
    dispose = render(
      () =>
        createComponent(MarkdownEditor, {
          label: "Late",
          value: "",
          get commands() {
            return source();
          },
        }),
      dom.root,
    );
    const textarea = dom.root.querySelector("textarea")!;
    textarea.focus();
    await type(textarea, "/");
    expect(options()).toHaveLength(0);
    setSource(commands);
    expect(options()).toHaveLength(4);
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
  });

  test("the old completions path with its own / trigger still inserts text", async () => {
    const { textarea, value } = await mount({
      completions: [{ trigger: "/", dropdown: true, suggest: () => [{ text: "/today", hint: "date" }] }],
    });
    await type(textarea, "/to");
    expect(dom.document.querySelector(".k2b-command-list")).toBeNull();
    const option = dom.document.querySelector<HTMLElement>(".k2b-autocomplete__option");
    expect(option?.textContent).toContain("today");
    expect(key(textarea, "Enter")).toBe(true);
    expect(value()).toBe("/today ");
  });
});
