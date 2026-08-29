import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, dialogCore, PanelDialog, panelDialogOptions, prompts, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "../../../api/client";
import { errorMessage } from "../utils/api-helpers";
import { sidebarMessages } from "./messages";

type CreatedCustomApp = { id: string };

export default function CreateCustomAppButton(props: { baseId: string }) {
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
    if (name) createMutation.mutate(name);
  };

  return (
    <AppWorkspace.SidebarItem tone="success" disabled={createMutation.loading()} onClick={() => void createApp()}>
      <AppWorkspace.SidebarItemIcon icon={createMutation.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"} />
      <AppWorkspace.SidebarItemLabel>{t.newAppAction}</AppWorkspace.SidebarItemLabel>
    </AppWorkspace.SidebarItem>
  );
}
