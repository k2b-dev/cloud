import { Button, Checkbox, InlineGuidance, NumberInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { workflowAiAdminMessages } from "../../workflow-ai-admin-messages";

const MIN = 1;
const MAX = 100_000;

/**
 * The body limit of Mail's AI workflow steps on the Mail admin page. A value the server refuses keeps its reason at
 * the field; an unreadable stored value is replaced only after the person confirms it.
 */
export default function MailAdminWorkflowAi(props: { bodyMaxChars: number; unreadable: boolean }) {
  const locale = useLocale();
  const t = createMemo(() => workflowAiAdminMessages.resolve([locale()]).t);
  const [stored, setStored] = createSignal(props.bodyMaxChars);
  const [value, setValue] = createSignal<number | null>(props.bodyMaxChars);
  const [unreadable, setUnreadable] = createSignal(props.unreadable);
  const [replace, setReplace] = createSignal(false);
  const [refused, setRefused] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const invalid = () => {
    const current = value();
    return current === null || !Number.isInteger(current) || current < MIN || current > MAX;
  };
  const dirty = () => value() !== stored() || (unreadable() && replace());
  const locked = () => saving() || (unreadable() && !replace());

  const save = async () => {
    if (saving() || invalid() || !dirty()) return;
    setSaving(true);
    setRefused("");
    const bodyMaxChars = value()!;
    try {
      const response = await apiClient.admin["workflow-ai"].$put({
        json: unreadable() && replace() ? { bodyMaxChars, replaceUnreadable: true } : { bodyMaxChars },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        // An unreadable stored value answers 409 from the platform's settings store, outside the route's own answers.
        const status: number = response.status;
        if (status === 409) setUnreadable(true);
        setRefused(status === 400 && body?.message ? body.message : t().saveFailed);
        return;
      }
      setStored(bodyMaxChars);
      setUnreadable(false);
      setReplace(false);
      toast.success(t().saved);
    } catch {
      setRefused(t().saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="paper flex flex-col gap-3 px-3 py-3" aria-label={t().label}>
      <Show when={unreadable()}>
        <InlineGuidance tone="warning" icon="ti ti-eye-off">
          <b>{t().unreadableTitle}</b> {t().unreadableKeep({ value: String(stored()) })}
          <Checkbox label={t().replaceStored} value={replace()} onValueChange={setReplace} disabled={saving()} />
        </InlineGuidance>
      </Show>
      <form
        class="flex max-w-2xl flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <NumberInput
          class="w-full"
          label={t().label}
          description={t().description}
          min={MIN}
          max={MAX}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            setRefused("");
          }}
          error={() => (invalid() ? t().outOfRange : refused() || undefined)}
          disabled={locked()}
          required
        />
        <Button type="submit" variant="secondary" size="sm" loading={saving()} disabled={saving() || invalid() || !dirty()}>
          {t().save}
        </Button>
      </form>
    </section>
  );
}
