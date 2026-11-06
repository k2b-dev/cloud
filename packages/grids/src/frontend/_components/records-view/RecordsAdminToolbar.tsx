import { Button, Dropdown, Tooltip, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import { fieldTypeIcon } from "../fields/field-type-meta";
import { recordsViewMessages } from "./messages";

export function RecordsAdminToolbar(props: {
  savedView: boolean;
  activeViewAvailable: boolean;
  canEditActiveView: boolean;
  hiddenViewColumnCount: number;
  allowForms: boolean;
  formsButtonLabel: string;
  tableFields: Field[];
  /** Opens a field's settings; omitted when the person cannot change the table's fields. */
  onFieldSettings?: (field: Field) => void;
  onOpenTableSettings: () => void;
  onAddField: () => void;
  onOpenForms: () => void;
  onOpenTemplates: () => void;
  onOpenViewSettings: () => void;
  onAddViewColumn: () => void;
  onDone: () => void;
}) {
  const locale = useLocale();
  const t = () => recordsViewMessages.resolve([locale()]).t;
  const viewDisabledReason = () => {
    if (!props.activeViewAvailable) return t().viewUnavailable;
    if (!props.canEditActiveView) return t().editViewDenied;
    return "";
  };
  // The same field settings as the column headers of the table view, reachable from every view and display mode.
  const fieldsMenu = () => (
    <Show when={props.onFieldSettings && props.tableFields.length > 0 ? props.onFieldSettings : undefined}>
      {(onFieldSettings) => (
        <Dropdown.Root
          position="bottom-right"
          label={t().fields}
          items={props.tableFields.map((field) => ({
            icon: fieldTypeIcon(field.type, field.icon),
            label: field.name,
            ariaLabel: t().fieldSettingsFor({ name: field.name }),
            action: () => onFieldSettings()(field),
          }))}
        >
          <Dropdown.Trigger variant="success" size="sm">
            <i class="ti ti-columns" /> {t().fields}
            <i class="ti ti-chevron-down text-[10px] opacity-60" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      )}
    </Show>
  );

  return (
    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <Show
        when={props.savedView}
        fallback={
          <>
            <Button variant="success" size="sm" onClick={props.onOpenTableSettings}>
              <i class="ti ti-settings" /> {t().general}
            </Button>
            {fieldsMenu()}
            <Button variant="success" size="sm" onClick={props.onAddField}>
              <i class="ti ti-plus" /> {t().addField}
            </Button>
            <Show when={props.allowForms}>
              <Button variant="success" size="sm" onClick={props.onOpenForms}>
                <i class="ti ti-forms" /> {props.formsButtonLabel}
              </Button>
            </Show>
            <Button variant="success" size="sm" onClick={props.onOpenTemplates}>
              <i class="ti ti-file-type-pdf" /> {t().templates}
            </Button>
          </>
        }
      >
        <Tooltip.Anchor content={viewDisabledReason()} disabled={!viewDisabledReason()}>
          <span class="inline-flex">
            <Button variant="success" size="sm" onClick={props.onOpenViewSettings} disabled={Boolean(viewDisabledReason())}>
              <i class="ti ti-table-spark" /> {t().view}
            </Button>
          </span>
        </Tooltip.Anchor>
        {fieldsMenu()}
      </Show>
      <Show when={props.hiddenViewColumnCount > 0}>
        <Button variant="success" size="sm" onClick={props.onAddViewColumn}>
          <i class="ti ti-plus" /> {t().addColumn}
        </Button>
      </Show>
      <Button variant="ghost" size="sm" type="button" class="ml-auto" onClick={props.onDone}>
        {t().done}
      </Button>
    </div>
  );
}
