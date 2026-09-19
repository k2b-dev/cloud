import type { DateContext } from "@k2b/stdlib";
import { Button, DataTable, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { type ObjectListColumn, ObjectListConfigSchema } from "../../../field-types/object-list";
import { formatCell } from "./format-cell";
import { tableMessages } from "./messages";

/** Display the supplied snapshot. In particular, never recompute finalized cells. */
export function ObjectListValue(props: {
  value: unknown;
  config: unknown;
  detail: boolean;
  dateConfig?: DateContext;
  layout?: "fields" | "table";
  ariaLabel?: string;
}) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const config = createMemo(() => {
    const parsed = ObjectListConfigSchema.safeParse(props.config);
    return parsed.success ? parsed.data : null;
  });
  const rows = createMemo((): Record<string, unknown>[] =>
    Array.isArray(props.value)
      ? props.value.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row))
      : [],
  );
  const valid = () => config() && Array.isArray(props.value) && rows().length === props.value.length;
  const secondaryColumn = (column: ObjectListColumn) => column.detailsOnly && (Boolean(column.formula) || !column.required);
  const [visible, setVisible] = createSignal(25);
  const [showDetails, setShowDetails] = createSignal(false);
  const visibleColumns = () => config()?.fields.filter((column) => !secondaryColumn(column) || showDetails()) ?? [];
  const cellText = (row: Record<string, unknown>, column: ObjectListColumn) =>
    formatCell(
      row[column.id],
      column.type,
      column.config,
      column.type === "number"
        ? { kind: "decimal" }
        : column.type === "date"
          ? { kind: "date", format: "short", includeTime: column.config.includeTime === true }
          : undefined,
      props.dateConfig,
      locale(),
    ) || "—";
  return (
    <Show when={valid()} fallback={<span class="text-dimmed">{t().listUnavailable}</span>}>
      <Show when={props.detail} fallback={<span>{t().listRows({ count: rows().length })}</span>}>
        <div class="flex min-w-0 flex-col gap-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm text-secondary">
              {props.ariaLabel ? (
                <>
                  {props.ariaLabel} <span class="text-dimmed">· {rows().length}</span>
                </>
              ) : (
                t().listRows({ count: rows().length })
              )}
            </p>
            <Show when={config()?.fields.some(secondaryColumn)}>
              <div>
                <Button type="button" variant="text" size="sm" aria-expanded={showDetails()} onClick={() => setShowDetails(!showDetails())}>
                  {config()?.fields.some((column) => secondaryColumn(column) && !column.formula)
                    ? t().listDetails
                    : t().listCalculationDetails}
                  <i class={showDetails() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
                </Button>
              </div>
            </Show>
          </div>
          <Show
            when={props.layout === "table" && rows().length > 0}
            fallback={
              <For each={rows().slice(0, visible())}>
                {(row, index) => (
                  <section class="min-w-0" aria-label={t().listRow({ number: index() + 1 })}>
                    <dl class="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                      <For each={visibleColumns()}>
                        {(column) => (
                          <div class="min-w-0">
                            <dt class="text-sm text-dimmed">{column.name}</dt>
                            <dd class="whitespace-pre-wrap break-words tabular-nums">{cellText(row, column)}</dd>
                          </div>
                        )}
                      </For>
                    </dl>
                  </section>
                )}
              </For>
            }
          >
            <DataTable
              rows={rows().slice(0, visible())}
              columns={visibleColumns().map((column) => ({
                id: column.id,
                header: column.name,
                value: (row: Record<string, unknown>) => cellText(row, column),
                align: ["number", "percent", "duration"].includes(column.type) ? "right" : "left",
              }))}
              ariaLabel={props.ariaLabel}
              density="compact"
              surface="paper"
              hoverRows={false}
              cellContentClass="whitespace-pre-wrap break-words tabular-nums"
            />
          </Show>
          <Show when={rows().length > visible()}>
            <div>
              <Button type="button" variant="input" onClick={() => setVisible((count) => count + 25)}>
                {t().listShowMore}
              </Button>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
