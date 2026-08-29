import { Button, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, prompts, TextInput, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import type { ColumnSpec } from "../../../contracts";
import { FormulaExpressionEditor } from "../fields/FormulaExpressionEditor";
import { recordsViewMessages } from "./messages";

type ComputedColumn = Extract<ColumnSpec, { kind: "computed" }>;

type ComputedColumnDialogResult = { action: "save"; column: ComputedColumn } | { action: "delete" };

const randomComputedColumnId = (): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `computed_${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
};

export const openComputedColumnDialog = (args: {
  fields: Field[];
  currentTableId: string;
  baseId: string;
  tableId: string;
  column?: ComputedColumn;
}) =>
  dialogCore.open<ComputedColumnDialogResult | null>((close) => {
    const locale = useLocale();
    const t = () => recordsViewMessages.resolve([locale()]).t;
    const [label, setLabel] = createSignal(args.column?.label ?? "");
    const [expression, setExpression] = createSignal(args.column?.expression ?? "");
    const save = () => {
      const nextLabel = label().trim();
      const nextExpression = expression().trim();
      if (!nextLabel) {
        prompts.error(t().nameRequired);
        return;
      }
      if (!nextExpression) {
        prompts.error(t().expressionRequired);
        return;
      }
      close({
        action: "save",
        column: {
          kind: "computed",
          id: args.column?.id ?? randomComputedColumnId(),
          label: nextLabel,
          expression: nextExpression,
          ...(args.column?.format ? { format: args.column.format } : {}),
        },
      });
    };
    return (
      <PanelDialog>
        <PanelDialog.Header
          title={args.column ? t().editComputedColumn : t().computedColumn}
          icon="ti ti-calculator"
          close={() => close(null)}
        />
        <PanelDialog.Body>
          <NoticeCard tone="info" title={t().computedTitle} detail={t().computedDetail} />
          <TextInput
            label={t().name}
            value={label}
            onValueChange={setLabel}
            icon="ti ti-typography"
            placeholder={t().computedExample}
            required
          />
          <FormulaExpressionEditor
            value={expression}
            onInput={setExpression}
            fields={args.fields}
            currentTableId={args.currentTableId}
            baseId={args.baseId}
            tableId={args.tableId}
            ariaLabel={t().computedExpression}
          />
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Show when={args.column} fallback={<span />}>
            <Button variant="danger" size="sm" type="button" onClick={() => close({ action: "delete" })}>
              <i class="ti ti-trash" /> {t().deleteColumn}
            </Button>
          </Show>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => close(null)}>
              {t().cancel}
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={save}>
              {t().save}
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
