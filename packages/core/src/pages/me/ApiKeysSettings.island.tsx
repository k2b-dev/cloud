import { dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CopyButton, DateTimePicker, NoticeCard, Placeholder, prompts, TextInput, useLocale } from "@k2b/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import type { ServiceAccountCredential } from "@k2b/cloud/contracts";
import { createSignal, For, Show } from "solid-js";
import { accountMessages } from "./messages";

type Props = {
  initialKeys: ServiceAccountCredential[];
  surface?: "paper" | "section";
};

const presetDate = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const hasInstantOffset = (value: string) => /[T\s].*([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
const toInstant = (value: string | null): string | null => {
  if (!value) return null;
  if (hasInstantOffset(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function TokenDialog(props: { token: string }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-4">
      <NoticeCard tone="warning" icon={false}>
        {t().apiKeyOneTime}
      </NoticeCard>
      <div class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <code class="block break-all font-mono text-xs text-primary">{props.token}</code>
      </div>
      <div class="flex justify-end">
        <CopyButton text={props.token} label={t().copyKey} variant="primary" size="sm" />
      </div>
    </div>
  );
}

function ApiKeyCreateDialog(props: { close: (value: { name: string; expiresAt: string | null } | null) => void }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [expiresAt, setExpiresAt] = createSignal<string | null>(presetDate(90));
  const [error, setError] = createSignal<string | undefined>();

  const submit = () => {
    const trimmedName = name().trim();
    if (!trimmedName) {
      setError(t().passkeyNameRequired);
      return;
    }
    props.close({ name: trimmedName, expiresAt: toInstant(expiresAt()) });
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
        description={t().apiKeyNameDescription}
        placeholder={t().apiKeyNamePlaceholder}
        icon="ti ti-tag"
        value={name}
        onValueChange={(value) => {
          setName(value);
          setError(undefined);
        }}
        error={error}
        required
      />
      <DateTimePicker
        label={t().expires}
        description={t().apiKeyExpiryDescription}
        value={expiresAt}
        onValueChange={setExpiresAt}
        clearable
        presets={[
          { label: t().days30, value: presetDate(30) },
          { label: t().days90, value: presetDate(90) },
          { label: t().year1, value: presetDate(365) },
          { label: t().never, value: null },
        ]}
      />
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm">
          <i class="ti ti-plus" />
          {t().createKey}
        </Button>
      </div>
    </form>
  );
}

export default function ApiKeysSettings(props: Props) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [keys, setKeys] = createSignal<ServiceAccountCredential[]>(props.initialKeys);
  const rootClass = () => (props.surface === "section" ? "min-w-0" : "paper p-5");

  const createMutation = mutations.create<
    { credential: ServiceAccountCredential; token: string },
    { name: string; expiresAt: string | null }
  >({
    mutation: async (vars) => {
      const res = await apiClient.me["api-keys"].$post({ json: vars });
      const data = await res.json();
      if (!res.ok) throw new Error(t().apiKeyCreateFailed);
      return data as { credential: ServiceAccountCredential; token: string };
    },
    onSuccess: async (data) => {
      setKeys([data.credential, ...keys()]);
      await prompts.dialog<void>(() => <TokenDialog token={data.token} />, {
        title: t().apiKeyCreated,
        icon: "ti ti-key",
        size: "medium",
      });
    },
    onError: (err) => prompts.error(err.message),
  });

  const revokeMutation = mutations.create<void, { id: string; name: string }, { id: string }>({
    onBefore: (vars) => ({ id: vars.id }),
    mutation: async (vars) => {
      const res = await apiClient.me["api-keys"][":id"].$delete({ param: { id: vars.id } });
      if (!res.ok) {
        throw new Error(t().apiKeyRevokeFailed);
      }
    },
    onSuccess: (_, ctx) => {
      if (ctx?.id) setKeys(keys().filter((key) => key.id !== ctx.id));
    },
    onError: (err) => prompts.error(err.message),
  });

  const openCreate = async () => {
    const result = await prompts.dialog<{ name: string; expiresAt: string | null } | null>(
      (close) => <ApiKeyCreateDialog close={close} />,
      { title: t().createApiKey, icon: "ti ti-key", size: "medium" },
    );
    if (result) await createMutation.mutate(result);
  };

  const revoke = async (key: ServiceAccountCredential) => {
    const confirmed = await prompts.confirm(t().revokeApiKeyConfirm({ name: key.name }), {
      title: t().revokeApiKey,
      icon: "ti ti-key-off",
      variant: "danger",
      confirmText: t().revoke,
    });
    if (confirmed) await revokeMutation.mutate({ id: key.id, name: key.name });
  };

  return (
    <section class={rootClass()}>
      <div class="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-primary">
            <i class="ti ti-key text-sm" />
            {t().apiKeys}
          </h2>
          <p class="mt-1 text-xs text-dimmed">{t().apiKeysDescription}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" class="shrink-0" onClick={openCreate} disabled={createMutation.loading()}>
          <i class="ti ti-plus" />
          {t().add}
        </Button>
      </div>

      <Show when={keys().length > 0} fallback={<Placeholder surface="paper" icon="ti ti-key" description={<>{t().noApiKeys}</>} />}>
        <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
          <For each={keys()}>
            {(key) => (
              <div class="flex items-center gap-3 p-3">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-sm font-medium text-primary">{key.name}</span>
                    <span class="tag bg-zinc-100 text-dimmed dark:bg-zinc-800">{key.tokenPrefix}</span>
                  </div>
                  <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dimmed">
                    <span>{t().created({ date: dates.formatDate(key.createdAt, { locale: locale() }) })}</span>
                    <span>
                      {key.expiresAt ? t().expiresOn({ date: dates.formatDate(key.expiresAt, { locale: locale() }) }) : t().neverExpires}
                    </span>
                    <span>
                      {key.lastUsedAt
                        ? t().used({ date: dates.formatDateTimeRelative(key.lastUsedAt, { locale: locale() }) })
                        : t().neverUsed}
                    </span>
                  </div>
                </div>
                <Button type="button" variant="ghost" size="sm" class="shrink-0 text-red-600 dark:text-red-400" onClick={() => revoke(key)}>
                  <i class="ti ti-trash" />
                  {t().revoke}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
