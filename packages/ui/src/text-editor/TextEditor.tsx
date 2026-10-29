import { history, historyKeymap, redo, undo } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { clipboard } from "@k2b/stdlib/solid";
import { createEffect, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { Button, IconButton } from "../actions/Button";
import { Dropdown, type DropdownAction, type DropdownChoice, type DropdownItem, type DropdownPosition } from "../actions/Dropdown";
import { SegmentedControl } from "../actions/SegmentedControl";
import { Toolbar } from "../actions/Toolbar";
import { Kbd } from "../content/Kbd";
import { dialogCore } from "../feedback/dialog-core";
import { NumberInput } from "../inputs/NumberInput";
import { LocaleProvider, useLocale } from "../intl/locale";
import { formatShortcut, type KeyboardPlatform, keyboardPlatform } from "../intl/shortcut";
import BottomSheet, { bottomSheetAdaptiveOptions } from "../layout/BottomSheet";
import { createTextEditor, type TextEditorController, type TextEditorMode, type TextEditorOptions } from "./engine";
import { commands, formatLabels, type InlineFormat } from "./format";
import { findTables, inspectTableStructure } from "./markdown-table";
import { textEditorMessages } from "./messages";
import {
  copyTable,
  editTableSource,
  formatActiveCell,
  type MenuAction,
  runMenuAction,
  runTableAction,
  type TableHost,
  tableActionEnabled,
} from "./table";

export type TextEditorProps = {
  label: string;
  initialValue?: string;
  mode?: TextEditorMode;
  onModeChange?: (mode: TextEditorMode) => void;
  readOnly?: boolean;
  loading?: boolean;
  placeholder?: string;
  extensions?: Extension;
  /** Host-owned Markdown presentation; see `createTextEditor`. The host then also styles the editor surface. */
  presentation?: TextEditorOptions["presentation"];
  /** `false` when the host renders its own formatting toolbar and mode control; place `controls.TableMenu` in it. */
  toolbar?: boolean;
  /** Collaboration supplies history and server-owned structure here. */
  host?: Pick<TableHost, "structure" | "renderCell" | "onCellSelection" | "tabMovesFocus"> &
    Partial<Pick<TableHost, "undo" | "redo" | "boundary">>;
  maxLength: number;
  maxPasteCells?: number;
  onChange?: (text: string) => void;
  onReady?: (editor: TextEditorController, controls: TextEditorControls) => void;
  /** Return `true` when the host attached the images itself; otherwise the editor shows its attachment hint. */
  onDroppedImages?: (count: number, files: File[]) => boolean | void;
  /** Opens the host's attachment picker when clipboard images cannot be inserted. */
  onAttachImages?: () => void;
  onTableCheck?: (needsCheck: boolean) => void;
  /** Host-owned sync status; its place is reserved across transitions. */
  status?: JSX.Element;
  class?: string;
};

export type TableSizePickerProps = {
  maxRows: number;
  maxColumns: number;
  onPick: (size: { rows: number; columns: number }) => void;
  /** Share this picker with slash commands or secondary menus. */
  onReady?: (open: () => void) => void;
  disabled?: boolean;
  class?: string;
  size?: "xs" | "sm";
};

/** Shared table-size control: pointer grid on desktop, large fields in a phone sheet. */
export function TableSizePicker(props: TableSizePickerProps) {
  const locale = useLocale();
  const t = () => textEditorMessages.resolve([locale()]).t;
  const [rows, setRows] = createSignal<number | null>(3);
  const [columns, setColumns] = createSignal<number | null>(3);
  const [expanded, setExpanded] = createSignal(false);
  const id = createUniqueId();
  const abort = new AbortController();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    abort.abort();
  });
  let trigger!: HTMLButtonElement;
  let popup!: HTMLDivElement;
  const reset = () => {
    setRows(Math.min(3, props.maxRows));
    setColumns(Math.min(3, props.maxColumns));
  };
  const choose = (r: number, c: number) => {
    popup.hidePopover();
    if (!disposed && !props.disabled) props.onPick({ rows: r, columns: c });
  };
  const open = async () => {
    if (disposed || props.disabled || expanded()) return;
    reset();
    if (!window.matchMedia("(max-width: 47.999rem)").matches) {
      popup.showPopover();
      const anchor = trigger.getBoundingClientRect(),
        box = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8))}px`;
      popup.style.top = `${Math.max(8, anchor.top > box.height + 8 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, innerHeight - box.height - 8))}px`;
      popup.focus();
      return;
    }
    setExpanded(true);
    const chosen = await dialogCore.open<{ rows: number; columns: number }>(
      (close, context) => (
        <LocaleProvider locale={locale()}>
          <BottomSheet onDismiss={context.requestDismiss}>
            <BottomSheet.Header title={t().insertTable} close={context.requestDismiss} />
            <BottomSheet.Body>
              <div class="k2b-ste-size-picker">
                <NumberInput label={t().rows} value={rows()} onValueChange={setRows} min={1} max={props.maxRows} step={1} />
                <NumberInput label={t().columns} value={columns()} onValueChange={setColumns} min={1} max={props.maxColumns} step={1} />
              </div>
            </BottomSheet.Body>
            <BottomSheet.Footer>
              <Button
                disabled={!rows() || !columns()}
                onClick={() => {
                  const r = rows(),
                    c = columns();
                  if (r && c) close({ rows: r, columns: c });
                }}
              >
                {t().insertSize({ rows: rows() ?? 0, columns: columns() ?? 0 })}
              </Button>
            </BottomSheet.Footer>
          </BottomSheet>
        </LocaleProvider>
      ),
      { ...bottomSheetAdaptiveOptions, ariaLabel: t().insertTable, history: true, signal: abort.signal },
    );
    setExpanded(false);
    if (chosen && !disposed && !props.disabled) props.onPick(chosen);
  };
  onMount(() => props.onReady?.(() => void open()));
  const keyboard = (event: KeyboardEvent) => {
    const directions: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      setRows(Math.max(1, Math.min(Math.min(9, props.maxRows), (rows() ?? 1) + direction[0])));
      setColumns(Math.max(1, Math.min(Math.min(10, props.maxColumns), (columns() ?? 1) + direction[1])));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(rows() ?? 1, columns() ?? 1);
    } else if (event.key === "Escape") trigger.focus();
  };
  return (
    <>
      <IconButton
        ref={trigger}
        variant="ghost"
        class={props.class}
        size={props.size ?? "sm"}
        disabled={props.disabled}
        label={t().insertTable}
        aria-haspopup="dialog"
        aria-controls={id}
        aria-expanded={expanded()}
        tooltip={t().insertTable}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void open()}
      >
        <i class="ti ti-table" aria-hidden="true" />
      </IconButton>
      <div
        ref={popup}
        id={id}
        popover="auto"
        class="k2b-ste-size-popover"
        role="dialog"
        aria-label={t().insertTable}
        tabIndex={-1}
        onKeyDown={keyboard}
        on:toggle={() => setExpanded(popup.matches(":popover-open"))}
      >
        <div class="k2b-ste-size-grid" role="group" aria-label={t().insertTable}>
          <For each={Array.from({ length: Math.min(9, props.maxRows) }, (_, index) => index + 1)}>
            {(r) => (
              <div class="k2b-ste-size-row">
                <For each={Array.from({ length: Math.min(10, props.maxColumns) }, (_, index) => index + 1)}>
                  {(c) => (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={t().insertSize({ rows: r, columns: c })}
                      data-selected={r <= (rows() ?? 0) && c <= (columns() ?? 0) ? "true" : undefined}
                      onPointerEnter={() => {
                        setRows(r);
                        setColumns(c);
                      }}
                      onClick={() => choose(r, c)}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <div class="k2b-ste-size-caption" role="status">
          {t().insertSize({ rows: rows() ?? 0, columns: columns() ?? 0 })}
        </div>
      </div>
    </>
  );
}

type TableMenuTrigger = { text?: string; class?: string; size?: "xs" | "sm"; position?: DropdownPosition };
/** Shared table controls for a host-owned toolbar (`toolbar={false}`). */
export type TextEditorControls = {
  /** A table cell has focus in the formatted view. */
  tableActive: () => boolean;
  /** The shared cell menu behind a host-styled trigger; on phones it opens as a sheet. */
  TableMenu: (props: TableMenuTrigger) => JSX.Element;
  /** Formats the focused cell's selection; `false` when no cell has focus. */
  formatCell: (format: InlineFormat) => boolean;
  /** Shows a host message, such as a server's reason for a rejected table action, in the editor's notice. */
  notify: (message: string) => void;
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
  moveRowUp: "arrow-up",
  moveRowDown: "arrow-down",
  moveColLeft: "arrow-left",
  moveColRight: "arrow-right",
  toggleHeader: "table-row",
  deleteTable: "trash",
} as const;
const isInlineCommand = (command: string): command is Extract<InlineFormat, string> => inlineCommands.has(command);
const shortcuts: Partial<Record<keyof typeof commands, string>> = { bold: "mod+b", italic: "mod+i", link: "mod+k" };
const inlineCommands = new Set<string>(["bold", "italic", "code", "link", "strike"]);

/** A Markdown text field with app-injected collaboration and a directly editable table view. */
export function TextEditor(props: TextEditorProps) {
  const locale = useLocale();
  const t = () => textEditorMessages.resolve([locale()]).t;
  const [mode, setMode] = createSignal<TextEditorMode>(props.mode ?? "formatted");
  const [ready, setReady] = createSignal(false);
  const [recovery, setRecovery] = createSignal<string>();
  const [notice, setNotice] = createSignal<{ message: string; images?: boolean }>();
  const [cell, setCell] = createSignal<HTMLElement>();
  const [localSource, setLocalSource] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal("");
  const [check, setCheck] = createSignal(false);
  const [missingSeparator, setMissingSeparator] = createSignal(false);
  const [active, setActive] = createSignal(false);
  const [documentRevision, setDocumentRevision] = createSignal(0);
  const [phoneMenu, setPhoneMenu] = createSignal(false);
  const [platform, setPlatform] = createSignal<KeyboardPlatform>("other");
  createEffect(() => {
    const target = cell();
    target?.setAttribute("data-active", "");
    onCleanup(() => target?.removeAttribute("data-active"));
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    const text = recovery();
    if (text !== undefined) detachedRecovery(text);
  });
  // A local draft can outlive an island during navigation. Keep its recovery
  // surface in the shared dialog root so disposal never silently drops it.
  const detachedRecovery = (text: string) => {
    const language = locale();
    const labels = t();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    const show = () =>
      void dialogCore
        .open<"discard">(
          (close, context) => {
            context.setDismissHandler(() => {});
            return (
              <LocaleProvider locale={language}>
                <BottomSheet handle={false} onDismiss={() => {}}>
                  <BottomSheet.Header title={labels.recoveredInput} />
                  <BottomSheet.Body>
                    <label class="k2b-ste-recovery-label">
                      {labels.recoveredInput}
                      <textarea class="k2b-ste-recovery" readOnly value={text} />
                    </label>
                  </BottomSheet.Body>
                  <BottomSheet.Footer>
                    <Button variant="ghost" onClick={() => close("discard")}>
                      {labels.discardRecovery}
                    </Button>
                  </BottomSheet.Footer>
                </BottomSheet>
              </LocaleProvider>
            );
          },
          { ...bottomSheetAdaptiveOptions, ariaLabel: labels.recoveredInput },
        )
        .then((result) => {
          if (result === "discard") window.removeEventListener("beforeunload", beforeUnload);
          // The shared dialog root closes on each island disposal. Retain the
          // draft across subsequent navigation until the person explicitly discards it.
          else queueMicrotask(show);
        });
    show();
  };
  let menuOpen = false;
  let pointerAnchor: { left: string; top: string } | undefined;
  let floatingTrigger: HTMLButtonElement | undefined;
  const tableTriggers = new Set<HTMLButtonElement>();
  let frame = 0;
  const [menuPosition, setMenuPosition] = createSignal({ left: "0px", top: "0px" });
  let root!: HTMLDivElement;
  let mount!: HTMLDivElement;
  let editor: TextEditorController | undefined;
  const menuBlocked = () => !!props.loading || !ready() || recovery() !== undefined;
  const blocked = () => !!props.readOnly || menuBlocked();
  const updateCheck = () => {
    const issue =
      mode() === "plain"
        ? { extraCells: false, missingSeparator: false }
        : inspectTableStructure(editor?.view.state.doc.toString() ?? props.initialValue ?? "");
    const needsCheck = issue.extraCells || issue.missingSeparator;
    setMissingSeparator(issue.missingSeparator);
    setCheck(needsCheck);
    props.onTableCheck?.(needsCheck);
  };
  const positionMenu = () => {
    const target = cell();
    if (!target) return;
    const wrap = target.closest<HTMLElement>(".k2b-ste-table");
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
    const position = props.readOnly
      ? {
          left: `${wrap.getBoundingClientRect().left - bounds.left}px`,
          top: `${wrap.getBoundingClientRect().bottom - bounds.top - (window.matchMedia("(max-width: 47.999rem)").matches ? 44 : 0)}px`,
        }
      : { left: `${right - bounds.left - 24}px`, top: `${rect.top - bounds.top + (rect.height - 24) / 2}px` };
    setMenuPosition(pointerAnchor ?? position);
  };
  const schedulePosition = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        positionMenu();
      });
  };
  const unavailable = () => !!props.host?.structure && !props.host.structure.available();
  const actionDisabled = (action: MenuAction) => {
    documentRevision();
    const wrap = cell()?.closest<HTMLElement>(".k2b-ste-table");
    return blocked() || !editor || !wrap || !tableActionEnabled(editor.view, wrap, action);
  };
  const isMove = (action: MenuAction) => action.startsWith("move");
  const runAction = (action: MenuAction) => {
    const wrap = cell()?.closest<HTMLElement>(".k2b-ste-table");
    const focused = document.activeElement;
    const menuElement = focused instanceof HTMLElement ? focused.closest<HTMLElement>('[role="menu"]') : null;
    if (editor && wrap && !actionDisabled(action)) runMenuAction(editor.view, wrap, action);
    // The phone move sheet remains usable for another move. Local structural
    // focus belongs to the cell only after the menu has closed.
    if (isMove(action) && focused instanceof HTMLElement && menuElement) {
      const restore = () => {
        if (disposed || !menuElement.isConnected) return;
        const target =
          focused.isConnected && !focused.matches(":disabled")
            ? focused
            : menuElement.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)');
        target?.focus({ preventScroll: true });
      };
      restore();
      queueMicrotask(restore);
    }
  };
  const moveKeys: Partial<Record<MenuAction, string>> = {
    moveRowUp: "alt+arrowup",
    moveRowDown: "alt+arrowdown",
    moveColLeft: "alt+arrowleft",
    moveColRight: "alt+arrowright",
  };
  const shortActionLabels = {
    rowAbove: "menuAbove",
    rowBelow: "menuBelow",
    moveRowUp: "menuUp",
    moveRowDown: "menuDown",
    deleteRow: "menuDelete",
    colLeft: "menuInsertLeft",
    colRight: "menuInsertRight",
    moveColLeft: "menuMoveLeft",
    moveColRight: "menuMoveRight",
    deleteCol: "menuDelete",
  } as const;
  const menuRow = () => {
    documentRevision();
    return t().menuRow(Number(cell()?.dataset.r ?? 0));
  };
  const menuColumn = () => {
    documentRevision();
    const column = Number(cell()?.dataset.c ?? 0);
    const header = cell()?.closest(".k2b-ste-table")?.querySelector<HTMLElement>(`.k2b-ste-cell[data-r="0"][data-c="${column}"]`);
    return t().menuColumn(header?.dataset.raw || t().column(column + 1));
  };
  const menuHeading = () => `${menuRow()} · ${menuColumn()}`;
  const actionItem = (action: keyof typeof actionIcons, choice?: Pick<DropdownChoice, "choice" | "checked" | "class" | "ariaLabel">) =>
    ({
      get label() {
        return phoneMenu() && action in shortActionLabels ? t()[shortActionLabels[action as keyof typeof shortActionLabels]] : t()[action];
      },
      icon: `ti ti-${actionIcons[action]}`,
      get disabled() {
        return actionDisabled(action);
      },
      immediate: true,
      trailing: moveKeys[action] ? <Kbd keys={moveKeys[action]!} /> : action === "rowBelow" ? <Kbd keys="enter" /> : undefined,
      variant: action === "deleteRow" || action === "deleteCol" || action === "deleteTable" ? "danger" : undefined,
      closeOnSelect: !isMove(action),
      action: () => runAction(action),
      ...choice,
    }) satisfies DropdownAction;
  const [copying, setCopying] = createSignal(false);
  const tableCopy = clipboard.createWriter({
    write: ({ view, wrap, format }: { view: EditorView; wrap: HTMLElement; format: "table" | "markdown" }) => copyTable(view, wrap, format),
  });
  const copy = async (format: "table" | "markdown") => {
    const wrap = cell()?.closest<HTMLElement>(".k2b-ste-table");
    if (!editor || !wrap || copying()) return;
    setCopying(true);
    setNotice({ message: t().copyingTable });
    const success = await tableCopy.copy({ view: editor.view, wrap, format });
    if (disposed) return;
    setCopying(false);
    setNotice({ message: success ? (format === "table" ? t().copiedTable : t().copiedMarkdown) : t().copyFailed });
  };
  const copyItems = (): DropdownAction[] => [
    {
      get label() {
        return phoneMenu() && !props.readOnly ? t().menuCopy : t().copyTable;
      },
      icon: "ti ti-copy",
      get disabled() {
        return copying();
      },
      immediate: true,
      action: () => {
        void copy("table");
      },
    },
    {
      get label() {
        return phoneMenu() && !props.readOnly ? t().menuMarkdown : t().copyMarkdown;
      },
      icon: "ti ti-markdown",
      get disabled() {
        return copying();
      },
      immediate: true,
      action: () => {
        void copy("markdown");
      },
    },
  ];
  const items = (): DropdownItem[] => {
    if (props.readOnly) return copyItems();
    const align = () => {
      documentRevision();
      return cell()?.parentElement?.style.textAlign || "left";
    };
    return [
      {
        get sectionLabel() {
          return menuHeading();
        },
        items: [],
      },
      {
        get sectionLabel() {
          return menuRow();
        },
        items: (["rowAbove", "rowBelow", "moveRowUp", "moveRowDown", "deleteRow"] as const).map((action) => actionItem(action)),
      },
      {
        get sectionLabel() {
          return menuColumn();
        },
        items: (["colLeft", "colRight", "moveColLeft", "moveColRight"] as const).map((action) => actionItem(action)),
      },
      {
        sectionLabel: t().alignment,
        layout: "row",
        items: (["alignLeft", "alignCenter", "alignRight"] as const).map((action, index) =>
          actionItem(action, {
            choice: "radio",
            class: "k2b-ste-align-choice",
            ariaLabel: t()[action],
            checked: () => align() === ["left", "center", "right"][index],
          }),
        ),
      },
      { items: [actionItem("deleteCol")] },
      {
        sectionLabel: t().table,
        items: [
          actionItem("toggleHeader", {
            choice: "checkbox",
            class: "k2b-ste-header-choice",
            checked: () => {
              documentRevision();
              return cell()?.closest<HTMLElement>(".k2b-ste-table")?.dataset.header === "true";
            },
          }),
          {
            label: t().editMarkdown,
            icon: "ti ti-markdown",
            action: () => {
              const wrap = cell()?.closest<HTMLElement>(".k2b-ste-table");
              if (editor && wrap) editTableSource(editor.view, wrap);
            },
          },
          ...copyItems(),
          actionItem("deleteTable"),
          ...(unavailable() ? [{ label: t().structureUnavailable, disabled: true as const }] : []),
        ],
      },
    ];
  };
  const preserveSelection = (event: MouseEvent) => event.preventDefault();
  const menuChange = (open: boolean) => {
    menuOpen = open;
  };
  const menuClose = () => {
    menuOpen = false;
    pointerAnchor = undefined;
    schedulePosition();
    queueMicrotask(() => {
      if (disposed) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches(".k2b-ste-cell-menu, .k2b-ste-table-tool")) cell()?.focus();
      checkFocus();
    });
  };
  const menu = (floating: boolean, trigger?: TableMenuTrigger) => (
    // A sheet owns its item inventory until it closes. Replace that owner when
    // edit access changes so an already open sheet cannot retain edit entries.
    <Show when={props.readOnly ? "read" : "write"} keyed>
      {(_access) => (
        <Dropdown
          items={items()}
          phone="sheet"
          sheetTop={
            props.readOnly
              ? undefined
              : (close) => (
                  <div class="k2b-ste-table-sheet-heading">
                    <span title={menuHeading()}>{menuHeading()}</span>
                    <Button variant="ghost" onClick={close}>
                      {t().done}
                    </Button>
                  </div>
                )
          }
          menuClass="k2b-ste-table-menu"
          position={floating ? "right-start" : (trigger?.position ?? "bottom-right")}
          width="18rem"
          label={props.readOnly ? t().copyTable : t().tableMenu}
          disabled={menuBlocked() || localSource() || !cell()?.isConnected}
          onOpenChange={menuChange}
          onClose={menuClose}
        >
          <Dropdown.Trigger
            ref={(element) => {
              if (floating) floatingTrigger = element;
              else {
                tableTriggers.add(element);
                onCleanup(() => tableTriggers.delete(element));
              }
            }}
            class={
              floating
                ? props.readOnly
                  ? "k2b-ste-cell-menu k2b-ste-copy-menu"
                  : "k2b-ste-cell-menu"
                : `k2b-ste-tool k2b-ste-table-tool ${trigger?.class ?? ""}`
            }
            variant="ghost"
            size={trigger?.size ?? "sm"}
            iconOnly={!trigger?.text && !props.readOnly}
            label={trigger?.text ?? (props.readOnly ? t().copyTable : t().tableMenu)}
            aria-pressed={!floating ? true : undefined}
            onMouseDown={preserveSelection}
          >
            <i class={props.readOnly ? "ti ti-copy" : floating ? "ti ti-dots" : "ti ti-table"} aria-hidden="true" />
            {trigger?.text ?? (props.readOnly ? t().copyTable : undefined)}
            <Show when={trigger?.text}>
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </Show>
          </Dropdown.Trigger>
        </Dropdown>
      )}
    </Show>
  );
  const runFormat = (command: keyof typeof commands) => {
    if (!editor || blocked()) return;
    if (cell()?.isConnected && isInlineCommand(command) && formatActiveCell(editor.view, command)) return;
    commands[command](editor.view);
  };
  const checkFocus = () => {
    if (disposed) return;
    // A host toolbar sits outside this root. Native popover focus moves before
    // its toggle callback, but Dropdown already exposes its synchronous state.
    if (
      menuOpen ||
      [...tableTriggers, floatingTrigger].some((trigger) => trigger?.isConnected && trigger.getAttribute("aria-expanded") === "true")
    )
      return;
    const focused = document.activeElement;
    setLocalSource(focused instanceof HTMLElement && !!focused.closest(".k2b-ste-table-source"));
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
      <Dropdown.Trigger class="k2b-ste-tool" variant="ghost" size="sm" iconOnly label={t()[command]} onMouseDown={preserveSelection}>
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
    const menuMedia = window.matchMedia("(max-width: 47.999rem)");
    const menuViewport = () => setPhoneMenu(menuMedia.matches);
    menuViewport();
    menuMedia.addEventListener("change", menuViewport);
    onCleanup(() => menuMedia.removeEventListener("change", menuViewport));
    // A standalone editor has no binding history; collaboration supplies its own instead.
    const nativeHistory = !props.host?.undo;
    editor = createTextEditor({
      parent: mount,
      doc: props.initialValue,
      mode: mode(),
      label: props.label,
      readOnly: props.readOnly,
      placeholder: props.placeholder,
      presentation: props.presentation,
      extensions: [
        nativeHistory ? [history(), keymap.of(historyKeymap)] : [],
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
        undo: props.host?.undo ?? (() => editor && undo(editor.view)),
        redo: props.host?.redo ?? (() => editor && redo(editor.view)),
        boundary: props.host?.boundary ?? (() => {}),
        cellLabel: (row, column, name) => t().cellLabel({ row, column, name }),
        actionLabel: (name) => t()[name],
        sourceLabels: () => ({
          edit: t().editMarkdown,
          valid: t().markdownValid,
          invalid: t().markdownInvalid,
          changed: t().markdownChanged,
          structural: t().markdownStructural,
          applying: t().applyingTable,
          applyFailed: t().markdownApplyFailed,
          done: phoneMenu() ? t().done : t().showTable,
          discard: t().discardMarkdown,
          continue: t().continueMarkdown,
          line: t().markdownLine,
          separator: (header, separator) => t().markdownSeparator({ header, separator }),
          extra: t().markdownExtra,
          complete: t().completeColumns,
        }),
        maxLength: props.maxLength,
        maxPasteCells: props.maxPasteCells ?? 2000,
        onRecovery: (text) => {
          if (disposed) detachedRecovery(text);
          else setRecovery((previous) => (previous === undefined ? text : `${previous}\n\n${text}`));
        },
        onError: (code) => setNotice({ message: t()[code] }),
      },
      onChange: (text) => {
        props.onChange?.(text);
        queueMicrotask(updateCheck);
      },
      onDroppedImages: (count, files) => {
        if (props.onDroppedImages?.(count, files) !== true) setNotice({ message: t().imageHint, images: true });
      },
    });
    const focus = (event: Event) => {
      if (!(event instanceof CustomEvent) || !(event.detail.cell instanceof HTMLElement)) return;
      setActive(true);
      if (!menuOpen) pointerAnchor = undefined;
      setCell(event.detail.cell);
      positionMenu();
    };
    const structureAnnouncement = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        detail &&
        typeof detail === "object" &&
        "rows" in detail &&
        "columns" in detail &&
        typeof detail.rows === "number" &&
        typeof detail.columns === "number"
      )
        setAnnouncement(t().tableChanged({ rows: detail.rows, columns: detail.columns }));
    };
    const focusChange = () => queueMicrotask(checkFocus);
    let pointerCheck: ReturnType<typeof setTimeout> | undefined;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.contains(event.target)) setActive(true);
      // After the press moved focus: a host toolbar control that keeps focus in the cell keeps it active.
      else if (!menuOpen) {
        clearTimeout(pointerCheck);
        pointerCheck = setTimeout(checkFocus);
      }
    };
    const keyboardMenu = (event: Event) => {
      if (menuBlocked()) return;
      focus(event);
      if (event instanceof CustomEvent) {
        const bounds = root.getBoundingClientRect();
        const anchor = event.detail.anchor instanceof HTMLElement ? event.detail.anchor.getBoundingClientRect() : undefined;
        if (anchor || typeof event.detail.x === "number") {
          pointerAnchor = {
            left: `${(anchor?.left ?? event.detail.x) - bounds.left}px`,
            top: `${(anchor?.bottom ?? event.detail.y) - bounds.top}px`,
          };
          positionMenu();
        }
      }
      queueMicrotask(() => {
        if (disposed || !cell()?.isConnected) return;
        const tableTrigger = [...tableTriggers].find((trigger) => trigger.isConnected);
        const trigger =
          (window.matchMedia("(max-width: 47.999rem)").matches && tableTrigger?.isConnected ? tableTrigger : undefined) ?? floatingTrigger;
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
      if (event.target instanceof Element && event.target.closest(".k2b-ste-views")) event.preventDefault();
    };
    root.addEventListener("mousedown", viewMouseDown);
    document.addEventListener("focusin", focusChange);
    document.addEventListener("pointerdown", pointer);
    root.addEventListener("k2b-ste-table-structure", structureAnnouncement);
    root.addEventListener("k2b-ste-cell-focus", focus);
    root.addEventListener("k2b-ste-cell-blur", focusChange);
    root.addEventListener("k2b-ste-cell-menu", keyboardMenu);
    const tableScroll = (event: Event) => {
      if (
        menuOpen &&
        event.target instanceof HTMLElement &&
        event.target.classList.contains("k2b-ste-table") &&
        floatingTrigger?.getAttribute("aria-expanded") === "true"
      )
        floatingTrigger.click();
      schedulePosition();
    };
    window.addEventListener("scroll", tableScroll, true);
    window.addEventListener("resize", schedulePosition);
    const viewport = window.visualViewport;
    const keyboard = () =>
      root.style.setProperty(
        "--k2b-ste-keyboard",
        `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`,
      );
    viewport?.addEventListener("resize", keyboard);
    viewport?.addEventListener("scroll", keyboard);
    keyboard();
    setReady(true);
    updateCheck();
    props.onReady?.(editor, {
      tableActive: () => mode() === "formatted" && !!cell()?.isConnected,
      TableMenu: (trigger) => menu(false, trigger),
      formatCell: (format) => !!editor && !blocked() && !!cell()?.isConnected && formatActiveCell(editor.view, format),
      notify: (message) => setNotice({ message }),
    });
    onCleanup(() => {
      clearTimeout(pointerCheck);
      mutations.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
      root.removeEventListener("mousedown", viewMouseDown);
      document.removeEventListener("focusin", focusChange);
      document.removeEventListener("pointerdown", pointer);
      root.removeEventListener("k2b-ste-table-structure", structureAnnouncement);
      root.removeEventListener("k2b-ste-cell-focus", focus);
      root.removeEventListener("k2b-ste-cell-blur", focusChange);
      root.removeEventListener("k2b-ste-cell-menu", keyboardMenu);
      window.removeEventListener("scroll", tableScroll, true);
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
      const next = mode();
      // Rendering the grid consults reactive host availability. Those reads
      // must not turn a history notification into a nested mode reconfigure.
      untrack(() => {
        menuOpen = false;
        setCell(undefined);
        editor?.setMode(next);
        updateCheck();
      });
    }
  });
  createEffect(() => {
    const label = props.label;
    if (ready()) untrack(() => editor?.setLabel(label));
  });
  createEffect(() => {
    const readOnly = !!props.readOnly || !!props.loading || recovery() !== undefined;
    if (ready()) untrack(() => editor?.setReadOnly(readOnly));
  });
  createEffect(() => {
    documentRevision();
    const disabled = blocked() || unavailable();
    if (ready())
      root.querySelectorAll<HTMLButtonElement>(".k2b-ste-addColumn").forEach((button) => {
        button.disabled = disabled;
      });
  });
  return (
    <div
      ref={root}
      class={`k2b-text-editor ${props.class ?? ""}`}
      data-mode={mode()}
      data-readonly={props.readOnly ? "true" : undefined}
      data-active={active() ? "true" : undefined}
      aria-busy={props.loading || !ready()}
    >
      <span class="k2b-ste-announcement" role="status" aria-live="polite" aria-atomic="true">
        {announcement()}
      </span>
      <Show when={!props.presentation || "status" in props || check()}>
        <div class="k2b-ste-status" role="status">
          <span>{props.status}</span>
          <Show when={check()}>
            <span class="k2b-ste-check" title={missingSeparator() ? t().checkSeparatorDetail : t().checkTableDetail}>
              <i class="ti ti-alert-triangle" aria-hidden="true" />
              {t().checkTable}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={blocked() || (!missingSeparator() && unavailable())}
              hidden={props.readOnly}
              tooltip={missingSeparator() ? t().checkSeparatorDetail : unavailable() ? t().structureUnavailable : t().checkTableDetail}
              onMouseDown={preserveSelection}
              onClick={() => {
                if (!editor) return;
                if (missingSeparator()) {
                  selectMode("source");
                  queueMicrotask(() => editor?.view.focus());
                  return;
                }
                const table = findTables(editor.view.state.doc.toString()).find((table) =>
                  table.lines.some((row) => row.cells.length > table.columns),
                );
                if (table) runTableAction(editor.view, table.from, 0, 0, "completeColumns");
              }}
            >
              {missingSeparator() ? t().reviewMarkdown : t().completeColumns}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={!props.readOnly && mode() !== "plain" && props.toolbar !== false}>
        <div class="k2b-ste-toolbar-slot">
          <Toolbar class="k2b-ste-toolbar" label={t().formatting}>
            <For each={[toolbar.slice(0, 3), toolbar.slice(3, 6), toolbar.slice(6)]}>
              {(group) => (
                <Toolbar.Group class="k2b-ste-tool-group">
                  <For each={group}>
                    {([command, icon]) =>
                      command === "heading" || command === "code" ? (
                        formatMenu(command)
                      ) : (
                        <Show
                          when={command === "table" && mode() === "formatted" && cell()?.isConnected}
                          fallback={
                            <IconButton
                              class="k2b-ste-tool"
                              variant="ghost"
                              size="sm"
                              label={t()[command]}
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
                            </IconButton>
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
              class="k2b-ste-views"
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
        </div>
      </Show>
      <Show when={props.loading || !ready()}>
        <div class="k2b-ste-loading" role="status" aria-label={t().loading}>
          <For each={[82, 100, 68, 0, 96, 74]}>
            {(width) => (
              <div>
                <span style={{ width: `${width}%` }} />
              </div>
            )}
          </For>
        </div>
      </Show>
      <div ref={mount} class={props.presentation ? "k2b-ste-app-host" : "k2b-ste-host"} hidden={props.loading || !ready()} />
      <Show when={cell() && mode() === "formatted" && !menuBlocked()}>
        <div class="k2b-ste-floating-menu" data-readonly={props.readOnly ? "true" : undefined} style={menuPosition()}>
          {menu(true)}
        </div>
      </Show>
      <div role="status" aria-live="polite" aria-atomic="true">
        <Show when={notice() || recovery() !== undefined}>
          <div class="k2b-ste-notice">
            <div class="k2b-ste-notice-content">
              <Show when={notice()}>
                <Show when={notice()?.images && props.onAttachImages} fallback={<span>{notice()?.message}</span>}>
                  <Button size="sm" variant="ghost" disabled={blocked()} onClick={() => props.onAttachImages?.()}>
                    {notice()?.message}
                  </Button>
                </Show>
              </Show>
              <Show when={recovery() !== undefined}>
                <label class="k2b-ste-recovery-label">
                  {t().recoveredInput}
                  <textarea class="k2b-ste-recovery" readOnly value={recovery()} />
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRecovery(undefined);
                    if (notice()?.message === t().cellRemoved) setNotice(undefined);
                  }}
                >
                  {t().discardRecovery}
                </Button>
              </Show>
            </div>
            <Show when={notice()}>
              <IconButton size="sm" variant="ghost" label={t().dismiss} onClick={() => setNotice(undefined)}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
