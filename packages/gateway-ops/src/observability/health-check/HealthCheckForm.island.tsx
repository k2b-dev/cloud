import { Checkbox, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { responseErrorMessage } from "../../frontend/health-webhook-queries";
import { gatewayOpsMessages } from "../../messages";
import { areaMessages } from "../_components/area-messages";
import { createDraftForm, saveFailure } from "../_components/draft-form";
import { SaveOutcome } from "../_components/SaveOutcome";

type Props = { schedule: string; unreadable: boolean };

/**
 * The health check schedule. It saves with the button in the level head. An unreadable stored schedule is replaced
 * only after the person confirms it; the displayed fallback can then be saved as it is.
 */
export default function HealthCheckForm(props: Props) {
  const locale = useLocale();
  const t = () => areaMessages.resolve([locale()]).t;
  const g = () => gatewayOpsMessages.resolve([locale()]).t;
  const [unreadable, setUnreadable] = createSignal(props.unreadable);
  const [replace, setReplace] = createSignal(false);
  const confirmed = () => unreadable() && replace();
  const form = createDraftForm({
    initial: { schedule: props.schedule },
    locale,
    validate: (value): Record<string, string> => (value.schedule.trim() ? {} : { schedule: t().scheduleRequired }),
    pending: confirmed,
    save: async (value) => {
      const schedule = value.schedule.trim();
      const response = await apiClient.settings[":key{.+}"].$put({
        param: { key: "gateway.health_check_schedule" },
        json: confirmed() ? { value: schedule, replaceUnreadable: true } : { value: schedule },
      });
      if (!response.ok) throw saveFailure(response.status, await responseErrorMessage(response, t().notSaved));
      setUnreadable(false);
      setReplace(false);
      return { schedule };
    },
  });
  return (
    <div class="flex max-w-2xl flex-col gap-4 px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">
      <SaveOutcome t={t()} outcome={form.outcome()} onRetry={() => void form.save()} />
      <Show when={unreadable()}>
        <NoticeCard tone="warning" title={g().unreadableTitle} detail={t().unreadableKeep({ value: props.schedule })}>
          <Checkbox
            label={`${g().replaceStored}: ${t().checkSchedule}`}
            value={replace()}
            onValueChange={setReplace}
            disabled={form.saving()}
          />
        </NoticeCard>
      </Show>
      <TextInput
        label={t().checkSchedule}
        description={t().checkScheduleHelp}
        icon="ti ti-calendar-time"
        value={() => form.draft().schedule}
        onValueChange={(schedule) => form.update({ schedule })}
        error={() => form.errors().schedule}
        disabled={form.saving() || (unreadable() && !replace())}
        required
      />
    </div>
  );
}
