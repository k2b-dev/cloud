import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEffect, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Button } from "../actions/Button";
import { Dropdown, type DropdownAction, type DropdownItem } from "../actions/Dropdown";
import { SegmentedControl } from "../actions/SegmentedControl";
import { Toolbar } from "../actions/Toolbar";
import { Kbd } from "../content/Kbd";
import { useLocale } from "../intl/locale";
import { formatShortcut, type KeyboardPlatform, keyboardPlatform } from "../intl/shortcut";
import { createTextEditor, type TextEditorController, type TextEditorMode } from "./engine";
import { commands, formatLabels, type InlineFormat } from "./format";
import { findTables } from "./markdown-table";
import { textEditorMessages } from "./messages";
import { formatActiveCell, type MenuAction, runMenuAction, runTableAction, type TableHost } from "./table";

export type TextEditorProps = {
  label: string;
  initialValue?: string;
  mode?: TextEditorMode;
  onModeChange?: (mode: TextEditorMode) => void;
  readOnly?: boolean;
  loading?: boolean;
  placeholder?: string;
  extensions?: Extension;
  /** Collaboration supplies history and server-owned structure here. */
  host?: Pick<TableHost, "structure" | "renderCell" | "onCellSelection"> & Partial<Pick<TableHost, "undo" | "redo" | "boundary">>;
  maxLength: number;
  maxPasteCells?: number;
  onChange?: (text: string) => void;
  onReady?: (editor: TextEditorController) => void;
  onDroppedImages?: (count: number, files: File[]) => void;
  onTableCheck?: (needsCheck: boolean) => void;
  /** Host-owned sync status; its place is reserved across transitions. */
  status?: JSX.Element;
  class?: string;
};

const toolbar = [
  ["bold", "bold"],
  ["italic", "italic"],
  ["heading", "heading"],
  ["bulletList", "list"],
  ["orderedList", "list-numbers"],
  ["quote", "quote"],
  ["link", "link"],
  ["code", "code"],
  ["table", "table"],
  ["rule", "separator"],
] as const;
const actionIcons = {
  rowAbove: "row-insert-top",
  rowBelow: "row-insert-bottom",
  colLeft: "column-insert-left",
  colRight: "column-insert-right",
  alignLeft: "align-left",
  alignCenter: "align-center",
  alignRight: "align-right",
  deleteRow: "row-remove",
  deleteCol: "column-remove",
} as const;
const isInlineCommand = (command: string): command is InlineFormat => inlineCommands.has(command);
const shortcuts: Partial<Record<keyof typeof commands, string>> = { bold: "mod+b", italic: "mod+i", link: "mod+k" };
const inlineCommands = new Set<string>(["bold", "italic", "code", "link", "strike"]);

/** A Markdown text field with app-injected collaboration and a directly editable table view. */
export function TextEditor(props: TextEditorProps) {
  const locale = useLocale();
  const t = () => textEditorMessages.resolve([locale()]).t;
  const [mode, setMode] = createSignal<TextEditorMode>(props.mode ?? "formatted");
  const [ready, setReady] = createSignal(false);
  const [recovery, setRecovery] = createSignal<string>();
  const [notice, setNotice] = createSignal<string>();
  const [cell, setCell] = createSignal<HTMLElement>();
  const [check, setCheck] = createSignal(false);
  const [active, setActive] = createSignal(false);
  const [documentRevision, setDocumentRevision] = createSignal(0);
  const [platform, setPlatform] = createSignal<KeyboardPlatform>("other");
  let menuOpen = false;
  let floatingTrigger: HTMLButtonElement | undefined;
  let tableTrigger: HTMLButtonElement | undefined;
  let frame = 0;
  const [menuPosition, setMenuPosition] = createSignal({ left: "0px", top: "0px" });
  let root!: HTMLDivElement;
  let mount!: HTMLDivElement;
  let editor: TextEditorController | undefined;
  const blocked = () => !!props.readOnly || !!props.loading || !ready() || recovery() !== undefined;
  const updateCheck = () => {
    const needsCheck = findTables(editor?.view.state.doc.toString() ?? props.initialValue ?? "").some((table) =>
      table.lines.some((row) => row.cells.length > table.columns),
    );
    setCheck(needsCheck);
    props.onTableCheck?.(needsCheck);
  };
  const positionMenu = () => {
    const target = cell();
    if (!target) return;
    const wrap = target.closest<HTMLElement>(".ste-table");
    const table = wrap?.querySelector("table");
    if (!target.isConnected || !wrap || !table || mode() !== "formatted") {
      menuOpen = false;
      setCell(undefined);
      checkFocus();
      return;
    }
    const rect = target.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    const right = Math.min(table.getBoundingClientRect().right, wrap.getBoundingClientRect().right);
    setMenuPosition({ left: `${right - bounds.left + 6}px`, top: `${rect.top - bounds.top + (rect.height - 24) / 2}px` });
  };
  const schedulePosition = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        positionMenu();
      });
  };
  const unavailable = () => !!props.host?.structure && !props.host.structure.available();
  const actionDisabled = (action: MenuAction) =>
    blocked() ||
    !cell()?.isConnected ||
    (action === "deleteRow" && cell()?.dataset.r === "0") ||
    (action === "deleteCol" && (cell()?.closest("table")?.querySelector("tr")?.children.length ?? 0) <= 1) ||
    (unavailable() && !(action === "rowBelow" && Number(cell()?.dataset.r) === (cell()?.closest("table")?.rows.length ?? 0) - 1));
  const runAction = (action: MenuAction) => {
    const wrap = cell()?.closest<HTMLElement>(".ste-table");
    if (editor && wrap && !actionDisabled(action)) runMenuAction(editor.view, wrap, action);
  };
  const actionItem = (action: keyof typeof actionIcons) =>
    ({
      label: t()[action],
      icon: `ti ti-${actionIcons[action]}`,
      disabled: actionDisabled(action),
      trailing: action === "rowBelow" ? <Kbd keys="enter" /> : undefined,
      variant: action === "deleteRow" || action === "deleteCol" ? "danger" : undefined,
      action: () => runAction(action),
    }) satisfies DropdownAction;
  const items = (): DropdownItem[] => {
    documentRevision();
    const column = Number(cell()?.dataset.c ?? 0);
    const align = cell()?.parentElement?.style.textAlign || "left";
    return [
      {
        sectionLabel: unavailable() ? t().structureUnavailable : undefined,
        items: (["rowAbove", "rowBelow", "colLeft", "colRight"] as const).map(actionItem),
      },
      {
        sectionLabel: t().columnAlignment(column + 1),
        layout: "row",
        items: (["alignLeft", "alignCenter", "alignRight"] as const).map((action, index) => ({
          ...actionItem(action),
          choice: "radio" as const,
          class: "ste-align-choice",
          ariaLabel: t()[action],
          checked: align === ["left", "center", "right"][index],
        })),
      },
      { items: [actionItem("deleteRow"), actionItem("deleteCol")] },
    ];
  };
  const preserveSelection = (event: MouseEvent) => event.preventDefault();
  const menuChange = (open: boolean) => {
    menuOpen = open;
  };
  const menuClose = () => {
    menuOpen = false;
    queueMicrotask(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches(".ste-cell-menu, .ste-table-tool")) cell()?.focus();
      checkFocus();
    });
  };
  const menu = (floating: boolean) => (
    <Dropdown
      items={items()}
      phone="sheet"
      position={floating ? "right-start" : "bottom-right"}
      width="236px"
      label={t().tableMenu}
      disabled={blocked() || !cell()?.isConnected}
      onOpenChange={menuChange}
      onClose={menuClose}
    >
      <Dropdown.Trigger
        ref={(element) => {
          if (floating) floatingTrigger = element;
          else tableTrigger = element;
        }}
        class={floating ? "ste-cell-menu" : "ste-tool ste-table-tool"}
        variant="ghost"
        size="sm"
        iconOnly
        label={t().tableMenu}
        aria-pressed={!floating ? true : undefined}
        onMouseDown={preserveSelection}
      >
        <i class={`ti ti-${floating ? "dots" : "table"}`} aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown>
  );
  const runFormat = (command: keyof typeof commands) => {
    if (!editor || blocked()) return;
    if (cell()?.isConnected && isInlineCommand(command) && formatActiveCell(editor.view, command)) return;
    commands[command](editor.view);
  };
  const checkFocus = () => {
    if (menuOpen) return;
    const focused = document.activeElement;
    const inside = focused instanceof Node && root.contains(focused);
    setActive(inside);
    if (!inside || focused === editor?.view.contentDOM) setCell(undefined);
    else if (!cell()?.isConnected) setCell(undefined);
  };
  const formatMenu = (command: "heading" | "code") => (
    <Dropdown
      phone="sheet"
      label={t()[command]}
      disabled={blocked() || (command === "heading" && !!cell())}
      onOpenChange={menuChange}
      onClose={menuClose}
      items={
        command === "heading"
          ? [
              {
                items: (["heading1", "heading2", "heading3"] as const).map((name, index) => ({
                  label: t()[name],
                  icon: `ti ti-h-${index + 1}`,
                  action: () => runFormat(name),
                })),
              },
            ]
          : [
              { label: t().inlineCode, icon: "ti ti-code", action: () => runFormat("code") },
              { label: t().codeBlock, icon: "ti ti-source-code", disabled: !!cell(), action: () => runFormat("codeBlock") },
              { label: t().strike, icon: "ti ti-strikethrough", trailing: <Kbd keys="mod+shift+x" />, action: () => runFormat("strike") },
            ]
      }
    >
      <Dropdown.Trigger class="ste-tool" variant="ghost" size="sm" iconOnly label={t()[command]} onMouseDown={preserveSelection}>
        <i class={`ti ti-${command}`} aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown>
  );
  const selectMode = (next: TextEditorMode) => {
    const restoreEditorFocus = !!editor?.view.contentDOM.contains(document.activeElement);
    menuOpen = false;
    setCell(undefined);
    setMode(next);
    props.onModeChange?.(next);
    if (restoreEditorFocus) queueMicrotask(() => editor?.view.focus());
  };
  onMount(() => {
    setPlatform(keyboardPlatform());
    editor = createTextEditor({
      parent: mount,
      doc: props.initialValue,
      mode: mode(),
      label: props.label,
      readOnly: props.readOnly,
      placeholder: props.placeholder,
      extensions: [
        formatLabels.of({
          get link() {
            return t().link;
          },
          column: (column) => t().column(column),
        }),
        EditorView.updateListener.of((update) => {
          schedulePosition();
          if (update.docChanged) queueMicrotask(() => setDocumentRevision((revision) => revision + 1));
        }),
        props.extensions ?? [],
      ],
      host: {
        ...props.host,
        cellLabel: (row, column) => t().cellLabel({ row, column }),
        maxLength: props.maxLength,
        maxPasteCells: props.maxPasteCells ?? 2000,
        onRecovery: (text) => setRecovery((previous) => (previous === undefined ? text : `${previous}\n\n${text}`)),
        onError: (code) => setNotice(t()[code]),
      },
      onChange: (text) => {
        props.onChange?.(text);
        queueMicrotask(updateCheck);
      },
      onDroppedImages: (count, files) => {
        setNotice(t().imageHint);
        props.onDroppedImages?.(count, files);
      },
    });
    const focus = (event: Event) => {
      if (!(event instanceof CustomEvent) || !(event.detail.cell instanceof HTMLElement)) return;
      setActive(true);
      setCell(event.detail.cell);
      positionMenu();
    };
    const focusChange = () => queueMicrotask(checkFocus);
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.contains(event.target)) setActive(true);
      else if (!menuOpen) {
        setActive(false);
        setCell(undefined);
      }
    };
    const keyboardMenu = (event: Event) => {
      if (blocked()) return;
      focus(event);
      queueMicrotask(() => {
        if (!cell()?.isConnected) return;
        const trigger = window.matchMedia("(max-width: 47.999rem)").matches ? tableTrigger : floatingTrigger;
        trigger?.click();
      });
    };
    const mutations = new MutationObserver(schedulePosition);
    mutations.observe(mount, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(schedulePosition);
    resize.observe(mount);
    // Safari blurs a contenteditable on mouse-down without focusing the radio.
    // Keep the caret and phone toolbar stationary until the view switch runs.
    const viewMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".ste-views")) event.preventDefault();
    };
    root.addEventListener("mousedown", viewMouseDown);
    document.addEventListener("focusin", focusChange);
    document.addEventListener("pointerdown", pointer);
    root.addEventListener("ste-cell-focus", focus);
    root.addEventListener("ste-cell-blur", focusChange);
    root.addEventListener("ste-cell-menu", keyboardMenu);
    window.addEventListener("scroll", schedulePosition, true);
    window.addEventListener("resize", schedulePosition);
    const viewport = window.visualViewport;
    const keyboard = () =>
      root.style.setProperty(
        "--ste-keyboard",
        `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`,
      );
    viewport?.addEventListener("resize", keyboard);
    viewport?.addEventListener("scroll", keyboard);
    keyboard();
    setReady(true);
    updateCheck();
    props.onReady?.(editor);
    onCleanup(() => {
      mutations.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
      root.removeEventListener("mousedown", viewMouseDown);
      document.removeEventListener("focusin", focusChange);
      document.removeEventListener("pointerdown", pointer);
      root.removeEventListener("ste-cell-focus", focus);
      root.removeEventListener("ste-cell-blur", focusChange);
      root.removeEventListener("ste-cell-menu", keyboardMenu);
      window.removeEventListener("scroll", schedulePosition, true);
      window.removeEventListener("resize", schedulePosition);
      viewport?.removeEventListener("resize", keyboard);
      viewport?.removeEventListener("scroll", keyboard);
      editor?.destroy();
    });
  });
  createEffect(() => {
    if (props.mode !== undefined) setMode(props.mode);
  });
  createEffect(() => {
    if (ready()) {
      menuOpen = false;
      setCell(undefined);
      editor?.setMode(mode());
    }
  });
  createEffect(() => {
    if (ready()) editor?.setReadOnly(!!props.readOnly || !!props.loading || recovery() !== undefined);
  });
  return (
    <div
      ref={root}
      class={`k2b-text-editor ${props.class ?? ""}`}
      data-mode={mode()}
      data-active={active() ? "true" : undefined}
      aria-busy={props.loading || !ready()}
    >
      <div class="ste-status" role="status">
        <span>{props.status}</span>
        <Show when={check()}>
          <span class="ste-check" title={t().checkTableDetail}>
            <i class="ti ti-alert-triangle" aria-hidden="true" />
            {t().checkTable}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={blocked() || unavailable()}
            tooltip={unavailable() ? t().structureUnavailable : t().checkTableDetail}
            onMouseDown={preserveSelection}
            onClick={() => {
              if (!editor) return;
              const table = findTables(editor.view.state.doc.toString()).find((table) =>
                table.lines.some((row) => row.cells.length > table.columns),
              );
              if (table) runTableAction(editor.view, table.from, 0, 0, "completeColumns");
            }}
          >
            {t().completeColumns}
          </Button>
        </Show>
      </div>
      <Show when={mode() !== "plain"}>
        <Toolbar class="ste-toolbar" label={t().formatting}>
          <For each={[toolbar.slice(0, 3), toolbar.slice(3, 6), toolbar.slice(6)]}>
            {(group) => (
              <Toolbar.Group class="ste-tool-group">
                <For each={group}>
                  {([command, icon]) =>
                    command === "heading" || command === "code" ? (
                      formatMenu(command)
                    ) : (
                      <Show
                        when={command === "table" && mode() === "formatted" && cell()?.isConnected}
                        fallback={
                          <Button
                            class="ste-tool"
                            variant="ghost"
                            size="sm"
                            aria-label={t()[command]}
                            tooltip={
                              shortcuts[command]
                                ? `${t()[command]} (${formatShortcut(shortcuts[command] ?? "", { platform: platform(), locale: locale() }).label})`
                                : t()[command]
                            }
                            disabled={blocked() || (!!cell() && !inlineCommands.has(command) && command !== "table")}
                            onMouseDown={preserveSelection}
                            onClick={() => runFormat(command)}
                          >
                            <i class={`ti ti-${icon}`} aria-hidden="true" />
                          </Button>
                        }
                      >
                        {menu(false)}
                      </Show>
                    )
                  }
                </For>
              </Toolbar.Group>
            )}
          </For>
          <SegmentedControl
            class="ste-views"
            size="sm"
            ariaLabel={t().view}
            value={mode() === "source" ? "source" : "formatted"}
            options={[
              { value: "formatted", label: t().formatted, icon: "ti ti-typography" },
              { value: "source", label: t().source, icon: "ti ti-markdown" },
            ]}
            onValueChange={selectMode}
          />
        </Toolbar>
      </Show>
      <Show when={props.loading || !ready()}>
        <div class="ste-loading" role="status" aria-label={t().loading}>
          <For each={[82, 100, 68, 0, 96, 74]}>
            {(width) => (
              <div>
                <span style={{ width: `${width}%` }} />
              </div>
            )}
          </For>
        </div>
      </Show>
      <div ref={mount} class="ste-host" hidden={props.loading || !ready()} />
      <Show when={cell() && mode() === "formatted" && !blocked()}>
        <div class="ste-floating-menu" style={menuPosition()}>
          {menu(true)}
        </div>
      </Show>
      <div class="ste-notice-region" role="status" aria-live="polite" aria-atomic="true">
        <Show when={notice() || recovery() !== undefined}>
          <div class="ste-notice">
            <div class="ste-notice-content">
              <Show when={notice()}>
                <span>{notice()}</span>
              </Show>
              <Show when={recovery() !== undefined}>
                <label class="ste-recovery-label">
                  {t().recoveredInput}
                  <textarea class="ste-recovery" readOnly value={recovery()} />
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRecovery(undefined);
                    if (notice() === t().cellRemoved) setNotice(undefined);
                  }}
                >
                  {t().discardRecovery}
                </Button>
              </Show>
            </div>
            <Show when={notice()}>
              <Button size="sm" variant="ghost" aria-label={t().dismiss} onClick={() => setNotice(undefined)}>
                <i class="ti ti-x" aria-hidden="true" />
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
