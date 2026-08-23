import { Button, dialogCore, IconButton, PanelDialog, Placeholder, panelDialogOptions, prompts, StatusBadge, Tag, Tooltip } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { DOCUMENT_TEMPLATE_STARTERS, type DocumentTemplateStarter } from "../../../document-template-starters";
import type { PublicDocumentTemplate } from "../documents/public-document-types";
import { errorMessage } from "../utils/api-helpers";
import { openDocumentTemplateEditorDialog } from "./DocumentTemplateEditorDialog";
import { defaultDocumentStarter } from "./document-template-dialog-defaults";

export const openDocumentTemplatesDialog = (args: { baseId: string; tableId: string; tableName: string }) =>
  dialogCore.open<void>(
    (close) => (
      <PanelDialog>
        <PanelDialog.Header title={`Templates — ${args.tableName}`} icon="ti ti-file-type-pdf" close={() => close()} />
        <PanelDialog.Body>
          <DocumentTemplatesManager baseId={args.baseId} tableId={args.tableId} tableName={args.tableName} />
        </PanelDialog.Body>
      </PanelDialog>
    ),
    panelDialogOptions,
  );

function DocumentTemplatesManager(props: { baseId: string; tableId: string; tableName: string }) {
  const [reordering, setReordering] = createSignal(false);
  const [templates, { refetch }] = createResource(
    () => props.tableId,
    async (tableId) => {
      const res = await apiClient.documents.templates["by-table"][":tableId"].full.$get({ param: { tableId } });
      if (!res.ok) {
        prompts.error(await errorMessage(res, "Failed to load document templates"));
        return [] as PublicDocumentTemplate[];
      }
      return res.json();
    },
  );

  const deleteTemplate = async (template: PublicDocumentTemplate) => {
    const confirmed = await prompts.confirm(`Delete "${template.name}"? Existing generated documents can still be redownloaded.`, {
      title: "Delete document template?",
      variant: "danger",
      confirmText: "Delete",
    });
    if (!confirmed) return;
    const res = await apiClient.documents.templates[":templateId"].$delete({ param: { templateId: template.id } });
    if (!res.ok) {
      prompts.error(await errorMessage(res, "Failed to delete document template"));
      return;
    }
    await refetch();
  };

  const patchTemplate = async (template: PublicDocumentTemplate, patch: Partial<Pick<PublicDocumentTemplate, "enabled" | "position">>) => {
    const res = await apiClient.documents.templates[":templateId"].$patch({ param: { templateId: template.id }, json: patch });
    if (!res.ok) {
      prompts.error(await errorMessage(res, "Failed to update document template"));
      return false;
    }
    await refetch();
    return true;
  };

  const duplicateTemplate = async (template: PublicDocumentTemplate) => {
    const res = await apiClient.documents.templates["by-table"][":tableId"].$post({
      param: { tableId: props.tableId },
      json: {
        name: `${template.name} copy`,
        description: template.description,
        source: template.source,
        renderer: template.renderer,
        enabled: false,
      },
    });
    if (!res.ok) {
      prompts.error(await errorMessage(res, "Failed to duplicate document template"));
      return;
    }
    await refetch();
  };

  const moveTemplate = async (template: PublicDocumentTemplate, direction: -1 | 1) => {
    const ordered = [...(templates() ?? [])].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const index = ordered.findIndex((item) => item.id === template.id);
    const swap = ordered[index + direction];
    if (!swap) return;
    const next = [...ordered];
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    setReordering(true);
    try {
      const res = await apiClient.documents.templates["by-table"][":tableId"].reorder.$patch({
        param: { tableId: props.tableId },
        json: { templateIds: next.map((item) => item.id) },
      });
      if (!res.ok) {
        await prompts.error(await errorMessage(res, "Failed to reorder document templates"));
        return;
      }
      await refetch();
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : "Failed to reorder document templates");
    } finally {
      setReordering(false);
    }
  };

  const openEditor = (template?: PublicDocumentTemplate, starter?: DocumentTemplateStarter) => {
    openDocumentTemplateEditorDialog({
      baseId: props.baseId,
      tableId: props.tableId,
      tableName: props.tableName,
      template,
      starter,
      onSaved: () => void refetch(),
    });
  };

  const addTemplate = async () => {
    const starter = await chooseDocumentTemplateStarter();
    if (starter) openEditor(undefined, starter);
  };

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-dimmed">{templates.loading ? "Loading..." : `${templates()?.length ?? 0} templates`}</span>
        <Button variant="secondary" size="sm" type="button" onClick={() => void addTemplate()}>
          <i class="ti ti-plus" /> Add template
        </Button>
      </div>

      <Show when={!templates.loading && (templates()?.length ?? 0) === 0}>
        <Placeholder align="left" description={<>No document templates yet.</>} />
      </Show>

      <For each={[...(templates() ?? [])].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))}>
        {(template, index) => (
          <div class="paper flex flex-wrap items-start gap-3 p-3">
            <i class="ti ti-file-type-pdf mt-0.5 text-lg text-dimmed" />
            <div class="min-w-48 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-semibold text-primary">{template.name}</span>
                <Show when={!template.enabled}>
                  <StatusBadge tone="neutral" label="disabled" />
                </Show>
              </div>
              <Show when={template.description}>
                <p class="mt-1 text-xs text-dimmed">{template.description}</p>
              </Show>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              <Tooltip.Anchor content={template.enabled ? "Disable template" : "Enable template"}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={template.enabled ? "Disable template" : "Enable template"}
                  onClick={() => void patchTemplate(template, { enabled: !template.enabled })}
                >
                  <i class={`ti ${template.enabled ? "ti-toggle-right" : "ti-toggle-left"}`} />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Move template up">
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label="Move template up"
                  disabled={reordering() || index() === 0}
                  onClick={() => void moveTemplate(template, -1)}
                >
                  <i class="ti ti-arrow-up" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Move template down">
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label="Move template down"
                  disabled={reordering() || index() === (templates()?.length ?? 0) - 1}
                  onClick={() => void moveTemplate(template, 1)}
                >
                  <i class="ti ti-arrow-down" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Duplicate template">
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label="Duplicate template"
                  onClick={() => void duplicateTemplate(template)}
                >
                  <i class="ti ti-copy" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Edit template">
                <IconButton variant="ghost" size="sm" type="button" label="Edit template" onClick={() => openEditor(template)}>
                  <i class="ti ti-pencil" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Delete template">
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="text-dimmed hover:text-red-500"
                  label="Delete template"
                  onClick={() => void deleteTemplate(template)}
                >
                  <i class="ti ti-trash" />
                </IconButton>
              </Tooltip.Anchor>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

const chooseDocumentTemplateStarter = () =>
  dialogCore.open<DocumentTemplateStarter | null>((close) => {
    const blank = defaultDocumentStarter();
    return (
      <PanelDialog>
        <PanelDialog.Header title="Choose template starter" icon="ti ti-file-type-pdf" close={() => close(null)} />
        <PanelDialog.Body>
          <div class="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            <For each={[blank, ...DOCUMENT_TEMPLATE_STARTERS]}>
              {(starter) => (
                <button type="button" class="paper p-3 text-left transition hover:paper-highlighted" onClick={() => close(starter)}>
                  <div class="flex items-start gap-3">
                    <span class="thumbnail flex h-9 w-9 shrink-0 items-center justify-center bg-[var(--ui-surface-raised)]">
                      <i class={`${starter.icon} text-lg text-primary`} />
                    </span>
                    <div class="min-w-0">
                      <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                        <div class="truncate text-sm font-semibold text-primary">{starter.name}</div>
                        <Tag size="sm">{starter.category}</Tag>
                      </div>
                      <p class="mt-1 text-xs leading-snug text-dimmed">{starter.description}</p>
                      <div class="mt-2 grid gap-1 text-[11px] leading-snug text-dimmed">
                        <div>
                          <span class="font-medium text-secondary">Best for:</span> {starter.bestFor}
                        </div>
                        <div>
                          <span class="font-medium text-secondary">Data:</span> {starter.expectedData}
                        </div>
                        <div class="flex flex-wrap items-center gap-1.5">
                          <Tag size="sm">{starter.page}</Tag>
                          <For each={starter.uses ?? []}>{(use) => <Tag size="sm">{use}</Tag>}</For>
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogOptions);
