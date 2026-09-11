import { Button, IconButton, NoticeCard, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Index, type JSX, Show } from "solid-js";
import {
  type ObjectListColumn,
  ObjectListConfigSchema,
  objectListScalarHandlers,
  validateObjectList,
} from "../../../field-types/object-list";
import type { FormulaRuntimeContext } from "../../../formula/function-runtime";
import { formatCell } from "../table/format-cell";
import { gridsFormMessages } from "./messages";

/** A parent-owned value editor; row controls never create independent records. */
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
  ) => JSX.Element;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const pageSize = 25;
  const [requestedPage, setPage] = createSignal(0);
  const page = () => Math.min(requestedPage(), Math.max(0, Math.ceil(rows().length / pageSize) - 1));
  let root: HTMLFieldSetElement | undefined;
  const focusRow = (index: number) => {
    setPage(Math.floor(Math.max(0, index) / pageSize));
    queueMicrotask(() => {
      const row = root?.querySelectorAll<HTMLFieldSetElement>("[data-list-row]")[index - page() * pageSize];
      (row ?? root)?.focus();
    });
  };
  const config = createMemo(() => {
    const parsed = ObjectListConfigSchema.safeParse(props.config);
    return parsed.success ? parsed.data : null;
  });
  const rows = (): Record<string, unknown>[] =>
    Array.isArray(props.value)
      ? props.value.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row))
      : [];
  const validValue = () => props.value == null || (Array.isArray(props.value) && rows().length === props.value.length);
  const calculatedColumns = createMemo(() => config()?.fields.filter((column) => column.formula) ?? []);
  const changeCell = (index: number, id: string, value: unknown) =>
    props.onChange(rows().map((row, current) => (current === index ? { ...row, [id]: value } : row)));
  const move = (index: number, delta: number) => {
    const next = [...rows()];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    props.onChange(next);
    focusRow(target);
  };
  return (
    <fieldset ref={root} tabIndex={-1} class="flex min-w-0 flex-col gap-3">
      <legend class="mb-2 font-medium">
        {props.label}
        <Show when={props.required}>
          {" "}
          <span aria-hidden="true">*</span>
        </Show>
      </legend>
      <Show when={props.description}>
        <p class="text-sm text-dimmed">{props.description}</p>
      </Show>
      <Show when={config() && validValue()} fallback={<NoticeCard tone="danger">{t().listInvalidValue}</NoticeCard>}>
        <Show when={rows().length === 0}>
          <p class="text-sm text-dimmed">{t().listEmpty}</p>
        </Show>
        <Show when={page() + 1} keyed>
          {(selectedPage) => (
            <Index each={rows().slice((selectedPage - 1) * pageSize, selectedPage * pageSize)}>
              {(row, position) => {
                const index = (selectedPage - 1) * pageSize + position;
                const preview = createMemo(() => {
                  const settings = config();
                  if (!settings || calculatedColumns().length === 0) return null;
                  // Preview this row only. List cardinality and total byte limits
                  // still apply to the complete value when it is saved.
                  return validateObjectList([row()], { ...settings, minItems: 0 }, false, {
                    stored: true,
                    context: { dateConfig: props.dateConfig, locale: locale() },
                  });
                });
                const calculationError = () => {
                  const result = preview();
                  return result && !result.ok ? result.calculationError : undefined;
                };
                return (
                  <fieldset data-list-row tabIndex={-1} class="flex min-w-0 flex-col gap-3 rounded-lg bg-input p-3">
                    <legend class="sr-only">{t().listRow({ number: index + 1 })}</legend>
                    <div class="flex items-center gap-2">
                      <span class="mr-auto text-sm text-dimmed">{t().listRow({ number: index + 1 })}</span>
                      <IconButton
                        type="button"
                        variant="ghost"
                        label={t().listMoveUp}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <i class="ti ti-arrow-up" aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        type="button"
                        variant="ghost"
                        label={t().listMoveDown}
                        disabled={index === rows().length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <i class="ti ti-arrow-down" aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        type="button"
                        variant="ghost"
                        label={t().listRemoveRow}
                        onClick={() => {
                          const next = rows().filter((_, current) => current !== index);
                          props.onChange(next);
                          focusRow(Math.min(index, next.length - 1));
                        }}
                      >
                        <i class="ti ti-trash" aria-hidden="true" />
                      </IconButton>
                    </div>
                    <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                      <For each={config()?.fields.filter((column) => !column.formula) ?? []}>
                        {(column) =>
                          props.renderCell(
                            column,
                            `${props.name}-${index}-${column.id}`,
                            () => row()[column.id],
                            (value) => changeCell(index, column.id, value),
                            () => {
                              const value = row()[column.id];
                              if (value === undefined && !props.error) return undefined;
                              const result = objectListScalarHandlers[column.type].validate(value, column.config, column.required, {
                                dateConfig: props.dateConfig,
                                locale: locale(),
                              });
                              return result.ok ? undefined : result.error;
                            },
                          )
                        }
                      </For>
                    </div>
                    <Show when={calculatedColumns().length > 0}>
                      <dl class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                        <For each={calculatedColumns()}>
                          {(column) => {
                            const value = () => {
                              const result = preview();
                              return result?.ok && Array.isArray(result.value) ? result.value[0]?.[column.id] : undefined;
                            };
                            return (
                              <div class="min-w-0">
                                <dt class="text-sm text-dimmed">
                                  <i class="ti ti-calculator" aria-hidden="true" /> {column.name}
                                </dt>
                                <dd class="break-words tabular-nums">
                                  <output>
                                    {formatCell(value(), column.type, column.config, undefined, props.dateConfig, locale()) || "—"}
                                  </output>
                                </dd>
                              </div>
                            );
                          }}
                        </For>
                      </dl>
                    </Show>
                    <Show when={preview() && !preview()?.ok}>
                      <Show when={calculationError()} fallback={<p class="text-sm text-dimmed">{t().listPreviewIncomplete}</p>}>
                        {(error) => (
                          <NoticeCard tone="danger" title={`${error().field}: ${error().detail}`}>
                            {t().listCalculationFailed}
                          </NoticeCard>
                        )}
                      </Show>
                    </Show>
                  </fieldset>
                );
              }}
            </Index>
          )}
        </Show>
        <Show when={calculatedColumns().length > 0}>
          <p class="text-sm text-dimmed">{t().listCalculationPreview}</p>
        </Show>
        <Show when={rows().length > pageSize}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="mr-auto text-sm text-dimmed" role="status">
              {t().listVisibleRows({
                from: page() * pageSize + 1,
                to: Math.min(rows().length, (page() + 1) * pageSize),
                total: rows().length,
              })}
            </span>
            <Button type="button" variant="input" disabled={page() === 0} onClick={() => focusRow((page() - 1) * pageSize)}>
              {t().listPreviousRows}
            </Button>
            <Button
              type="button"
              variant="input"
              disabled={(page() + 1) * pageSize >= rows().length}
              onClick={() => focusRow((page() + 1) * pageSize)}
            >
              {t().listNextRows}
            </Button>
          </div>
        </Show>
        <div>
          <Button
            type="button"
            variant="input"
            disabled={rows().length >= (config()?.maxItems ?? 0)}
            onClick={() => {
              const index = rows().length;
              props.onChange([...rows(), {}]);
              focusRow(index);
            }}
          >
            <i class="ti ti-plus" aria-hidden="true" />
            {t().listAddRow}
          </Button>
        </div>
      </Show>
      <Show when={props.error}>
        <p role="alert" class="text-sm text-red-500">
          {props.error}
        </p>
      </Show>
    </fieldset>
  );
}
