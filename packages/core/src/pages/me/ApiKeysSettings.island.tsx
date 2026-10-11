import { apiClient } from "@k2b/cloud/clients/core";
import { isModelsOnlyApiKey, type ServiceAccountCredential } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CopyButton,
  DateTimePicker,
  NoticeCard,
  Placeholder,
  prompts,
  Select,
  SettingsSection,
  Tag,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { accountMessages } from "./messages";

type Props = {
  initialKeys: ServiceAccountCredential[];
  /** Set while the operator offers the OpenAI-compatible API; models-only keys exist only then. */
  openAiBaseUrl: string | null;
};

type ApiKeyAccess = "full" | "models";
type ApiKeyDraft = { name: string; expiresAt: string | null; access?: ApiKeyAccess };

const presetDate = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const hasInstantOffset = (value: string) => /[T\s].*([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
const toInstant = (value: string | null): string | null => {
  if (!value) return null;
  if (hasInstantOffset(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function TokenDialog(props: { token: string; baseUrl: string | null }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-4">
      <NoticeCard tone="warning">{t().apiKeyOneTime}</NoticeCard>
      <div class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <code class="block break-all font-mono text-xs text-primary">{props.token}</code>
      </div>
      <Show when={props.baseUrl}>
        {(baseUrl) => (
          <div class="flex flex-col gap-1.5">
            <span class="text-sm font-medium text-primary">{t().openAiBaseUrl}</span>
            <div class="flex items-center gap-2">
              <code class="min-w-0 flex-1 break-all rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 font-mono text-xs text-secondary">
                {baseUrl()}
              </code>
              <CopyButton text={baseUrl()} label={t().copyBaseUrl} iconOnly size="sm" />
            </div>
            <p class="text-xs text-dimmed">{t().openAiBaseUrlDescription}</p>
          </div>
        )}
      </Show>
      <div class="flex justify-end">
        <CopyButton text={props.token} label={t().copyKey} variant="primary" size="sm" />
      </div>
    </div>
  );
}

function ApiKeyCreateDialog(props: { modelsOnlyAvailable: boolean; close: (value: ApiKeyDraft | null) => void }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [access, setAccess] = createSignal<ApiKeyAccess>("full");
  const [expiresAt, setExpiresAt] = createSignal<string | null>(presetDate(90));
  const [error, setError] = createSignal<string | undefined>();

  const submit = () => {
    const trimmedName = name().trim();
    if (!trimmedName) {
      setError(t().passkeyNameRequired);
      return;
    }
    props.close({
      name: trimmedName,
      expiresAt: toInstant(expiresAt()),
      ...(props.modelsOnlyAvailable ? { access: access() } : {}),
    });
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
      <Show when={props.modelsOnlyAvailable}>
        <Select
          label={t().keyAccess}
          description={t().keyAccessDescription}
          value={access}
          onValueChange={(value) => setAccess(value === "models" ? "models" : "full")}
          options={[
            { value: "full", label: t().fullAccess, description: t().fullAccessDescription, icon: "ti ti-key" },
            { value: "models", label: t().modelsOnly, description: t().modelsOnlyDescription, icon: "ti ti-sparkles" },
          ]}
        />
      </Show>
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

  const createMutation = mutations.create<{ credential: ServiceAccountCredential; token: string }, ApiKeyDraft>({
    mutation: async (vars) => {
      const res = await apiClient.me["api-keys"].$post({ json: vars });
      const data = await res.json();
      if (!res.ok) throw new Error(t().apiKeyCreateFailed);
      return data as { credential: ServiceAccountCredential; token: string };
    },
    onSuccess: async (data) => {
      setKeys([data.credential, ...keys()]);
      const baseUrl = isModelsOnlyApiKey(data.credential) ? props.openAiBaseUrl : null;
      await prompts.dialog<void>(() => <TokenDialog token={data.token} baseUrl={baseUrl} />, {
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
    const result = await prompts.dialog<ApiKeyDraft | null>(
      (close) => <ApiKeyCreateDialog modelsOnlyAvailable={props.openAiBaseUrl !== null} close={close} />,
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
    <SettingsSection
      title={t().apiKeys}
      subtitle={t().apiKeysDescription}
      actions={
        <Button type="button" variant="secondary" size="sm" onClick={openCreate} disabled={createMutation.loading()}>
          <i class="ti ti-plus" aria-hidden="true" />
          {t().add}
        </Button>
      }
    >
      <Show when={keys().length > 0} fallback={<Placeholder icon="ti ti-key" description={<>{t().noApiKeys}</>} />}>
        <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
          <For each={keys()}>
            {(key) => (
              <div class="flex items-center gap-3 p-3">
                <div class="min-w-0 flex-1">
                  {/* The name keeps its width; on narrow screens the prefix and access tag move to the next line. */}
                  <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="max-w-full shrink-0 truncate text-sm font-medium text-primary">{key.name}</span>
                    <span class="tag shrink-0 bg-zinc-100 text-dimmed dark:bg-zinc-800">{key.tokenPrefix}</span>
                    <Show when={isModelsOnlyApiKey(key)}>
                      <Tag icon="ti ti-sparkles" size="sm" class="shrink-0">
                        {t().modelsOnly}
                      </Tag>
                    </Show>
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
    </SettingsSection>
  );
}
