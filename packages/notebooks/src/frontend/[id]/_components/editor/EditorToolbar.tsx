import { Prec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { keymap } from "@codemirror/view";
import { Dropdown, IconButton, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { requestNotebookSearch } from "../../../lib/hotkeys";
import { DETAIL_PANEL_STATE_EVENT, DETAIL_PANEL_TOGGLE_EVENT } from "../detail/events";
import { openAttachmentPicker } from "./AttachmentPicker";
import { cycleHeading, insertCallout, insertLinePrefix, insertLink, insertNoteLink, insertTable, wrapSelection } from "./editor-actions";
import { notebookWorkspaceMessages } from "../../messages";

type Props = {
  connected: boolean;
  editorView: EditorView | undefined;
  notebookId: string;
  /** Initial open state for the detail panel — kept in sync at runtime via
   *  `DETAIL_PANEL_STATE_EVENT`. Used to seed the toggle button's icon so SSR
   *  output matches the eventual hydrated state (no flicker). */
  initialPanelOpen: boolean;
};

/* ── Formatting keymap (Ctrl/Cmd shortcuts) ────────────── */

export function formattingKeymap(opts: { notebookId: string }) {
  return Prec.high(
    keymap.of([
      {
        key: "Mod-Shift-k",
        run: () => {
          requestNotebookSearch();
          return true;
        },
      },
      {
        key: "Mod-b",
        run: (view) => {
          wrapSelection(view, "**");
          return true;
        },
      },
      {
        key: "Mod-i",
        run: (view) => {
          wrapSelection(view, "_");
          return true;
        },
      },
      {
        key: "Mod-Shift-s",
        run: (view) => {
          wrapSelection(view, "~~");
          return true;
        },
      },
      {
        key: "Mod-e",
        run: (view) => {
          wrapSelection(view, "`");
          return true;
        },
      },
      {
        key: "Mod-k",
        run: (view) => {
          insertLink(view);
          return true;
        },
      },
      {
        key: "Mod-Alt-k",
        run: (view) => {
          void insertNoteLink(view, opts.notebookId);
          return true;
        },
      },
      {
        key: "Mod-Shift-h",
        run: (view) => {
          cycleHeading(view);
          return true;
        },
      },
    ]),
  );
}

/* ── Component ─────────────────────────────────────────── */

export default function EditorToolbar(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const withView = (action: (view: EditorView) => void) => () => {
    if (props.editorView) action(props.editorView);
  };

  const bold = withView((v) => wrapSelection(v, "**"));
  const italic = withView((v) => wrapSelection(v, "_"));
  const strikethrough = withView((v) => wrapSelection(v, "~~"));
  const inlineCode = withView((v) => wrapSelection(v, "`"));
  const heading = withView(cycleHeading);
  const link = withView((v) => insertLink(v, locale()));
  const linkToNote = withView((v) => void insertNoteLink(v, props.notebookId, locale()));
  const bulletList = withView((v) => insertLinePrefix(v, "- "));
  const numberedList = withView((v) => insertLinePrefix(v, "1. "));
  const checkbox = withView((v) => insertLinePrefix(v, "- [ ] "));
  const callout = (type: string) => withView((v) => insertCallout(v, type));
  const table = withView((v) => void insertTable(v, undefined, locale()));

  const [panelOpen, setPanelOpen] = createSignal(props.initialPanelOpen);
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
      const detail = (event as CustomEvent<{ isOpen: boolean }>).detail;
      if (typeof detail?.isOpen === "boolean") setPanelOpen(detail.isOpen);
    };
    window.addEventListener(DETAIL_PANEL_STATE_EVENT, handler);
    onCleanup(() => {
      clearTimeout(disconnectedTimer);
      window.removeEventListener(DETAIL_PANEL_STATE_EVENT, handler);
    });
  });

  const toggleDetailPanel = () => window.dispatchEvent(new CustomEvent(DETAIL_PANEL_TOGGLE_EVENT));

  const Btn = (p: { icon: string; title: string; onClick: () => void }) => (
    <Tooltip.Anchor content={p.title}>
      <IconButton label={p.title} size="xs" onClick={p.onClick} class="text-dimmed">
        <i class={`ti ${p.icon} text-sm`} />
      </IconButton>
    </Tooltip.Anchor>
  );

  return (
    <div class="mt-1 flex min-w-0 items-center gap-2 px-2 py-2 text-base text-dimmed">
      <div class="no-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        <Btn icon="ti-bold" title={t().bold} onClick={bold} />
        <Btn icon="ti-italic" title={t().italic} onClick={italic} />
        <Btn icon="ti-strikethrough" title={t().strikethrough} onClick={strikethrough} />
        <Btn icon="ti-heading" title={t().heading} onClick={heading} />
        <Btn icon="ti-link" title={t().link} onClick={link} />
        <Btn icon="ti-file-symlink" title={t().linkToNoteShortcut} onClick={linkToNote} />
        <Btn icon="ti-paperclip" title={t().attachFile} onClick={() => void openAttachmentPicker(props.notebookId, locale())} />

        <Dropdown.Root
          position="top-right"
          width="13rem"
          items={[
            {
              sectionLabel: t().lists,
              items: [
                { icon: "ti ti-list", label: t().bulletList, action: bulletList },
                { icon: "ti ti-list-numbers", label: t().numberedList, action: numberedList },
                { icon: "ti ti-checkbox", label: t().checkbox, action: checkbox },
              ],
            },
            {
              sectionLabel: t().blocks,
              items: [
                { icon: "ti ti-chevron-right", label: t().note, action: callout("note") },
                { icon: "ti ti-info-circle", label: t().info, action: callout("info") },
                { icon: "ti ti-check", label: t().success, action: callout("success") },
                { icon: "ti ti-alert-circle", label: t().warning, action: callout("warning") },
                { icon: "ti ti-alert-hexagon", label: t().danger, action: callout("danger") },
              ],
            },
            {
              sectionLabel: t().misc,
              items: [
                { icon: "ti ti-table", label: t().table, action: table },
                { icon: "ti ti-code", label: t().inlineCode, action: inlineCode },
              ],
            },
          ]}
        >
          <Dropdown.Trigger iconOnly label={t().insertContent} size="xs" class="text-dimmed" tooltip={t().insertContent}>
            <i class="ti ti-layout-grid-add text-sm" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </div>

      <Show when={showDisconnected()}>
        <span class="flex shrink-0 items-center gap-1 text-xs" role="status">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          {t().reconnecting}
        </span>
      </Show>

      {/* Detail panel toggle */}
      <Btn
        icon={panelOpen() ? "ti-layout-sidebar-right-collapse" : "ti-layout-sidebar-right-expand"}
        title={panelOpen() ? t().collapseDetails : t().expandDetails}
        onClick={toggleDetailPanel}
      />
    </div>
  );
}
