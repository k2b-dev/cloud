import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CopyButton, dialogCore, panelDialogWideOptions, prompts, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { CreateOAuthClient, OAuthClientWithSecret } from "@/contracts";
import OAuthClientDialog from "./OAuthClientDialog";
import { oauthMessages } from "../messages";

const CreateClientButton = () => {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  const mutation = mutations.create<OAuthClientWithSecret, CreateOAuthClient>({
    mutation: async (data) => {
      const res = await apiClient.index.$post({ json: data });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(t().failedCreate);
      }
      return result as OAuthClientWithSecret;
    },
    onSuccess: async (data) => {
      await prompts.alert(
        <div class="space-y-4">
          <div>
            <div class="text-xs text-dimmed mb-1">{t().clientId}</div>
            <div class="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 rounded px-3 py-2">
              <code class="text-sm flex-1 break-all">{data.clientId}</code>
              <CopyButton text={data.clientId} />
            </div>
          </div>
          {data.clientSecret && (
            <div>
              <div class="text-xs text-dimmed mb-1">{t().clientSecret}</div>
              <div class="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 rounded px-3 py-2">
                <code class="text-sm flex-1 break-all">{data.clientSecret}</code>
                <CopyButton text={data.clientSecret} />
              </div>
              <div class="text-xs text-amber-600 dark:text-amber-400 mt-2 flex items-center gap-1">
                <i class="ti ti-alert-triangle" />
                {t().saveSecretNow}
              </div>
            </div>
          )}
          {!data.clientSecret && <div class="text-xs text-dimmed">{t().publicNoSecret}</div>}
        </div>,
        { title: t().clientCreated, icon: "ti ti-check" },
      );
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleCreate = async () => {
    void dialogCore.open<void>(
      (close) => (
        <OAuthClientDialog
          mode="create"
          close={close}
          loading={mutation.loading}
          onSubmit={async (data) => {
            await mutation.mutate(data);
            if (!mutation.error()) close();
          }}
        />
      ),
      panelDialogWideOptions,
    );
  };

  return (
    <Button type="button" size="sm" onClick={handleCreate}>
      <i class="ti ti-plus" />
      {t().newClient}
    </Button>
  );
};

export default CreateClientButton;
