import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Dropdown, IconButton, IconButtonLink, Toolbar, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { indentListItems, outdentListItems, setListKind } from "../../../lib/editor/list-commands";
import { ariaShortcut, isApple, shortcutLabel } from "../../../lib/shortcut-label";
import { asUndoStep } from "../../../lib/yjs/history";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { bookMessages } from "../book/messages";
import { DETAIL_PANEL_STATE_EVENT, DETAIL_PANEL_TOGGLE_EVENT } from "../detail/events";
import { readNavigationHidden } from "../settings/NotebookSettingsStore";
import { createNavigationHidden, NOTEBOOK_NAVIGATION_ID, setNavigationHidden } from "../sidebar/navigation-visibility";
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

type Props = {
  connected: boolean;
  editorView: EditorView | undefined;
  notebookId: string;
  noteId: string;
  initialPanelOpen: boolean;
  /** Formats at the caret: pressed toggles, the text style, and whether Indent and Outdent apply. */
  format: CaretFormat;
  onUndo: () => void;
  onRedo: () => void;
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
  const keys = (spec: string) => shortcutLabel(spec, { ctrl: t().keyCtrl, shift: t().keyShift, alt: t().keyAlt });
  // Every action is one undo step and leaves focus in the note, also after a picker closes.
  const withView = (action: (view: EditorView) => void | Promise<void>) => () => {
    const view = props.editorView;
    if (!view) return;
    void asUndoStep(view, () => {
      const result = action(view);
      if (!result) return view.focus();
      return result.finally(() => view.focus());
    });
  };
  const list = (kind: "bullet" | "ordered" | "task") =>
    withView((view) => {
      setListKind(kind)(view);
    });
  const style = () => (props.format.heading ? `H${props.format.heading}` : t().normalText);
  const styleLabels = () => [t().normalText, "H1", "H2", "H3", "H4", "H5", "H6"];
  const [panelOpen, setPanelOpen] = createSignal(props.initialPanelOpen);
  // The toolbar renders only in the browser, where the cookie holds the same state SSR used.
  const navigationHidden = createNavigationHidden(readNavigationHidden());
  const navigationLabel = () => (navigationHidden() ? t().showNavigation : t().hideNavigation);
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
    const handler = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
      if (detail && typeof detail === "object" && "isOpen" in detail && typeof detail.isOpen === "boolean") setPanelOpen(detail.isOpen);
    };
    window.addEventListener(DETAIL_PANEL_STATE_EVENT, handler);
    onCleanup(() => {
      clearTimeout(disconnectedTimer);
      window.removeEventListener(DETAIL_PANEL_STATE_EVENT, handler);
    });
  });

  const toggleDetailPanel = () => window.dispatchEvent(new CustomEvent(DETAIL_PANEL_TOGGLE_EVENT));

  const Btn = (p: { icon: string; title: string; shortcut?: string; pressed?: boolean; enabled?: boolean; onClick: () => void }) => (
    <Tooltip.Anchor content={p.shortcut ? t().withShortcut({ label: p.title, keys: keys(p.shortcut) }) : p.title}>
      <IconButton
        label={p.title}
        tooltip={false}
        size="xs"
        aria-pressed={p.pressed === undefined ? undefined : p.pressed ? "true" : "false"}
        aria-disabled={p.enabled === false ? "true" : undefined}
        aria-keyshortcuts={p.shortcut ? ariaShortcut(p.shortcut) : undefined}
        onClick={() => {
          if (p.enabled !== false) p.onClick();
        }}
        class="text-dimmed"
      >
        <i class={`ti ${p.icon} text-sm`} aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );

  return (
    // Pointer presses on any control, menu items included, keep focus and selection in the note. A native listener,
    // because the menus are popovers inside this element and must not depend on delegation reaching them.
    <div
      class="notebooks-editor-toolbar mt-1 flex min-w-0 items-center gap-2 px-2 py-2 text-base text-dimmed"
      on:mousedown={(event) => event.preventDefault()}
    >
      {/* The navigation sidebar exists from lg up; phones keep the header's menu. */}
      <div class="hidden shrink-0 lg:flex">
        <Tooltip.Anchor content={navigationLabel()}>
          <IconButton
            label={navigationLabel()}
            tooltip={false}
            size="xs"
            class="text-dimmed"
            aria-expanded={!navigationHidden()}
            aria-controls={NOTEBOOK_NAVIGATION_ID}
            onClick={() => setNavigationHidden(!navigationHidden())}
          >
            <i
              class={`ti ${navigationHidden() ? "ti-layout-sidebar-left-expand" : "ti-layout-sidebar-left-collapse"} text-sm`}
              aria-hidden="true"
            />
          </IconButton>
        </Tooltip.Anchor>
      </div>
      <Toolbar label={t().formatting} class="notebooks-editor-toolbar__tools no-scrollbar min-w-0 flex-1 overflow-x-auto">
        <Toolbar.Group label={t().history} class="notebooks-editor-toolbar__history shrink-0">
          <Btn icon="ti-arrow-back-up" title={t().undo} shortcut="Mod-z" onClick={props.onUndo} />
          <Btn icon="ti-arrow-forward-up" title={t().redo} shortcut="Mod-Shift-z" onClick={props.onRedo} />
        </Toolbar.Group>
        <Toolbar.Separator class="notebooks-editor-toolbar__history-separator" />
        <Toolbar.Group label={t().textStyle} class="shrink-0">
          <Dropdown.Root
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
                  action: withView((view) => setHeadingLevel(view, level)),
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
        </Toolbar.Group>
        <Toolbar.Separator />
        <Toolbar.Group class="shrink-0">
          <Btn
            icon="ti-bold"
            title={t().bold}
            shortcut="Mod-b"
            pressed={props.format.bold}
            onClick={withView((view) => toggleInlineMark(view, "bold"))}
          />
          <Btn
            icon="ti-italic"
            title={t().italic}
            shortcut="Mod-i"
            pressed={props.format.italic}
            onClick={withView((view) => toggleInlineMark(view, "italic"))}
          />
          <Btn
            icon="ti-strikethrough"
            title={t().strikethrough}
            shortcut="Mod-Shift-s"
            pressed={props.format.strikethrough}
            onClick={withView((view) => toggleInlineMark(view, "strikethrough"))}
          />
          <Btn
            icon="ti-highlight"
            title={t().highlight}
            shortcut="Mod-Shift-h"
            pressed={props.format.highlight}
            onClick={withView((view) => toggleInlineMark(view, "highlight"))}
          />
        </Toolbar.Group>
        <Toolbar.Separator />
        <Toolbar.Group label={t().lists} class="shrink-0">
          <Btn
            icon="ti-list"
            title={t().bulletList}
            shortcut="Mod-Shift-8"
            pressed={props.format.list === "bullet"}
            onClick={list("bullet")}
          />
          <Btn
            icon="ti-list-numbers"
            title={t().numberedList}
            shortcut="Mod-Shift-7"
            pressed={props.format.list === "ordered"}
            onClick={list("ordered")}
          />
          <Btn
            icon="ti-checkbox"
            title={t().checklist}
            shortcut="Mod-Shift-9"
            pressed={props.format.list === "task"}
            onClick={list("task")}
          />
          <Btn
            icon="ti-indent-decrease"
            title={t().outdentListItem}
            shortcut="Mod-["
            enabled={props.format.outdent}
            onClick={withView((view) => {
              outdentListItems(view);
            })}
          />
          <Btn
            icon="ti-indent-increase"
            title={t().indentListItem}
            shortcut="Mod-]"
            enabled={props.format.indent}
            onClick={withView((view) => {
              indentListItems(view);
            })}
          />
        </Toolbar.Group>
        <Toolbar.Separator />
        <Toolbar.Group label={t().insertContent} class="shrink-0">
          <Btn icon="ti-link" title={t().link} shortcut="Mod-k" onClick={withView((view) => insertLink(view, locale()))} />
          <Btn
            icon="ti-file-symlink"
            title={t().linkToNote}
            shortcut="Mod-Alt-k"
            onClick={withView((view) => insertNoteLink(view, props.notebookId, locale()))}
          />
          <Btn icon="ti-paperclip" title={t().attachFile} onClick={withView(() => openAttachmentPicker(props.notebookId, locale()))} />
          <Dropdown.Root
            position="top-right"
            width="13rem"
            items={[
              {
                sectionLabel: t().blocks,
                items: [
                  { icon: "ti ti-chevron-right", label: t().note, action: withView((view) => insertCallout(view, "note")) },
                  { icon: "ti ti-info-circle", label: t().info, action: withView((view) => insertCallout(view, "info")) },
                  { icon: "ti ti-check", label: t().success, action: withView((view) => insertCallout(view, "success")) },
                  { icon: "ti ti-alert-circle", label: t().warning, action: withView((view) => insertCallout(view, "warning")) },
                  { icon: "ti ti-alert-hexagon", label: t().danger, action: withView((view) => insertCallout(view, "danger")) },
                ],
              },
              {
                sectionLabel: t().misc,
                items: [
                  { icon: "ti ti-table", label: t().table, action: withView((view) => insertTable(view, undefined, locale())) },
                  { icon: "ti ti-code-plus", label: t().codeBlock, action: withView(insertCodeBlock) },
                  {
                    icon: "ti ti-code",
                    label: t().inlineCode,
                    description: keys("Mod-e"),
                    action: withView((view) => toggleInlineMark(view, "code")),
                  },
                ],
              },
            ]}
          >
            <Dropdown.Trigger iconOnly label={t().moreInsert} size="xs" class="text-dimmed" tooltip={t().moreInsert}>
              <i class="ti ti-dots text-sm" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </Toolbar.Group>
      </Toolbar>

      <Show when={showDisconnected()}>
        <span class="flex shrink-0 items-center gap-1 text-xs" role="status">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          {t().reconnecting}
        </span>
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
      <Btn
        icon={panelOpen() ? "ti-layout-sidebar-right-collapse" : "ti-layout-sidebar-right-expand"}
        title={panelOpen() ? t().collapseDetails : t().expandDetails}
        onClick={toggleDetailPanel}
      />
    </div>
  );
}
