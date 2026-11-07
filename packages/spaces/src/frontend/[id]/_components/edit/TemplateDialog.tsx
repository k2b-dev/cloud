import type { DateContext } from "@k2b/stdlib";
import { dialogCore, LocaleProvider, PanelDialog, panelDialogOptions, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { ItemTemplateKind, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { spaceMessages } from "../../messages";
import { browserTimeZone } from "../shared/item-form/templates";
import { TemplateForm, type TemplateSuggestions, type TemplateValue } from "./TemplatesSection";
import { readErrorMessage } from "./utils";

export type TemplateDialogOptions = {
  spaceId: string;
  kind: ItemTemplateKind;
  tags: SpaceTag[];
  /** The Space's templates as the page knows them, for the name check before saving. */
  templates: readonly SpaceItemTemplate[];
  dateConfig?: DateContext;
  locale: string;
  /** Values of an item saved as a template. */
  draft?: Parameters<typeof TemplateForm>[0]["draft"];
  suggestions?: TemplateSuggestions;
};

const sameName = (template: Pick<SpaceItemTemplate, "kind" | "name">, kind: ItemTemplateKind, name: string) =>
  template.kind === kind && template.name.trim().toLowerCase() === name.trim().toLowerCase();

/**
 * The template form as a dialog, where a "+" or an item's "…" opens it. Every failure keeps the input: a taken name
 * marks the field, a refusal says the right is gone, and an unclear failure offers to try again after checking that
 * the first try did not save after all. Resolves with the saved template, or null when the person cancels.
 */
export const openTemplateDialog = (options: TemplateDialogOptions): Promise<SpaceItemTemplate | null> => {
  const { t } = spaceMessages.resolve([options.locale]);
  return dialogCore
    .open<SpaceItemTemplate | null>(
      (close) => {
        const [loading, setLoading] = createSignal(false);
        const [saveError, setSaveError] = createSignal<string>();
        const [nameTaken, setNameTaken] = createSignal(false);
        /** A failure whose outcome is unknown, such as a lost answer: the next try first looks for the template. */
        let unsure = false;
        const list = async (): Promise<SpaceItemTemplate[] | null> => {
          const response = await apiClient[":id"].templates
            .$get({ param: { id: options.spaceId }, query: { kind: options.kind } })
            .catch(() => null);
          return response?.ok ? response.json() : null;
        };
        const save = async (value: TemplateValue) => {
          if (loading()) return;
          setSaveError(undefined);
          if (!unsure && options.templates.some((template) => sameName(template, value.kind, value.name))) {
            setNameTaken(true);
            return;
          }
          setLoading(true);
          try {
            if (unsure) {
              // The first try saved after all: the retry keeps the person's later corrections by changing that one.
              const saved = (await list())?.find((template) => sameName(template, value.kind, value.name));
              if (saved) {
                const { kind: _kind, ...changes } = value;
                const updated = await apiClient[":id"].templates[":templateId"]
                  .$patch({ param: { id: options.spaceId, templateId: saved.id }, json: changes })
                  .catch(() => null);
                if (updated?.ok) return close(await updated.json());
                setSaveError(t.templateSaveFailed);
                return;
              }
            }
            const response = await apiClient[":id"].templates.$post({ param: { id: options.spaceId }, json: value }).catch(() => null);
            if (response?.ok) return close(await response.json());
            unsure = false;
            if (response?.status === 409) {
              // A name taken meanwhile, or the limit of templates reached.
              const taken = (await list())?.some((template) => sameName(template, value.kind, value.name));
              if (taken) setNameTaken(true);
              else setSaveError(await readErrorMessage(response, t.templateSaveFailed));
            } else if (response?.status === 403 || response?.status === 404) setSaveError(t.templateNoPermission);
            else if (response && response.status < 500) setSaveError(await readErrorMessage(response, t.templateSaveFailed));
            else {
              unsure = true;
              setSaveError(t.templateSaveFailed);
            }
          } finally {
            setLoading(false);
          }
        };
        const title = options.draft ? t.saveAsTemplate : options.kind === "event" ? t.newEventTemplate : t.newTaskTemplate;
        return (
          <LocaleProvider locale={options.locale}>
            <PanelDialog>
              <PanelDialog.Header title={title} icon="ti ti-template" close={() => close(null)} />
              <TemplateForm
                spaceId={options.spaceId}
                kind={options.kind}
                draft={options.draft}
                suggestions={options.suggestions}
                tags={options.tags}
                timeZone={options.dateConfig?.timeZone ?? browserTimeZone()}
                loading={loading()}
                saveError={saveError()}
                nameTaken={nameTaken()}
                onNameInput={() => setNameTaken(false)}
                variant="dialog"
                onCancel={() => close(null)}
                onSave={(value) => void save(value)}
              />
            </PanelDialog>
          </LocaleProvider>
        );
      },
      {
        ...panelDialogOptions,
        ariaLabel: options.draft ? t.saveAsTemplate : options.kind === "event" ? t.newEventTemplate : t.newTaskTemplate,
      },
    )
    .then((template) => {
      // A dismissal by Escape or the backdrop resolves without a value.
      if (!template) return null;
      toast.success(t.templateSaved({ name: template.name }));
      return template;
    });
};
