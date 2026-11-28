import type { MailRetention } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import { Button, Check, Dialog, Field, Input, Notice } from "@k2b/ui/v2";
import { createEffect, createSignal, For, Show } from "solid-js";
import { outgoingMailMessages } from "./messages";
import { api } from "./shared";

const KEYS = ["outgoing_mail.content_retention_days", "outgoing_mail.record_retention_days"] as const;
const days = (value: string) => {
  const parsed = Number(value);
  return value.trim() && Number.isInteger(parsed) ? parsed : null;
};

/**
 * How long the send log keeps mail text and records, as a v2 dialog. An unreadable stored value is replaced only when
 * the person ticks it; a save that meets one keeps the draft and reads which values are unreadable now.
 */
export default function RetentionDialog(props: {
  open: boolean;
  retention: MailRetention;
  onClose: () => void;
  onSaved: (value: MailRetention) => void;
}) {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  const [contentDays, setContentDays] = createSignal<number | null>(props.retention.contentDays);
  const [recordDays, setRecordDays] = createSignal<number | null>(props.retention.recordDays);
  const [unreadable, setUnreadable] = createSignal(props.retention.unreadable);
  const [replace, setReplace] = createSignal<string[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Each opening starts from what is stored.
  createEffect(() => {
    if (!props.open) return;
    setContentDays(props.retention.contentDays);
    setRecordDays(props.retention.recordDays);
    setUnreadable(props.retention.unreadable);
    setReplace([]);
    setError(null);
  });
  const locked = (key: (typeof KEYS)[number]) => unreadable()?.[key] === true && !replace().includes(key);
  const order = () => !!contentDays() && !!recordDays() && recordDays()! < contentDays()!;
  const valid = () => !!contentDays() && !!recordDays() && !order();
  const message = async (response: { json(): Promise<unknown> }, fallback: string) => {
    const body = await response.json().catch(() => null);
    return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
  };
  const save = async () => {
    if (!valid() || saving()) return;
    setSaving(true);
    setError(null);
    try {
      const changed = (key: (typeof KEYS)[number], value: number | null, stored: number) =>
        !locked(key) && (value !== stored || replace().includes(key));
      const json = {
        ...(changed(KEYS[0], contentDays(), props.retention.contentDays) ? { contentDays: contentDays()! } : {}),
        ...(changed(KEYS[1], recordDays(), props.retention.recordDays) ? { recordDays: recordDays()! } : {}),
        replaceUnreadable: KEYS.filter((key) => replace().includes(key)),
      };
      const response = await api.retention.$put({ json });
      if (!response.ok) {
        const failure = await message(response.clone(), t().retentionFailed);
        const body: unknown = await response.json().catch(() => null);
        if (body && typeof body === "object" && "code" in body && body.code === "setting_unreadable") {
          const latest = await api.retention.$get({}).catch(() => null);
          if (!latest?.ok) throw new Error(`${failure} ${t().recoveryFailed}`);
          setUnreadable((await latest.json()).unreadable);
        }
        throw new Error(failure);
      }
      props.onSaved(await response.json());
      props.onClose();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : t().retentionFailed);
    } finally {
      setSaving(false);
    }
  };
  const label = (key: (typeof KEYS)[number]) => (key === KEYS[0] ? t().retentionContent : t().retentionRecords);
  return (
    <Dialog
      title={t().retentionTitle}
      open={props.open}
      dismissible={!saving()}
      onOpenChange={(open) => {
        if (!open && !saving()) props.onClose();
      }}
      foot={
        <>
          <Button disabled={saving()} onClick={props.onClose}>
            {t().cancel}
          </Button>
          <Button variant="primary" busy={saving()} disabled={!valid()} onClick={() => void save()}>
            {t().save}
          </Button>
        </>
      }
    >
      <Show when={KEYS.some((key) => unreadable()?.[key])}>
        <Notice tone="warn" icon="eye-off" title={t().unreadableTitle}>
          {t().unreadableDetail}
        </Notice>
        <For each={KEYS.filter((key) => unreadable()?.[key])}>
          {(key) => (
            <Check
              label={`${t().replaceStored}: ${label(key)}`}
              checked={replace().includes(key)}
              disabled={saving()}
              onChange={(checked) => setReplace((keys) => (checked ? [...keys, key] : keys.filter((entry) => entry !== key)))}
            />
          )}
        </For>
      </Show>
      <Field name="contentDays" label={t().retentionContent} hint={t().retentionContentHint} required>
        <Input
          type="number"
          min={1}
          max={36500}
          value={contentDays() === null ? "" : String(contentDays())}
          disabled={saving() || locked(KEYS[0])}
          onInput={(value) => setContentDays(days(value))}
        />
      </Field>
      <Field
        name="recordDays"
        label={t().retentionRecords}
        hint={t().retentionRecordsHint}
        error={order() ? t().retentionOrder : undefined}
        required
      >
        <Input
          type="number"
          min={1}
          max={36500}
          value={recordDays() === null ? "" : String(recordDays())}
          disabled={saving() || locked(KEYS[1])}
          onInput={(value) => setRecordDays(days(value))}
        />
      </Field>
      <Show when={error()}>
        {(text) => (
          <Notice tone="bad" title={t().retentionFailed}>
            {text()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
