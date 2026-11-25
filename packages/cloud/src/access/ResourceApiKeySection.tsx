import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, DateInput, Dialog, Empty, Facts, Field, Input, List, Menu, Notice, Row, Section, Select, useToast } from "@k2b/ui/v2";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { PermissionLevel } from "../contracts";
import { accessMessages } from "./messages";
import type { ResourceApiKey, ResourceApiKeyPermissionOption, ResourceApiKeysProps } from "./ResourceApiKeys";

type GrantablePermission = Exclude<PermissionLevel, "none">;
type Expiry = "30" | "90" | "365" | "never" | "date";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A day the person typed ("27.11.2026" or "2026-11-27") as the end of that day in their zone; null when unreadable. */
export const expiryFromDay = (text: string): string | null => {
  const value = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : dotted ? [dotted[3], dotted[2], dotted[1]] : [];
  if (!year || !month || !day) return null;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59);
  if (date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day) || date.getTime() <= Date.now()) return null;
  return date.toISOString();
};

/**
 * The API keys of one resource on a v2 screen: a section with each key as a row, "Neuer Schlüssel" in its head, the
 * new key's token shown once in a dialog, and revoking behind the row's "…" after a question. Same contract as
 * `ResourceApiKeys`; the app passes its create and revoke calls.
 */
export default function ResourceApiKeySection(props: ResourceApiKeysProps) {
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
  const [keys, setKeys] = createSignal<ResourceApiKey[]>(props.initialKeys);
  createEffect(() => setKeys(props.initialKeys));
  const [creating, setCreating] = createSignal(false);
  const [token, setToken] = createSignal<string | null>(null);
  const [revoking, setRevoking] = createSignal<string | null>(null);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  const permissionLabel = (permission: PermissionLevel) =>
    permission === "none" ? t().noAccess : (options().find((option) => option.value === permission)?.label ?? permission);
  const context = () => ({ locale: locale() });
  const line = (key: ResourceApiKey) =>
    [
      permissionLabel(key.permission),
      key.expiresAt ? t().expiresOn({ date: dates.formatDate(key.expiresAt, context()) }) : t().neverExpires,
      key.lastUsedAt ? t().used({ date: dates.formatDateTimeRelative(key.lastUsedAt, context()) }) : t().neverUsed,
    ].join(" · ");

  const revoke = async (key: ResourceApiKey) => {
    const agreed = await Dialog.confirm({ title: t().revokeApiKey, description: t().revokeConfirm({ name: key.name }), confirm: t().revoke, cancel: t().cancel });
    if (!agreed || !alive) return;
    setRevoking(key.id);
    try {
      await props.revokeKey(key.id);
      if (alive) setKeys(keys().filter((each) => each.id !== key.id));
    } catch (error) {
      if (alive) toast(error instanceof Error ? error.message : t().revokeApiKey, { status: "bad" });
    } finally {
      if (alive) setRevoking(null);
    }
  };

  return (
    <Section
      icon="key"
      title={props.title ?? t().apiKeys}
      count={keys().length || undefined}
      summary={props.description ?? t().apiKeysDescription}
      actions={[{ label: t().add, icon: "plus", onClick: () => setCreating(true) }]}
    >
      <Show when={keys().length > 0} fallback={<Empty icon="key" text={t().noApiKeys} />}>
        <List label={props.title ?? t().apiKeys}>
          <For each={keys()}>
            {(key) => (
              <Row
                icon="key"
                lines={[key.name, line(key)]}
                meta={`${key.tokenPrefix}…`}
                end={
                  <Menu
                    label={`${t().revokeApiKey}: ${key.name}`}
                    disabled={revoking() === key.id}
                    items={[{ label: t().revoke, icon: "key-off", danger: true, onClick: () => void revoke(key) }]}
                  />
                }
              />
            )}
          </For>
        </List>
      </Show>
      <CreateKeyDialog
        open={creating()}
        options={options()}
        onOpenChange={setCreating}
        create={async (input) => {
          const created = await props.createKey(input);
          if (!alive) return;
          setKeys((current) =>
            current.some((key) => key.id === created.credential.id)
              ? current.map((key) => (key.id === created.credential.id ? created.credential : key))
              : [created.credential, ...current],
          );
          setCreating(false);
          setToken(created.token);
        }}
      />
      <Dialog
        title={t().keyCreated}
        open={token() !== null}
        onOpenChange={(open) => {
          if (!open) setToken(null);
        }}
        foot={
          <Button variant="primary" onClick={() => setToken(null)}>
            {t().keyDone}
          </Button>
        }
      >
        <Notice tone="warn" icon="alert-triangle">
          {t().copyOnce}
        </Notice>
        <Facts items={[{ label: t().apiKeys, value: token() ?? "", mono: true, copy: token() ?? "" }]} />
      </Dialog>
    </Section>
  );
}

function CreateKeyDialog(props: {
  open: boolean;
  options: ResourceApiKeyPermissionOption[];
  onOpenChange: (open: boolean) => void;
  create: (input: { name: string; permission: GrantablePermission; expiresAt: string | null }) => Promise<void>;
}) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [permission, setPermission] = createSignal<string>("");
  const [expiry, setExpiry] = createSignal<Expiry>("90");
  const [day, setDay] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const chosen = (): GrantablePermission => props.options.find((option) => option.value === permission())?.value ?? props.options[0]?.value ?? "read";
  const expiresAt = () => (expiry() === "never" ? null : expiry() === "date" ? expiryFromDay(day()) : new Date(Date.now() + Number(expiry()) * DAY_MS).toISOString());
  const dayInvalid = () => expiry() === "date" && expiresAt() === null;
  const close = (open: boolean) => {
    if (busy()) return;
    props.onOpenChange(open);
    if (!open) {
      setName("");
      setPermission("");
      setExpiry("90");
      setDay("");
      setTried(false);
      setError(null);
    }
  };
  const submit = async () => {
    setTried(true);
    if (!name().trim() || dayInvalid() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.create({ name: name().trim(), permission: chosen(), expiresAt: expiresAt() });
      setBusy(false);
      close(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().createApiKey);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().createApiKey}
      open={props.open}
      onOpenChange={close}
      foot={
        <>
          <Button onClick={() => close(false)} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void submit()}>
            {t().createKey}
          </Button>
        </>
      }
    >
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
      <Field name="name" label={t().name} hint={t().keyNameDescription} required error={tried() && !name().trim() ? t().nameRequired : undefined}>
        <Input value={name()} placeholder={t().namePlaceholder} onInput={setName} />
      </Field>
      <Show when={props.options.length > 1}>
        <Field name="permission" label={t().access} hint={props.options.find((option) => option.value === chosen())?.description}>
          <Select options={props.options.map((option) => ({ value: option.value, label: option.label }))} value={chosen()} onChange={setPermission} />
        </Field>
      </Show>
      <Field name="expires" label={t().expires} hint={t().expiryDescription}>
        <Select
          options={[
            { value: "30", label: t().days30 },
            { value: "90", label: t().days90 },
            { value: "365", label: t().year1 },
            { value: "never", label: t().never },
            { value: "date", label: t().certainDay },
          ]}
          value={expiry()}
          onChange={(value) => setExpiry(value === "30" || value === "365" || value === "never" || value === "date" ? value : "90")}
        />
      </Field>
      <Show when={expiry() === "date"}>
        {/* k2b-ui gap: DateInput gives the typed text, without a picker yet; the day is read here. */}
        <Field name="day" label={t().expires} error={tried() && dayInvalid() ? t().expiryDayInvalid : undefined}>
          <DateInput value={day()} onInput={setDay} placeholder={t().dayPlaceholder} />
        </Field>
      </Show>
    </Dialog>
  );
}
