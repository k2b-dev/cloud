import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, SettingsSection, prompts, useLocale } from "@k2b/ui";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { Show } from "solid-js";
import { accountLinuxError, linuxAccountMessages } from "../../linux-messages";

export default function PrepareLinuxGroup(props: { id: string }) {
  const locale = useLocale();
  const t = () => linuxAccountMessages.resolve([locale()]).t;
  const action = mutation.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core["linux-identities"].groups[":id"].$post({ param: { id: props.id } });
      if (!response.ok) throw await accountLinuxError(response, t());
      refreshCurrentPath();
    },
  });
  return (
    <SettingsSection title={t().title} subtitle={t().groupDescription}>
      <Show when={action.error()}>
        <p role="alert" class="mb-3 text-sm text-red-700 dark:text-red-300">
          {action.error()?.message}
        </p>
      </Show>
      <Button
        size="sm"
        disabled={action.loading()}
        onClick={async () => {
          if (await prompts.confirm(t().groupConfirm, { title: t().title, confirmText: t().prepareGroup })) await action.mutate();
        }}
      >
        {t().prepareGroup}
      </Button>
    </SettingsSection>
  );
}
