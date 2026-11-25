import { coreClient } from "@k2b/cloud/clients/core";
import { dates } from "@k2b/stdlib";
import { Button, Choice, DateInput, Dialog, Facts, Field, Input, Lookup, Notice } from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { useAccountsMessages } from "../messages";
import { useApiKeyMessages } from "./messages";

/** Longest key name the server takes. */
const NAME_MAX = 120;
const CreatedSchema = z.object({ token: z.string().min(1) });
const AccountsSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) });

/**
 * The day a key's expiry names, typed as `2026-12-31` or `31.12.2026`, as the instant it stops: the start of the next
 * day in the person's time zone. `undefined` for a text that is no day, `null` for no expiry.
 */
export const expiryOf = (text: string, timeZone: string): string | null | undefined => {
  const value = text.trim();
  if (!value) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value);
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : german
      ? [Number(german[3]), Number(german[2]), Number(german[1])]
      : [];
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const next = new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return new Date(dates.zonedDateTimeToInstant(`${next}T00:00`, timeZone, { disambiguation: "compatible" })).toISOString();
};

/**
 * A new API key for an agent, from the API key list: the agent, a name, its purpose and an optional last day; then the
 * key itself, once, with a copy button. The token lives only in this dialog; closing it shows the list with the key.
 */
export default function MachineKeyDialog(props: {
  /** The agent the key is for, from its record; without it the dialog asks for the agent first. */
  account?: { id: string; name: string };
  modelsAvailable: boolean;
  /** The person's time zone: the last day ends at midnight there. */
  timeZone: string;
  /** Close the dialog; `changed` when a key was created or may have been, so the list must be read again. */
  close: (changed: boolean) => void;
}) {
  const t = useAccountsMessages();
  const words = useApiKeyMessages();
  const [agent, setAgent] = createSignal<LookupItem | null>(props.account ? { value: props.account.id, label: props.account.name } : null);
  const [name, setName] = createSignal("");
  const [access, setAccess] = createSignal<"full" | "models">(props.modelsAvailable ? "models" : "full");
  const [expires, setExpires] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A lost answer may follow a created key: offer no second creation, the list shows what exists.
  const [uncertain, setUncertain] = createSignal(false);
  const [token, setToken] = createSignal<string | null>(null);
  const known = new Map<string, LookupItem>();

  const nameError = () =>
    tried() && !name().trim() ? words().keyNameRequired : name().length > NAME_MAX ? t().machineKeyFailed : undefined;
  const expiry = () => expiryOf(expires(), props.timeZone);
  const expiresError = () => {
    if (!tried() && !expires().trim()) return undefined;
    const value = expiry();
    return value === undefined || (value !== null && Date.parse(value) <= Date.now()) ? words().expiresInvalid : undefined;
  };

  const load = async (search: string, context: { signal: AbortSignal; limit: number }) => {
    const response = await coreClient.admin.identity["service-accounts"].$get(
      { query: { search, status: "active", perPage: String(context.limit) } },
      { init: { signal: context.signal } },
    );
    if (!response.ok) throw new Error(t().machineAccountsFailed);
    const items = AccountsSchema.parse(await response.json()).items.map((account) => ({
      value: account.id,
      label: account.name,
      meta: t().agentServiceAccount,
    }));
    for (const item of items) known.set(item.value, item);
    return { items };
  };

  const create = async () => {
    setTried(true);
    const chosen = agent();
    const until = expiry();
    if (busy() || uncertain() || !chosen || nameError() || expiresError() || until === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"]
        .$post({ param: { id: chosen.value }, json: { name: name().trim(), access: access(), expiresAt: until } })
        .catch(() => null);
      const body: unknown = await response?.json().catch(() => null);
      if (response && !response.ok && response.status < 500) {
        const refused = z.object({ message: z.string() }).safeParse(body);
        setError(refused.success ? refused.data.message : t().machineKeyFailed);
        return;
      }
      const created = CreatedSchema.safeParse(response?.ok ? body : null);
      if (!created.success) {
        setUncertain(true);
        setError(t().machineKeyUncertain);
        return;
      }
      setToken(created.data.token);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (!busy()) props.close(token() !== null || uncertain());
  };
  const locked = () => busy() || uncertain();

  return (
    <Dialog
      title={token() ? words().created_ : props.account ? words().createKeyFor({ name: props.account.name }) : t().createMachineKey}
      open
      // While the token shows, an outside press or a swipe would lose the one copy: only "Done", × and Escape close.
      dismissible={token() === null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      foot={
        <Show
          when={token()}
          fallback={
            <>
              <Button onClick={close} disabled={busy()}>
                {t().cancel}
              </Button>
              <Button variant="primary" icon="key" busy={busy()} disabled={uncertain()} onClick={() => void create()}>
                {t().createMachineKey}
              </Button>
            </>
          }
        >
          <Button variant="primary" onClick={close}>
            {t().done}
          </Button>
        </Show>
      }
    >
      <Show
        when={token()}
        fallback={
          <>
            <Show when={!props.account}>
              <Field
                label={t().machineAccount}
                hint={words().agentPickerHint}
                error={tried() && !agent() ? words().chooseAgentFirst : undefined}
                required
              >
                {/* k2b-ui gap: Lookup has no single choice; the dialog keeps only the newest pick and cannot lock it while busy. */}
                <Lookup
                  label={t().machineAccount}
                  value={agent() ? [agent()!.value] : []}
                  known={agent() ? [agent()!] : []}
                  load={load}
                  onChange={(values) => {
                    if (locked()) return;
                    const picked = values.find((value) => value !== agent()?.value) ?? values[0];
                    setAgent(picked ? (known.get(picked) ?? null) : null);
                  }}
                />
              </Field>
            </Show>
            <Field name="name" label={t().name} error={nameError()} required>
              {/* k2b-ui gap: Input has no maxLength; the dialog holds the server's limit itself. */}
              <Input
                value={name()}
                disabled={locked()}
                onInput={setName}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing) void create();
                }}
              />
            </Field>
            <Show
              when={props.modelsAvailable}
              fallback={
                <Notice tone="note" icon="sparkles">
                  {t().machineModelsDisabled}
                </Notice>
              }
            >
              <Field
                name="access"
                label={t().keyPurpose}
                hint={access() === "models" ? t().machineModelsDescription : t().fullKeyDescription}
              >
                <Choice
                  name="access"
                  disabled={locked()}
                  value={access()}
                  onChange={(value) => setAccess(value === "models" ? "models" : "full")}
                  options={[
                    { value: "models", label: t().modelsOnlyKey },
                    { value: "full", label: t().fullKeyAccess },
                  ]}
                />
              </Field>
            </Show>
            <Field name="expires" label={t().expires} optional={words().optional} hint={words().expiresHint} error={expiresError()}>
              {/* k2b-ui gap: DateInput has no calendar picker, no time and no disabled state yet. */}
              <DateInput value={expires()} placeholder={words().expiresPlaceholder} onInput={setExpires} />
            </Field>
            <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
          </>
        }
      >
        {(value) => (
          <>
            <Notice tone="warn" icon="key">
              {t().machineKeyOneTime}
            </Notice>
            <Facts
              items={[
                ...(props.account ? [] : [{ label: t().machineAccount, value: agent()?.label ?? "" }]),
                { label: t().name, value: name().trim() },
                { label: words().token, value: value(), copy: value(), mono: true },
                { label: t().keyPurpose, value: access() === "models" ? t().modelsOnlyKey : t().fullKeyAccess },
              ]}
            />
          </>
        )}
      </Show>
    </Dialog>
  );
}
