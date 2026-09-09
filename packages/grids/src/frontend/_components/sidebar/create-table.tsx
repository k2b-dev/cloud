import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CheckboxCard, dialogCore, PanelDialog, panelDialogOptions, prompts, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicTable } from "../../../api/public-dto";
import type { TableKind } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";
import { sidebarMessages } from "./messages";

export function createTableAction(props: { baseId: string }) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  const createMutation = mutations.create<PublicTable, { name: string; kind: TableKind }>({
    mutation: async (input) => {
      const res = await apiClient.tables["by-base"][":baseId"].$post({
        param: { baseId: props.baseId },
        json: { name: input.name, kind: input.kind },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t.createTableFailed));
      return res.json();
    },
    onSuccess: (table) => navigateTo(`/app/grids/${props.baseId}/table/${table.id}?edit=true`),
    onError: (e) => prompts.error(e.message),
  });

  const handleClick = async () => {
    const result = await dialogCore.open<{ name: string; kind: TableKind } | null>((close) => {
      const [name, setName] = createSignal("");
      const [kind, setKind] = createSignal<TableKind>("stored");
      return (
        <PanelDialog>
          <PanelDialog.Header title={t.newTable} icon="ti ti-table-plus" close={() => close(null)} />
          <PanelDialog.Body>
            <PanelDialog.Section title={t.tableType} subtitle={t.tableTypeDescription} icon="ti ti-database">
              <CheckboxCard
                label={t.storedTable}
                description={t.storedTableDescription}
                icon="ti ti-table"
                variant="input"
                value={() => kind() === "stored"}
                onValueChange={() => setKind("stored")}
              />
              <CheckboxCard
                label={t.combinedTable}
                description={t.combinedTableDescription}
                icon="ti ti-table-share"
                variant="input"
                value={() => kind() === "federated"}
                onValueChange={() => setKind("federated")}
              />
              <TextInput label={t.name} value={name} onValueChange={setName} placeholder={t.tableNameExample} required />
            </PanelDialog.Section>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span />
            <div class="flex items-center gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
                {t.cancel}
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={() => {
                  const trimmed = name().trim();
                  if (trimmed) close({ name: trimmed, kind: kind() });
                }}
              >
                {t.create}
              </Button>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    }, panelDialogOptions);
    if (!result) return;
    await createMutation.mutate(result);
  };

  return handleClick;
}
