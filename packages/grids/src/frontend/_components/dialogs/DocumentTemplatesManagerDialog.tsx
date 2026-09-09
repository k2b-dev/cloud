import { query } from "@k2b/stdlib/solid";
import {
  Button,
  dialogCore,
  IconButton,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  StatusBadge,
  Tag,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type DocumentTemplateStarter, getDocumentTemplateStarters } from "../../../document-template-starters";
import { documentMessages, documentStarterPresentation } from "../documents/messages";
import type { PublicDocumentTemplate } from "../documents/public-document-types";
import { errorMessage } from "../utils/api-helpers";
import { openDocumentTemplateEditorDialog } from "./DocumentTemplateEditorDialog";
import { defaultDocumentStarter } from "./document-template-dialog-defaults";

export const openDocumentTemplatesDialog = (args: { baseId: string; tableId: string; tableName: string }) =>
  dialogCore.open<void>((close) => {
    const Dialog = () => {
      const locale = useLocale();
      const t = () => documentMessages.resolve([locale()]).t;
      return (
        <PanelDialog>
          <PanelDialog.Header title={t().templatesTitle({ table: args.tableName })} icon="ti ti-file-type-pdf" close={() => close()} />
          <PanelDialog.Body>
            <DocumentTemplatesManager baseId={args.baseId} tableId={args.tableId} tableName={args.tableName} />
          </PanelDialog.Body>
        </PanelDialog>
      );
    };
    return <Dialog />;
  }, panelDialogOptions);

function DocumentTemplatesManager(props: { baseId: string; tableId: string; tableName: string }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const [reordering, setReordering] = createSignal(false);
  const [actionPending, setActionPending] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const templatesQuery = query.create({
    source: () => props.tableId,
    load: async (tableId, { abortSignal }) => {
      const res = await apiClient.documents.templates["by-table"][":tableId"].full.$get(
        { param: { tableId } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, t().failedLoadTemplates));
      return res.json();
    },
  });
  const templates = templatesQuery.data;
  const refetch = templatesQuery.refresh;
  const busy = () => actionPending() || reordering();
  const runAction = async (action: () => Promise<unknown>) => {
    if (busy()) return;
    setActionPending(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t().failedUpdateTemplate);
    } finally {
      setActionPending(false);
    }
  };

  const deleteTemplate = async (template: PublicDocumentTemplate) => {
    const confirmed = await prompts.confirm(t().deleteTemplateConfirm({ name: template.name }), {
      title: t().deleteTemplateTitle,
      variant: "danger",
      confirmText: t().delete,
    });
    if (!confirmed) return;
    const res = await apiClient.documents.templates[":templateId"].$delete({ param: { templateId: template.id } });
    if (!res.ok) {
      throw new Error(await errorMessage(res, t().failedDeleteTemplate));
    }
    await refetch();
  };

  const patchTemplate = async (template: PublicDocumentTemplate, patch: Partial<Pick<PublicDocumentTemplate, "enabled" | "position">>) => {
    const res = await apiClient.documents.templates[":templateId"].$patch({ param: { templateId: template.id }, json: patch });
    if (!res.ok) {
      throw new Error(await errorMessage(res, t().failedUpdateTemplate));
    }
    await refetch();
    return true;
  };

  const duplicateTemplate = async (template: PublicDocumentTemplate) => {
    const res = await apiClient.documents.templates["by-table"][":tableId"].$post({
      param: { tableId: props.tableId },
      json: {
        name: t().copySuffix({ name: template.name }),
        description: template.description,
        source: template.source,
        renderer: template.renderer,
        enabled: false,
      },
    });
    if (!res.ok) {
      throw new Error(await errorMessage(res, t().failedDuplicateTemplate));
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
        await prompts.error(await errorMessage(res, t().failedReorderTemplates));
        return;
      }
      await refetch();
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : t().failedReorderTemplates);
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
    const starter = await chooseDocumentTemplateStarter(locale());
    if (starter) openEditor(undefined, starter);
  };

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-dimmed">
          {templatesQuery.loading()
            ? t().loading
            : templatesQuery.error()
              ? ""
              : t().templateCount({
                  count: templates()?.length ?? 0,
                  formatted: new Intl.NumberFormat(locale()).format(templates()?.length ?? 0),
                })}
        </span>
        <Button variant="secondary" size="sm" type="button" onClick={() => void addTemplate()}>
          <i class="ti ti-plus" /> {t().addTemplate}
        </Button>
      </div>

      <Show when={actionError()}>{(message) => <NoticeCard tone="danger" title={message()} />}</Show>
      <Show when={templatesQuery.error()}>
        <Placeholder
          state="error"
          title={t().failedLoadTemplates}
          description={templatesQuery.error()?.message !== t().failedLoadTemplates ? templatesQuery.error()?.message : undefined}
          action={
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              {t().retry}
            </Button>
          }
        />
      </Show>
      <Show when={!templatesQuery.loading() && !templatesQuery.error() && (templates()?.length ?? 0) === 0}>
        <Placeholder align="left" description={t().noTemplates} />
      </Show>

      <For each={[...(templates() ?? [])].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))}>
        {(template, index) => (
          <div class="paper flex flex-wrap items-start gap-3 p-3">
            <i class="ti ti-file-type-pdf mt-0.5 text-lg text-dimmed" />
            <div class="min-w-48 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-semibold text-primary">{template.name}</span>
                <Show when={!template.enabled}>
                  <StatusBadge tone="neutral" label={t().disabled} />
                </Show>
              </div>
              <Show when={template.description}>
                <p class="mt-1 text-xs text-dimmed">{template.description}</p>
              </Show>
            </div>
            <div class="flex shrink-0 items-center gap-0.5">
              <Tooltip.Anchor content={template.enabled ? t().disableTemplate : t().enableTemplate}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={template.enabled ? t().disableTemplate : t().enableTemplate}
                  disabled={busy()}
                  onClick={() => void runAction(() => patchTemplate(template, { enabled: !template.enabled }))}
                >
                  <i class={`ti ${template.enabled ? "ti-toggle-right" : "ti-toggle-left"}`} />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().moveTemplateUp}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={t().moveTemplateUp}
                  disabled={busy() || index() === 0}
                  onClick={() => void moveTemplate(template, -1)}
                >
                  <i class="ti ti-arrow-up" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().moveTemplateDown}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={t().moveTemplateDown}
                  disabled={busy() || index() === (templates()?.length ?? 0) - 1}
                  onClick={() => void moveTemplate(template, 1)}
                >
                  <i class="ti ti-arrow-down" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().duplicateTemplate}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={t().duplicateTemplate}
                  disabled={busy()}
                  onClick={() => void runAction(() => duplicateTemplate(template))}
                >
                  <i class="ti ti-copy" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().editTemplate}>
                <IconButton variant="ghost" size="sm" type="button" label={t().editTemplate} onClick={() => openEditor(template)}>
                  <i class="ti ti-pencil" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content={t().deleteTemplate}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="text-dimmed hover:text-red-500"
                  label={t().deleteTemplate}
                  disabled={busy()}
                  onClick={() => void runAction(() => deleteTemplate(template))}
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

const chooseDocumentTemplateStarter = (locale: string) =>
  dialogCore.open<DocumentTemplateStarter | null>((close) => {
    const blank = defaultDocumentStarter();
    const t = documentMessages.resolve([locale]).t;
    return (
      <PanelDialog>
        <PanelDialog.Header title={t.chooseTemplateStarter} icon="ti ti-file-type-pdf" close={() => close(null)} />
        <PanelDialog.Body>
          <div class="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            <For each={[blank, ...getDocumentTemplateStarters(locale)]}>
              {(starter) => {
                const copy = documentStarterPresentation(starter, locale);
                return (
                  <button type="button" class="paper p-3 text-left transition hover:paper-highlighted" onClick={() => close(starter)}>
                    <div class="flex items-start gap-3">
                      <span class="thumbnail flex h-9 w-9 shrink-0 items-center justify-center bg-[var(--ui-surface-raised)]">
                        <i class={`${starter.icon} text-lg text-primary`} />
                      </span>
                      <div class="min-w-0">
                        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                          <div class="truncate text-sm font-semibold text-primary">{copy.name}</div>
                          <Tag size="sm">{copy.category}</Tag>
                        </div>
                        <p class="mt-1 text-xs leading-snug text-dimmed">{copy.description}</p>
                        <div class="mt-2 grid gap-1 text-[11px] leading-snug text-dimmed">
                          <div>
                            <span class="font-medium text-secondary">{t.bestFor}</span> {copy.bestFor}
                          </div>
                          <div>
                            <span class="font-medium text-secondary">{t.data}</span> {copy.expectedData}
                          </div>
                          <div class="flex flex-wrap items-center gap-1.5">
                            <Tag size="sm">{copy.page}</Tag>
                            <For each={copy.uses ?? []}>{(use) => <Tag size="sm">{use}</Tag>}</For>
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              }}
            </For>
          </div>
        </PanelDialog.Body>
      </PanelDialog>
    );
  }, panelDialogOptions);
