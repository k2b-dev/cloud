import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import { type DateContext, dates } from "@k2b/stdlib";
import { Button, DatePicker, Dialog, Field, Notice } from "@k2b/ui/v2";
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
  /** The end as the picker shows it: the wall time in the named zone. */
  const wallValue = () => {
    const end = value();
    return end ? dates.instantToZonedInput(end, props.dateConfig.timeZone) : undefined;
  };
  const save = async () => {
    const end = value();
    // a refused pick keeps its message and saves nothing, not even the end shown before it
    if (error()) return;
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
          <Button variant="primary" busy={saving()} disabled={!value() || !!error()} onClick={() => void save()}>
            {t().moveEndSave}
          </Button>
        </>
      }
    >
      <Field name="until" label={t().newEnd} hint={t().timeIn({ zone: props.dateConfig.timeZone })} error={error()}>
        {/* k2b-ui gap: DatePicker has no `disabled`; while the end saves, the dialog's buttons wait and a pick only changes
            the value the next save would send. */}
        <DatePicker
          time
          label={t().newEnd}
          value={wallValue()}
          min={todayKey(props.dateConfig.timeZone)}
          timeZone={props.dateConfig.timeZone}
          onPick={(wall) => {
            // a wall time the clock change skips or repeats is refused, never moved to a neighbouring hour
            let next: string;
            try {
              next = dates.zonedDateTimeToInstant(wall, props.dateConfig.timeZone);
            } catch {
              return void setError(t().timeUnclear);
            }
            setValue(next);
            setError(isFutureEnd(next) ? undefined : t().timePassed);
          }}
        />
      </Field>
      <Show when={failed()}>
        <Notice tone="bad">{t().moveEndFailed}</Notice>
      </Show>
    </Dialog>
  );
}
