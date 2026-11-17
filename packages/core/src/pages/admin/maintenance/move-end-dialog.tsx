import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import type { DateContext } from "@k2b/stdlib";
import { Button, DateTimePicker, dialogCore, NoticeCard, PanelDialog, panelDialogOptions } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { maintenanceApi, refusedField } from "./client";
import { maintenanceAdminMessages } from "./messages";
import { defaultEnd, isFutureEnd, todayKey } from "./time";

/**
 * Asks for the new end and saves it. The dialog stays open while saving and keeps a failure inside it, with the
 * previous end unchanged; it resolves with the saved state, or `undefined` when the admin cancels.
 */
export const openMoveEndDialog = (current: string | undefined, dateConfig: DateContext & { timeZone: string; locale: string }) =>
  dialogCore.open<MaintenanceStatus | undefined>(
    (close, context) => {
      const t = maintenanceAdminMessages.resolve([dateConfig.locale]).t;
      const [value, setValue] = createSignal<string | null>(current && isFutureEnd(current) ? current : defaultEnd());
      const [error, setError] = createSignal<string>();
      const [saving, setSaving] = createSignal(false);
      const [failed, setFailed] = createSignal(false);
      context.setDismissHandler(() => {
        if (!saving()) close(undefined);
      });
      const save = async () => {
        const end = value();
        if (!end || !isFutureEnd(end)) {
          setError(t.timePassed);
          return;
        }
        setSaving(true);
        setFailed(false);
        try {
          close(await maintenanceApi.until(end));
        } catch (error) {
          // The server refused the time itself (its clock is ahead of this browser's): say so at the field.
          if (refusedField(error) === "until") setError(t.timePassed);
          else setFailed(true);
          setSaving(false);
        }
      };
      return (
        <PanelDialog>
          <div class="contents" data-move-end-dialog>
            <PanelDialog.Header title={t.moveEndTitle} icon="ti ti-clock" close={() => close(undefined)} closeDisabled={saving()} />
            <PanelDialog.Body>
              <div class="flex flex-col gap-3">
                <DateTimePicker
                  label={t.newEnd}
                  value={value}
                  dateConfig={dateConfig}
                  min={todayKey(dateConfig.timeZone)}
                  error={error}
                  disabled={saving()}
                  onValueChange={(next) => {
                    setValue(next);
                    setError(next && !isFutureEnd(next) ? t.timePassed : undefined);
                  }}
                />
                <Show when={failed()}>
                  <NoticeCard tone="danger" icon="ti ti-alert-circle" role="alert">
                    {t.moveEndFailed}
                  </NoticeCard>
                </Show>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Button variant="secondary" disabled={saving()} onClick={() => close(undefined)}>
                {t.cancel}
              </Button>
              <Button variant="primary" loading={saving()} disabled={!value()} onClick={() => void save()}>
                {t.moveEndSave}
              </Button>
            </PanelDialog.Footer>
          </div>
        </PanelDialog>
      );
    },
    { ...panelDialogOptions, ariaLabel: maintenanceAdminMessages.resolve([dateConfig.locale]).t.moveEndTitle },
  );
