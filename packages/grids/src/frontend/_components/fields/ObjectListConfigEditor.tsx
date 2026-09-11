import { crypto } from "@k2b/stdlib";
import { Button, CheckboxCard, DetailPanel, NoticeCard, NumberInput, Select, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Index, type JSX, Show } from "solid-js";
import { z } from "zod";
import { FormulaConfigSchema } from "../../../field-types/formula";
import { OBJECT_LIST_LIMITS, ObjectListColumnSchema, ObjectListScalarTypeSchema } from "../../../field-types/object-list";
import { planObjectListCalculations } from "../../../formula/object-list-plan";
import { gridsFieldMessages } from "./messages";

// Drafts permit unfinished names/formulas; the owning field schema validates save.
const DraftColumns = z.array(
  z.object({ ...ObjectListColumnSchema.in.shape, name: z.string(), formula: z.object(FormulaConfigSchema.shape).optional() }),
);
type ColumnDraft = z.infer<typeof DraftColumns>[number];

export function ObjectListConfigEditor(props: {
  config: () => Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  renderConstraints: (column: () => ColumnDraft, onChange: (config: Record<string, unknown>) => void) => JSX.Element;
}) {
  const locale = useLocale();
  const [expandedColumns, setExpandedColumns] = createSignal<ReadonlySet<string>>(new Set());
  let root: HTMLFieldSetElement | undefined;
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const columns = createMemo(() => DraftColumns.safeParse(props.config().fields ?? []));
  const fields = () => {
    const result = columns();
    return result.success ? result.data : [];
  };
  const calculations = createMemo(() => planObjectListCalculations(fields()));
  const formulaError = (id: string) => {
    const result = calculations();
    return !result.ok && result.columnId === id ? result.error : null;
  };
  const changeColumns = (next: ColumnDraft[], focusIndex: number) => {
    props.onChange({ ...props.config(), fields: next });
    queueMicrotask(() => {
      const column = root?.querySelectorAll<HTMLElement>("[data-list-column]").item(Math.max(0, focusIndex));
      (column?.querySelector<HTMLInputElement>("input") ?? root)?.focus();
    });
  };
  const move = (index: number, delta: number) => {
    const next = [...fields()];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    changeColumns(next, target);
  };
  const update = (index: number, patch: Partial<ColumnDraft>) =>
    props.onChange({
      ...props.config(),
      fields: fields().map((column, current) => (current === index ? { ...column, ...patch } : column)),
    });
  const options = () => ObjectListScalarTypeSchema.options.map((id) => ({ id, label: t().typeLabel({ type: id }) }));
  return (
    <fieldset ref={root} tabIndex={-1} class="flex min-w-0 flex-col gap-3" aria-label={t().listColumnsDescription}>
      <p class="text-sm text-dimmed">{t().listColumnsDescription}</p>
      <Show when={columns().success} fallback={<NoticeCard tone="danger">{t().listInvalidColumns}</NoticeCard>}>
        <Index each={fields()}>
          {(column, index) => (
            <div data-list-column class="flex min-w-0 flex-col gap-3">
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <TextInput label={t().name} value={() => column().name} onValueChange={(name) => update(index, { name })} required />
                <Select
                  label={t().listColumnType}
                  options={options()}
                  value={() => column().type}
                  onValueChange={(value) => {
                    const type = ObjectListScalarTypeSchema.safeParse(value);
                    if (type.success && type.data !== column().type) update(index, { type: type.data, config: {} });
                  }}
                />
              </div>
              <DetailPanel.Section
                collapsible
                title={t().listColumnOptions}
                icon="ti ti-adjustments"
                open={expandedColumns().has(column().id)}
                onOpenChange={(open) => {
                  const id = column().id;
                  setExpandedColumns((previous) => {
                    const next = new Set(previous);
                    if (open) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
              >
                <div class="flex flex-col gap-3">
                  <dl class="flex flex-wrap gap-x-2 text-sm">
                    <dt class="text-dimmed">{t().listColumnId}</dt>
                    <dd class="select-all font-mono">{column().id}</dd>
                  </dl>
                  <CheckboxCard
                    value={() => column().required}
                    onValueChange={(required) => update(index, { required })}
                    label={t().required}
                  />
                  <TextInput
                    label={t().description}
                    value={() => column().description ?? ""}
                    onValueChange={(description) => update(index, { description })}
                  />
                  {props.renderConstraints(column, (config) => update(index, { config }))}
                  <CheckboxCard
                    value={() => Boolean(column().formula)}
                    disabled={column().type === "select" && !column().formula}
                    onValueChange={(calculated) => update(index, { formula: calculated ? { expression: "" } : undefined })}
                    label={t().listCalculatedColumn}
                    description={column().type === "select" ? t().listCalculatedSelectUnsupported : t().listCalculatedDescription}
                  />
                  <Show when={column().formula}>
                    <TextInput
                      label={t().listRowFormula}
                      value={() => column().formula?.expression ?? ""}
                      onValueChange={(expression) => update(index, { formula: { ...column().formula, expression } })}
                    />
                    <p class="text-sm text-dimmed">{t().listFormulaHelp}</p>
                    <Show when={column().formula?.expression?.trim() && formulaError(column().id)}>
                      {(error) => <NoticeCard tone="danger">{error()}</NoticeCard>}
                    </Show>
                    <a class="text-sm text-primary" href="/app/grids/help/grids-formulas" target="_blank" rel="noopener noreferrer">
                      {t().formulaBasics}
                      <i class="ti ti-arrow-up-right ml-1" aria-hidden="true" />
                    </a>
                  </Show>
                  <div class="flex flex-wrap gap-2">
                    <Button type="button" variant="input" disabled={index === 0} onClick={() => move(index, -1)}>
                      <i class="ti ti-arrow-up" aria-hidden="true" />
                      {t().listMoveColumnUp}
                    </Button>
                    <Button type="button" variant="input" disabled={index === fields().length - 1} onClick={() => move(index, 1)}>
                      <i class="ti ti-arrow-down" aria-hidden="true" />
                      {t().listMoveColumnDown}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        changeColumns(
                          fields().filter((_, current) => current !== index),
                          Math.min(index, fields().length - 2),
                        )
                      }
                    >
                      <i class="ti ti-trash" aria-hidden="true" />
                      {t().listRemoveColumn}
                    </Button>
                  </div>
                </div>
              </DetailPanel.Section>
            </div>
          )}
        </Index>
        <div>
          <Button
            type="button"
            variant="input"
            disabled={fields().length >= OBJECT_LIST_LIMITS.fields}
            onClick={() => {
              let id = crypto.common.readableId(6);
              while (fields().some((column) => column.id === id)) id = crypto.common.readableId(6);
              changeColumns([...fields(), { id, name: "", type: "text", config: {}, required: false }], fields().length);
            }}
          >
            <i class="ti ti-plus" aria-hidden="true" />
            {t().listAddColumn}
          </Button>
        </div>
      </Show>
      <DetailPanel.Section collapsible title={t().listBounds} icon="ti ti-list-numbers">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberInput
            label={t().listMinRows}
            value={() => (typeof props.config().minItems === "number" ? Number(props.config().minItems) : 0)}
            min={0}
            max={OBJECT_LIST_LIMITS.rows}
            onValueChange={(minItems) => props.onChange({ ...props.config(), minItems: minItems ?? 0 })}
          />
          <NumberInput
            label={t().listMaxRows}
            value={() => (typeof props.config().maxItems === "number" ? Number(props.config().maxItems) : 100)}
            min={1}
            max={OBJECT_LIST_LIMITS.rows}
            onValueChange={(maxItems) => props.onChange({ ...props.config(), maxItems: maxItems ?? 100 })}
          />
        </div>
      </DetailPanel.Section>
    </fieldset>
  );
}
