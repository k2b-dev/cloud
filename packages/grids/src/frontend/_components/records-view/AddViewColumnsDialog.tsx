import { Button, dialogCore, MultiSelectInput, PanelDialog, panelDialogOptions, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { recordsViewMessages } from "./messages";

type AddViewColumnOption = {
  id: string;
  label: string;
  description: string;
  icon: string;
};

export const openAddViewColumnsDialog = (columns: AddViewColumnOption[]) =>
  dialogCore.open<string[] | null>((close) => {
    const locale = useLocale();
    const t = () => recordsViewMessages.resolve([locale()]).t;
    const [selectedColumnIds, setSelectedColumnIds] = createSignal<string[]>([]);
    const addSelected = () => {
      const selected = selectedColumnIds();
      if (selected.length === 0) return;
      close(selected);
    };
    return (
      <PanelDialog>
        <PanelDialog.Header title={t().addColumns} icon="ti ti-plus" close={() => close(null)} />
        <PanelDialog.Body>
          <MultiSelectInput
            label={t().columns}
            description={t().chooseHiddenColumns}
            placeholder={t().chooseColumns}
            icon="ti ti-columns"
            value={selectedColumnIds}
            onValueChange={setSelectedColumnIds}
            options={columns}
            clearable
          />
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span />
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => close(null)}>
              {t().cancel}
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={addSelected} disabled={selectedColumnIds().length === 0}>
              {t().addColumns}
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
