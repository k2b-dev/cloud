import { Button, Tooltip, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { recordsViewMessages } from "./messages";

export function RecordsAdminToolbar(props: {
  savedView: boolean;
  activeViewAvailable: boolean;
  canEditActiveView: boolean;
  hiddenViewColumnCount: number;
  allowForms: boolean;
  formsButtonLabel: string;
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

  return (
    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <Show
        when={props.savedView}
        fallback={
          <>
            <Button variant="success" size="sm" onClick={props.onOpenTableSettings}>
              <i class="ti ti-settings" /> {t().general}
            </Button>
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
        <>
          <Tooltip.Anchor content={viewDisabledReason()} disabled={!viewDisabledReason()}>
            <span class="inline-flex">
              <Button variant="success" size="sm" onClick={props.onOpenViewSettings} disabled={Boolean(viewDisabledReason())}>
                <i class="ti ti-table-spark" /> {t().view}
              </Button>
            </span>
          </Tooltip.Anchor>
          <Show when={props.hiddenViewColumnCount > 0}>
            <Button variant="success" size="sm" onClick={props.onAddViewColumn}>
              <i class="ti ti-plus" /> {t().addColumn}
            </Button>
          </Show>
        </>
      </Show>
      <Button variant="ghost" size="sm" type="button" class="ml-auto" onClick={props.onDone}>
        {t().done}
      </Button>
    </div>
  );
}
