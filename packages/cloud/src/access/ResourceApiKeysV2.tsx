import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import {
  Button,
  Chip,
  Choice,
  confirm,
  DateInput,
  Dialog,
  Empty,
  Facts,
  Field,
  Input,
  Menu,
  Notice,
  Row,
  Section,
  Select,
  useToast,
} from "@k2b/ui/v2";
import { createEffect, createSignal, For, Show } from "solid-js";
import { accessMessages } from "./messages";
import type { ResourceApiKey, ResourceApiKeyPermissionOption, ResourceApiKeysProps } from "./ResourceApiKeys";

type Grantable = ResourceApiKeyPermissionOption["value"];
type Expiry = "30" | "90" | "365" | "never" | "date";

const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
/** A picked day (a date key such as "2027-12-31") as the end of that day here, or `null` when it is none or past. */
const endOfDay = (key: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  return Number.isNaN(date.getTime()) || date.getTime() < Date.now() ? null : date.toISOString();
};

/**
 * The API keys of one resource on v2: one row per key with its level, prefix, dates and "Revoke"; a new key in a v2
 * dialog (name, level, expiry), its token shown once to copy. The same props, calls and results as `ResourceApiKeys`.
 * A `Section`, so it stands in a v2 pane or as `extraSections` of the v2 access dialog.
 */
export function ResourceApiKeysV2(props: ResourceApiKeysProps) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const toast = useToast();
  const options = (): ResourceApiKeyPermissionOption[] =>
    props.permissionOptions?.length
      ? props.permissionOptions
      : [
          { value: "read", label: t().read, description: t().readDescription },
          { value: "write", label: t().write, description: t().writeDescription },
          { value: "admin", label: t().admin, description: t().adminDescription },
        ];
  const levelLabel = (key: ResourceApiKey) =>
    key.permission === "none" ? t().noAccess : (options().find((option) => option.value === key.permission)?.label ?? key.permission);
  const [keys, setKeys] = createSignal<ResourceApiKey[]>(props.initialKeys);
  createEffect(() => setKeys(props.initialKeys));

  // ── Create ────────────────────────────────────────────────────────────
  const [creating, setCreating] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal("");
  const [level, setLevel] = createSignal<Grantable>("read");
  const [expiry, setExpiry] = createSignal<Expiry>("90");
  const [date, setDate] = createSignal("");
  const [nameError, setNameError] = createSignal<string>();
  const [dateError, setDateError] = createSignal<string>();
  const [createFailed, setCreateFailed] = createSignal<string>();
  const [token, setToken] = createSignal<string>();
  const openCreate = () => {
    setName("");
    setLevel(options()[0]?.value ?? "read");
    setExpiry("90");
    setDate("");
    setNameError(undefined);
    setDateError(undefined);
    setCreateFailed(undefined);
    setCreating(true);
  };
  const expiresAt = (): string | null | undefined =>
    expiry() === "never" ? null : expiry() === "date" ? (endOfDay(date()) ?? undefined) : inDays(Number(expiry()));
  const create = async () => {
    if (busy()) return;
    const trimmed = name().trim();
    if (!trimmed) return void setNameError(t().nameRequired);
    const until = expiresAt();
    if (until === undefined) return void setDateError(t().dateInvalid);
    setBusy(true);
    setCreateFailed(undefined);
    try {
      const result = await props.createKey({ name: trimmed, permission: level(), expiresAt: until });
      setKeys((current) =>
        current.some((key) => key.id === result.credential.id)
          ? current.map((key) => (key.id === result.credential.id ? result.credential : key))
          : [result.credential, ...current],
      );
      setCreating(false);
      setToken(result.token);
    } catch (error) {
      setCreateFailed(error instanceof Error ? error.message : t().createFailed);
    } finally {
      setBusy(false);
    }
  };

  // ── Revoke ────────────────────────────────────────────────────────────
  const revoke = async (key: ResourceApiKey) => {
    const confirmed = await confirm({ title: t().revokeApiKey, description: t().revokeConfirm({ name: key.name }), confirm: t().revoke });
    if (!confirmed) return;
    try {
      await props.revokeKey(key.id);
      setKeys((current) => current.filter((entry) => entry.id !== key.id));
    } catch (error) {
      toast(error instanceof Error ? error.message : t().revokeFailed, { status: "bad", retry: () => void revoke(key) });
    }
  };

  const dateLine = (key: ResourceApiKey) =>
    [
      t().created({ date: dates.formatDate(key.createdAt, { locale: locale() }) }),
      key.expiresAt ? t().expiresOn({ date: dates.formatDate(key.expiresAt, { locale: locale() }) }) : t().neverExpires,
      key.lastUsedAt ? t().used({ date: dates.formatDateTimeRelative(key.lastUsedAt, { locale: locale() }) }) : t().neverUsed,
    ].join(" · ");

  return (
    <Section
      icon="key"
      title={props.title ?? t().apiKeys}
      count={keys().length}
      summary={props.description ?? t().apiKeysDescription}
      actions={[{ label: t().add, icon: "plus", onClick: openCreate }]}
    >
      <Show
        when={keys().length > 0}
        fallback={<Empty icon="key" text={t().noApiKeys} action={{ label: t().createKey, icon: "plus", onClick: openCreate }} />}
      >
        <For each={keys()}>
          {(key) => (
            <Row
              icon="key"
              lines={[key.name, dateLine(key)]}
              meta={key.tokenPrefix}
              end={
                <>
                  {key.permission === "none" ? <Chip status="bad">{levelLabel(key)}</Chip> : <Chip>{levelLabel(key)}</Chip>}
                  <Menu
                    label={t().keyActions({ name: key.name })}
                    items={[{ label: t().revoke, icon: "trash", danger: true, onClick: () => void revoke(key) }]}
                  />
                </>
              }
            />
          )}
        </For>
      </Show>

      <Dialog
        title={t().createApiKey}
        open={creating()}
        onOpenChange={(open) => {
          if (!open && !busy()) setCreating(false);
        }}
        foot={
          <>
            <Button disabled={busy()} onClick={() => setCreating(false)}>
              {t().cancel}
            </Button>
            <Button variant="primary" icon="plus" busy={busy()} onClick={() => void create()}>
              {t().createKey}
            </Button>
          </>
        }
      >
        <Field label={t().name} name="key-name" hint={t().keyNameDescription} error={nameError()} required>
          <Input
            value={name()}
            placeholder={t().namePlaceholder}
            onInput={(value) => {
              setName(value);
              setNameError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) void create();
            }}
          />
        </Field>
        <Field
          label={t().access}
          name="key-access"
          hint={options().find((option) => option.value === level())?.description ?? t().keyAccessDescription}
        >
          <Select
            value={level()}
            options={options().map((option) => ({ value: option.value, label: option.label }))}
            onChange={(value) => {
              const option = options().find((candidate) => candidate.value === value);
              if (option) setLevel(option.value);
            }}
          />
        </Field>
        <Field label={t().expires} name="key-expiry" hint={t().expiryDescription}>
          <Choice
            name="key-expiry"
            value={expiry()}
            options={[
              { value: "30", label: t().days30 },
              { value: "90", label: t().days90 },
              { value: "365", label: t().year1 },
              { value: "never", label: t().never },
              { value: "date", label: t().onDate },
            ]}
            onChange={(value) => {
              setExpiry(value as Expiry);
              setDateError(undefined);
            }}
          />
        </Field>
        <Show when={expiry() === "date"}>
          <Field label={t().expiryDate} name="key-expiry-date" error={dateError()}>
            <DateInput
              value={date()}
              placeholder="31.12.2027"
              onInput={(value) => {
                setDate(value);
                setDateError(undefined);
              }}
            />
          </Field>
        </Show>
        <Show when={createFailed()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      </Dialog>

      <Dialog
        title={t().keyCreated}
        open={token() !== undefined}
        // The token is shown once: a stray touch must not lose it.
        dismissible={false}
        onOpenChange={(open) => {
          if (!open) setToken(undefined);
        }}
        foot={
          <Button variant="primary" onClick={() => setToken(undefined)}>
            {t().done}
          </Button>
        }
      >
        <Notice tone="warn">{t().copyOnce}</Notice>
        <Facts items={[{ label: t().apiKey, value: token() ?? "", mono: true, copy: token() ?? "" }]} />
      </Dialog>
    </Section>
  );
}
