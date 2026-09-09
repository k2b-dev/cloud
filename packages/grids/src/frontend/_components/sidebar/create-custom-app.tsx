import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, dialogCore, PanelDialog, panelDialogOptions, prompts, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "../../../api/client";
import { errorMessage } from "../utils/api-helpers";
import { sidebarMessages } from "./messages";

type CreatedCustomApp = { id: string };

export function createCustomAppAction(props: { baseId: string }) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  const createMutation = mutations.create<CreatedCustomApp, string>({
    mutation: async (name) => {
      const response = await apiClient.apps["by-base"][":baseId"].$post({
        param: { baseId: props.baseId },
        json: { name },
      });
      if (!response.ok) throw new Error(await errorMessage(response, t.createAppFailed));
      return response.json();
    },
    onSuccess: (app) => navigateTo(`/app/grids/${props.baseId}/apps/${app.id}?edit=true&settings=app`),
    onError: (error) => prompts.error(error.message),
  });

  const createApp = async () => {
    const name = await dialogCore.open<string | null>((close) => {
      const [value, setValue] = createSignal("");
      return (
        <PanelDialog>
          <PanelDialog.Header title={t.newApp} subtitle={t.newAppSubtitle} icon="ti ti-app-window" close={() => close(null)} />
          <PanelDialog.Body>
            <TextInput label={t.name} value={value} onValueChange={setValue} placeholder={t.appNameExample} required />
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span />
            <div class="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => close(null)}>
                {t.cancel}
              </Button>
              <Button size="sm" onClick={() => value().trim() && close(value().trim())}>
                {t.create}
              </Button>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    }, panelDialogOptions);
    if (name) await createMutation.mutate(name);
  };

  return createApp;
}
