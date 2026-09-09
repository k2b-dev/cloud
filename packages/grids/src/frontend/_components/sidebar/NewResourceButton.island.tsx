import { AppWorkspace, Button, dialogCore, PanelDialog, panelDialogOptions, prompts, Select, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { navigationMessages } from "../../../navigation-messages";
import { openDocumentTemplateEditorDialog } from "../dialogs/DocumentTemplateEditorDialog";
import { createForm, openFormEditorDialog } from "../forms/FormsManager";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import { createCustomAppAction } from "./create-custom-app";
import { createTableAction } from "./create-table";
import { createWorkflowAction } from "./create-workflow";

type ResourceKind = "table" | "view" | "form" | "documentTemplate" | "workflow" | "customApp";
type Props = {
  baseId: string;
  tables: PublicOkWorkspaceState["catalog"]["tables"];
  fieldsByTable: PublicOkWorkspaceState["catalog"]["fieldsByTable"];
  tableLevels: PublicOkWorkspaceState["catalog"]["tableLevels"];
  canCreateTables: boolean;
  canManageBase: boolean;
  activeTableId?: string;
};

export default function NewResourceButton(props: Props) {
  const locale = useLocale();
  const { t } = navigationMessages.resolve([locale()]);
  const createTable = createTableAction(props);
  const createApp = createCustomAppAction(props);
  const createWorkflow = createWorkflowAction(props);
  const [busy, setBusy] = createSignal(false);
  const eligibleTables = (kind: ResourceKind) =>
    props.tables.filter((table) => props.tableLevels[table.id] === "admin" && (kind !== "form" || table.kind === "stored"));
  const choices = [
    { kind: "table" as const, icon: "ti ti-table", description: t.tableDescription, allowed: props.canCreateTables },
    { kind: "view" as const, icon: "ti ti-table-spark", description: t.viewDescription, allowed: eligibleTables("view").length > 0 },
    { kind: "form" as const, icon: "ti ti-forms", description: t.formDescription, allowed: eligibleTables("form").length > 0 },
    {
      kind: "documentTemplate" as const,
      icon: "ti ti-file-type-pdf",
      description: t.documentTemplateDescription,
      allowed: eligibleTables("documentTemplate").length > 0,
    },
    { kind: "workflow" as const, icon: "ti ti-route", description: t.workflowDescription, allowed: props.canManageBase },
    { kind: "customApp" as const, icon: "ti ti-app-window", description: t.customAppDescription, allowed: props.canManageBase },
  ].filter((choice) => choice.allowed);

  const open = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      const choice = await dialogCore.open<ResourceKind | undefined>(
        (close) => (
          <PanelDialog>
            <PanelDialog.Header title={t.newResource} subtitle={t.newResourceDescription} close={() => close()} />
            <PanelDialog.Body>
              <div class="flex flex-col gap-2">
                <For each={choices}>
                  {(choice) => (
                    <Button variant="ghost" class="grids-navigation-link w-full text-left" onClick={() => close(choice.kind)}>
                      <span class="flex w-full items-center gap-3">
                        <i class={choice.icon} aria-hidden="true" />
                        <span class="flex min-w-0 flex-col gap-1 text-left">
                          <span class="font-medium">{t[choice.kind]}</span>
                          <span class="whitespace-normal text-xs font-normal text-dimmed">{choice.description}</span>
                        </span>
                      </span>
                    </Button>
                  )}
                </For>
              </div>
            </PanelDialog.Body>
          </PanelDialog>
        ),
        panelDialogOptions,
      );
      if (!choice) return;
      if (choice === "table") return await createTable();
      if (choice === "customApp") return await createApp();
      if (choice === "workflow") return await createWorkflow();
      const tables = eligibleTables(choice);
      const tableId = await dialogCore.open<string | undefined>((close) => {
        const [selected, setSelected] = createSignal<string | null>(tables.find((table) => table.id === props.activeTableId)?.id ?? null);
        return (
          <PanelDialog>
            <PanelDialog.Header title={t[choice]} close={() => close()} />
            <PanelDialog.Body>
              <Select
                label={t.chooseTable}
                options={tables.map((table) => ({ id: table.id, label: table.name }))}
                value={selected}
                onValueChange={setSelected}
                required
              />
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <span />
              <Button disabled={!selected()} onClick={() => close(selected() ?? undefined)}>
                {t.continue}
              </Button>
            </PanelDialog.Footer>
          </PanelDialog>
        );
      }, panelDialogOptions);
      const table = tables.find((table) => table.id === tableId);
      if (!table) return;
      if (choice === "view") {
        window.location.assign(
          `/app/grids/${props.baseId}/table/${table.id}/query?q=${encodeURIComponent(`from table {${table.id}}`)}&edit=true`,
        );
      } else if (choice === "documentTemplate") {
        await openDocumentTemplateEditorDialog({
          baseId: props.baseId,
          tableId: table.id,
          tableName: table.name,
          onSaved: (template) => window.location.assign(`/app/grids/${props.baseId}/document/${table.id}/${template.id}?edit=true`),
        });
      } else {
        const form = await createForm({ tableId: table.id, fields: props.fieldsByTable[table.id] ?? [] }, locale());
        if (form) {
          await openFormEditorDialog({ form, tableFields: props.fieldsByTable[table.id] ?? [] });
          window.location.reload();
        }
      }
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : t.createFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={choices.length > 0}>
      <AppWorkspace.SidebarItem tone="success" disabled={busy()} onClick={() => void open()}>
        <AppWorkspace.SidebarItemIcon icon="ti ti-plus" />
        <AppWorkspace.SidebarItemLabel>{t.newResource}</AppWorkspace.SidebarItemLabel>
      </AppWorkspace.SidebarItem>
    </Show>
  );
}
