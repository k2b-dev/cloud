import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts, SettingsSection, useLocale } from "@k2b/ui";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { Show } from "solid-js";
import { showAccountActionNotice } from "../../action-notice";
import { accountLinuxError, linuxAccountMessages } from "../../linux-messages";
import { useAccountsMessages } from "../../messages";

export default function PrepareLinuxGroup(props: { id: string }) {
  const messages = useAccountsMessages();
  const locale = useLocale();
  const t = () => linuxAccountMessages.resolve([locale()]).t;
  const action = mutation.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core["linux-identities"].groups[":id"].$post({ param: { id: props.id } });
      if (!response.ok) throw await accountLinuxError(response, t());
      await showAccountActionNotice({ action: "group.posix", id: props.id, provider: "local" }, messages());
      refreshCurrentPath();
    },
  });
  return (
    <SettingsSection title={t().title} subtitle={t().groupDescription}>
      <Show when={action.error()}>
        <NoticeCard tone="danger" role="alert">
          {action.error()?.message}
        </NoticeCard>
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
