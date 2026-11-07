import { createEffect, createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { CommandList, commandListKey, commandOptionId, createCommandNavigator } from "../../actions/CommandList";
import { dockCommandList, followComposer } from "../../actions/command-dock";
import { type CommandSource, commandPlace } from "../../actions/command-items";
import { useCommandMessages } from "../../actions/command-messages";
import { type Completion, detectQuery, type QueryContext } from "../completion";
import { isInCodeZone } from "./code-zone";

export type SlashCommandsProps = {
  /** The editor's textarea, from `MarkdownEditor`'s `textareaRef`. The commands attach once it is there. */
  textarea: HTMLTextAreaElement | undefined;
  /** The same entries as `CommandMenu`'s `items`. */
  items: CommandSource;
  /**
   * The composer box the list docks to, such as the frame around the editor and its "+" row. Defaults to the editor
   * itself.
   */
  composer?: HTMLElement;
};

/** Replaces a range of the text the way typing would, so undo keeps working; an empty text deletes. */
const replace = (textarea: HTMLTextAreaElement, start: number, end: number, text: string) => {
  textarea.focus();
  textarea.setSelectionRange(start, end);
  if (start === end && text === "") return;
  try {
    if (document.execCommand?.(text === "" ? "delete" : "insertText", false, text)) return;
  } catch {
    // Fall through to the standards-based replacement.
  }
  textarea.setRangeText(text, start, end, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

const trigger: Completion = { trigger: "/", suggest: () => [] };

/**
 * Slash commands for a `MarkdownEditor`: `/` at the start of a line or after a space opens the entries docked above the
 * composer, as wide as it is. Place it beside the editor and pass the editor's textarea. It listens to the textarea itself, so editors without
 * commands carry none of it: native listeners run before the editor's own, and a key it uses is marked handled with
 * `preventDefault`, which the editor respects.
 */
export function SlashCommands(props: SlashCommandsProps): JSX.Element {
  return (
    <Show when={props.textarea}>
      {(textarea) => <AttachedCommands textarea={textarea()} items={props.items} composer={props.composer} />}
    </Show>
  );
}

function AttachedCommands(props: { textarea: HTMLTextAreaElement; items: CommandSource; composer?: HTMLElement }): JSX.Element {
  const messages = useCommandMessages();
  const textarea = props.textarea;
  const id = `${textarea.id || "k2b-markdown"}-commands`;
  const composer = (): Element => props.composer ?? textarea.closest(".k2b-markdown-editor") ?? textarea;
  const [context, setContext] = createSignal<QueryContext | null>(null);
  /**
   * The list as a command left it: the `/query` is gone from the text, but the list stays at its slash while the
   * command runs or after it failed, until the person types, leaves, or presses Escape.
   */
  const [held, setHeld] = createSignal<{ start: number; query: string }>();
  /** Where Escape closed the commands; they stay closed while the caret stays in that `/query`. */
  let dismissedAt: number | null = null;
  /**
   * How deep the list is. A further list has its own search field: the `/query` leaves the text, the focus moves into
   * the field, and the composer's text stays as it is while the person searches.
   */
  const [depth, setDepth] = createSignal(0);
  const [search, setSearch] = createSignal("");
  let searchField: HTMLInputElement | undefined;
  /** Set while this part moves the focus between the text and the search field itself. */
  let moving = false;
  /** Puts the focus back in the text at `at`, where the slash stood. */
  const focusText = (at: number) => {
    moving = true;
    try {
      textarea.focus();
      textarea.setSelectionRange(at, at);
    } finally {
      moving = false;
    }
  };
  /** Set while this part edits the text itself, so its own edit does not count as the person typing. */
  let editing = false;
  let popover: HTMLDivElement | undefined;
  const edit = (start: number, end: number, text: string) => {
    editing = true;
    try {
      replace(textarea, start, end, text);
    } finally {
      editing = false;
    }
  };
  const nav = createCommandNavigator({
    items: () => props.items,
    query: () => (depth() > 0 ? search() : (context()?.query ?? held()?.query ?? "")),
    onText: (item) => {
      // After a command failed, the held list has no `/query` left; a snippet goes where it stood.
      const current = context();
      const start = current?.start ?? held()?.start;
      if (start === undefined) return;
      close();
      edit(start, current?.end ?? start, item.text ?? "");
    },
    beforeRun: () => {
      const current = context();
      if (!current) return;
      // The list stays where it was while the `/query` leaves the text.
      setHeld({ start: current.start, query: current.query });
      setContext(null);
      edit(current.start, current.end, "");
    },
    // While the `/query` is in the text, the context leaves it out; once a command removed it, the text is as it is.
    context: () => {
      const current = context();
      const start = current?.start ?? held()?.start ?? textarea.selectionStart;
      const place = commandPlace(textarea.value, start, current?.end ?? start);
      return {
        ...place,
        selection: current ? { start, end: start } : { start: textarea.selectionStart, end: textarea.selectionEnd },
        insert: (text: string) => edit(textarea.selectionStart, textarea.selectionEnd, text),
      };
    },
    // A finished command leaves the focus in the text where the slash stood; its outcome, if any, shows in the list's place.
    afterRun: () => {
      const at = held()?.start;
      close();
      if (at !== undefined && document.activeElement !== textarea) focusText(at);
    },
    active: () => context() !== null || held() !== undefined,
    onStep: (next) => {
      const previous = depth();
      if (next === 0) {
        // Back to the first list: the typed `/query` comes back, and the text has the focus again. The list keeps its
        // place throughout: the context returns before the held state goes, and the focus is in the text before the
        // search field leaves, since a browser blurs a focused field that is removed, which would close the list.
        const at = held();
        if (at) {
          const text = `/${at.query}`;
          setContext({ start: at.start, end: at.start + text.length, text, query: at.query, completion: trigger });
          setHeld(undefined);
          moving = true;
          try {
            edit(at.start, at.start, text);
          } finally {
            moving = false;
          }
        }
        setDepth(0);
        setSearch("");
        return;
      }
      setDepth(next);
      setSearch("");
      if (previous === 0) {
        // Into a further list: the `/query` leaves the text, and the list stays where it was.
        const current = context();
        if (current) {
          setHeld({ start: current.start, query: current.query });
          setContext(null);
          edit(current.start, current.end, "");
        }
      }
      queueMicrotask(() => {
        moving = true;
        try {
          searchField?.focus({ preventScroll: true });
        } finally {
          moving = false;
        }
      });
    },
  });
  // Entries on their way, or a list that could not load, show too, so the person sees what happens.
  const open = createMemo(
    () =>
      nav.outcome() !== undefined ||
      held() !== undefined ||
      (context() !== null && (nav.step() !== undefined || nav.entries().length > 0 || nav.load().state !== "ready")),
  );
  const close = () => {
    setContext(null);
    setHeld(undefined);
    setDepth(0);
    setSearch("");
    nav.reset();
  };

  const detect = () => {
    if (editing) return;
    // Typing after a command ran or failed moves on: the held list closes, the command keeps running.
    if (held()) close();
    const found = document.activeElement === textarea ? detectQuery(textarea, [trigger], { isExcluded: isInCodeZone }) : null;
    // Commands start at the line start or after a space, never inside `https://` or after a bracket.
    const usable = found && (found.start === 0 || /\s/.test(textarea.value[found.start - 1] ?? "")) ? found : null;
    if (usable?.start !== context()?.start) {
      if (usable?.start !== dismissedAt) dismissedAt = null;
      close();
    }
    if (usable && usable.start !== dismissedAt) {
      // A new `/` takes the place at once, even from an outcome still in its least time.
      if (usable.start !== context()?.start) nav.clearOutcome();
      setContext(usable);
    }
  };
  /** The person typed: an outcome clears once it showed long enough, and a new `/` opens the list. */
  const typed = () => {
    if (!editing) nav.typedOn();
    detect();
  };
  /** An outcome's button leaves the focus in the text, where the person goes on writing. */
  const backToText = () => {
    if (document.activeElement === textarea) return;
    moving = true;
    try {
      textarea.focus({ preventScroll: true });
    } finally {
      moving = false;
    }
  };

  const position = () => {
    if (!popover?.isConnected) return;
    if (!popover.matches(":popover-open")) popover.showPopover?.();
    dockCommandList(popover, composer());
  };

  // The textarea points at the list while it shows, as a combobox does.
  createEffect(() => {
    const marked = nav.entries()[nav.active()];
    // In a further list the search field points at it instead.
    const pointing = open() && depth() === 0 && !nav.outcome();
    const active = pointing && marked && !marked.disabled ? commandOptionId(id, nav.active()) : undefined;
    if (pointing) textarea.setAttribute("aria-controls", id);
    else if (textarea.getAttribute("aria-controls") === id) textarea.removeAttribute("aria-controls");
    if (active) textarea.setAttribute("aria-activedescendant", active);
    else if (textarea.getAttribute("aria-activedescendant")?.startsWith(`${id}-`)) textarea.removeAttribute("aria-activedescendant");
  });
  // Opening, and entries that arrive while the `/` waits, such as from a reactive source, show the list.
  createEffect(() => {
    if (!open()) return;
    queueMicrotask(position);
    // The composer grows with its text, and a phone's keyboard moves the visible viewport.
    onCleanup(followComposer(composer(), position));
  });

  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (!open() || event.defaultPrevented) return;
      const current = context();
      if (event.key === "Escape" && !current) {
        // Escape stops a running command and closes the list it held, or clears an outcome at once.
        event.preventDefault();
        nav.abort();
        nav.clearOutcome();
        close();
        return;
      }
      // An outcome is no list: other keys are the person writing on.
      if (!current && nav.outcome()) return;
      if (commandListKey(nav, event, current?.query ?? "")) event.preventDefault();
      else if (event.key === "Escape" && current) {
        event.preventDefault();
        dismissedAt = current.start;
        close();
      }
    };
    const selection = () => {
      if (document.activeElement === textarea && !held()) detect();
    };
    const blur = (event: FocusEvent) => {
      if (moving || (event.relatedTarget instanceof Node && popover?.contains(event.relatedTarget))) return;
      close();
      dismissedAt = null;
    };
    textarea.addEventListener("keydown", key);
    textarea.addEventListener("input", typed);
    textarea.addEventListener("blur", blur);
    document.addEventListener("selectionchange", selection);
    // A `/` typed while this module loaded opens the list now.
    detect();
    onCleanup(() => {
      textarea.removeEventListener("keydown", key);
      textarea.removeEventListener("input", typed);
      textarea.removeEventListener("blur", blur);
      document.removeEventListener("selectionchange", selection);
      popover?.hidePopover?.();
    });
  });

  return (
    <Show when={open()}>
      <div
        ref={popover}
        popover="manual"
        class="k2b-autocomplete__options"
        data-commands=""
        data-outcome={nav.outcome()?.state}
        role="presentation"
        // Escape on an outcome's button clears it, as it does in the text.
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !nav.outcome() || event.target === searchField) return;
          event.preventDefault();
          nav.clearOutcome();
          backToText();
        }}
      >
        <CommandList
          onOutcomeAction={backToText}
          navigator={nav}
          id={id}
          label={messages().commands}
          query={nav.query}
          header={
            <Show when={depth() > 0}>
              <label class="k2b-dropdown__search">
                <i class="ti ti-search" aria-hidden="true" />
                <input
                  ref={searchField}
                  type="search"
                  role="combobox"
                  aria-label={nav.step()?.next?.label}
                  aria-expanded="true"
                  aria-controls={id}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    nav.entries()[nav.active()] && !nav.entries()[nav.active()]!.disabled ? commandOptionId(id, nav.active()) : undefined
                  }
                  autocomplete="off"
                  spellcheck={false}
                  enterkeyhint="go"
                  placeholder={nav.step()?.next?.label}
                  value={search()}
                  // While a command runs, the list waits for it.
                  readOnly={nav.busy()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && nav.busy()) {
                      // Escape stops a running command and closes the list.
                      event.preventDefault();
                      const at = held()?.start;
                      nav.abort();
                      close();
                      if (at !== undefined) focusText(at);
                      return;
                    }
                    if (commandListKey(nav, event, search())) event.preventDefault();
                  }}
                  onBlur={(event) => {
                    // Leaving the list, other than to the text by this part itself, closes it.
                    if (moving || (event.relatedTarget instanceof Node && popover?.contains(event.relatedTarget))) return;
                    close();
                  }}
                />
              </label>
            </Show>
          }
        />
      </div>
    </Show>
  );
}
