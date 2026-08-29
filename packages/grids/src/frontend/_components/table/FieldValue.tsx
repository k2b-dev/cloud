import type { DateContext } from "@k2b/stdlib";
import { Button, dialogCore, MarkdownView, PanelDialog, ProgressBar, panelDialogFixedOptions, TemplatePreview, useLocale } from "@k2b/ui";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { FormatSpec } from "../../../contracts";
import { BarcodeDisplay } from "./BarcodeCell";
import { type FieldDisplayIntent, type RelationDisplayItem, relationIds, resolveFieldDisplay } from "./field-display";
import { tableMessages } from "./messages";
import { RecordLink } from "./RecordLink";
import { SelectValueBadges } from "./select-badges";

type FieldValueMode = "table" | "card" | "detail";

type FieldValueProps = {
  field: Field;
  value: unknown;
  record?: GridRecord;
  allFields?: Field[];
  baseId?: string;
  fieldsByTable?: Record<string, Field[]>;
  relationLabels?: Record<string, string>;
  dateConfig?: DateContext;
  format?: FormatSpec;
  mode?: FieldValueMode;
  empty?: JSX.Element | string;
  markdownClass?: string;
  linkLookup?: boolean;
  relationValueMode?: "ids" | "labels";
  showBarcodeOpenAction?: boolean;
};

const defaultEmpty = (field: Field, mode: FieldValueMode): JSX.Element | string => {
  if (mode === "table" && field.type !== "lookup") return "";
  return "—";
};

const lookupTarget = (props: FieldValueProps): { relationField: Field; targetId: string; targetTableId?: string } | null => {
  if (!props.record || !props.allFields) return null;
  const relationFieldId = (props.field.config as { relationFieldId?: string }).relationFieldId;
  const relationField = relationFieldId
    ? props.allFields.find((field) => field.id === relationFieldId && field.type === "relation" && !field.deletedAt)
    : undefined;
  if (!relationField) return null;
  const linked = props.record.data[relationField.id];
  const targetId = relationIds(linked)[0];
  if (!targetId) return null;
  return { relationField, targetId, targetTableId: (relationField.config as { targetTableId?: string }).targetTableId };
};

function RelationValue(
  props: FieldValueProps & { items: RelationDisplayItem[]; targetTableId?: string; emptyValue: JSX.Element | string },
) {
  return (
    <Show when={props.items.length > 0} fallback={props.emptyValue}>
      <span class="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <For each={props.items}>
          {(item, index) =>
            item.linkable ? (
              <RecordLink
                label={item.label}
                targetTableId={props.targetTableId}
                targetRecordId={item.id}
                baseId={props.baseId}
                comma={index() < props.items.length - 1}
              />
            ) : (
              <span>{item.label}</span>
            )
          }
        </For>
      </span>
    </Show>
  );
}

function ProgressValue(props: { intent: Extract<FieldDisplayIntent, { kind: "progress" }> }) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const percent = () => Math.round(props.intent.ratio * 100);
  return (
    <span class="flex min-w-36 items-center gap-3">
      <ProgressBar value={percent()} size="sm" class="w-32 shrink-0" label={t().fieldProgress} />
      <Show when={props.intent.label}>{(text) => <span class="whitespace-nowrap tabular-nums text-primary">{text()}</span>}</Show>
    </span>
  );
}

const openHtmlTemplatePreview = (field: Field, html: string) =>
  dialogCore.open<void>((close) => {
    const locale = useLocale();
    const t = () => tableMessages.resolve([locale()]).t;
    return (
      <PanelDialog>
        <PanelDialog.Header title={t().htmlPreview({ field: field.name })} icon="ti ti-template" close={() => close()} />
        <PanelDialog.Body>
          <TemplatePreview html={html} title={t().htmlPreviewTitle({ field: field.name })} class="h-[65dvh] min-h-[24rem]" />
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogFixedOptions);

function HtmlTemplateValue(props: { field: Field; value: unknown; mode: FieldValueMode; empty: JSX.Element | string }) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const html = () => (typeof props.value === "string" ? props.value : "");
  const PreviewButton = () => (
    <Show
      when={html() !== "#TEMPLATE_ERROR!"}
      fallback={<span class="text-xs font-medium text-red-600 dark:text-red-400">{t().renderError}</span>}
    >
      <Button
        variant="secondary"
        size="sm"
        type="button"
        class="shrink-0"
        onClick={(event) => {
          event.stopPropagation();
          void openHtmlTemplatePreview(props.field, html());
        }}
      >
        <i class="ti ti-eye" /> {t().preview}
      </Button>
    </Show>
  );
  return (
    <Show when={html()} fallback={props.empty}>
      <Show
        when={props.mode === "detail"}
        fallback={
          <span class="flex min-w-0 items-center gap-2">
            <code class="block min-w-0 flex-1 truncate text-xs text-dimmed">{html()}</code>
            <PreviewButton />
          </span>
        }
      >
        <PreviewButton />
      </Show>
    </Show>
  );
}

export function FieldValue(props: FieldValueProps) {
  const locale = useLocale();
  const mode = () => props.mode ?? "table";
  const emptyValue = () => props.empty ?? defaultEmpty(props.field, mode());
  const display = createMemo(() =>
    resolveFieldDisplay({
      field: props.field,
      value: props.value,
      record: props.record,
      fieldsByTable: props.fieldsByTable,
      relationLabels: props.relationLabels,
      dateConfig: props.dateConfig,
      format: props.format,
      relationValueMode: props.relationValueMode,
      locale: locale(),
    }),
  );

  const renderRawValue = () => {
    const intent = display();
    if (intent.kind === "empty") return emptyValue();
    if (intent.kind === "relation") {
      return <RelationValue {...props} items={intent.items} targetTableId={intent.targetTableId} emptyValue={emptyValue()} />;
    }
    if (intent.kind === "select") return <SelectValueBadges items={intent.items} empty={emptyValue()} />;
    if (intent.kind === "principal") return intent.text;
    if (intent.kind === "markdown") {
      return intent.text.trim() ? (
        <MarkdownView markdown={intent.text} headingScale="compact" class={props.markdownClass ?? "text-sm"} />
      ) : (
        emptyValue()
      );
    }
    if (intent.kind === "barcode") {
      return (
        <BarcodeDisplay
          value={intent.value}
          format={intent.format}
          size={mode() === "detail" ? "detail" : "table"}
          showOpenAction={props.showBarcodeOpenAction}
        />
      );
    }
    if (intent.kind === "progress") return <ProgressValue intent={intent} />;
    return intent.text || emptyValue();
  };

  const renderLookup = () => {
    const value = renderRawValue();
    const intent = display();
    if (!props.linkLookup || props.field.type !== "lookup" || intent.kind === "barcode" || intent.kind === "empty") return value;
    const target = lookupTarget(props);
    if (!target?.targetTableId || !props.baseId) return value;
    if (typeof value === "string") {
      return <RecordLink label={value} targetTableId={target.targetTableId} targetRecordId={target.targetId} baseId={props.baseId} />;
    }
    return (
      <a
        href={`/app/grids/${props.baseId}/table/${target.targetTableId}?record=${target.targetId}`}
        class="inline-flex items-baseline gap-1 hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        <i class="ti ti-arrow-up-right text-[10px] text-dimmed self-center" />
        <span>{value}</span>
      </a>
    );
  };

  return (
    <>
      {props.field.type === "html_template" ? (
        <HtmlTemplateValue field={props.field} value={props.value} mode={mode()} empty={emptyValue()} />
      ) : props.field.type === "lookup" ? (
        renderLookup()
      ) : (
        renderRawValue()
      )}
    </>
  );
}
