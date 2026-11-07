import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import type { CommandContext, CommandItem, CommandSource } from "../src/actions/command-items";
import { createDomTestHarness, type DomTestHarness } from "./dom";

// What a command gets when it runs: the composer's text without the typed `/query`, the selection, `insert` at the
// caret, and a signal; a returned promise keeps its row busy, a rejection shows on the row, and Escape aborts.

let dom: DomTestHarness;
let dispose: (() => void) | undefined;

beforeEach(() => {
  dom = createDomTestHarness();
  const prototype = dom.window.HTMLElement.prototype as unknown as { showPopover?: () => void; hidePopover?: () => void };
  prototype.showPopover ??= () => undefined;
  prototype.hidePopover ??= () => undefined;
  delegateEvents(["keydown", "input", "click", "mousedown", "pointermove"], dom.document);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  dom.cleanup();
});

/** A promise the test settles itself. */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const mount = async (items: readonly CommandItem[], start = "") => {
  const { MarkdownEditor } = await import("../src/inputs/markdown/MarkdownEditor");
  const { SlashCommands } = await import("../src/inputs/markdown/SlashCommands");
  const [value, setValue] = createSignal(start);
  const [element, setElement] = createSignal<HTMLTextAreaElement>();
  dispose = render(
    () => [
      createComponent(MarkdownEditor, { label: "Nachricht", value, onValueChange: setValue, textareaRef: setElement }),
      createComponent(SlashCommands, {
        get textarea() {
          return element();
        },
        items,
      }),
    ],
    dom.root,
  );
  const textarea = dom.root.querySelector("textarea")!;
  textarea.focus();
  textarea.setSelectionRange(start.length, start.length);
  return { textarea, value };
};
const mountWith = async (items: CommandSource, start: string) => {
  const { MarkdownEditor } = await import("../src/inputs/markdown/MarkdownEditor");
  const { SlashCommands } = await import("../src/inputs/markdown/SlashCommands");
  const [value, setValue] = createSignal(start);
  const [element, setElement] = createSignal<HTMLTextAreaElement>();
  dispose = render(
    () => [
      createComponent(MarkdownEditor, { label: "Nachricht", value, onValueChange: setValue, textareaRef: setElement }),
      createComponent(SlashCommands, {
        get textarea() {
          return element();
        },
        items,
      }),
    ],
    dom.root,
  );
  const textarea = dom.root.querySelector("textarea")!;
  textarea.focus();
  textarea.setSelectionRange(start.length, start.length);
  return { textarea, value };
};
const type = async (textarea: HTMLTextAreaElement, text: string) => {
  const start = textarea.selectionStart;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(textarea.selectionEnd);
  textarea.setSelectionRange(start + text.length, start + text.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await Promise.resolve();
};
const key = (target: HTMLElement, name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};
const row = (label: string) =>
  Array.from(dom.document.querySelectorAll<HTMLElement>(".k2b-command-list [role='option']")).find((option) =>
    option.textContent?.includes(label),
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("slash command context", () => {
  test("a command gets the text without its /query, the caret, and insert at the caret", async () => {
    let seen: CommandContext | undefined;
    const { textarea, value } = await mount(
      [
        {
          label: "Marktpreis prüfen",
          onSelect: (context) => {
            seen = context;
            context.insert("240 €");
          },
        },
      ],
      "Eichentruhe Art. 4711, ",
    );
    await type(textarea, "/markt");
    expect(key(textarea, "Enter")).toBe(true);
    expect(seen?.text).toBe("Eichentruhe Art. 4711, ");
    expect(seen?.selection).toEqual({ start: 23, end: 23 });
    expect(seen?.signal.aborted).toBe(false);
    expect(value()).toBe("Eichentruhe Art. 4711, 240 €");
    expect(row("Marktpreis")).toBeUndefined();
  });

  test("a returned promise keeps the row busy and the list open; success closes it", async () => {
    const run = deferred();
    const { textarea } = await mount([
      { label: "Marktpreis prüfen", icon: "ti ti-coin", onSelect: () => run.promise },
      { label: "Telefonat", onSelect: () => {} },
    ]);
    await type(textarea, "/");
    key(textarea, "Enter");
    const busy = row("Marktpreis")!;
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.querySelector(".k2b-command-list__busy")).not.toBeNull();
    expect(dom.document.querySelector("[role='status']")?.textContent).toBe("Marktpreis prüfen is running");
    // Another entry waits while one runs; the text keeps the focus.
    row("Telefonat")!.click();
    expect(row("Marktpreis")?.getAttribute("aria-busy")).toBe("true");
    expect(dom.document.activeElement).toBe(textarea);
    run.resolve();
    await settle();
    expect(row("Marktpreis")).toBeUndefined();
  });

  test("a rejection shows its message on the row and announces it; the entry can run again", async () => {
    let attempts = 0;
    const { textarea, value } = await mount([
      {
        label: "Marktpreis prüfen",
        hint: "/preis",
        onSelect: async ({ insert }) => {
          attempts++;
          if (attempts === 1) throw new Error("Keine Artikelnummer im Text");
          insert("240 €");
        },
      },
    ]);
    await type(textarea, "/preis");
    key(textarea, "Enter");
    await settle();
    const failed = row("Marktpreis")!;
    expect(failed.hasAttribute("data-failed")).toBe(true);
    expect(failed.querySelector(".k2b-command-list__error")?.getAttribute("title")).toBe("Keine Artikelnummer im Text");
    expect(failed.querySelector(".k2b-command-list__hint")).toBeNull();
    expect(dom.document.querySelector("[role='alert']")?.textContent).toBe("Keine Artikelnummer im Text");
    expect(value()).toBe("");
    expect(dom.document.activeElement).toBe(textarea);
    key(textarea, "Enter");
    await settle();
    expect(attempts).toBe(2);
    expect(value()).toBe("240 €");
    expect(row("Marktpreis")).toBeUndefined();
  });

  test("a rejection without a message says that it did not work", async () => {
    const { textarea } = await mount([{ label: "Abholung planen", onSelect: () => Promise.reject("offline") }]);
    await type(textarea, "/");
    key(textarea, "Enter");
    await settle();
    expect(row("Abholung")?.querySelector(".k2b-command-list__error")?.textContent).toBe("That did not work.");
  });

  test("Escape aborts a running command and closes the list; its late result changes nothing", async () => {
    const run = deferred();
    let signal: AbortSignal | undefined;
    const { textarea } = await mount([
      {
        label: "Marktpreis prüfen",
        onSelect: (context) => {
          signal = context.signal;
          return run.promise;
        },
      },
    ]);
    await type(textarea, "/");
    key(textarea, "Enter");
    expect(key(textarea, "Escape")).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(row("Marktpreis")).toBeUndefined();
    run.reject(new Error("late"));
    await settle();
    expect(dom.document.querySelector("[role='alert']")).toBeNull();
  });

  test("a command stopped with Escape writes nothing when it finishes later", async () => {
    const run = deferred();
    const { textarea, value } = await mount([
      {
        label: "Marktpreis prüfen",
        onSelect: async ({ insert }) => {
          await run.promise;
          insert("240 €");
        },
      },
    ]);
    await type(textarea, "/");
    key(textarea, "Enter");
    key(textarea, "Escape");
    run.resolve();
    await settle();
    expect(value()).toBe("");
  });

  test("after a command failed, a snippet in the same list still goes where the slash stood", async () => {
    const { textarea, value } = await mount(
      [
        { label: "Marktpreis prüfen", onSelect: () => Promise.reject(new Error("Nein")) },
        { label: "Fotos erbeten", text: "Bitte Fotos." },
      ],
      "Hallo ",
    );
    await type(textarea, "/");
    key(textarea, "Enter");
    await settle();
    row("Fotos erbeten")!.click();
    expect(value()).toBe("Hallo Bitte Fotos.");
    expect(row("Fotos erbeten")).toBeUndefined();
  });

  test("Escape in a second list stops its running command before it goes back", async () => {
    const run = deferred();
    let signal: AbortSignal | undefined;
    const { textarea } = await mount([
      {
        label: "Zuweisen",
        next: {
          label: "Person suchen",
          items: [
            {
              label: "Mara Brandt",
              onSelect: (context) => {
                signal = context.signal;
                return run.promise;
              },
            },
          ],
        },
      },
    ]);
    await type(textarea, "/");
    key(textarea, "Enter");
    await Promise.resolve();
    const field = dom.document.querySelector<HTMLInputElement>(".k2b-dropdown__search > input")!;
    key(field, "Enter");
    expect(row("Mara Brandt")?.getAttribute("aria-busy")).toBe("true");
    expect(key(field, "Escape")).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(dom.document.activeElement).toBe(textarea);
  });

  test("typing after a failure moves on: the list closes", async () => {
    const { textarea } = await mount([{ label: "Marktpreis prüfen", onSelect: () => Promise.reject(new Error("Nein")) }]);
    await type(textarea, "/");
    key(textarea, "Enter");
    await settle();
    expect(row("Marktpreis")).toBeDefined();
    await type(textarea, "a");
    expect(row("Marktpreis")).toBeUndefined();
  });

  test("an unavailable entry is greyed with its reason, passed over by keys and pointer, and cannot be chosen", async () => {
    const ran: string[] = [];
    const { textarea } = await mount([
      { label: "Telefonat", description: "Anruf festhalten", onSelect: () => ran.push("call") },
      {
        label: "Termin bestätigen",
        description: "Termin per Mail",
        icon: "ti ti-calendar",
        disabled: "Nur mit einer Ankündigung",
        onSelect: () => ran.push("never"),
      },
      { label: "Kunde zuordnen", onSelect: () => ran.push("assign") },
    ]);
    await type(textarea, "/");
    const locked = row("Termin bestätigen")!;
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    // The reason takes the description's place on the same line.
    expect(locked.querySelector(".k2b-command-list__description")?.textContent).toBe("Nur mit einer Ankündigung");
    expect(locked.textContent).not.toContain("Termin per Mail");
    const marked = () => dom.document.getElementById(textarea.getAttribute("aria-activedescendant") ?? "")?.textContent ?? "";
    key(textarea, "ArrowDown");
    expect(marked()).toContain("Kunde zuordnen");
    key(textarea, "ArrowUp");
    expect(marked()).toContain("Telefonat");
    key(textarea, "End");
    expect(marked()).toContain("Kunde zuordnen");
    // The pointer does not mark it, and a press does nothing.
    locked.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    expect(locked.hasAttribute("data-active")).toBe(false);
    expect(marked()).toContain("Kunde zuordnen");
    locked.click();
    expect(ran).toEqual([]);
    expect(row("Termin bestätigen")).toBeDefined();
  });

  test("an image shows at icon size, decorative, in place of the icon; one per theme when given two", async () => {
    const { textarea } = await mount([
      { label: "Trödelplatz", image: "/logos/t.svg", icon: "ti ti-shop", onSelect: () => {} },
      { label: "Antikmarkt", image: { light: "/logos/a.svg", dark: "/logos/a-dark.svg" }, onSelect: () => {} },
    ]);
    await type(textarea, "/");
    const single = row("Trödelplatz")!;
    expect(single.querySelector(".ti-shop")).toBeNull();
    const image = single.querySelector<HTMLImageElement>(".k2b-command-list__image > img")!;
    expect([image.getAttribute("src"), image.getAttribute("alt"), image.getAttribute("width"), image.getAttribute("height")]).toEqual([
      "/logos/t.svg",
      "",
      "16",
      "16",
    ]);
    const pair = Array.from(row("Antikmarkt")!.querySelectorAll<HTMLImageElement>(".k2b-command-list__image > img"));
    expect(pair.map((img) => [img.className, img.getAttribute("src")])).toEqual([
      ["k2b-command-list__image-light", "/logos/a.svg"],
      ["k2b-command-list__image-dark", "/logos/a-dark.svg"],
    ]);
  });
});

describe("dynamic entries", () => {
  const labels = () =>
    Array.from(
      dom.document.querySelectorAll<HTMLElement>(".k2b-command-list [role='option'] .k2b-command-list__text > span:first-child"),
    ).map((label) => label.textContent);
  const templates: CommandItem[] = [{ group: "Vorlagen", label: "Fotos erbeten", text: "Bitte Fotos." }];
  const actions: CommandItem[] = [{ group: "Aktionen", label: "Zuweisen", onSelect: () => {} }];

  test("entries know where the slash stands: templates only at the start, actions everywhere", async () => {
    const seen: CommandContext[] = [];
    const items = (context: CommandContext) => {
      seen.push(context);
      return context.atStart ? [...templates, ...actions] : actions;
    };
    const mounted = await mountWith(items, "");
    await type(mounted.textarea, "/");
    expect(labels()).toEqual(["Fotos erbeten", "Zuweisen"]);
    expect(seen.at(-1)).toMatchObject({ query: "", text: "", before: "", atStart: true, lineStart: true, path: [] });
    await type(mounted.textarea, "zu");
    expect(labels()).toEqual(["Zuweisen"]);
    expect(seen.at(-1)?.query).toBe("zu");
  });

  test("after text, and on a new line, the context says so", async () => {
    const seen: CommandContext[] = [];
    const { textarea } = await mountWith((context) => {
      seen.push(context);
      return actions;
    }, "Guten Tag ");
    await type(textarea, "/");
    expect(seen.at(-1)).toMatchObject({ text: "Guten Tag ", before: "Guten Tag ", atStart: false, lineStart: false });
    await type(textarea, "\n");
    await type(textarea, "  /");
    expect(seen.at(-1)).toMatchObject({ before: "Guten Tag /\n  ", atStart: false, lineStart: true });
  });

  test("each level gets the path chosen so far, down to a command on the third level", async () => {
    const paths: string[][] = [];
    let chosen: CommandContext | undefined;
    const roles = (context: CommandContext) => {
      paths.push(context.path.map((item) => item.label));
      return ["Verantwortlich", "Beteiligt"].map((role) => ({
        label: role,
        onSelect: (selected: CommandContext) => {
          chosen = selected;
        },
      }));
    };
    const people = (context: CommandContext) => {
      paths.push(context.path.map((item) => item.label));
      return ["Mara Brandt", "Lea Krüger"].map((name) => ({ label: name, next: { label: "Rolle", items: roles } }));
    };
    const { textarea } = await mountWith([{ label: "Zuweisen", next: { label: "Person suchen", items: people } }], "");
    await type(textarea, "/zuw");
    key(textarea, "Enter");
    await Promise.resolve();
    const field = () => dom.document.querySelector<HTMLInputElement>(".k2b-dropdown__search > input")!;
    field().value = "lea";
    field().dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    key(field(), "Enter");
    await Promise.resolve();
    expect(labels()).toEqual(["Verantwortlich", "Beteiligt"]);
    key(field(), "Enter");
    expect(paths.at(0)).toEqual(["Zuweisen"]);
    expect(paths.at(-1)).toEqual(["Zuweisen", "Lea Krüger"]);
    expect(chosen?.path.map((item) => item.label)).toEqual(["Zuweisen", "Lea Krüger"]);
  });

  test("entries from a promise show loading in place, then the result; a new query aborts and discards the old one", async () => {
    const requests: { query: string; signal: AbortSignal; run: ReturnType<typeof deferred> & { items?: CommandItem[] } }[] = [];
    const { textarea } = await mountWith((context) => {
      const run = deferred() as ReturnType<typeof deferred> & { items?: CommandItem[] };
      requests.push({ query: context.query, signal: context.signal, run });
      return run.promise.then(() => run.items ?? []);
    }, "");
    await type(textarea, "/m");
    expect(dom.document.querySelector(".k2b-command-list__state")?.textContent).toContain("Loading");
    expect(dom.document.querySelector(".k2b-command-list")?.getAttribute("aria-busy")).toBe("true");
    await type(textarea, "a");
    expect(requests.map((request) => [request.query, request.signal.aborted])).toEqual([
      ["m", true],
      ["ma", false],
    ]);
    // The stale answer arrives late and changes nothing.
    requests[0]!.run.items = [{ label: "Alt", onSelect: () => {} }];
    requests[0]!.run.resolve();
    await settle();
    expect(labels()).toEqual([]);
    requests[1]!.run.items = [{ label: "Mara Brandt", onSelect: () => {} }];
    requests[1]!.run.resolve();
    await settle();
    expect(labels()).toEqual(["Mara Brandt"]);
    expect(dom.document.querySelector(".k2b-command-list__state")).toBeNull();
  });

  test("Enter while people load waits for that query and takes its first match; a changed query or no match takes none", async () => {
    const assigned: string[] = [];
    const requests: { query: string; run: ReturnType<typeof deferred> }[] = [];
    const people = ["Valentin Brandt", "Valeska Öz", "Lea Krüger"];
    const search = (context: CommandContext) => {
      const run = deferred();
      requests.push({ query: context.query, run });
      return run.promise.then(() =>
        people.map((name) => ({ label: name, onSelect: (chosen: CommandContext) => assigned.push(`${chosen.path[0]?.label}:${name}`) })),
      );
    };
    const { textarea } = await mountWith([{ label: "Zuweisen", next: { label: "Person suchen", items: search } }], "");
    const field = () => dom.document.querySelector<HTMLInputElement>(".k2b-dropdown__search > input")!;
    const typeSearch = async (text: string) => {
      field().value = text;
      field().dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    };
    await type(textarea, "/zuw");
    key(textarea, "Enter");
    await Promise.resolve();
    // While the further list loads, the list it came from is gone: no row can choose "Zuweisen" again.
    expect(labels()).toEqual([]);
    requests.at(-1)!.run.resolve();
    await settle();
    await typeSearch("val");
    expect(key(field(), "Enter")).toBe(true);
    expect(dom.document.querySelector(".k2b-command-list__state")?.textContent).toContain("Loading, then the first match");
    requests.at(-1)!.run.resolve();
    await settle();
    expect(assigned).toEqual(["Zuweisen:Valentin Brandt"]);
    expect(dom.document.activeElement).toBe(textarea);

    // A query changed while waiting chooses nothing.
    await type(textarea, "/zuw");
    key(textarea, "Enter");
    await Promise.resolve();
    await typeSearch("val");
    key(field(), "Enter");
    await typeSearch("lea");
    for (const request of requests) request.run.resolve();
    await settle();
    expect(assigned).toEqual(["Zuweisen:Valentin Brandt"]);
    expect(labels()).toEqual(["Lea Krüger"]);

    // No match chooses nothing and says so.
    await typeSearch("xyz");
    key(field(), "Enter");
    requests.at(-1)!.run.resolve();
    await settle();
    expect(assigned).toEqual(["Zuweisen:Valentin Brandt"]);
    expect(dom.document.querySelector(".k2b-dropdown__empty")?.textContent).toBe("No results");
  });

  test("a list that could not load says why and loads again on Retry or Enter", async () => {
    let attempts = 0;
    const { textarea } = await mountWith(async () => {
      attempts++;
      if (attempts < 3) throw new Error("Server nicht erreichbar");
      return actions;
    }, "");
    await type(textarea, "/");
    await settle();
    const state = dom.document.querySelector<HTMLElement>(".k2b-command-list__state[data-error]")!;
    expect(state.textContent).toContain("Server nicht erreichbar");
    expect(dom.document.querySelector("[role='alert']")?.textContent).toBe("Server nicht erreichbar");
    state.querySelector("button")!.click();
    await settle();
    expect(attempts).toBe(2);
    expect(key(textarea, "Enter")).toBe(true);
    await settle();
    expect(attempts).toBe(3);
    expect(labels()).toEqual(["Zuweisen"]);
  });

  test("a command gets the same context: where the slash stood and what was typed", async () => {
    let chosen: CommandContext | undefined;
    const { textarea } = await mountWith(
      [
        {
          label: "Zuweisen",
          onSelect: (context) => {
            chosen = context;
          },
        },
      ],
      "Hallo\n",
    );
    await type(textarea, "/zuw");
    key(textarea, "Enter");
    expect(chosen).toMatchObject({ query: "zuw", text: "Hallo\n", before: "Hallo\n", atStart: false, lineStart: true, path: [] });
  });
});

describe("CommandMenu context", () => {
  test("with a target, a command gets its text and selection and inserts into it; snippets go there too", async () => {
    const { CommandMenu } = await import("../src/actions/CommandMenu");
    const target = dom.document.createElement("textarea") as unknown as HTMLTextAreaElement;
    dom.root.append(target);
    target.value = "Hallo ";
    target.setSelectionRange(6, 6);
    let seen: CommandContext | undefined;
    const items: CommandItem[] = [
      { label: "Gruß", text: "Viele Grüße" },
      {
        label: "Datum",
        onSelect: (context) => {
          seen = context;
          context.insert("7.11.");
        },
      },
    ];
    let open!: (anchor: { getBoundingClientRect: () => DOMRect }) => void;
    dispose = render(
      () =>
        createComponent(CommandMenu, {
          items,
          label: "Hinzufügen",
          search: "Suchen",
          target,
          openAt: (fn) => {
            open = fn;
          },
        }),
      dom.root,
    );
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10 }) as DOMRect };
    open(anchor);
    const option = (label: string) =>
      Array.from(dom.document.querySelectorAll<HTMLElement>("[role='option']")).find((element) => element.textContent?.includes(label))!;
    option("Datum").click();
    expect(seen?.text).toBe("Hallo ");
    expect(seen?.selection).toEqual({ start: 6, end: 6 });
    expect(target.value).toBe("Hallo 7.11.");
    open(anchor);
    option("Gruß").click();
    expect(target.value).toBe("Hallo 7.11.Viele Grüße");
  });

  test("while a command runs, the search field waits, Escape stops it, and a callback's focus stays", async () => {
    const { CommandMenu } = await import("../src/actions/CommandMenu");
    const run = deferred();
    let signal: AbortSignal | undefined;
    const elsewhere = dom.document.createElement("input") as unknown as HTMLInputElement;
    dom.root.append(elsewhere);
    let open!: (anchor: { getBoundingClientRect: () => DOMRect }) => void;
    dispose = render(
      () =>
        createComponent(CommandMenu, {
          items: [
            {
              label: "Marktpreis prüfen",
              onSelect: (context) => {
                signal = context.signal;
                return run.promise;
              },
            },
            { label: "Feld wählen", onSelect: () => elsewhere.focus() },
          ],
          label: "Hinzufügen",
          search: "Suchen",
          openAt: (fn) => {
            open = fn;
          },
        }),
      dom.root,
    );
    const anchor = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10 }) as DOMRect };
    open(anchor);
    const option = (label: string) =>
      Array.from(dom.document.querySelectorAll<HTMLElement>("[role='option']")).find((element) => element.textContent?.includes(label))!;
    option("Marktpreis").click();
    const search = dom.document.querySelector<HTMLInputElement>("input[role='combobox']")!;
    expect(search.readOnly).toBe(true);
    key(search, "Escape");
    expect(signal?.aborted).toBe(true);
    run.resolve();
    await settle();
    open(anchor);
    option("Feld wählen").click();
    expect(dom.document.activeElement).toBe(elsewhere);
  });

  test("without a target, the text is empty and insert hands the text to onInsert", async () => {
    const { CommandMenu } = await import("../src/actions/CommandMenu");
    const inserted: string[] = [];
    let seen: CommandContext | undefined;
    let open!: (anchor: { getBoundingClientRect: () => DOMRect }) => void;
    dispose = render(
      () =>
        createComponent(CommandMenu, {
          items: [
            {
              label: "Datum",
              onSelect: (context) => {
                seen = context;
                context.insert("7.11.");
              },
            },
          ],
          label: "Hinzufügen",
          search: "Suchen",
          onInsert: (text) => inserted.push(text),
          openAt: (fn) => {
            open = fn;
          },
        }),
      dom.root,
    );
    open({ getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10 }) as DOMRect });
    dom.document.querySelector<HTMLElement>("[role='option']")!.click();
    expect(seen?.text).toBe("");
    expect(seen?.selection).toEqual({ start: 0, end: 0 });
    expect(inserted).toEqual(["7.11."]);
  });
});
