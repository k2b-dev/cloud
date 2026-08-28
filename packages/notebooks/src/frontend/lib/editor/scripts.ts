/**
 * `\`\`\`script` block extension for the rich-mode CodeMirror editor.
 *
 * Markdown body authoring contract:
 *
 *   ```script
 *   ui.button("Hello", () => ui.toast(current.title));
 *   ```
 *
 * # Architecture — minimal, mirrors the homepage app's `code` ext
 *
 * Each `\`\`\`script` block gets ONE output widget that hosts the
 * kit-driven UI (buttons, toasts, error blocks). When the cursor is
 * outside the fence, the widget replaces the source range as a true
 * block decoration, matching tables/data blocks. When the cursor is in
 * or near the fence, the source stays visible and the same output
 * surface is rendered as a block widget after the closing fence.
 *
 * No `requestMeasure`, no fold support — every previous attempt at
 * auto-folding caused the "ArrowUp jumps to a random script block"
 * regression. Source collapsing is table-style `Decoration.replace`
 * with atomic ranges; the runtime output owns its DOM lifecycle.
 *
 * # Output widget — runtime isolation
 *
 * - `updateDOM()` reuses the output DOM and only re-runs when the
 *   source changes. Positional shifts update header metadata without
 *   re-invoking the script.
 * - `contenteditable=false` on the widget root keeps CM6's
 *   MutationObserver out of the kit's runtime DOM mutations
 *   (ui.button, error blocks, toasts). Without this, those
 *   mutations get misinterpreted as user edits and corrupt the
 *   script body.
 * - `ignoreEvent` returns true — clicks on internal buttons stay
 *   self-contained; CM doesn't try to caret-move on them.
 * - `disposed` flag handles the late-registration race for async
 *   scripts that `await` before subscribing via
 *   `current.kv.observe`.
 * - `runId` guards stale async runs. We can't cancel an already
 *   executing AsyncFunction, but late kit side effects from old
 *   source are rejected after a re-run/destroy.
 *
 * Locked / read-only notes use the same output widget, but the
 * runtime is created in read mode so script write APIs stay disabled.
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec, type Range, RangeSet, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type * as Y from "yjs";
import type { KitNoteSnapshot } from "../script/kit";
import { createKit } from "../script/kit";
import { runScript } from "../script/runner";
import { selectionIntersectsRange } from "./_lib/cursor-zone-field";
import { notebookWorkspaceMessages } from "../../[id]/messages";

/** Per-notebook config the extension needs to run scripts. The
 *  fields are functions (rather than values) so the extension picks
 *  up changes — `scriptsEnabled` flips at runtime via the settings
 *  panel; the snapshot getter reflects the current note metadata
 *  at the moment a script is run.
 *
 *  `notebookId` is the user-visible 6-character ID. The kit uses it
 *  both as the `:id` param for API calls and as the value of
 *  `current.notebook.id` exposed to script authors. */
export type ScriptsConfig = {
  scriptsEnabled: () => boolean;
  readOnly: () => boolean;
  notebookId: string;
  /** Snapshot of the current note at script-run time. The factory
   *  re-reads this getter every run, so renames / locks are picked
   *  up on the next debounced re-evaluation. */
  noteSnapshot: () => KitNoteSnapshot;
  /** Live Y.Text for the current note's content — kit writes mutate
   *  this directly when `readOnly()` is false. */
  ytext: Y.Text;
  /** Y.Doc for the current note — feeds `current.kv.*` when
   *  `readOnly()` is false. */
  ydoc: Y.Doc;
};

/** Debounce window for re-runs after a source change. Keep it above
 *  normal typing cadence: showcase scripts often perform several API
 *  calls and rebuild a large output tree, so re-running after every
 *  slow keystroke makes the editor feel like the keystroke itself is
 *  delayed. */
const RERUN_DEBOUNCE_MS = 500;

// =============================================================================
// Output widget — block-level script output surface
// =============================================================================

/**
 * Widget that hosts the `.md-script-output` container the runtime renders
 * into. In collapsed mode it is used as the replacement widget for the
 * whole script source range; in edit mode it is a block widget after
 * the closing fence.
 *
 * # DOM reuse via `updateDOM` — critical for typing perf
 *
 * Every keystroke INSIDE a script fence changes the source, which
 * means `eq()` returns false against the previous widget instance.
 * Without intervention CM would call `destroy(oldDom)` + `toDOM()`
 * for every keystroke — tearing down the output DOM, running all
 * disposers (kvStore.watch unsubs, ymap unobserves), and rebuilding
 * fresh divs. Even though the user script itself is debounced 500ms,
 * the destroy/create cycle alone is enough to make typing visibly
 * laggy in a doc with several scripts.
 *
 * Fix: implement `updateDOM(dom)` to opt into CM's same-type-widget
 * DOM reuse path. When `updateDOM` returns true, CM keeps the
 * existing DOM and skips `destroy`. We stash the per-DOM run state
 * (timer, disposers, output/error refs, runId, scriptIndex) on the
 * dom element itself via a symbol key, so successive widget
 * instances all schedule runs against the same persistent state.
 * The first run starts immediately after the widget mounts; later
 * source changes only re-arm the debounce timer. No DOM teardown
 * happens until the widget is actually removed (script deleted /
 * editor unmounted) or it migrates to a different `scriptIndex`
 * (defensive guard against CM matching the wrong decoration).
 */

/** Per-DOM run state. Lives on the widget's root element via the
 *  symbol key below so it survives widget-instance churn (source
 *  edits create new widgets every keystroke; the DOM and its state
 *  are reused). */
type WidgetRunState = {
  source: string;
  sourceVisible: boolean;
  iconEl: HTMLElement;
  labelEl: HTMLElement;
  metaEl: HTMLElement;
  outputEl: HTMLElement;
  errorEl: HTMLElement;
  fromPos: number;
  /** Pending debounce timer for the next script execution. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Disposers registered by the most recent successful run. Re-run
   *  fires them BEFORE registering new ones. */
  disposers: Array<() => void>;
  /** True once the dom is permanently torn down (CM `destroy`).
   *  Late async callbacks check this to short-circuit. */
  disposed: boolean;
  /** Bumped on every run + on destroy. Lets async callbacks tell
   *  whether they're a leftover from an earlier run. */
  runId: number;
  /** Index of the script this state belongs to. If CM ever calls
   *  `updateDOM` across mismatched indices we refuse and force a
   *  rebuild (defense against CM matching the wrong decoration when
   *  scripts are added/removed). */
  scriptIndex: number;
};

const RUN_STATE_KEY = Symbol("kit-script-run-state");

type DomWithState = HTMLElement & { [RUN_STATE_KEY]?: WidgetRunState };
const formatScriptLineCount = (lineCount: number): string => `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;

class OutputWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly config: ScriptsConfig,
    private readonly fromPos: number,
    private readonly lineCount: number,
    private readonly sourceVisible: boolean,
    /** Positional index of this script block within the document
     *  (0 for the first `\`\`\`script` fence, 1 for the second, …).
     *  Included in `eq()` so CM treats two scripts with the SAME
     *  source body at DIFFERENT positions as distinct decorations.
     *  Without this, pasting an identical script twice would make
     *  CM's diff algorithm conflate them (both widgets are eq() to
     *  each other) — observed as a complete tab freeze on the second
     *  paste. */
    private readonly scriptIndex: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    // Source, source position, line count, and positional index. Any
    // change should give `updateDOM()` a chance to refresh header
    // metadata or schedule a source re-run while still keeping the
    // DOM alive.
    return (
      other instanceof OutputWidget &&
      other.source === this.source &&
      other.fromPos === this.fromPos &&
      other.lineCount === this.lineCount &&
      other.sourceVisible === this.sourceVisible &&
      other.scriptIndex === this.scriptIndex
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div") as DomWithState;
    root.className = "md-script-block cm-script-output-frame";
    root.setAttribute("contenteditable", "false");
    root.onmousedown = (event) => {
      event.stopPropagation();
      const target = event.target as HTMLElement | null;
      if (target?.closest("button,a,input,textarea,select,[role='button'],[contenteditable='true']")) return;
      event.preventDefault();
      const state = root[RUN_STATE_KEY];
      view.dispatch({ selection: { anchor: state?.fromPos ?? this.fromPos } });
      view.focus();
    };
    root.ondblclick = (event) => {
      event.stopPropagation();
    };

    const header = document.createElement("div");
    header.className = "cm-script-output-header";

    const icon = document.createElement("i");
    icon.className = "ti text-sm";

    const label = document.createElement("span");
    label.className = "cm-script-output-title";

    const meta = document.createElement("span");
    meta.className = "cm-script-output-meta";
    meta.textContent = formatScriptLineCount(this.lineCount);

    header.append(icon, label, meta);
    root.appendChild(header);

    const output = document.createElement("div");
    output.className = "md-script-output";
    root.appendChild(output);

    const errors = document.createElement("div");
    errors.className = "md-script-errors";
    root.appendChild(errors);

    const state: WidgetRunState = {
      source: this.source,
      sourceVisible: this.sourceVisible,
      iconEl: icon,
      labelEl: label,
      metaEl: meta,
      outputEl: output,
      errorEl: errors,
      fromPos: this.fromPos,
      timer: null,
      disposers: [],
      disposed: false,
      runId: 0,
      scriptIndex: this.scriptIndex,
    };
    root[RUN_STATE_KEY] = state;
    this.applyVisualState(root, state);
    this.scheduleRun(state, 0);
    return root;
  }

  /**
   * Hook into CM's same-type-widget DOM-reuse path. Called when the
   * new widget's `eq()` returned false but the widget classes match.
   * Returning `true` tells CM to keep the existing DOM and skip
   * `destroy` — we just re-arm the debounce timer with the new
   * source. This turns the per-keystroke cost of "tear down +
   * rebuild divs + run all disposers" into "clearTimeout +
   * setTimeout", which is what makes typing inside script fences
   * feel native.
   *
   * Refuses the reuse if `scriptIndex` doesn't match — defensive
   * guard for the (rare) case where CM matches a leftover
   * decoration from an unrelated script position.
   */
  override updateDOM(dom: HTMLElement): boolean {
    const state = (dom as DomWithState)[RUN_STATE_KEY];
    if (!state || state.disposed) return false;
    if (state.scriptIndex !== this.scriptIndex) return false;
    state.fromPos = this.fromPos;
    state.sourceVisible = this.sourceVisible;
    state.metaEl.textContent = formatScriptLineCount(this.lineCount);
    this.applyVisualState(dom, state);
    if (state.source !== this.source) {
      state.source = this.source;
      this.scheduleRun(state);
    }
    return true;
  }

  private applyVisualState(root: HTMLElement, state: WidgetRunState): void {
    const t = notebookWorkspaceMessages.resolve([document.documentElement.lang]).t;
    root.classList.toggle("cm-script-output-frame-editing", state.sourceVisible);
    state.iconEl.className = `ti ${state.sourceVisible ? "ti-terminal-2" : "ti-code"} text-sm`;
    state.labelEl.textContent = state.sourceVisible ? t.output : t.script;
  }

  override destroy(dom: HTMLElement): void {
    const state = (dom as DomWithState)[RUN_STATE_KEY];
    if (!state) return;
    state.disposed = true;
    state.runId++;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.runDisposers(state);
  }

  override ignoreEvent(): boolean {
    return true;
  }

  private runDisposers(state: WidgetRunState): void {
    for (const fn of state.disposers) {
      try {
        fn();
      } catch (err) {
        console.error("[kit dispose]", err);
      }
    }
    state.disposers = [];
  }

  private scheduleRun(state: WidgetRunState, delayMs = RERUN_DEBOUNCE_MS): void {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.run(state);
    }, delayMs);
  }

  private run(state: WidgetRunState): void {
    if (state.disposed) return;
    if (!state.outputEl.isConnected) return;
    state.runId++;
    const runId = state.runId;
    const isActive = () => !state.disposed && state.runId === runId && state.outputEl.isConnected;
    this.runDisposers(state);
    // Clear BOTH containers on every fresh run — old output and
    // old errors shouldn't bleed across re-evaluations.
    state.outputEl.replaceChildren();
    state.errorEl.replaceChildren();

    // Defense in depth: wrap the runtime + run-script setup in a
    // try/catch so any failure during widget-side preparation
    // (runtime factory throws, console proxy init throws, etc.) is
    // surfaced as a visible error chip rather than silently
    // bringing down the widget. `runScript` itself already catches
    // user-script errors and renders them into `errorEl`; this
    // outer guard only catches the rare framework-side failure.
    try {
      const kit = createKit({
        mode: this.config.readOnly() ? "read" : "edit",
        notebookId: this.config.notebookId,
        note: this.config.noteSnapshot(),
        ytext: this.config.readOnly() ? undefined : this.config.ytext,
        ydoc: this.config.readOnly() ? undefined : this.config.ydoc,
        outputEl: state.outputEl,
        isActive,
        registerDisposer: (fn) => {
          if (!isActive()) {
            try {
              fn();
            } catch (err) {
              console.error("[kit dispose late]", err);
            }
            return;
          }
          state.disposers.push(fn);
        },
      });
      void runScript(this.source, kit, state.outputEl, { isActive, errorEl: state.errorEl });
    } catch (err) {
      console.error("[scripts] widget-side setup failed:", err);
      if (isActive()) {
        const block = document.createElement("div");
        block.className =
          "md-script-error-block flex flex-col gap-1 px-3 py-2 rounded text-xs " +
          "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 " +
          "border border-red-200 dark:border-red-900";
        block.textContent = `script widget error: ${err instanceof Error ? err.message : String(err)}`;
        state.errorEl.appendChild(block);
      }
    }
  }
}

// =============================================================================
// Fence parser
// =============================================================================

/**
 * Extract the language tag and body of a `FencedCode` node by walking
 * its Lezer-markdown children. Same lexer the markdown preview
 * pipeline uses, so accepts every variant `marked` accepts (3+
 * backticks / tildes, indented fences, missing closing fence).
 *
 * `node` MUST be the `FencedCode` node itself — not a cursor /
 * resolved position. Pulling the SyntaxNode straight from `iterate`'s
 * `nodeRef.node` avoids the trap where `tree.cursorAt(from, 1)`
 * lands on the opening `CodeMark` (no children) and silently skips
 * every block (codex review on commit 972e16e).
 *
 * Returns null when the fence isn't a `script` block.
 */
type FenceParts = { body: string };
type ScriptRange = { from: number; to: number; collapseTo: number };
type ScriptDecorationState = {
  decorations: DecorationSet;
  collapsedSourceDecorations: DecorationSet;
  scriptRanges: ScriptRange[];
};

const parseScriptFence = (state: EditorState, node: SyntaxNode): FenceParts | null => {
  let info: string | null = null;
  let bodyFrom: number | null = null;
  let bodyTo: number | null = null;

  let child: SyntaxNode | null = node.firstChild;
  while (child) {
    const name = child.name;
    if (name === "CodeInfo" && info === null) {
      info = state.doc.sliceString(child.from, child.to).trim().toLowerCase();
    } else if (name === "CodeText") {
      if (bodyFrom === null) bodyFrom = child.from;
      bodyTo = child.to;
    }
    child = child.nextSibling;
  }

  if (info !== "script") return null;
  const body = bodyFrom !== null && bodyTo !== null ? state.doc.sliceString(bodyFrom, bodyTo) : "";
  return { body };
};

// =============================================================================
// Output widget decoration
// =============================================================================

/**
 * Walk the doc and emit ONE additive block widget per `\`\`\`script`
 * fence when the source is visible. When the cursor is away from the
 * fence, replace the source range with that same output surface.
 * The widget owns script runtime lifecycle state.
 *
 * `updateDOM()` keeps the output DOM alive across source and position
 * changes, so typing outside the script or moving it in the document
 * does not tear down the running kit output.
 */
const changeMightAffectScriptFence = (tr: Transaction): boolean => {
  let might = false;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    if (might) return;
    const insertedText = inserted.toString();
    if (insertedText.includes("`") || insertedText.includes("~") || insertedText.includes("script")) {
      might = true;
      return;
    }

    const from = Math.max(0, fromB - 16);
    const to = Math.min(tr.state.doc.length, toB + 16);
    const context = tr.state.doc.sliceString(from, to);
    might = context.includes("```") || context.includes("~~~");
  });
  return might;
};

const changesIntersectScriptRanges = (tr: Transaction, ranges: ScriptRange[]): boolean => {
  if (ranges.length === 0) return false;
  let intersects = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (intersects) return;
    intersects = ranges.some((range) => fromA <= range.to && toA >= range.from);
  });
  return intersects;
};

const cursorScriptKey = (state: EditorState, ranges: ScriptRange[]): string | null => {
  if (ranges.length === 0) return null;
  const cursor = state.selection.main;
  const hits: number[] = [];
  for (const r of ranges) {
    const prevLineStart = state.doc.lineAt(Math.max(r.from - 1, 0)).from;
    const nextLineEnd = state.doc.lineAt(Math.min(r.to + 1, state.doc.length)).to;
    if (selectionIntersectsRange(cursor, prevLineStart, nextLineEnd)) hits.push(r.from);
  }
  return hits.length > 0 ? hits.sort((a, b) => a - b).join(",") : null;
};

const isCollapsedScriptRange = (collapsedSourceDecorations: DecorationSet, range: ScriptRange): boolean => {
  let collapsed = false;
  collapsedSourceDecorations.between(range.from, range.collapseTo, (from, to) => {
    if (from === range.from && to === range.collapseTo) {
      collapsed = true;
      return false;
    }
    return undefined;
  });
  return collapsed;
};

const scanScripts = (state: EditorState, config: ScriptsConfig): ScriptDecorationState => {
  if (!config.scriptsEnabled()) {
    return {
      decorations: Decoration.none,
      collapsedSourceDecorations: Decoration.none,
      scriptRanges: [],
    };
  }

  const widgets: Range<Decoration>[] = [];
  const collapsedSourceWidgets: Range<Decoration>[] = [];
  const scriptRanges: ScriptRange[] = [];
  const cursor = state.selection.main;
  let scriptIndex = 0;
  syntaxTree(state).iterate({
    enter: (nodeRef) => {
      if (nodeRef.type.name !== "FencedCode") return;
      const parts = parseScriptFence(state, nodeRef.node);
      if (!parts) return;

      const closingLine = state.doc.lineAt(Math.max(0, nodeRef.to - 1));
      const firstLine = state.doc.lineAt(nodeRef.from);
      const sourceFrom = firstLine.from;
      const sourceTo = closingLine.to;
      const outputPos = nodeRef.to > sourceTo ? nodeRef.to : sourceTo;
      const collapseTo = sourceTo;
      const range = { from: sourceFrom, to: nodeRef.to, collapseTo };
      scriptRanges.push(range);
      const lineCount = closingLine.number - firstLine.number + 1;

      const prevLine = state.doc.lineAt(Math.max(sourceFrom - 1, 0));
      const nextLine = state.doc.lineAt(Math.min(nodeRef.to + 1, state.doc.length));
      const sourceVisible = selectionIntersectsRange(cursor, prevLine.from, nextLine.to);
      const outputWidget = new OutputWidget(parts.body, config, sourceFrom, lineCount, sourceVisible, scriptIndex);
      if (!sourceVisible && collapseTo > sourceFrom) {
        const sourceReplacement = Decoration.replace({
          block: true,
          inclusiveEnd: false,
        }).range(sourceFrom, collapseTo);
        widgets.push(sourceReplacement);
        collapsedSourceWidgets.push(sourceReplacement);
      }
      widgets.push(
        Decoration.widget({
          widget: outputWidget,
          side: 1,
          block: true,
        }).range(outputPos),
      );
      scriptIndex++;
    },
  });
  return {
    decorations: widgets.length > 0 ? RangeSet.of(widgets, true) : Decoration.none,
    collapsedSourceDecorations: collapsedSourceWidgets.length > 0 ? RangeSet.of(collapsedSourceWidgets, true) : Decoration.none,
    scriptRanges,
  };
};

// =============================================================================
// Extension factory
// =============================================================================

/**
 * Public extension factory. Wire it alongside the other rich-mode
 * extensions in `NoteEditor.client.tsx`.
 *
 * Returns:
 *  1. The script StateField — emits one block output widget per
 *     `\`\`\`script` fence while the source is visible, and replaces
 *     the source range with that widget when collapsed.
 *  2. The output-frame theme.
 *
 * NOTE: an earlier revision included an auto-fold `ViewPlugin` that
 * kept fold state synced with caret position. That layer caused
 * cursor displacement on ArrowUp from anywhere in the doc — every
 * `selectionSet` triggered fold/unfold dispatches and the resulting
 * layout shifts confused CM's vertical-navigation math. Auto-fold
 * is left out on purpose.
 */
export const scriptsExtension = (config: ScriptsConfig): Extension => {
  const outputField = StateField.define<ScriptDecorationState>({
    create: (state) => scanScripts(state, config),
    update: (value, tx) => {
      if (!config.scriptsEnabled()) {
        return {
          decorations: Decoration.none,
          collapsedSourceDecorations: Decoration.none,
          scriptRanges: [],
        };
      }

      if (tx.docChanged) {
        const decorations = value.decorations.map(tx.changes);
        const collapsedSourceDecorations = value.collapsedSourceDecorations.map(tx.changes);
        const mightAffectScriptFence = changeMightAffectScriptFence(tx);
        if (value.scriptRanges.length === 0 && !mightAffectScriptFence) {
          return { decorations, collapsedSourceDecorations, scriptRanges: [] };
        }
        if (!changesIntersectScriptRanges(tx, value.scriptRanges) && !mightAffectScriptFence) {
          return {
            decorations,
            collapsedSourceDecorations,
            scriptRanges: value.scriptRanges.map((range) => ({
              from: tx.changes.mapPos(range.from, 1),
              to: tx.changes.mapPos(range.to, -1),
              collapseTo: tx.changes.mapPos(range.collapseTo, -1),
            })),
          };
        }
        return scanScripts(tx.state, config);
      }
      if (!tx.selection) {
        return value;
      }
      const oldKey = cursorScriptKey(tx.startState, value.scriptRanges);
      const newKey = cursorScriptKey(tx.state, value.scriptRanges);
      if (oldKey === newKey) return value;
      return scanScripts(tx.state, config);
    },
    provide: (f) => [
      EditorView.decorations.from(f, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(f).collapsedSourceDecorations),
    ],
  });

  const collapsedSourceEditKeymap = Prec.highest(
    keymap.of([
      {
        key: "Backspace",
        run: (view) => openCollapsedSourceInsteadOfDeleting(view, -1),
      },
      {
        key: "Delete",
        run: (view) => openCollapsedSourceInsteadOfDeleting(view, 1),
      },
    ]),
  );

  function openCollapsedSourceInsteadOfDeleting(view: EditorView, dir: -1 | 1): boolean {
    const scriptState = view.state.field(outputField, false);
    if (!scriptState) return false;
    const selection = view.state.selection.main;

    const target = scriptState.scriptRanges.find((range) => {
      if (!isCollapsedScriptRange(scriptState.collapsedSourceDecorations, range)) return false;
      if (!selection.empty) return selection.from < range.collapseTo && selection.to > range.from;
      return dir < 0 ? selection.head === range.collapseTo : selection.head === range.from;
    });
    if (!target) return false;

    view.dispatch({
      selection: { anchor: dir < 0 ? target.collapseTo : target.from },
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  }

  const outputFrameTheme = EditorView.theme({
    ".cm-script-output-frame": {
      boxSizing: "border-box",
      border: "1px solid transparent",
      borderRadius: "6px",
      background:
        "linear-gradient(135deg, rgb(239 246 255 / 0.94), rgb(236 253 245 / 0.88), rgb(245 243 255 / 0.88)) padding-box, linear-gradient(135deg, rgb(59 130 246 / 0.5), rgb(20 184 166 / 0.42), rgb(168 85 247 / 0.38)) border-box",
      padding: "0.375rem",
    },
    ".cm-script-output-frame.cm-script-output-frame-editing": {
      background:
        "linear-gradient(135deg, rgb(239 246 255 / 0.96), rgb(236 253 245 / 0.9)) padding-box, linear-gradient(135deg, rgb(37 99 235 / 0.42), rgb(20 184 166 / 0.34)) border-box",
      boxShadow: "0 0 0 1px rgb(37 99 235 / 0.12) inset",
    },
    ".cm-script-output-header": {
      display: "flex",
      alignItems: "center",
      gap: "0.45rem",
      minHeight: "1.25rem",
      color: "#1d4ed8",
      cursor: "pointer",
      fontSize: "0.75rem",
      lineHeight: "1rem",
      userSelect: "none",
    },
    ".cm-script-output-header:hover": {
      color: "#1e40af",
    },
    ".cm-script-output-title": {
      fontWeight: "600",
    },
    ".cm-script-output-meta": {
      marginLeft: "auto",
      opacity: "0.72",
    },
    ".cm-script-output-frame .md-script-output": {
      border: "0",
      borderRadius: "0",
      background: "transparent",
      padding: "0.375rem 0 0",
    },
    ".cm-script-output-frame .md-script-errors": {
      marginTop: "0.5rem",
    },
    ".dark .cm-script-output-frame": {
      background:
        "linear-gradient(135deg, rgb(15 23 42 / 0.98), rgb(12 24 28 / 0.98), rgb(24 18 43 / 0.98)) padding-box, linear-gradient(135deg, rgb(59 130 246 / 0.52), rgb(20 184 166 / 0.38), rgb(168 85 247 / 0.34)) border-box",
    },
    ".dark .cm-script-output-frame.cm-script-output-frame-editing": {
      background:
        "linear-gradient(135deg, rgb(15 23 42 / 0.99), rgb(12 24 28 / 0.98)) padding-box, linear-gradient(135deg, rgb(147 197 253 / 0.44), rgb(45 212 191 / 0.32)) border-box",
      boxShadow: "0 0 0 1px rgb(147 197 253 / 0.28) inset",
    },
    ".dark .cm-script-output-header": {
      color: "#bfdbfe",
    },
    ".dark .cm-script-output-header:hover": {
      color: "#dbeafe",
    },
  });

  return [outputField, outputFrameTheme, collapsedSourceEditKeymap];
};
