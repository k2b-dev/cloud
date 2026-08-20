import { Checkbox, dialogCore, NumberInput, PanelDialog, panelDialogOptions, Select, TextInput, Button } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { FormatSpec } from "../../../contracts";
import { effectiveDisplayField } from "../../../lookup-display";
import type { Field } from "../../../service";
import { TYPE_LABELS } from "../fields/field-config-editor";
import { BARCODE_GROUPS, barcodeSelectedLabel, DEFAULT_BARCODE_BCID, searchBarcodeOptions } from "../table/barcode-options";

type ViewColumnSettingsResult = { action: "save"; label: string | undefined; format: FormatSpec | undefined } | { action: "hide" };

type Args = {
  title: string;
  labelPlaceholder: string;
  currentLabel?: string;
  currentFormat?: FormatSpec;
  formatField?: Pick<Field, "type" | "config"> | null;
  hideLabel: string;
};

type DateFormatChoice = "default" | "iso" | "short" | "long" | "relative";
type ProgressLabelChoice = "percent" | "value" | "none";
type FormulaFormatChoice = "default" | "number" | "percent" | "date" | "progress" | "barcode";
type TextFormatChoice = "default" | "barcode";
export type ColumnFormatControlsHandle = { value: () => FormatSpec | undefined };

export const openViewColumnSettingsDialog = (args: Args) =>
  dialogCore.open<ViewColumnSettingsResult | null>((close) => <ViewColumnSettingsDialog args={args} close={close} />, panelDialogOptions);

function ViewColumnSettingsDialog(props: { args: Args; close: (result: ViewColumnSettingsResult | null) => void }) {
  const [label, setLabel] = createSignal(props.args.currentLabel ?? "");
  let formatControls: ColumnFormatControlsHandle | undefined;

  const save = () =>
    props.close({
      action: "save",
      label: label().trim() || undefined,
      format: formatControls?.value(),
    });

  return (
    <PanelDialog>
      <PanelDialog.Header title={`Column — ${props.args.title}`} icon="ti ti-settings" close={() => props.close(null)} />
      <PanelDialog.Body>
        <TextInput
          label="Column name"
          description="Shown in this view. Empty uses the generated name."
          placeholder={props.args.labelPlaceholder}
          icon="ti ti-heading"
          value={label}
          onValueChange={setLabel}
          clearable
        />

        <ColumnFormatControls
          field={props.args.formatField}
          currentFormat={props.args.currentFormat}
          expose={(handle) => {
            formatControls = handle;
          }}
        />
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="danger" size="sm" type="button" onClick={() => props.close({ action: "hide" })}>
          <i class="ti ti-eye-off" /> {props.args.hideLabel}
        </Button>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={() => props.close(null)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={save}>
            Save
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function ColumnFormatControls(props: {
  field?: Pick<Field, "type" | "config"> | null;
  currentFormat?: FormatSpec;
  expose?: (handle: ColumnFormatControlsHandle) => void;
  onChange?: () => void;
}) {
  const displayField = () => (props.field ? effectiveDisplayField(props.field) : null);
  const fieldType = () => displayField()?.type;
  const [dateFormat, setDateFormat] = createSignal<DateFormatChoice>(
    props.currentFormat?.kind === "date" ? props.currentFormat.format : "default",
  );
  const [includeTime, setIncludeTime] = createSignal(
    props.currentFormat?.kind === "date" ? Boolean(props.currentFormat.includeTime) : false,
  );
  const [customNumber, setCustomNumber] = createSignal(props.currentFormat?.kind === "decimal");
  const [precision, setPrecision] = createSignal<number | null>(
    props.currentFormat?.kind === "decimal" && props.currentFormat.precision !== undefined ? props.currentFormat.precision : null,
  );
  const [thousandsSeparator, setThousandsSeparator] = createSignal(
    props.currentFormat?.kind === "decimal" ? Boolean(props.currentFormat.thousandsSeparator) : false,
  );
  const [customPercent, setCustomPercent] = createSignal(props.currentFormat?.kind === "percent");
  const [progress, setProgress] = createSignal(props.currentFormat?.kind === "progress");
  const [progressLabel, setProgressLabel] = createSignal<ProgressLabelChoice>(
    props.currentFormat?.kind === "progress" ? (props.currentFormat.label ?? "percent") : "percent",
  );
  const [formulaFormat, setFormulaFormat] = createSignal<FormulaFormatChoice>(
    props.currentFormat?.kind === "decimal"
      ? "number"
      : props.currentFormat?.kind === "percent"
        ? "percent"
        : props.currentFormat?.kind === "date"
          ? "date"
          : props.currentFormat?.kind === "progress"
            ? "progress"
            : props.currentFormat?.kind === "barcode"
              ? "barcode"
              : "default",
  );
  const [textFormat, setTextFormat] = createSignal<TextFormatChoice>(props.currentFormat?.kind === "barcode" ? "barcode" : "default");
  const [barcodeBcid, setBarcodeBcid] = createSignal(
    props.currentFormat?.kind === "barcode" ? props.currentFormat.bcid : DEFAULT_BARCODE_BCID,
  );
  const [barcodeShowText, setBarcodeShowText] = createSignal(
    props.currentFormat?.kind === "barcode" ? Boolean(props.currentFormat.showText) : false,
  );
  const [percentPrecision, setPercentPrecision] = createSignal<number | null>(
    props.currentFormat?.kind === "percent" && props.currentFormat.precision !== undefined ? props.currentFormat.precision : null,
  );

  const touch =
    <T,>(setter: (v: T) => void) =>
    (value: T) => {
      setter(value);
      props.onChange?.();
    };

  const buildFormat = (): FormatSpec | undefined => {
    if (fieldType() === "date") {
      const fmt = dateFormat();
      return fmt === "default" ? undefined : { kind: "date", format: fmt, includeTime: includeTime() };
    }
    if (fieldType() === "text" || fieldType() === "id") {
      return textFormat() === "barcode" ? { kind: "barcode", bcid: barcodeBcid(), showText: barcodeShowText() } : undefined;
    }
    if (fieldType() === "number") {
      return customNumber()
        ? {
            kind: "decimal",
            precision: precision() ?? undefined,
            thousandsSeparator: thousandsSeparator(),
          }
        : undefined;
    }
    if (fieldType() === "formula") {
      if (formulaFormat() === "number")
        return { kind: "decimal", precision: precision() ?? undefined, thousandsSeparator: thousandsSeparator() };
      if (formulaFormat() === "percent") return { kind: "percent", precision: percentPrecision() ?? undefined };
      if (formulaFormat() === "date") {
        const fmt = dateFormat();
        return { kind: "date", format: fmt === "default" ? "short" : fmt, includeTime: includeTime() };
      }
      if (formulaFormat() === "progress") return { kind: "progress", label: progressLabel() };
      if (formulaFormat() === "barcode") return { kind: "barcode", bcid: barcodeBcid(), showText: barcodeShowText() };
      return undefined;
    }
    if (fieldType() === "percent") {
      if (progress()) return { kind: "progress", label: progressLabel() };
      return customPercent() ? { kind: "percent", precision: percentPrecision() ?? undefined } : undefined;
    }
    return undefined;
  };
  props.expose?.({ value: buildFormat });
  const canUseTextBarcode = () => fieldType() === "text" || fieldType() === "id";
  const hasFormatOptions = () => ["date", "number", "percent", "formula", "text", "id"].includes(fieldType() ?? "");

  return (
    <div class="flex flex-col gap-4">
      <Show when={fieldType() === "date"}>
        <div class="flex flex-col gap-4">
          <Select
            label="Date format"
            value={dateFormat}
            onValueChange={(id) => touch(setDateFormat)((id as DateFormatChoice | null) ?? "default")}
            options={[
              { id: "default", label: "Default", description: "Use the app default." },
              { id: "iso", label: "ISO", description: "2026-05-03" },
              { id: "short", label: "Short", description: "May 3, 2026" },
              { id: "long", label: "Long", description: "Sunday, May 3, 2026" },
              { id: "relative", label: "Relative", description: "2 days ago" },
            ]}
          />
          <Checkbox label="Include time" value={includeTime} onValueChange={touch(setIncludeTime)} />
        </div>
      </Show>
      <Show when={fieldType() === "number"}>
        <Checkbox label="Custom number format" value={customNumber} onValueChange={touch(setCustomNumber)} />
        <Show when={customNumber()}>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <NumberInput label="Decimal places" min={0} max={10} value={precision} onValueChange={touch(setPrecision)} clearable />
            <Checkbox
              label="Thousands separator"
              description="Example: 1,234,567"
              value={thousandsSeparator}
              onValueChange={touch(setThousandsSeparator)}
            />
          </div>
        </Show>
      </Show>
      <Show when={canUseTextBarcode()}>
        <Select
          label="Text format"
          value={textFormat}
          onValueChange={(v) => touch(setTextFormat)((v as TextFormatChoice | null) ?? "default")}
          options={[
            { id: "default", label: "Default" },
            { id: "barcode", label: "Barcode / 2D code", description: "Render the stored text as a scannable code." },
          ]}
        />
        <Show when={textFormat() === "barcode"}>
          <BarcodeFormatControls
            bcid={barcodeBcid}
            setBcid={touch(setBarcodeBcid)}
            showText={barcodeShowText}
            setShowText={touch(setBarcodeShowText)}
          />
        </Show>
      </Show>
      <Show when={fieldType() === "formula"}>
        <Select
          label="Formula format"
          value={formulaFormat}
          onValueChange={(v) => touch(setFormulaFormat)((v as FormulaFormatChoice | null) ?? "default")}
          options={[
            { id: "default", label: "Default" },
            { id: "number", label: "Number" },
            { id: "percent", label: "Percent" },
            { id: "date", label: "Date" },
            { id: "progress", label: "Progress bar" },
            { id: "barcode", label: "Barcode / 2D code" },
          ]}
        />
      </Show>
      <Show when={fieldType() === "percent"}>
        <Checkbox
          label="Progress bar"
          value={progress}
          onValueChange={(v) => {
            setProgress(v);
            if (v) setCustomPercent(false);
            props.onChange?.();
          }}
        />
      </Show>
      <Show when={(fieldType() === "percent" && progress()) || (fieldType() === "formula" && formulaFormat() === "progress")}>
        <Select
          label="Progress label"
          value={progressLabel}
          onValueChange={(v) => touch(setProgressLabel)((v as ProgressLabelChoice | null) ?? "percent")}
          options={[
            { id: "percent", label: "Percent" },
            { id: "value", label: "Value" },
            { id: "none", label: "None" },
          ]}
        />
      </Show>
      <Show when={fieldType() === "formula" && formulaFormat() === "number"}>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <NumberInput label="Decimal places" min={0} max={10} value={precision} onValueChange={touch(setPrecision)} clearable />
          <Checkbox label="Thousands separator" value={thousandsSeparator} onValueChange={touch(setThousandsSeparator)} />
        </div>
      </Show>
      <Show when={fieldType() === "formula" && formulaFormat() === "percent"}>
        <NumberInput
          label="Decimal places"
          min={0}
          max={10}
          value={percentPrecision}
          onValueChange={touch(setPercentPrecision)}
          clearable
        />
      </Show>
      <Show when={fieldType() === "formula" && formulaFormat() === "date"}>
        <Select
          label="Date format"
          value={dateFormat}
          onValueChange={(id) => touch(setDateFormat)((id as DateFormatChoice | null) ?? "short")}
          options={[
            { id: "iso", label: "ISO", description: "2026-05-03" },
            { id: "short", label: "Short", description: "May 3, 2026" },
            { id: "long", label: "Long", description: "Sunday, May 3, 2026" },
            { id: "relative", label: "Relative", description: "2 days ago" },
          ]}
        />
        <Checkbox label="Include time" value={includeTime} onValueChange={touch(setIncludeTime)} />
      </Show>
      <Show when={fieldType() === "formula" && formulaFormat() === "barcode"}>
        <BarcodeFormatControls
          bcid={barcodeBcid}
          setBcid={touch(setBarcodeBcid)}
          showText={barcodeShowText}
          setShowText={touch(setBarcodeShowText)}
        />
      </Show>
      <Show when={fieldType() === "percent" && !progress()}>
        <Checkbox label="Custom percent format" value={customPercent} onValueChange={touch(setCustomPercent)} />
        <Show when={customPercent()}>
          <NumberInput
            label="Decimal places"
            min={0}
            max={10}
            value={percentPrecision}
            onValueChange={touch(setPercentPrecision)}
            clearable
          />
        </Show>
      </Show>
      <Show when={!hasFormatOptions()}>
        <p class="text-xs leading-snug text-dimmed">
          No format options for {fieldType() ? (TYPE_LABELS[fieldType()!] ?? fieldType()) : "this column"}.
        </p>
      </Show>
    </div>
  );
}

function BarcodeFormatControls(props: {
  bcid: () => string;
  setBcid: (value: string) => void;
  showText: () => boolean;
  setShowText: (value: boolean) => void;
}) {
  return (
    <div class="flex flex-col gap-3">
      <Select
        label="Code type"
        description="Common codes are shown first. Search for advanced BWIP symbol names."
        value={props.bcid}
        onValueChange={(value) => {
          if (value !== null) props.setBcid(value);
        }}
        selectedLabel={() => barcodeSelectedLabel(props.bcid())}
        fetchData={async (query, _signal, group) => searchBarcodeOptions(query, group)}
        groups={BARCODE_GROUPS}
        defaultGroup="recommended"
        groupsAriaLabel="Filter code types"
      />
      <Checkbox
        label="Show encoded text"
        description="Print the value below the code when the symbol supports it."
        value={props.showText}
        onValueChange={props.setShowText}
      />
    </div>
  );
}
