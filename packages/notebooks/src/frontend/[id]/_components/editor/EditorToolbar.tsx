import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { asUndoStep, type EditorAction, type EditorHandle, Toolbar, type ToolbarCustom, type ToolbarMenu } from "@k2b/editor";
import { indentListItems, outdentListItems, setListKind } from "@k2b/editor/markdown";
import { Button, Dropdown, IconButtonLink, Tooltip, useLocale } from "@k2b/ui";
import { type InlineFormat, TableSizePicker, type TextEditorControls } from "@k2b/ui/text-editor";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ariaShortcut, isApple, shortcutLabel } from "../../../lib/shortcut-label";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { bookMessages } from "../book/messages";
import { commentMessages } from "../comments/messages";
import { openAttachmentPicker } from "./AttachmentPicker";
import {
  type CaretFormat,
  insertCallout,
  insertCodeBlock,
  insertLink,
  insertNoteLink,
  insertTable,
  setHeadingLevel,
  toggleHeadingLevel,
  toggleInlineMark,
} from "./editor-actions";
import { DetailsButton, NavigationButton } from "./workspace-buttons";

type Props = {
  connected: boolean;
  /** The note's shared editor state; the toolbar formats its view. */
  editor: EditorHandle;
  notebookId: string;
  noteId: string;
  /** Formats at the caret: pressed toggles, the text style, and whether Indent and Outdent apply. */
  format: CaretFormat;
  onUndo: () => void;
  onRedo: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onTablePickerReady?: (open: () => void) => void;
  /** The shared editor's table controls: inline formats apply to a focused cell, and its menu edits the table. */
  table?: TextEditorControls;
  /** The note's open comments: the button shows their number and opens them. */
  comments?: { open: number; onOpen: () => void };
};

/** Formatting shortcuts; headings match the physical digit keys like the @k2b/ui MarkdownEditor and the list keys. */
export function formattingKeymap(opts: { notebookId: string }) {
  const command = (run: (view: EditorView) => void | Promise<void>) => (view: EditorView) => {
    void asUndoStep(view, () => run(view));
    return true;
  };
  return Prec.high([
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (
          !event.shiftKey ||
          event.altKey ||
          event.isComposing ||
          !(isApple() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
        )
          return false;
        const level = event.code === "Digit1" ? 1 : event.code === "Digit2" ? 2 : event.code === "Digit3" ? 3 : null;
        if (!level) return false;
        void asUndoStep(view, () => toggleHeadingLevel(view, level));
        event.preventDefault();
        return true;
      },
    }),
    keymap.of([
      { key: "Mod-b", run: command((view) => toggleInlineMark(view, "bold")) },
      { key: "Mod-i", run: command((view) => toggleInlineMark(view, "italic")) },
      { key: "Mod-Shift-s", run: command((view) => toggleInlineMark(view, "strikethrough")) },
      { key: "Mod-Shift-h", run: command((view) => toggleInlineMark(view, "highlight")) },
      { key: "Mod-e", run: command((view) => toggleInlineMark(view, "code")) },
      { key: "Mod-k", run: command((view) => insertLink(view)) },
      { key: "Mod-Alt-k", run: command((view) => insertNoteLink(view, opts.notebookId)) },
    ]),
  ]);
}

export default function EditorToolbar(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const keys = (spec: string) => shortcutLabel(spec, locale());
  const view = () => props.editor.view();
  // A focused table cell takes inline formats; block formats would split its row, so they wait outside the table.
  const inCell = () => !!props.table?.tableActive();
  let openTablePicker = () => {};
  const action = (
    id: string,
    icon: string,
    label: string,
    run: (view: EditorView) => void | Promise<void>,
    extra: Partial<EditorAction> = {},
  ): EditorAction => ({ id, icon, label, run, ...extra });
  // Every action is one undo step and leaves focus in the note, also after a picker closes (`editor.run`).
  const mark = (
    name: Parameters<typeof toggleInlineMark>[1],
    cell: InlineFormat | undefined,
    icon: string,
    label: string,
    shortcut: string,
    pressed?: () => boolean,
  ) =>
    action(
      name,
      icon,
      label,
      (view) => {
        if (!cell || !props.table?.formatCell(cell)) toggleInlineMark(view, name);
      },
      { shortcut, isActive: pressed },
    );
  const list = (kind: "bullet" | "ordered" | "task", icon: string, label: string, shortcut: string) =>
    action(
      kind,
      icon,
      label,
      (view) => {
        setListKind(kind)(view);
      },
      { shortcut, isActive: () => props.format.list === kind, isEnabled: () => !inCell() },
    );
  const style = () => (props.format.heading ? `H${props.format.heading}` : t().normalText);
  const styleLabels = () => [t().normalText, "H1", "H2", "H3", "H4", "H5", "H6"];
  const [coarsePointer, setCoarsePointer] = createSignal(false);
  // On touch screens, the controlled style menu opens on a tap without taking focus, so the note keeps focus, the
  // keyboard, and the lifted toolbar. Keys on the trigger still move focus into the menu.
  const [styleOpen, setStyleOpen] = createSignal(false);
  const [showDisconnected, setShowDisconnected] = createSignal(false);
  let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    clearTimeout(disconnectedTimer);
    if (props.connected) {
      setShowDisconnected(false);
      return;
    }
    disconnectedTimer = setTimeout(() => setShowDisconnected(true), 1_000);
  });

  onMount(() => {
    const coarse = window.matchMedia("(pointer: coarse)");
    setCoarsePointer(coarse.matches);
    const pointerChanged = () => setCoarsePointer(coarse.matches);
    coarse.addEventListener("change", pointerChanged);
    onCleanup(() => {
      clearTimeout(disconnectedTimer);
      coarse.removeEventListener("change", pointerChanged);
    });
  });

  const styleMenu: ToolbarCustom = {
    kind: "custom",
    id: "text-style",
    render: () => (
      <Show
        when={inCell()}
        fallback={
          <Dropdown.Root
            disabled={inCell()}
            open={coarsePointer() ? styleOpen() : undefined}
            onOpenChange={setStyleOpen}
            position="top-left"
            items={[
              {
                sectionLabel: t().textStyle,
                items: ([0, 1, 2, 3] as const).map((level) => ({
                  choice: "radio",
                  label: level === 0 ? t().normalText : level === 1 ? t().heading1 : level === 2 ? t().heading2 : t().heading3,
                  checked: props.format.heading === level,
                  // macOS takes ⇧⌘3 for screenshots, so Mac users pick Heading 3 here.
                  description: level && !(level === 3 && isApple()) ? keys(`Mod-Shift-${level}`) : undefined,
                  action: () => void props.editor.run(action(`heading${level}`, "", "", (view) => setHeadingLevel(view, level))),
                })),
              },
            ]}
          >
            <Dropdown.Trigger label={`${t().textStyle}: ${style()}`} size="xs" variant="ghost" class="text-dimmed">
              {/* Every label shares one grid cell, so the widest one sets the width and a new style never moves a button. */}
              <span class="notebooks-editor-toolbar__style">
                <For each={styleLabels()}>
                  {(label) => (
                    <span data-current={label === style() ? "true" : undefined} aria-hidden={label !== style()}>
                      {label}
                    </span>
                  )}
                </For>
              </span>
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        }
      >
        {props.table?.TableMenu({ class: "text-dimmed", size: "xs", position: "top-left", text: t().table })}
      </Show>
    ),
  };
  // Inserts a table; in a focused cell the same place opens the shared cell menu, as a sheet on phones.
  const tablePicker: ToolbarCustom = {
    kind: "custom",
    id: "table",
    render: () => (
      <Show
        when={props.table && inCell()}
        fallback={
          <TableSizePicker
            class="text-dimmed"
            size="xs"
            onReady={(open) => {
              openTablePicker = open;
              props.onTablePickerReady?.(open);
            }}
            maxRows={50}
            maxColumns={20}
            disabled={view()?.state.readOnly}
            onPick={({ rows, columns }) =>
              void props.editor.run(
                action("insert-table", "", "", (view) => {
                  if (!view.state.readOnly) return insertTable(view, { rows, cols: columns }, locale());
                }),
              )
            }
          />
        }
      >
        {props.table?.TableMenu({ class: "text-dimmed", size: "xs", position: "top-right" })}
      </Show>
    ),
  };
  const outsideCell = { isEnabled: () => !inCell() };
  const callout = (kind: Parameters<typeof insertCallout>[1], icon: string, label: string) =>
    action(`callout-${kind}`, icon, label, (view) => insertCallout(view, kind), outsideCell);
  const more = (): ToolbarMenu => ({
    kind: "menu",
    id: "more",
    icon: "ti-dots",
    label: t().moreInsert,
    position: "top-right",
    width: "13rem",
    sections: [
      {
        label: t().blocks,
        actions: [
          callout("note", "ti-chevron-right", t().note),
          callout("info", "ti-info-circle", t().info),
          callout("success", "ti-check", t().success),
          callout("warning", "ti-alert-circle", t().warning),
          callout("danger", "ti-alert-hexagon", t().danger),
        ],
      },
      {
        label: t().misc,
        actions: [
          action("table-picker", "ti-table", t().table, () => queueMicrotask(() => openTablePicker()), outsideCell),
          action("code-block", "ti-code-plus", t().codeBlock, insertCodeBlock, outsideCell),
          mark("code", "code", "ti-code", t().inlineCode, "Mod-e"),
        ],
      },
    ],
  });

  return (
    <Toolbar
      editor={props.editor}
      label={t().formatting}
      class="notebooks-editor-toolbar mt-1 flex min-w-0 items-center gap-2 px-2 py-2 text-base text-dimmed"
      toolsClass="notebooks-editor-toolbar__tools no-scrollbar min-w-0 flex-1 overflow-x-auto"
      liftAboveKeyboard
      groups={[
        {
          label: t().history,
          class: "notebooks-editor-toolbar__history shrink-0",
          separatorClass: "notebooks-editor-toolbar__history-separator",
          items: [
            action("undo", "ti-arrow-back-up", t().undo, props.onUndo, { shortcut: "Mod-z", isEnabled: () => props.canUndo !== false }),
            action("redo", "ti-arrow-forward-up", t().redo, props.onRedo, {
              shortcut: "Mod-Shift-z",
              isEnabled: () => props.canRedo !== false,
            }),
          ],
        },
        { label: t().textStyle, items: [styleMenu] },
        {
          items: [
            mark("bold", "bold", "ti-bold", t().bold, "Mod-b", () => props.format.bold),
            mark("italic", "italic", "ti-italic", t().italic, "Mod-i", () => props.format.italic),
            mark("strikethrough", "strike", "ti-strikethrough", t().strikethrough, "Mod-Shift-s", () => props.format.strikethrough),
            mark("highlight", { marker: "==" }, "ti-highlight", t().highlight, "Mod-Shift-h", () => props.format.highlight),
          ],
        },
        {
          label: t().lists,
          items: [
            list("bullet", "ti-list", t().bulletList, "Mod-Shift-8"),
            list("ordered", "ti-list-numbers", t().numberedList, "Mod-Shift-7"),
            list("task", "ti-checkbox", t().checklist, "Mod-Shift-9"),
            action("outdent", "ti-indent-decrease", t().outdentListItem, (view) => void outdentListItems(view), {
              shortcut: "Mod-[",
              isEnabled: () => props.format.outdent && !inCell(),
            }),
            action("indent", "ti-indent-increase", t().indentListItem, (view) => void indentListItems(view), {
              shortcut: "Mod-]",
              isEnabled: () => props.format.indent && !inCell(),
            }),
          ],
        },
        {
          label: t().insertContent,
          items: [
            action(
              "link",
              "ti-link",
              t().link,
              (view) => {
                if (!props.table?.formatCell("link")) return insertLink(view, locale());
              },
              { shortcut: "Mod-k" },
            ),
            action("note-link", "ti-file-symlink", t().linkToNote, (view) => insertNoteLink(view, props.notebookId, locale()), {
              shortcut: "Mod-Alt-k",
              ...outsideCell,
            }),
            action("attach", "ti-paperclip", t().attachFile, () => openAttachmentPicker(props.notebookId, locale())),
            tablePicker,
            more(),
          ],
        },
      ]}
      start={<NavigationButton />}
      end={
        <>
          <Show when={showDisconnected()}>
            <span class="flex shrink-0 items-center gap-1 text-xs" role="status">
              <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              {t().reconnecting}
            </span>
          </Show>

          <Show when={props.comments}>
            {(comments) => (
              <Tooltip.Anchor content={commentMessages.resolve([locale()]).t.commentsShortcut}>
                <Button
                  size="xs"
                  variant="ghost"
                  class="text-dimmed notebook-comments-button"
                  aria-label={commentMessages.resolve([locale()]).t.commentsButton({ count: comments().open })}
                  aria-keyshortcuts={ariaShortcut("Mod-Alt-m")}
                  onClick={() => comments().onOpen()}
                >
                  <i class="ti ti-message-circle text-sm" aria-hidden="true" />
                  <Show when={comments().open}>
                    <span class="tabular-nums font-semibold">{comments().open}</span>
                  </Show>
                </Button>
              </Tooltip.Anchor>
            )}
          </Show>
          {/* Detail panel toggle */}
          <Tooltip.Anchor content={bookMessages.resolve([locale()]).t.openBook}>
            <IconButtonLink
              href={buildNoteUrl(props.notebookId, props.noteId, "book")}
              label={bookMessages.resolve([locale()]).t.openBook}
              tooltip={false}
              size="xs"
              class="text-dimmed"
            >
              <i class="ti ti-book" aria-hidden="true" />
            </IconButtonLink>
          </Tooltip.Anchor>
          <DetailsButton />
        </>
      }
    />
  );
}
