import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  dialogCore,
  InlineGuidance,
  PanelDialog,
  panelDialogOptions,
  TextInput,
} from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicBase } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import type { overviewMessages } from "./messages";

type Template = { id: string; name: string; icon: string };
export async function openCreateBase(t: ReturnType<typeof overviewMessages.resolve>["t"], template?: Template) {
  const base = await dialogCore.open<PublicBase>((close, context) => {
    const initialName = template?.name ?? "";
    const [name, setName] = createSignal(initialName);
    const [description, setDescription] = createSignal("");
    const [sampleData, setSampleData] = createSignal(true);
    const [submitted, setSubmitted] = createSignal(false);
    const save = mutations.create<PublicBase, void>({
      mutation: async () => {
        const response = template
          ? await apiClient.templates[":templateId"].$post({
              param: { templateId: template.id },
              json: { name: name().trim(), withSampleData: sampleData() },
            })
          : await apiClient.bases.$post({ json: { name: name().trim(), description: description().trim() || null } });
        if (!response.ok) throw new Error(await errorMessage(response, template ? t.createFromTemplateFailed : t.createBaseFailed));
        return response.json();
      },
      onSuccess: close,
    });
    const dismiss = async () => {
      if (!save.loading() && (await confirmDiscardIfDirty(name() !== initialName || description().length > 0 || !sampleData()))) close();
    };
    context.setDismissHandler(dismiss);
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (name().trim() && !save.loading()) void save.mutate();
        }}
      >
        <PanelDialog>
          <PanelDialog.Header
            title={template ? t.createTemplate({ name: template.name }) : t.newBase}
            icon={template?.icon ?? "ti ti-database-plus"}
            close={dismiss}
            closeDisabled={save.loading()}
          />
          <PanelDialog.Body>
            <div class="flex flex-col gap-4">
              <Show when={save.error()}>{(error) => <InlineGuidance tone="danger">{error().message}</InlineGuidance>}</Show>
              <TextInput
                label={t.name}
                description={template ? t.renameTemplateDescription : undefined}
                value={name}
                onValueChange={setName}
                placeholder={t.baseNameExample}
                required
                error={submitted() && !name().trim() ? t.requiredName : undefined}
                disabled={save.loading()}
              />
              <Show
                when={template}
                fallback={
                  <TextInput
                    label={t.description}
                    value={description}
                    onValueChange={setDescription}
                    multiline
                    placeholder={t.optional}
                    disabled={save.loading()}
                  />
                }
              >
                <CheckboxCard
                  label={t.includeSampleData}
                  description={t.includeSampleDataDescription}
                  value={sampleData}
                  onValueChange={setSampleData}
                  disabled={save.loading()}
                />
              </Show>
            </div>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span />
            <div class="flex gap-2">
              <Button type="button" variant="secondary" onClick={dismiss} disabled={save.loading()}>
                {t.cancel}
              </Button>
              <Button type="submit" loading={save.loading()}>
                {t.createBase}
              </Button>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      </form>
    );
  }, panelDialogOptions);
  if (base) navigateTo(`/app/grids/${base.id}`);
}
