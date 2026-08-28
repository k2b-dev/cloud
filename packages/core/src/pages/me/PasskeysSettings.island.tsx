import { dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Placeholder, prompts, TextInput, useLocale } from "@k2b/ui";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import type { WebAuthnPasskey } from "@valentinkolb/cloud/contracts";
import { createSignal, For, Show } from "solid-js";
import { accountMessages } from "./messages";

type Props = {
  initialPasskeys: WebAuthnPasskey[];
  surface?: "paper" | "section";
};

function PasskeyCreateDialog(props: { close: (value: { name: string } | null) => void }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();

  const submit = () => {
    const trimmedName = name().trim();
    if (!trimmedName) {
      setError(t().passkeyNameRequired);
      return;
    }
    props.close({ name: trimmedName });
  };

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextInput
        label={t().name}
        description={t().passkeyNameDescription}
        placeholder={t().passkeyNamePlaceholder}
        icon="ti ti-tag"
        value={name}
        onValueChange={(value) => {
          setName(value);
          setError(undefined);
        }}
        error={error}
        required
      />
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm">
          <i class="ti ti-fingerprint" />
          {t().addPasskey}
        </Button>
      </div>
    </form>
  );
}

export default function PasskeysSettings(props: Props) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [passkeys, setPasskeys] = createSignal<WebAuthnPasskey[]>(props.initialPasskeys);
  const rootClass = () => (props.surface === "section" ? "min-w-0" : "paper p-5");

  const createMutation = mutations.create<WebAuthnPasskey, { name: string }>({
    mutation: async (vars) => {
      if (!browserSupportsWebAuthn()) throw new Error(t().passkeysUnsupported);
      const optionsRes = await apiClient.me.passkeys.registration.start.$post();
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(t().passkeyRegistrationFailed);

      const response = await startRegistration({ optionsJSON: options as never });
      const verifyRes = await apiClient.me.passkeys.registration.verify.$post({
        json: { name: vars.name, response },
      });
      const data = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(t().passkeyAddFailed);
      return data as WebAuthnPasskey;
    },
    onSuccess: (passkey) => {
      setPasskeys([passkey, ...passkeys()]);
    },
    onError: (err) => prompts.error(err.message),
  });

  const deleteMutation = mutations.create<void, { id: string; name: string }, { id: string }>({
    onBefore: (vars) => ({ id: vars.id }),
    mutation: async (vars) => {
      const res = await apiClient.me.passkeys[":id"].$delete({ param: { id: vars.id } });
      if (!res.ok) {
        throw new Error(t().passkeyDeleteFailed);
      }
    },
    onSuccess: (_, ctx) => {
      if (ctx?.id) setPasskeys(passkeys().filter((passkey) => passkey.id !== ctx.id));
    },
    onError: (err) => prompts.error(err.message),
  });

  const openCreate = async () => {
    const result = await prompts.dialog<{ name: string } | null>((close) => <PasskeyCreateDialog close={close} />, {
      title: t().addPasskey,
      icon: "ti ti-fingerprint",
      size: "medium",
    });
    if (result) await createMutation.mutate(result);
  };

  const remove = async (passkey: WebAuthnPasskey) => {
    const confirmed = await prompts.confirm(t().deletePasskeyConfirm({ name: passkey.name }), {
      title: t().deletePasskey,
      icon: "ti ti-fingerprint-off",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) await deleteMutation.mutate({ id: passkey.id, name: passkey.name });
  };

  return (
    <section class={rootClass()}>
      <div class="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-primary">
            <i class="ti ti-fingerprint text-sm" />
            {t().passkeys}
          </h2>
          <p class="mt-1 text-xs text-dimmed">{t().passkeysDescription}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" class="shrink-0" onClick={openCreate} disabled={createMutation.loading()}>
          <i class="ti ti-plus" />
          {t().add}
        </Button>
      </div>

      <Show
        when={passkeys().length > 0}
        fallback={<Placeholder surface="paper" icon="ti ti-fingerprint" description={<>{t().noPasskeys}</>} />}
      >
        <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
          <For each={passkeys()}>
            {(passkey) => (
              <div class="flex items-center gap-3 p-3">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-sm font-medium text-primary">{passkey.name}</span>
                    {passkey.backedUp && (
                      <span class="tag bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">{t().synced}</span>
                    )}
                  </div>
                  <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dimmed">
                    <span>{t().created({ date: dates.formatDate(passkey.createdAt, { locale: locale() }) })}</span>
                    <span>
                      {passkey.lastUsedAt
                        ? t().used({ date: dates.formatDateTimeRelative(passkey.lastUsedAt, { locale: locale() }) })
                        : t().neverUsed}
                    </span>
                    {passkey.transports.length > 0 && <span>{passkey.transports.join(", ")}</span>}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="shrink-0 text-red-600 dark:text-red-400"
                  onClick={() => remove(passkey)}
                >
                  <i class="ti ti-trash" />
                  {t().delete}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
