import { timed } from "@k2b/stdlib/solid";
import { AutocompleteEditor, Button, DataTable, type DataTableColumn, NoticeCard, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicField as Field } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import { buildFormulaCompletions, formulaFieldRefs, formulaFieldToken, formulaHighlight } from "./formula-authoring";
import { gridsFieldMessages } from "./messages";

type FormulaPreviewResponse = {
  ok: boolean;
  diagnostics: { severity: "error" | "info"; message: string }[];
  fields: { id: string; name: string; type: string }[];
  rows: { recordId: string; values: Record<string, unknown>; result: unknown }[];
};

const previewValue = (value: unknown, empty: string): string => {
  if (value === null || value === undefined || value === "") return empty;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => previewValue(item, empty)).join(", ");
  return JSON.stringify(value);
};

const formulaReferenceHref = (args: { baseId?: string; tableId?: string; currentFieldId?: string }) => {
  if (!args.baseId || !args.tableId) return null;
  const params = args.currentFieldId ? `?field=${encodeURIComponent(args.currentFieldId)}` : "";
  return `/app/grids/help/grids-formulas${params}`;
};

const openReferenceWindow = (href: string | null) => {
  if (!href || typeof window === "undefined") return;
  window.open(href, "grids-formula-reference", "popup,width=1120,height=820,resizable=yes,scrollbars=yes");
};

function FormulaPreview(props: { preview: FormulaPreviewResponse | null; loading: boolean }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const columns = (): DataTableColumn<FormulaPreviewResponse["rows"][number]>[] => {
    const preview = props.preview;
    if (!preview) return [];
    return [
      ...preview.fields.map((field) => ({
        id: field.id,
        header: field.name,
        subtitle: t().typeLabel({ type: field.type }),
        value: (row: FormulaPreviewResponse["rows"][number]) => row.values[field.id],
      })),
      {
        id: "result",
        header: t().result,
        value: (row: FormulaPreviewResponse["rows"][number]) => row.result,
        headerClass: "text-primary",
      },
    ];
  };

  return (
    <div class="flex flex-col gap-2 text-xs">
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium text-secondary">{t().formulaPreview}</span>
        <Show when={props.loading}>
          <span class="inline-flex items-center gap-1 text-[11px] text-dimmed">
            <i class="ti ti-loader-2 animate-spin" /> {t().checking}
          </span>
        </Show>
      </div>

      <div class="h-48 overflow-auto">
        <Show when={props.preview} fallback={<p class="text-dimmed">{t().typeFormula}</p>}>
          {(preview) => (
            <div class="flex flex-col gap-2">
              <Show when={preview().diagnostics.length > 0}>
                <NoticeCard tone={preview().ok ? "info" : "danger"} icon={false}>
                  <For each={preview().diagnostics}>{(diagnostic) => <div>{diagnostic.message}</div>}</For>
                </NoticeCard>
              </Show>

              <Show
                when={preview().rows.length > 0}
                fallback={<Show when={preview().ok}>{<p class="text-dimmed">{t().formulaNoRecords}</p>}</Show>}
              >
                <DataTable
                  ariaLabel={t().formulaPreviewLabel}
                  rows={preview().rows}
                  columns={columns()}
                  getRowId={(row) => row.recordId}
                  class="overflow-auto"
                  tableClass="w-full text-[11px]"
                  density="compact"
                  stickyHeader={false}
                  hoverRows={false}
                  cellContentClass="max-w-40 whitespace-nowrap"
                  renderCell={({ col, value }) => (
                    <span
                      class={
                        col.id === "result" && typeof value === "string" && value.startsWith("#")
                          ? "font-medium text-red-600 dark:text-red-400"
                          : col.id === "result"
                            ? "font-medium text-secondary"
                            : "text-dimmed"
                      }
                    >
                      {previewValue(value, t().empty)}
                    </span>
                  )}
                />
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

export function FormulaExpressionEditor(props: {
  value: () => string;
  onInput: (value: string) => void;
  fields: Field[];
  currentTableId: string;
  currentFieldId?: string;
  baseId?: string;
  tableId?: string;
  ariaLabel?: string;
}) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const refs = () => formulaFieldRefs(props.fields, props.currentFieldId);
  const completions = () => buildFormulaCompletions(refs());
  const referenceHref = () =>
    formulaReferenceHref({
      baseId: props.baseId,
      tableId: props.tableId,
      currentFieldId: props.currentFieldId,
    });

  const numericRefs = () => refs().filter((field) => ["number", "percent", "duration", "rollup", "formula"].includes(field.type));
  const textRefs = () => refs().filter((field) => ["text", "longtext", "select", "id", "lookup", "formula"].includes(field.type));
  const dateRefs = () => refs().filter((field) => ["date", "created_at", "updated_at", "formula"].includes(field.type));
  const boolRefs = () => refs().filter((field) => ["boolean", "formula"].includes(field.type));
  const refOr = (list: ReturnType<typeof refs>, fallback: string) => (list[0] ? formulaFieldToken(list[0]) : fallback);
  const examples = () => {
    const price = refOr(numericRefs(), "price");
    const qty = refOr(numericRefs().slice(1), "quantity");
    const name = refOr(textRefs(), "name");
    const date = refOr(dateRefs(), "date");
    const active = refOr(boolRefs(), "active");
    return [
      { label: t().markup, expression: `${price} * 1.19` },
      { label: t().total, expression: `${price} * ${qty}` },
      { label: t().textLabel, expression: `CONCAT(UPPER(${name}), ' - EUR ', ${price})` },
      { label: t().conditional, expression: `IF(${active}, 'Available', 'Out of stock')` },
      { label: t().dateAge, expression: `DATEDIFF(${date}, TODAY(), 'days')` },
    ];
  };

  const [preview, setPreview] = createSignal<FormulaPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  let previewToken = 0;
  const loadPreview = async (expression: string) => {
    const token = ++previewToken;
    if (!expression.trim()) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await apiClient.formulas["by-table"][":tableId"].check.$post({
        param: { tableId: props.currentTableId },
        json: { expression, currentFieldId: props.currentFieldId ?? null },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t().previewFormulaFailed));
      const data = await res.json();
      if (token === previewToken) setPreview(data);
    } catch {
      if (token === previewToken) {
        setPreview({
          ok: false,
          diagnostics: [{ severity: "error", message: t().previewFormulaFailed }],
          fields: [],
          rows: [],
        });
      }
    } finally {
      if (token === previewToken) setPreviewLoading(false);
    }
  };
  const previewDebounce = timed.debounce(loadPreview, 300);
  createEffect(() => {
    previewDebounce.debouncedFn(props.value());
  });

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1 text-xs leading-snug text-dimmed">
        <span class="font-medium">{t().formulaBasics}</span>
        <span>{t().formulaReferenceHelp}</span>
        <span>{t().formulaRenameWarning}</span>
        <span>{t().formulaStrings}</span>
      </div>

      <div class="flex flex-col gap-2 text-xs">
        <span class="font-medium text-secondary">{t().examples}</span>
        <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          <For each={examples()}>
            {(example) => (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                class="h-auto min-w-0 justify-start py-2 text-left"
                onClick={() => props.onInput(example.expression)}
              >
                <span class="block text-[11px] font-medium text-secondary">{example.label}</span>
                <code class="block truncate font-mono text-[11px] text-dimmed">{example.expression}</code>
              </Button>
            )}
          </For>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-label text-xs">{t().expression}</span>
        <AutocompleteEditor
          value={props.value}
          onValueChange={props.onInput}
          placeholder={t().expressionPlaceholder}
          completions={completions()}
          highlight={formulaHighlight}
          restoreExpansionOnBackspace={false}
          lines={4}
          aria-label={props.ariaLabel ?? t().formulaExpression}
        />
      </div>

      <p class="text-xs text-dimmed leading-snug">{t().formulaUpdates}</p>

      <div class="flex flex-col gap-2">
        <FormulaPreview preview={preview()} loading={previewLoading()} />
        <Show when={referenceHref()}>
          <Button variant="secondary" size="sm" type="button" class="w-fit" onClick={() => openReferenceWindow(referenceHref())}>
            <i class="ti ti-external-link" /> {t().openReference}
          </Button>
        </Show>
      </div>
    </div>
  );
}
