import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, prompts, SettingsCollection, toast, useLocale } from "@k2b/ui";
import { For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { PAGE_TEMPLATE_NAME_MAX_LENGTH, type PageTemplateSummary } from "@/lib/page-templates";
import type { Notebook } from "../sidebar/types";
import { notebookSettingsMessages } from "./messages";
import { readErrorMessage } from "./utils";

/**
 * The notebook's page templates: its own ones, which writers rename and delete, and the built-in ones. Saving a note
 * as a template happens on the note itself, where its text is.
 */
export function TemplatesSection(props: { notebook: Notebook; canWrite: boolean }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const templates = query.create({
    source: () => props.notebook.id,
    load: async (notebookId, { abortSignal }): Promise<PageTemplateSummary[]> => {
      const res = await apiClient[":id"]["page-templates"].$get({ param: { id: notebookId } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().templatesLoadFailed));
      return await res.json();
    },
  });
  const own = () => (templates.data() ?? []).filter((template) => !template.builtIn);
  const builtIn = () => (templates.data() ?? []).filter((template) => template.builtIn);

  const rename = mutations.create<PageTemplateSummary, { template: PageTemplateSummary; name: string }>({
    mutation: async ({ template, name }, { abortSignal }) => {
      const res = await apiClient[":id"]["page-templates"][":templateId"].$patch(
        { param: { id: props.notebook.id, templateId: template.id }, json: { name } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().templateChangeFailed));
      return await res.json();
    },
    onSuccess: () => void templates.refresh(),
    onError: (error) => toast.error(error.message),
  });
  const remove = mutations.create<PageTemplateSummary, PageTemplateSummary>({
    mutation: async (template, { abortSignal }) => {
      const res = await apiClient[":id"]["page-templates"][":templateId"].$delete(
        { param: { id: props.notebook.id, templateId: template.id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().templateChangeFailed));
      return template;
    },
    onSuccess: (template) => {
      toast.success(t().templateDeleted({ name: template.name }));
      void templates.refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => {
    rename.abort();
    remove.abort();
  });
  const busy = () => rename.loading() || remove.loading();

  const askRename = async (template: PageTemplateSummary) => {
    const taken = new Set(
      own()
        .filter((other) => other.id !== template.id)
        .map((other) => other.name.toLocaleLowerCase(locale())),
    );
    const result = await prompts.form({
      title: t().renameTemplate,
      icon: "ti ti-pencil",
      confirmText: t().rename,
      fields: {
        name: {
          type: "text",
          label: t().templateName,
          default: template.name,
          required: true,
          maxLength: PAGE_TEMPLATE_NAME_MAX_LENGTH,
          validate: (value) => (value && taken.has(value.trim().toLocaleLowerCase(locale())) ? t().templateNameTaken : null),
        },
      },
    });
    const name = result?.name?.trim();
    if (name && name !== template.name) void rename.mutate({ template, name });
  };

  const askDelete = async (template: PageTemplateSummary) => {
    const confirmed = await prompts.confirm(t().deleteTemplateConfirm({ name: template.name }), {
      title: t().deleteTemplate,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) void remove.mutate(template);
  };

  return (
    <Show
      when={!templates.loading() || templates.data()}
      fallback={<Placeholder state="loading" variant="panel" title={t().loadingTemplates} />}
    >
      <Show
        when={templates.data()}
        fallback={
          <Placeholder
            state="error"
            variant="panel"
            title={t().templatesLoadFailed}
            description={templates.error()?.message}
            action={
              <Button type="button" variant="secondary" size="sm" onClick={() => void templates.refresh()}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t().retry}
              </Button>
            }
          />
        }
      >
        <SettingsCollection
          title={t().ownTemplates}
          description={props.canWrite ? t().ownTemplatesDescription : t().templatesReadOnly}
          empty={t().noOwnTemplates}
        >
          <For each={own()}>
            {(template) => (
              <SettingsCollection.Item
                title={template.name}
                icon={<i class={`${template.icon} text-base text-dimmed`} aria-hidden="true" />}
              >
                <Show when={props.canWrite}>
                  <SettingsCollection.Item.Actions>
                    <IconButton
                      label={t().renameTemplateLabel({ name: template.name })}
                      tooltip={t().rename}
                      size="sm"
                      disabled={busy()}
                      onClick={() => void askRename(template)}
                    >
                      <i class="ti ti-pencil" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={t().deleteTemplateLabel({ name: template.name })}
                      tooltip={t().delete}
                      size="sm"
                      disabled={busy()}
                      onClick={() => void askDelete(template)}
                    >
                      <i class="ti ti-trash" aria-hidden="true" />
                    </IconButton>
                  </SettingsCollection.Item.Actions>
                </Show>
              </SettingsCollection.Item>
            )}
          </For>
        </SettingsCollection>
        <SettingsCollection title={t().builtInTemplates} description={t().builtInTemplatesDescription}>
          <For each={builtIn()}>
            {(template) => (
              <SettingsCollection.Item
                title={template.name}
                description={template.description ?? undefined}
                icon={<i class={`${template.icon} text-base text-dimmed`} aria-hidden="true" />}
              />
            )}
          </For>
        </SettingsCollection>
      </Show>
    </Show>
  );
}
