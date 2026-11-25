import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import type { DateContext } from "@k2b/stdlib";
import { DateTimePicker } from "@k2b/ui";
import { Button, Dialog, Field, Notice } from "@k2b/ui/v2";
import { createEffect, createSignal, Show } from "solid-js";
import { maintenanceApi, refusedField } from "./client";
import { maintenanceAdminMessages } from "./messages";
import { defaultEnd, isFutureEnd, todayKey } from "./time";

/**
 * Asks for the new end and saves it. The dialog stays open while saving and keeps a failure inside it, with the
 * previous end unchanged; `onClose` gets the saved state, or `undefined` when the admin cancels.
 */
export default function MoveEndDialog(props: {
  open: boolean;
  current: string | undefined;
  dateConfig: DateContext & { timeZone: string; locale: string };
  onClose: (saved?: MaintenanceStatus) => void;
}) {
  const t = () => maintenanceAdminMessages.resolve([props.dateConfig.locale]).t;
  const start = () => (props.current && isFutureEnd(props.current) ? props.current : defaultEnd());
  const [value, setValue] = createSignal<string | null>(start());
  const [error, setError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  // Each opening starts from the current end, or a suggestion when it has passed.
  createEffect(() => {
    if (!props.open) return;
    setValue(start());
    setError(undefined);
    setFailed(false);
  });
  const save = async () => {
    const end = value();
    if (!end || !isFutureEnd(end)) return void setError(t().timePassed);
    setSaving(true);
    setFailed(false);
    try {
      props.onClose(await maintenanceApi.until(end));
    } catch (failure) {
      // The server refused the time itself (its clock is ahead of this browser's): say so at the field.
      if (refusedField(failure) === "until") setError(t().timePassed);
      else setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t().moveEndTitle}
      open={props.open}
      dismissible={!saving()}
      onOpenChange={(open) => {
        if (!open && !saving()) props.onClose(undefined);
      }}
      foot={
        <>
          <Button disabled={saving()} onClick={() => props.onClose(undefined)}>
            {t().cancel}
          </Button>
          <Button variant="primary" busy={saving()} disabled={!value()} onClick={() => void save()}>
            {t().moveEndSave}
          </Button>
        </>
      }
    >
      <Field name="until" label={t().newEnd} error={error()}>
        {/* k2b-ui gap: no date and time picker in v2; the v1 picker stands in, with the time zone it names. */}
        <DateTimePicker
          aria-label={t().newEnd}
          value={value}
          dateConfig={props.dateConfig}
          min={todayKey(props.dateConfig.timeZone)}
          disabled={saving()}
          onValueChange={(next) => {
            setValue(next);
            setError(next && !isFutureEnd(next) ? t().timePassed : undefined);
          }}
        />
      </Field>
      <Show when={failed()}>
        <Notice tone="bad">{t().moveEndFailed}</Notice>
      </Show>
    </Dialog>
  );
}
