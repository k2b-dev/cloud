import { coreClient } from "@k2b/cloud/clients/core";
import { dates } from "@k2b/stdlib";
import { Button, Choice, DateInput, Dialog, Facts, Field, Input, Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { useAccountsMessages } from "../messages";
import { useApiKeyMessages } from "./messages";

/** Longest key name the server takes (`ServiceAccountApiKeyInputSchema`, admin identity API). */
const NAME_MAX = 120;
const CreatedSchema = z.object({ token: z.string().min(1) });

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
 * A new API key for an agent, from its record: a name, its purpose and an optional last day; then the key itself,
 * once, with a copy button. The token lives only in this dialog; closing it shows the record with the key.
 */
export default function MachineKeyDialog(props: {
  /** The agent the key is for. */
  account: { id: string; name: string };
  modelsAvailable: boolean;
  /** The person's time zone: the last day ends at midnight there. */
  timeZone: string;
  /** Close the dialog; `changed` when a key was created or may have been, so the list must be read again. */
  close: (changed: boolean) => void;
}) {
  const t = useAccountsMessages();
  const words = useApiKeyMessages();
  const [name, setName] = createSignal("");
  const [access, setAccess] = createSignal<"full" | "models">(props.modelsAvailable ? "models" : "full");
  const [expires, setExpires] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A lost answer may follow a created key: offer no second creation, the list shows what exists.
  const [uncertain, setUncertain] = createSignal(false);
  const [token, setToken] = createSignal<string | null>(null);

  const nameError = () =>
    tried() && !name().trim()
      ? words().keyNameRequired
      : name().trim().length > NAME_MAX
        ? words().nameTooLong({ max: NAME_MAX })
        : undefined;
  const expiry = () => expiryOf(expires(), props.timeZone);
  const expiresError = () => {
    if (!tried() && !expires().trim()) return undefined;
    const value = expiry();
    return value === undefined || (value !== null && Date.parse(value) <= Date.now()) ? words().expiresInvalid : undefined;
  };

  const create = async () => {
    setTried(true);
    const until = expiry();
    if (busy() || uncertain() || nameError() || expiresError() || until === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"]
        .$post({ param: { id: props.account.id }, json: { name: name().trim(), access: access(), expiresAt: until } })
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
      title={token() ? words().created_ : words().createKeyFor({ name: props.account.name })}
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
