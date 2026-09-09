import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, confirmDiscardIfDirty, dialogCore, InlineGuidance, PanelDialog, panelDialogOptions, TextInput, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { errorMessage } from "../utils/api-helpers";
import { sidebarMessages } from "./messages";

type CreatedCustomApp = { id: string };

export function createCustomAppAction(props: { baseId: string }) {
  const { t } = sidebarMessages.resolve([useLocale()()]);
  const createApp = async () => {
    const app = await dialogCore.open<CreatedCustomApp>((close, context) => {
      const [value, setValue] = createSignal("");
      const [submitted, setSubmitted] = createSignal(false);
      const createMutation = mutations.create<CreatedCustomApp, string>({
        mutation: async (name) => {
          const response = await apiClient.apps["by-base"][":baseId"].$post({
            param: { baseId: props.baseId },
            json: { name },
          });
          if (!response.ok) throw new Error(await errorMessage(response, t.createAppFailed));
          return response.json();
        },
        onSuccess: close,
      });
      const dismiss = async () => {
        if (!createMutation.loading() && (await confirmDiscardIfDirty(value().length > 0))) close();
      };
      context.setDismissHandler(dismiss);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (value().trim() && !createMutation.loading()) void createMutation.mutate(value().trim());
          }}
        >
          <PanelDialog>
            <PanelDialog.Header
              title={t.newApp}
              subtitle={t.newAppSubtitle}
              icon="ti ti-app-window"
              close={dismiss}
              closeDisabled={createMutation.loading()}
            />
            <PanelDialog.Body>
              <Show when={createMutation.error()}>{(error) => <InlineGuidance tone="danger">{error().message}</InlineGuidance>}</Show>
              <TextInput
                label={t.name}
                value={value}
                onValueChange={setValue}
                placeholder={t.appNameExample}
                required
                error={submitted() && !value().trim() ? t.requiredName : undefined}
                disabled={createMutation.loading()}
              />
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <span />
              <div class="flex gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={dismiss} disabled={createMutation.loading()}>
                  {t.cancel}
                </Button>
                <Button type="submit" size="sm" loading={createMutation.loading()}>
                  {t.create}
                </Button>
              </div>
            </PanelDialog.Footer>
          </PanelDialog>
        </form>
      );
    }, panelDialogOptions);
    if (app) navigateTo(`/app/grids/${props.baseId}/apps/${app.id}?edit=true&settings=app`);
  };

  return createApp;
}
