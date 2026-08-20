import type { DateContext } from "@k2b/stdlib";
import { Button, Placeholder, ScrollArea } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { RecordDisplayConfig } from "../../../contracts";
import type { GridFilePreview } from "../../../service";
import { recordDisplayTitle } from "../records/record-display";
import { FieldValue } from "../table/FieldValue";
import { fieldDisplayFormat, formatFieldValueText } from "../table/field-value-format";
import { visibleCardFields } from "./display-mode";
import type { CardSize } from "./query-url";

const cardPaddingClass: Record<CardSize, string> = {
  small: "p-2",
  medium: "p-2.5",
  large: "p-3",
};

const plainCardValue = (
  record: GridRecord,
  field: Field,
  fieldsByTable?: Record<string, Field[]>,
  dateConfig?: DateContext,
  relationLabels?: Record<string, string>,
): string => formatFieldValueText({ field, value: record.data[field.id], record, fieldsByTable, dateConfig, relationLabels });

const subtitleCandidate = (field: Field): boolean => ["text", "id", "relation", "select"].includes(field.type);

const hasVisualFormat = (field: Field): boolean => fieldDisplayFormat(field)?.kind === "barcode";

export function RecordCardsView(props: {
  items: GridRecord[];
  fields: Field[];
  displayConfig: RecordDisplayConfig;
  filePreviews?: Record<string, Record<string, GridFilePreview>>;
  baseId: string;
  tableId: string;
  fieldsByTable?: Record<string, Field[]>;
  relationLabels?: Record<string, string>;
  selectedId?: string | null;
  highlightedIds?: ReadonlySet<string>;
  onRecordClick?: (record: GridRecord) => void;
  renderActions?: (record: GridRecord) => JSX.Element;
  cardSize?: CardSize;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  dateConfig?: DateContext;
  emptyText?: JSX.Element | string;
  formatValueText?: (record: GridRecord, field: Field) => string;
  renderValue?: (record: GridRecord, field: Field) => JSX.Element;
  coverUrl?: (preview: GridFilePreview) => string;
  titleForRecord?: (record: GridRecord, fields: Field[]) => string;
}) {
  const size = () => props.cardSize ?? "medium";
  const cardFields = () => visibleCardFields(props.fields, props.displayConfig);
  const title = (record: GridRecord) =>
    props.titleForRecord?.(record, cardFields()) ??
    recordDisplayTitle({ fields: props.fields, record, fieldsByTable: props.fieldsByTable, dateConfig: props.dateConfig });
  const valueText = (record: GridRecord, field: Field) =>
    props.formatValueText?.(record, field) ?? plainCardValue(record, field, props.fieldsByTable, props.dateConfig, props.relationLabels);
  const displayFields = (record: GridRecord) => {
    const titleKey = title(record).trim().toLowerCase();
    return cardFields().filter((field) => {
      if (field.type === "file") return false;
      const value = valueText(record, field).trim().toLowerCase();
      return value && value !== titleKey;
    });
  };
  const subtitleFields = (record: GridRecord) => displayFields(record).filter(subtitleCandidate).slice(0, 2);
  const factFields = (record: GridRecord) => {
    const subtitleIds = new Set(subtitleFields(record).map((field) => field.id));
    return displayFields(record).filter((field) => !subtitleIds.has(field.id));
  };
  const subtitle = (record: GridRecord) =>
    subtitleFields(record)
      .map((field) => valueText(record, field))
      .filter(Boolean)
      .join(" · ");
  const coverPreview = (record: GridRecord): GridFilePreview | undefined => {
    const fieldId = props.displayConfig.cards?.imageFieldId;
    return fieldId ? props.filePreviews?.[record.id]?.[fieldId] : undefined;
  };
  const coverUrl = (preview: GridFilePreview) =>
    props.coverUrl?.(preview) ??
    `/api/grids/records/${props.tableId}/${preview.recordId}/files/${preview.fieldId}/${preview.fileId}/content?inline=true`;

  return (
    <ScrollArea class="flex flex-1 flex-col" scrollPreserveKey={`grids-cards-${props.tableId}`}>
      <Show
        when={props.items.length > 0}
        fallback={<Placeholder icon="ti ti-table" class="min-h-48 justify-center" description={props.emptyText ?? <>No records</>} />}
      >
        <div class="grids-record-card-grid grid px-3 pb-3 pt-0.5" data-card-size={size()}>
          <For each={props.items}>
            {(record) => {
              const preview = () => coverPreview(record);
              const selected = () => props.selectedId === record.id;
              const highlighted = () => props.highlightedIds?.has(record.id);
              return (
                <article
                  class={`grids-record-card relative flex min-w-0 flex-col overflow-hidden rounded-[var(--ui-radius-surface)] bg-[var(--k2b-surface-muted)] text-left transition-[background-color,box-shadow] ${
                    props.onRecordClick ? "hover:bg-[var(--k2b-hover)] hover:shadow-xs" : ""
                  } ${cardPaddingClass[size()]} ${
                    selected() ? "bg-[var(--ui-selected)]" : ""
                  } ${highlighted() ? "bg-[var(--ui-active)]" : ""}`}
                  data-selected={selected() ? "true" : undefined}
                >
                  <Show when={props.onRecordClick}>
                    <button
                      type="button"
                      class="absolute inset-0 z-10 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ui-focus)]"
                      aria-label={`Open ${title(record)}`}
                      onClick={() => props.onRecordClick?.(record)}
                    />
                  </Show>
                  <div class="pointer-events-none relative flex flex-col">
                    <Show when={preview()}>
                      {(file) => (
                        <div class="aspect-square w-full overflow-hidden rounded-md bg-white shadow-sm ring-1 ring-black/5 dark:bg-zinc-950 dark:ring-white/10">
                          <img src={coverUrl(file())} alt="" class="h-full w-full object-cover" loading="lazy" />
                        </div>
                      )}
                    </Show>
                    <div class="flex flex-col gap-3 pt-3">
                      <div class="min-w-0">
                        <div class={`truncate text-sm font-semibold leading-tight ${selected() ? "app-accent-text" : "text-primary"}`}>
                          {title(record)}
                        </div>
                        <Show when={subtitle(record)}>
                          {(text) => <div class="mt-1 truncate text-xs leading-snug text-dimmed">{text()}</div>}
                        </Show>
                      </div>
                      <Show when={factFields(record).length > 0}>
                        <div class="flex flex-col gap-1.5">
                          <For each={factFields(record)}>
                            {(field) => (
                              <div class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5">
                                <div class="max-w-[6.5rem] truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-dimmed">
                                  {field.name}
                                </div>
                                <div
                                  class={`min-w-0 overflow-hidden text-xs font-medium leading-snug text-primary [overflow-wrap:anywhere] ${
                                    hasVisualFormat(field) ? "pointer-events-auto relative z-20" : "line-clamp-2"
                                  }`}
                                >
                                  {props.renderValue?.(record, field) ?? (
                                    <FieldValue
                                      record={record}
                                      field={field}
                                      value={record.data[field.id]}
                                      baseId={props.baseId}
                                      fieldsByTable={props.fieldsByTable}
                                      relationLabels={props.relationLabels}
                                      dateConfig={props.dateConfig}
                                      mode="card"
                                      markdownClass="line-clamp-3 text-sm"
                                      showBarcodeOpenAction
                                    />
                                  )}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                  <Show when={props.renderActions?.(record)}>
                    {(actions) => <footer class="relative z-20 mt-3 flex flex-wrap items-center gap-1">{actions()}</footer>}
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={props.hasMore}>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          class="mt-3 self-center"
          onClick={props.onLoadMore}
          disabled={props.loadingMore}
        >
          {props.loadingMore ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-chevron-down" />}
          Load more
        </Button>
      </Show>
    </ScrollArea>
  );
}
