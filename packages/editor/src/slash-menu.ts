import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  pickedCompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { fuzzy } from "@k2b/stdlib";
import type { EditorAction } from "./editor-state";

/** One entry of the slash menu: an editor action reached by typing `/` and its name. */
export type SlashAction = Omit<EditorAction, "run"> & {
  /** What a person types after `/`: lowercase, no spaces. */
  name: string;
  /** One line after the label. */
  description?: string;
  /** Further names that match exactly, such as `img` for an image action. */
  aliases?: string[];
  /**
   * A suffix after the name, such as `2x4` in `/table2x4`. Without it, only the bare name matches exactly; with it,
   * `run` receives the match for a typed suffix and `undefined` for the bare name.
   */
  params?: RegExp;
  /** `true` inserts at the caret; otherwise an action typed mid-line starts on a new line. */
  inline?: boolean;
  /** Runs after the typed `/name` left the document. */
  run: (view: EditorView, params?: RegExpMatchArray) => void | Promise<void>;
};

export type SlashMenuOptions = {
  actions: SlashAction[];
  /**
   * Further completion sources that share the popup, such as links or tags. CodeMirror shows one completion popup per
   * editor, so every source the host wants lives in this list; a source that throws only drops its own options.
   */
  sources?: { name: string; source: CompletionSource }[];
};

/** `/name` after the line start or a space; group 1 is the space, group 2 the typed name and suffix. */
const trigger = /(^|\s)\/(\w*)$/;
/** stdlib's fuzzy scores run up to about 100; below this, accidental subsequence matches crowd the list. */
const minimumScore = 25;

type SlashCompletion = Completion & { slashAction: SlashAction; parsedParams?: RegExpMatchArray };

const matchExact = (action: SlashAction, typed: string): { params?: RegExpMatchArray } | null => {
  const lower = typed.toLowerCase();
  const names = [action.name, ...(action.aliases ?? [])];
  if (names.some((name) => name.toLowerCase() === lower)) return { params: undefined };
  if (!action.params) return null;
  for (const name of names) {
    if (!lower.startsWith(name.toLowerCase())) continue;
    const suffix = typed.slice(name.length);
    const match = suffix ? action.params.exec(suffix) : null;
    if (match) return { params: match };
  }
  return null;
};

// CodeMirror accepts pointer-picked options on mousedown. Opening another popover before mouseup lets that same
// press light-dismiss it in WebKit, so actions picked with a pointer run after the release.
const pointerRuns = new WeakMap<EditorView, (() => void)[]>();
const pointerTiming = ViewPlugin.define((view) => {
  let alive = true;
  const press = (event: MouseEvent) => {
    if (event.button === 0 && event.target instanceof Element && event.target.closest(".cm-tooltip-autocomplete"))
      pointerRuns.set(view, []);
  };
  const release = () => {
    const pending = pointerRuns.get(view);
    pointerRuns.delete(view);
    if (pending?.length)
      queueMicrotask(() => {
        if (alive) for (const run of pending) run();
      });
  };
  view.dom.addEventListener("mousedown", press, true);
  view.dom.ownerDocument.addEventListener("mouseup", release, true);
  return {
    destroy() {
      alive = false;
      pointerRuns.delete(view);
      view.dom.removeEventListener("mousedown", press, true);
      view.dom.ownerDocument.removeEventListener("mouseup", release, true);
    },
  };
});

const completion = (action: SlashAction, parsedParams?: RegExpMatchArray): SlashCompletion => ({
  label: `/${action.name}`,
  displayLabel: action.label,
  detail: action.description,
  slashAction: action,
  parsedParams,
  apply: (view, picked, from, to) => {
    // A block action typed after text starts on a fresh line; the newline replaces the typed `/name`.
    const line = view.state.doc.lineAt(from);
    const midLine = line.text.slice(0, from - line.from).trim().length > 0;
    view.dispatch({
      changes: { from, to, insert: midLine && !action.inline ? "\n" : "" },
      annotations: pickedCompletion.of(picked),
      userEvent: "input.complete",
    });
    // Run after autocomplete updated: an action that opens a dialog inside the same update re-enters CodeMirror.
    const run = () => void action.run(view, parsedParams);
    const pending = pointerRuns.get(view);
    if (pending) pending.push(run);
    else queueMicrotask(run);
  },
});

/** The slash source alone, for hosts that compose their own autocompletion. */
export const slashCompletionSource = (actions: SlashAction[]) => {
  const haystacks = new Map(actions.map((action) => [action, [action.name, action.label, ...(action.aliases ?? [])].join(" ")]));
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const match = trigger.exec(line.text.slice(0, context.pos - line.from));
    if (!match) return null;
    const typed = match[2] ?? "";
    const from = line.from + match.index + (match[1] ?? "").length;
    const enabled = actions.filter((action) => action.isEnabled?.(context.state) !== false);
    const options: SlashCompletion[] = [];
    if (!typed) for (const action of enabled) options.push(completion(action));
    else {
      // Exact names and parameter matches come first, then fuzzy matches by score.
      const exact = new Set<SlashAction>();
      for (const action of enabled) {
        const found = matchExact(action, typed);
        if (!found) continue;
        options.push(completion(action, found.params));
        exact.add(action);
      }
      for (const hit of fuzzy.filter(
        typed,
        enabled.filter((action) => !exact.has(action)),
        { key: (action) => haystacks.get(action) ?? action.name },
      ))
        if (hit.score >= minimumScore) options.push(completion(hit.item));
    }
    return { from, to: context.pos, filter: false, options };
  };
};

/** Default icons for completions of other sources without one. */
const typeIcons: Record<string, string> = {
  method: "ti-math-function",
  function: "ti-math-function",
  property: "ti-circle-dot",
  namespace: "ti-category",
  class: "ti-cube",
  keyword: "ti-braces",
  constant: "ti-pennant",
  variable: "ti-variable",
};
const iconOf = (option: Completion) =>
  (option as SlashCompletion).slashAction?.icon ??
  (option as Completion & { completionIcon?: string }).completionIcon ??
  (option.type ? typeIcons[option.type] : undefined) ??
  "ti-command";

const iconRenderer = {
  position: 20,
  render: (option: Completion): Node => {
    const icon = document.createElement("i");
    icon.className = `ti ${iconOf(option)} cm-slash-icon`;
    icon.setAttribute("aria-hidden", "true");
    return icon;
  },
};
const detailRenderer = {
  position: 70,
  render: (option: Completion): Node => {
    const detail = document.createElement("span");
    if (!option.detail) return detail;
    detail.className = "cm-completion-detail";
    detail.textContent = option.detail;
    return detail;
  },
};

/** A source that throws returns nothing instead of ending the whole popup, and the error stays visible in the console. */
const safe =
  (name: string, source: CompletionSource): CompletionSource =>
  (context) => {
    try {
      const result = source(context);
      if (result instanceof Promise)
        return result.catch((error: unknown) => {
          console.error(`[autocomplete:${name}]`, error);
          return null;
        });
      return result;
    } catch (error) {
      console.error(`[autocomplete:${name}]`, error);
      return null;
    }
  };

/**
 * The slash menu as a CodeMirror extension: `/` at the line start or after a space opens the actions, typing filters
 * them by exact name first and then fuzzily, ↑↓ ⏎ ⎋ work as in any completion popup. It owns the editor's one
 * completion popup; pass further sources through `sources`.
 */
export const slashMenu = (options: SlashMenuOptions): Extension => [
  pointerTiming,
  autocompletion({
    override: [
      safe("slash", slashCompletionSource(options.actions)),
      ...(options.sources ?? []).map((entry) => safe(entry.name, entry.source)),
    ],
    activateOnTyping: true,
    selectOnOpen: true,
    closeOnBlur: true,
    icons: false,
    addToOptions: [iconRenderer, detailRenderer],
  }),
];
