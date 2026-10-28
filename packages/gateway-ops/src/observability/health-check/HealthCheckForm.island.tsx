import { InlineGuidance, TextInput, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { apiClient } from "../../api/client";
import { responseErrorMessage } from "../../frontend/health-webhook-queries";
import { areaMessages } from "../_components/area-messages";
import { createDraftForm, SaveRejected } from "../_components/draft-form";
import { SaveOutcome } from "../_components/SaveOutcome";

type Props = { schedule: string; unreadable: boolean };

/** The health check schedule. It saves with the button in the level head. */
export default function HealthCheckForm(props: Props) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  let replaceUnreadable = props.unreadable;
  const form = createDraftForm({
    initial: { schedule: props.schedule },
    locale,
    validate: (value): Record<string, string> => (value.schedule.trim() ? {} : { schedule: t().scheduleRequired }),
    save: async (value) => {
      const schedule = value.schedule.trim();
      const response = await apiClient.settings[":key{.+}"].$put({
        param: { key: "gateway.health_check_schedule" },
        // The form shows the unreadable warning, so the first save is an explicit replacement.
        json: replaceUnreadable ? { value: schedule, replaceUnreadable: true } : { value: schedule },
      });
      if (!response.ok) throw new SaveRejected(await responseErrorMessage(response, t().notSaved));
      replaceUnreadable = false;
      return { schedule };
    },
  });
  return (
    <div class="flex max-w-2xl flex-col gap-4 px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">
      <SaveOutcome t={t()} outcome={form.outcome()} onRetry={() => void form.save()} />
      <Show when={props.unreadable}>
        <InlineGuidance tone="warning" icon="ti ti-eye-off">
          <b>{t().unreadableValue}</b> {t().unreadableKeep({ value: props.schedule })}
        </InlineGuidance>
      </Show>
      <TextInput
        label={t().checkSchedule}
        description={t().checkScheduleHelp}
        icon="ti ti-calendar-time"
        value={() => form.draft().schedule}
        onValueChange={(schedule) => form.update({ schedule })}
        error={() => form.errors().schedule}
        disabled={form.saving()}
        required
      />
    </div>
  );
}
