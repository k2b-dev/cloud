import { Button, DataTable, IconButton, LocaleProvider, NoticeCard, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import {
  createObjectListEntry,
  type ObjectListColumn,
  ObjectListConfigSchema,
  objectListScalarHandlers,
  validateObjectList,
} from "../../../field-types/object-list";
import type { FormulaRuntimeContext } from "../../../formula/function-runtime";
import { formatCell } from "../table/format-cell";
import { formFieldClass, formLayoutClass } from "./field-layout";
import { gridsFormMessages } from "./messages";
import { objectListColumnWidth, objectListInlineColumn, objectListInlineWidth } from "./object-list-presentation";

type Entry = Record<string, unknown>;

/** All edits belong to the enclosing form; entries are not independent records. */
export function ObjectListInput(props: {
  name: string;
  label: string;
  description?: string;
  required?: boolean;
  config: unknown;
  value: unknown;
  error?: string;
  dateConfig?: FormulaRuntimeContext["dateConfig"];
  onChange: (value: unknown) => void;
  renderCell: (
    column: ObjectListColumn,
    name: string,
    value: () => unknown,
    onChange: (value: unknown) => void,
    error: () => string | undefined,
    compact?: boolean,
  ) => JSX.Element;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const pageSize = 25;
  const [requestedPage, setPage] = createSignal(0);
  const [width, setWidth] = createSignal(Infinity);
  const [active, setActive] = createSignal<number | null>(null);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editError, setEditError] = createSignal<string>();
  let original: Entry | undefined;
  let lastEdited: Entry | undefined;
  let root: HTMLFieldSetElement | undefined;
  let addRef: HTMLButtonElement | undefined;
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const config = createMemo(() => {
    const parsed = ObjectListConfigSchema.safeParse(props.config);
    return parsed.success ? parsed.data : null;
  });
  const rows = createMemo((): Entry[] =>
    Array.isArray(props.value)
      ? props.value.filter((row): row is Entry => row !== null && typeof row === "object" && !Array.isArray(row))
      : [],
  );
  const validValue = () => props.value == null || (Array.isArray(props.value) && rows().length === props.value.length);
  const primary = createMemo(() => config()?.fields.filter(objectListInlineColumn) ?? []);
  const headingColumn = createMemo(() =>
    config()?.fields.find((column) => !column.formula && (column.type === "text" || column.type === "longtext")),
  );
  const summaryResult = createMemo(() =>
    primary()
      .filter((column) => column.formula)
      .at(-1),
  );
  const fits = () => width() >= objectListInlineWidth(primary());
  // Resizing must not unmount the field the user is typing into. Switch after
  // the row is finished; its values already live in the parent form draft.
  const inline = () => active() !== null || fits();
  const page = () => Math.min(requestedPage(), Math.max(0, Math.ceil(rows().length / pageSize) - 1));
  const fieldError = (row: Entry, column: ObjectListColumn) => {
    if (column.formula) return undefined;
    const result = objectListScalarHandlers[column.type].validate(row[column.id], column.config, column.required, {
      dateConfig: props.dateConfig,
      locale: locale(),
    });
    return result.ok ? undefined : result.error;
  };
  const preview = (row: Entry) => {
    const settings = config();
    return settings
      ? validateObjectList([row], { ...settings, minItems: 0 }, false, {
          stored: true,
          context: { dateConfig: props.dateConfig, locale: locale() },
        })
      : null;
  };
  const text = (value: unknown, column: ObjectListColumn) =>
    formatCell(
      value,
      column.type,
      column.config,
      column.type === "number" && !column.formula ? { kind: "decimal" } : undefined,
      props.dateConfig,
      locale(),
    );
  // Keep table rows stable while values change. Each value memo gates preview
  // work by that entry's reference; editing one entry does not remount others.
  const visibleIndices = createMemo(() => `${page()}:${rows().length}`);
  const stableSlots = createMemo(() => {
    const [pageNumber = 0, length = 0] = visibleIndices().split(":").map(Number);
    return Array.from({ length: Math.min(pageSize, Math.max(0, length - pageNumber * pageSize)) }, (_, offset) => {
      const index = pageNumber * pageSize + offset;
      const value = createMemo(() => rows()[index] ?? {});
      const calculated = createMemo(() => preview(value()));
      const calculationError = () => {
        const result = calculated();
        return result && !result.ok ? result.calculationError : undefined;
      };
      return { index, value, calculated, calculationError };
    });
  });
  const tableColumns = createMemo(() => [
    ...primary().map((column) => ({
      id: column.id,
      header: () => (
        <span>
          {column.name}
          {column.required && !column.formula ? <span aria-hidden="true"> *</span> : null}
        </span>
      ),
      align: ["number", "percent", "duration"].includes(column.type) ? ("right" as const) : ("left" as const),
    })),
    { id: "_actions", header: () => <span class="sr-only">{t().listEditRow}</span> },
  ]);
  const focus = (index: number, columnId?: string) => {
    queueMicrotask(() => {
      const cells = Array.from(
        root?.querySelectorAll<HTMLElement>(`[data-entry-index="${index}"]${columnId ? `[data-column-id="${columnId}"]` : ""}`) ?? [],
      );
      const control = cells
        .map((cell) =>
          cell.querySelector<HTMLElement>(
            "input:not([type=hidden]):not([disabled]), textarea, select, [role=combobox], button:not([disabled])",
          ),
        )
        .find(Boolean);
      (control ?? addRef)?.focus();
    });
  };
  const finish = (revert = false) => {
    const index = active();
    if (index === null) return;
    // Do not restore a snapshot over a replacement supplied by the parent.
    if (revert && rows()[index] === lastEdited) {
      props.onChange(original ? rows().map((row, i) => (i === index ? original! : row)) : rows().filter((_, i) => i !== index));
    }
    setActive(null);
    original = undefined;
    lastEdited = undefined;
    focus(index);
  };
  const changeCell = (index: number, column: ObjectListColumn, value: unknown) => {
    if (rows()[index] !== lastEdited) original = rows()[index];
    const next = { ...rows()[index], [column.id]: value };
    lastEdited = next;
    props.onChange(rows().map((row, i) => (i === index ? next : row)));
  };
  const activate = (index: number, columnId?: string, isNew = false) => {
    if (!fits() && active() === null) {
      void editDialog(index);
      return;
    }
    if (active() !== index) {
      finish();
      original = isNew ? undefined : rows()[index];
      lastEdited = rows()[index];
      setPage(Math.floor(index / pageSize));
      setActive(index);
    }
    focus(index, columnId);
  };
  const add = () => {
    const settings = config();
    if (!settings || rows().length >= settings.maxItems) return;
    finish();
    if (!fits()) {
      void editDialog();
      return;
    }
    const index = rows().length;
    props.onChange([...rows(), createObjectListEntry(settings)]);
    activate(index, primary().find((column) => !column.formula)?.id, true);
  };
  const move = (index: number, delta: number, entry?: Entry) => {
    const next = [...rows()];
    if (entry) next[index] = entry;
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    finish();
    [next[index], next[target]] = [next[target]!, next[index]!];
    props.onChange(next);
    setPage(Math.floor(target / pageSize));
    focus(target);
  };
  const editDialog = async (index?: number, invalidColumn?: string) => {
    const settings = config();
    if (!settings || dialogOpen() || lifetime.signal.aborted) return;
    finish();
    const source = index === undefined ? undefined : rows()[index];
    if (index !== undefined && !source) return;
    setEditError(undefined);
    setDialogOpen(true);
    type Result = { kind: "apply"; row: Entry; another: boolean } | { kind: "remove" } | { kind: "up" | "down"; row: Entry };
    const result = await prompts.dialog<Result>(
      (close) => {
        const [draft, setDraft] = createSignal<Entry>(structuredClone(source ?? createObjectListEntry(settings)));
        const [submitted, setSubmitted] = createSignal(Boolean(invalidColumn));
        const calculated = createMemo(() => preview(draft()));
        let body: HTMLDivElement | undefined;
        const apply = (another: boolean) => {
          setSubmitted(true);
          const invalid = settings.fields.find((column) => fieldError(draft(), column));
          if (invalid) {
            body
              ?.querySelector<HTMLElement>(`[data-column-id="${invalid.id}"]`)
              ?.querySelector<HTMLElement>("input, textarea, select, button")
              ?.focus();
            return;
          }
          const calculation = calculated();
          if (calculation && !calculation.ok) return;
          close({ kind: "apply", row: draft(), another });
        };
        onMount(() => {
          if (invalidColumn)
            queueMicrotask(() =>
              body
                ?.querySelector<HTMLElement>(`[data-column-id="${invalidColumn}"]`)
                ?.querySelector<HTMLElement>("input, textarea, select, button")
                ?.focus(),
            );
        });
        return (
          <LocaleProvider locale={locale()}>
            <div ref={body} class="grids-object-entry-dialog flex min-w-0 flex-col gap-4">
              <div class={formLayoutClass}>
                <For each={settings.fields}>
                  {(column) => (
                    <div class={formFieldClass(column.width)} data-column-id={column.id}>
                      <Show
                        when={!column.formula}
                        fallback={
                          <div>
                            <span class="text-sm text-dimmed">{column.name}</span>
                            <output class="block tabular-nums" aria-label={column.name}>
                              {(() => {
                                const result = calculated();
                                return result?.ok && Array.isArray(result.value)
                                  ? text(result.value[0]?.[column.id], column)
                                  : t().calculationPending;
                              })()}
                            </output>
                          </div>
                        }
                      >
                        {props.renderCell(
                          column,
                          `${props.name}-entry-${column.id}`,
                          () => draft()[column.id],
                          (value) => setDraft((row) => ({ ...row, [column.id]: value })),
                          () => (submitted() ? fieldError(draft(), column) : undefined),
                        )}
                      </Show>
                    </div>
                  )}
                </For>
              </div>
              <Show when={calculated() && !calculated()?.ok && submitted()}>
                <NoticeCard tone="danger">{t().listCalculationFailed}</NoticeCard>
              </Show>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex gap-1">
                  <Show when={index !== undefined}>
                    <IconButton
                      type="button"
                      variant="ghost"
                      label={t().listMoveUp}
                      disabled={index === 0}
                      onClick={() => close({ kind: "up", row: draft() })}
                    >
                      <i class="ti ti-arrow-up" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      type="button"
                      variant="ghost"
                      label={t().listMoveDown}
                      disabled={index === rows().length - 1}
                      onClick={() => close({ kind: "down", row: draft() })}
                    >
                      <i class="ti ti-arrow-down" aria-hidden="true" />
                    </IconButton>
                    <Button
                      type="button"
                      variant="text"
                      class="ml-3"
                      style={{ color: "var(--k2b-danger-text)" }}
                      onClick={() => close({ kind: "remove" })}
                    >
                      <i class="ti ti-trash" aria-hidden="true" />
                      {t().listRemoveRow}
                    </Button>
                  </Show>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={() => close()}>
                    {t().cancel}
                  </Button>
                  <Show when={rows().length + (index === undefined ? 1 : 0) < settings.maxItems}>
                    <Button type="button" variant="secondary" onClick={() => apply(true)}>
                      {t().listApplyAnother}
                    </Button>
                  </Show>
                  <Button type="button" onClick={() => apply(false)}>
                    {t().listApply}
                  </Button>
                </div>
              </div>
            </div>
          </LocaleProvider>
        );
      },
      { title: index === undefined ? t().listAddRow : t().listRow({ number: index + 1 }), size: "large", signal: lifetime.signal },
    );
    setDialogOpen(false);
    if (!result || lifetime.signal.aborted) return;
    if (config() !== settings || (index !== undefined && rows()[index] !== source)) {
      setEditError(t().listChanged);
      return;
    }
    if (result.kind === "apply") {
      if (index === undefined && rows().length >= settings.maxItems) return;
      const target = index ?? rows().length;
      props.onChange(index === undefined ? [...rows(), result.row] : rows().map((row, i) => (i === index ? result.row : row)));
      setPage(Math.floor(target / pageSize));
      if (result.another) void editDialog();
      else focus(target);
    } else if (index !== undefined) {
      if (result.kind === "remove") {
        props.onChange(rows().filter((_, i) => i !== index));
        queueMicrotask(() => addRef?.focus());
      } else {
        const delta = result.kind === "up" ? -1 : 1;
        move(index, delta, result.row);
        void editDialog(index + delta);
      }
    }
  };
  const keyboard = (event: KeyboardEvent, index: number, column: ObjectListColumn) => {
    if (event.defaultPrevented || event.isComposing || active() !== index) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute("aria-expanded") === "true") return;
    const popup = target.closest('[role="dialog"], [role="listbox"], [popover]');
    if (popup && event.currentTarget instanceof HTMLElement && event.currentTarget.contains(popup)) return;
    // Composite controls own Enter/Escape. Single-line inputs alone use row shortcuts.
    const plain =
      target.tagName === "INPUT" &&
      ["text", "number", "percent", "duration"].includes(column.type) &&
      target.getAttribute("role") !== "combobox";
    if (plain && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    } else if (plain && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) add();
      else finish();
    } else if (event.key === "Tab") {
      const editable = primary().filter((field) => !field.formula);
      const next = editable.findIndex((field) => field.id === column.id) + (event.shiftKey ? -1 : 1);
      if (next >= 0 && next < editable.length) {
        event.preventDefault();
        focus(index, editable[next]!.id);
      } else if (index + (event.shiftKey ? -1 : 1) >= 0 && index + (event.shiftKey ? -1 : 1) < rows().length) {
        event.preventDefault();
        activate(index + (event.shiftKey ? -1 : 1), event.shiftKey ? editable.at(-1)?.id : editable[0]?.id);
      } else if (!event.shiftKey) {
        event.preventDefault();
        finish();
        queueMicrotask(() => addRef?.focus());
      }
    }
  };
  onMount(() => {
    if (!root) return;
    const measure = (size: number) => {
      if (size > 0) setWidth(size);
    };
    measure(root.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    if (!props.error) return;
    // Reveal errors once per parent validation attempt, not on every keystroke.
    untrack(() => {
      for (const [index, row] of rows().entries()) {
        const column = config()?.fields.find((column) => fieldError(row, column));
        if (!column) continue;
        setPage(Math.floor(index / pageSize));
        if (fits() && primary().some((field) => field.id === column.id)) activate(index, column.id);
        else void editDialog(index, column.id);
        break;
      }
    });
  });

  return (
    <fieldset ref={root} tabIndex={-1} class="grids-object-list min-w-0" data-layout={inline() ? "table" : "summary"}>
      <legend class="mb-2 font-medium">
        {props.label}
        <Show when={props.required}>
          <span aria-hidden="true"> *</span>
        </Show>{" "}
        <span class="ml-2 text-sm font-normal text-dimmed">{rows().length}</span>
      </legend>
      <Show when={props.description}>
        <p class="mb-3 text-xs leading-snug text-dimmed">{props.description}</p>
      </Show>
      <Show when={config() && validValue()} fallback={<NoticeCard tone="danger">{t().listInvalidValue}</NoticeCard>}>
        <Show when={rows().length > 0} fallback={<Placeholder variant="compact" title={t().listEmpty} />}>
          <Show
            when={inline()}
            fallback={
              <div class="paper grids-object-list-summary">
                <For each={stableSlots()}>
                  {(slot) => (
                    <div data-entry-index={slot.index}>
                      <Button
                        type="button"
                        variant="ghost"
                        class="grids-object-list-summary-button"
                        wrap
                        onClick={() => void editDialog(slot.index)}
                      >
                        <span class="min-w-0">
                          <span class="sr-only">{t().listRow({ number: slot.index + 1 })} · </span>
                          <strong class="line-clamp-1">
                            {(() => {
                              const heading = headingColumn();
                              return heading && slot.value()[heading.id]
                                ? text(slot.value()[heading.id], heading)
                                : t().listRow({ number: slot.index + 1 });
                            })()}
                          </strong>
                          <span class="grids-object-list-summary-detail line-clamp-2 font-normal text-dimmed">
                            {primary()
                              .filter((column) => column !== headingColumn() && column !== summaryResult())
                              .map((column) => {
                                const result = slot.calculated();
                                const value = column.formula
                                  ? result?.ok && Array.isArray(result.value)
                                    ? result.value[0]?.[column.id]
                                    : null
                                  : slot.value()[column.id];
                                return `${column.name}: ${value == null ? t().calculationPending : text(value, column)}`;
                              })
                              .join(" · ")}
                          </span>
                        </span>
                        <Show when={summaryResult()}>
                          {(column) => (
                            <span class="ml-auto shrink-0 tabular-nums">
                              <span class="sr-only">{column().name}: </span>
                              {(() => {
                                const result = slot.calculated();
                                return result?.ok && Array.isArray(result.value)
                                  ? text(result.value[0]?.[column().id], column())
                                  : t().calculationPending;
                              })()}
                            </span>
                          )}
                        </Show>
                        <i class="ti ti-chevron-right shrink-0" aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <DataTable
              rows={stableSlots()}
              columns={tableColumns()}
              getRowId={(slot) => String(slot.index)}
              density="compact"
              surface="paper"
              class="grids-object-list-table"
              ariaLabel={props.label}
              hoverRows={false}
              highlightColumns={false}
              rowClass={(slot) => (active() === slot.index ? "grids-object-list-active" : "")}
              renderCell={({ row: slot, col }) => {
                const column = primary().find((column) => column.id === col.id);
                if (!column)
                  return (
                    <div class="flex items-center justify-end" data-entry-index={slot.index} data-column-id="_actions">
                      <Show when={active() === slot.index}>
                        <IconButton type="button" variant="ghost" size="sm" label={t().listFinishRow} onClick={() => finish()}>
                          <i class="ti ti-check" aria-hidden="true" />
                        </IconButton>
                      </Show>
                      <IconButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        label={t().listEditRow}
                        onClick={() => void editDialog(slot.index)}
                      >
                        <i class="ti ti-dots" aria-hidden="true" />
                      </IconButton>
                    </div>
                  );
                const error = () => fieldError(slot.value(), column);
                const value = () => {
                  if (!column.formula) return slot.value()[column.id];
                  const result = slot.calculated();
                  return result?.ok && Array.isArray(result.value) ? result.value[0]?.[column.id] : undefined;
                };
                return (
                  <div
                    role="group"
                    aria-label={column.name}
                    class="grids-object-list-input-cell"
                    data-entry-index={slot.index}
                    data-column-id={column.id}
                    data-invalid={error() ? "true" : undefined}
                    style={{ "min-width": `${objectListColumnWidth(column) - 24}px` }}
                    onKeyDown={(event) => keyboard(event, slot.index, column)}
                  >
                    <Show
                      when={column.formula}
                      fallback={
                        <Show
                          when={active() === slot.index}
                          fallback={
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              class="grids-object-list-cell"
                              title={text(value(), column)}
                              tabIndex={column === primary().find((field) => !field.formula) ? 0 : -1}
                              aria-label={`${column.name} · ${t().listRow({ number: slot.index + 1 })}`}
                              onClick={() => activate(slot.index, column.id)}
                            >
                              {value() == null || value() === "" ? <span class="text-dimmed">—</span> : text(value(), column)}
                            </Button>
                          }
                        >
                          {props.renderCell(
                            column,
                            `${props.name}-${slot.index}-${column.id}`,
                            value,
                            (value) => changeCell(slot.index, column, value),
                            () => (slot.value()[column.id] === undefined && !props.error ? undefined : error()),
                            true,
                          )}
                        </Show>
                      }
                    >
                      <output class="grids-object-list-cell flex items-center tabular-nums" aria-label={column.name}>
                        {value() == null ? <span class="sr-only">{t().calculationPending}</span> : text(value(), column)}
                      </output>
                    </Show>
                  </div>
                );
              }}
            />
          </Show>
          <For each={stableSlots()}>
            {(slot) => (
              <>
                <Show when={inline()}>
                  <For each={primary()}>
                    {(column) => (
                      <Show when={fieldError(slot.value(), column)}>
                        {(message) => (
                          <p class="mt-1 text-xs" style={{ color: "var(--k2b-danger-text)" }}>
                            {t().listRow({ number: slot.index + 1 })} · {column.name}: {message()}
                          </p>
                        )}
                      </Show>
                    )}
                  </For>
                </Show>
                <Show when={slot.calculationError()}>
                  {(error) => (
                    <NoticeCard tone="danger" title={`${t().listRow({ number: slot.index + 1 })} · ${error().field}: ${error().detail}`}>
                      {t().listCalculationFailed}
                    </NoticeCard>
                  )}
                </Show>
              </>
            )}
          </For>
        </Show>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button
            ref={addRef}
            type="button"
            variant="text"
            size="sm"
            disabled={dialogOpen() || rows().length >= (config()?.maxItems ?? 0)}
            onClick={add}
          >
            <i class="ti ti-plus" aria-hidden="true" />
            {t().listAddRow}
          </Button>
          <Show when={rows().length > pageSize}>
            <span class="ml-auto text-sm text-dimmed" role="status">
              {t().listVisibleRows({
                from: page() * pageSize + 1,
                to: Math.min(rows().length, (page() + 1) * pageSize),
                total: rows().length,
              })}
            </span>
            <Button
              type="button"
              variant="text"
              size="sm"
              disabled={page() === 0}
              onClick={() => {
                finish();
                setPage(page() - 1);
              }}
            >
              {t().listPreviousRows}
            </Button>
            <Button
              type="button"
              variant="text"
              size="sm"
              disabled={(page() + 1) * pageSize >= rows().length}
              onClick={() => {
                finish();
                setPage(page() + 1);
              }}
            >
              {t().listNextRows}
            </Button>
          </Show>
        </div>
        <Show when={inline() && rows().length > 0}>
          <p class="mt-2 text-xs text-dimmed">{t().listKeyboardHelp}</p>
        </Show>
      </Show>
      <Show when={editError()}>
        <NoticeCard tone="danger">{editError()}</NoticeCard>
      </Show>
      <Show when={props.error}>
        <p role="alert" class="mt-2 text-sm text-red-500">
          {props.error}
        </p>
      </Show>
    </fieldset>
  );
}
