import { dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { NoticeCard, Button, CopyButton, DateTimePicker, Placeholder, prompts, Select, Tag, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { PermissionLevel, ServiceAccountCredential } from "../contracts/shared";
import { accessMessages } from "./messages";

type GrantablePermission = Exclude<PermissionLevel, "none">;

export type ResourceApiKey = ServiceAccountCredential & {
  permission: PermissionLevel;
};

export type ResourceApiKeyPermissionOption = {
  value: GrantablePermission;
  label: string;
  description: string;
  icon?: string;
};

type CreateResourceApiKeyInput = {
  name: string;
  expiresAt: string | null;
  permission: GrantablePermission;
};

export type ResourceApiKeysProps = {
  title?: string;
  description?: string;
  initialKeys: ResourceApiKey[];
  permissionOptions?: ResourceApiKeyPermissionOption[];
  createKey: (input: CreateResourceApiKeyInput) => Promise<{ credential: ResourceApiKey; token: string }>;
  revokeKey: (credentialId: string) => Promise<void>;
};

const defaultPermissions = (t: ReturnType<typeof accessMessages.resolve>["t"]): ResourceApiKeyPermissionOption[] => [
  { value: "read", label: t.read, description: t.readDescription, icon: "ti ti-eye" },
  { value: "write", label: t.write, description: t.writeDescription, icon: "ti ti-pencil" },
  { value: "admin", label: t.admin, description: t.adminDescription, icon: "ti ti-shield" },
];

const presetDate = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const hasInstantOffset = (value: string) => /[T\s].*([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
const toInstant = (value: string | null): string | null => {
  if (!value) return null;
  if (hasInstantOffset(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const permissionLabel = (permission: PermissionLevel, options: ResourceApiKeyPermissionOption[], noAccess: string) =>
  permission === "none" ? noAccess : (options.find((option) => option.value === permission)?.label ?? permission);

function TokenDialog(props: { token: string }) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-4">
      <NoticeCard tone="warning" icon={false}>
        {t().copyOnce}
      </NoticeCard>
      <div class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <code class="block break-all font-mono text-xs text-primary">{props.token}</code>
      </div>
      <div class="flex justify-end">
        <CopyButton text={props.token} label={t().copyKey} />
      </div>
    </div>
  );
}

function CreateResourceApiKeyDialog(props: {
  permissionOptions: ResourceApiKeyPermissionOption[];
  close: (value: CreateResourceApiKeyInput | null) => void;
}) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [permission, setPermission] = createSignal<GrantablePermission>(props.permissionOptions[0]?.value ?? "read");
  const [expiresAt, setExpiresAt] = createSignal<string | null>(presetDate(90));
  const [error, setError] = createSignal<string | undefined>();
  const selectOptions = () =>
    props.permissionOptions.map((option) => ({
      id: option.value,
      label: option.label,
      description: option.description,
      icon: option.icon ?? "ti ti-key",
    }));

  const submit = () => {
    const trimmedName = name().trim();
    if (!trimmedName) {
      setError(t().nameRequired);
      return;
    }
    props.close({ name: trimmedName, permission: permission(), expiresAt: toInstant(expiresAt()) });
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
        description={t().keyNameDescription}
        placeholder={t().namePlaceholder}
        icon="ti ti-tag"
        value={name}
        onValueChange={(value) => {
          setName(value);
          setError(undefined);
        }}
        error={error}
        required
      />
      <Select
        label={t().access}
        description={t().keyAccessDescription}
        icon="ti ti-shield-lock"
        value={permission}
        onValueChange={(value) => setPermission(value as GrantablePermission)}
        options={selectOptions()}
        required
      />
      <DateTimePicker
        label={t().expires}
        description={t().expiryDescription}
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
        <Button type="submit" variant="primary" size="sm">
          <i class="ti ti-plus" />
          {t().createKey}
        </Button>
      </div>
    </form>
  );
}

export default function ResourceApiKeys(props: ResourceApiKeysProps) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const dateContext = () => ({ locale: locale() });
  const options = () => (props.permissionOptions && props.permissionOptions.length > 0 ? props.permissionOptions : defaultPermissions(t()));
  const [keys, setKeys] = createSignal<ResourceApiKey[]>(props.initialKeys);

  createEffect(() => {
    setKeys(props.initialKeys);
  });

  const createMutation = mutations.create<{ credential: ResourceApiKey; token: string }, CreateResourceApiKeyInput>({
    mutation: props.createKey,
    onSuccess: async (data) => {
      setKeys([data.credential, ...keys()]);
      await prompts.dialog<void>(() => <TokenDialog token={data.token} />, {
        title: t().keyCreated,
        icon: "ti ti-key",
        size: "medium",
      });
    },
    onError: (error) => prompts.error(error.message),
  });

  const revokeMutation = mutations.create<void, { id: string; name: string }, { id: string }>({
    onBefore: (vars) => ({ id: vars.id }),
    mutation: async (vars) => props.revokeKey(vars.id),
    onSuccess: (_, ctx) => {
      if (ctx?.id) setKeys(keys().filter((key) => key.id !== ctx.id));
    },
    onError: (error) => prompts.error(error.message),
  });

  const openCreate = async () => {
    const result = await prompts.dialog<CreateResourceApiKeyInput | null>(
      (close) => <CreateResourceApiKeyDialog permissionOptions={options()} close={close} />,
      { title: t().createApiKey, icon: "ti ti-key", size: "medium" },
    );
    if (result) await createMutation.mutate(result);
  };

  const revoke = async (key: ResourceApiKey) => {
    const confirmed = await prompts.confirm(t().revokeConfirm({ name: key.name }), {
      title: t().revokeApiKey,
      icon: "ti ti-key-off",
      variant: "danger",
      confirmText: t().revoke,
    });
    if (confirmed) await revokeMutation.mutate({ id: key.id, name: key.name });
  };

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="flex items-center gap-1.5 text-sm font-semibold text-primary">
            <i class="ti ti-key text-sm" />
            {props.title ?? t().apiKeys}
          </h3>
          <p class="mt-1 text-xs text-dimmed">{props.description ?? t().apiKeysDescription}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" class="shrink-0" onClick={openCreate} disabled={createMutation.loading()}>
          <i class="ti ti-plus" />
          {t().add}
        </Button>
      </div>

      <Show
        when={keys().length > 0}
        fallback={
          <Placeholder
            icon="ti ti-key"
            class="rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800"
            description={t().noApiKeys}
          />
        }
      >
        <div class="flex flex-col gap-2">
          <For each={keys()}>
            {(key) => (
              <div class="group/api-key flex items-center gap-3 rounded-lg bg-zinc-50/70 p-3 dark:bg-zinc-900/35">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-sm font-medium text-primary">{key.name}</span>
                    <Tag color={key.permission === "none" ? "#dc2626" : "#2563eb"}>
                      {permissionLabel(key.permission, options(), t().noAccess)}
                    </Tag>
                    <Tag>{key.tokenPrefix}</Tag>
                  </div>
                  <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dimmed">
                    <span>{t().created({ date: dates.formatDate(key.createdAt, dateContext()) })}</span>
                    <span>
                      {key.expiresAt ? t().expiresOn({ date: dates.formatDate(key.expiresAt, dateContext()) }) : t().neverExpires}
                    </span>
                    <span>
                      {key.lastUsedAt ? t().used({ date: dates.formatDateTimeRelative(key.lastUsedAt, dateContext()) }) : t().neverUsed}
                    </span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="shrink-0 text-red-600 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/api-key:opacity-100 sm:group-focus-within/api-key:opacity-100 dark:text-red-400"
                  onClick={() => revoke(key)}
                >
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
