import { coreClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CopyButton, dialogCore, NoticeCard, PanelDialog, prompts, RemoveButton } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { apiClient } from "@/api/client";
import { usePageSwap } from "@/frontend/lib/page-swap";
import { useAccountsMessages } from "../messages";

type Props = {
  credentialId: string;
  name: string;
  disabled?: boolean;
  /** An agent's older key with narrower scopes: offer a new key that acts as the agent, then revoke this one. */
  replace?: { serviceAccountId: string };
};

const revokeCredential = async (credentialId: string, fallback: string) => {
  const res = await apiClient["service-accounts"].credentials[":id"].$delete({ param: { id: credentialId } });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.message ?? fallback);
  }
};

/**
 * Replacing creates the new key first and shows it once; the old key is revoked only on an explicit click. Closing
 * earlier keeps both keys, so a program that still uses the old one never stops by surprise.
 */
function ReplaceKeyDialog(props: { name: string; serviceAccountId: string; credentialId: string; close: (changed: boolean) => void }) {
  const t = useAccountsMessages();
  const [token, setToken] = createSignal<string | null>(null);
  const create = mutations.create<string, void>({
    mutation: async () => {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"].$post({
        param: { id: props.serviceAccountId },
        json: { name: props.name, access: "full", expiresAt: null },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = z.object({ message: z.string() }).safeParse(body);
        throw new Error(error.success ? error.data.message : t().replaceKeyFailed);
      }
      return z.object({ token: z.string() }).parse(body).token;
    },
    onSuccess: setToken,
  });
  const revoke = mutations.create<void, void>({
    mutation: () => revokeCredential(props.credentialId, t().revokeApiKeyFailed),
    onSuccess: () => props.close(true),
  });
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().replaceKeyTitle({ name: props.name })}
        close={() => props.close(token() !== null)}
        closeDisabled={create.loading() || revoke.loading()}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <p class="text-sm text-secondary">{t().replaceKeyIntro}</p>
          <Show when={token()}>
            {(value) => (
              <>
                <NoticeCard tone="warning">{t().machineKeyOneTime}</NoticeCard>
                <code class="break-all rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 text-xs text-primary">
                  {value()}
                </code>
                <div>
                  <CopyButton text={value()} label={t().copyMachineKey} />
                </div>
              </>
            )}
          </Show>
          <Show when={create.error() ?? revoke.error()}>
            {(error) => (
              <NoticeCard tone="danger" role="alert">
                {error().message}
              </NoticeCard>
            )}
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="flex w-full justify-end gap-2">
          <Show
            when={token()}
            fallback={
              <>
                <Button variant="secondary" disabled={create.loading()} onClick={() => props.close(false)}>
                  {t().cancel}
                </Button>
                <Button loading={create.loading()} onClick={() => void create.mutate()}>
                  {t().replaceKeyCreate}
                </Button>
              </>
            }
          >
            <Button variant="secondary" disabled={revoke.loading()} onClick={() => props.close(true)}>
              {t().replaceKeyLater}
            </Button>
            <Button variant="danger" loading={revoke.loading()} onClick={() => void revoke.mutate()}>
              {t().replaceKeyRevokeOld}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function ServiceAccountCredentialActions(props: Props) {
  const { showChanges } = usePageSwap();
  const messages = useAccountsMessages();
  const revokeMutation = mutations.create<void, void>({
    mutation: () => revokeCredential(props.credentialId, messages().revokeApiKeyFailed),
    onSuccess: () => showChanges(),
    onError: (error) => prompts.error(error.message),
  });

  const revoke = async () => {
    const confirmed = await prompts.confirm(messages().revokeApiKeyConfirm({ name: props.name }), {
      title: messages().revokeApiKey,
      icon: "ti ti-key-off",
      confirmText: messages().revoke,
      cancelText: messages().cancel,
      variant: "danger",
    });
    if (confirmed) await revokeMutation.mutate();
  };

  const replace = async (serviceAccountId: string) => {
    const changed = await dialogCore.open<boolean>(
      (close) => <ReplaceKeyDialog name={props.name} serviceAccountId={serviceAccountId} credentialId={props.credentialId} close={close} />,
      { ariaLabel: messages().replaceKeyTitle({ name: props.name }) },
    );
    if (changed) await showChanges();
  };

  return (
    <span class="inline-flex items-center gap-1">
      <Show when={props.replace && !props.disabled ? props.replace : undefined}>
        {(target) => (
          <Button
            variant="text"
            size="sm"
            aria-label={messages().replaceKeyLabel({ name: props.name })}
            onClick={() => void replace(target().serviceAccountId)}
          >
            {messages().replaceKey}
          </Button>
        )}
      </Show>
      <RemoveButton
        ariaLabel={messages().revokeApiKeyLabel({ name: props.name })}
        onClick={revoke}
        loading={revokeMutation.loading()}
        disabled={props.disabled}
      />
    </span>
  );
}
