import type { AccessEntry } from "@k2b/cloud/contracts";
import { Button, Placeholder, useLocale } from "@k2b/ui";
import { createUniqueId, For, Show } from "solid-js";
import type { VenueDashboard } from "../../../contracts";
import { venueMessages } from "../../../messages";
import type { VenueSettingsTab } from "./settings";

type SetupStep = { id: "hours" | "shifts" | "team"; done: boolean; tab: VenueSettingsTab };

/** No active shift plans slots and nobody signed up in the loaded window: the schedule has nothing to show. */
export const scheduleIsEmpty = (dashboard: Pick<VenueDashboard, "templates" | "slots" | "otherAssignments">): boolean =>
  !dashboard.templates.some((template) => template.active) && dashboard.slots.length === 0 && dashboard.otherAssignments.length === 0;

/**
 * The steps that make a new venue usable, read from what exists; nothing stores progress. Shifts count as a step
 * only when they open the venue, and the team step needs anyone besides the viewer: a person, a group, or everyone.
 */
export const setupSteps = (
  dashboard: Pick<VenueDashboard, "venue" | "openingRules" | "templates">,
  accessEntries: readonly AccessEntry[],
  userId: string,
): SetupStep[] => {
  const hasShifts = dashboard.templates.length > 0;
  const shared = accessEntries.some(({ principal }) =>
    principal.type === "user" ? principal.userId !== userId : principal.type !== "service_account",
  );
  return [
    { id: "hours", done: dashboard.openingRules.length > 0 || hasShifts, tab: "schedule" },
    ...(dashboard.venue.openMode === "regular" ? [] : [{ id: "shifts" as const, done: hasShifts, tab: "schedule" as const }]),
    { id: "team", done: shared, tab: "access" },
  ];
};

/**
 * What an empty schedule says: admins get the setup steps with a way into the right settings until every step is
 * done; everyone else, and admins after that, read that no shifts are planned yet.
 */
export function ScheduleEmptyState(props: {
  dashboard: VenueDashboard;
  accessEntries: readonly AccessEntry[];
  userId: string;
  onOpenSettings: (tab: VenueSettingsTab) => void;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const headingId = `venue-setup-${createUniqueId()}`;
  const steps = () => setupSteps(props.dashboard, props.accessEntries, props.userId);
  const copy = (id: SetupStep["id"]) =>
    id === "hours"
      ? { title: t().setupHours, detail: t().setupHoursDetail, action: t().setupHoursAction }
      : id === "shifts"
        ? { title: t().setupShifts, detail: t().setupShiftsDetail, action: t().setupShiftsAction }
        : { title: t().setupTeam, detail: t().setupTeamDetail, action: t().setupTeamAction };
  const showChecklist = () => props.dashboard.venue.permission === "admin" && steps().some((step) => !step.done);

  return (
    <Show
      when={showChecklist()}
      fallback={<Placeholder variant="compact" align="left" icon="ti ti-calendar-off" description={<>{t().noShiftsPlanned}</>} />}
    >
      <section class="paper grid gap-3 p-4" aria-labelledby={headingId} data-setup-checklist="">
        <div class="min-w-0">
          <h2 id={headingId} class="text-sm font-semibold text-primary">
            {t().setupTitle}
          </h2>
          <p class="text-xs text-dimmed">{t().setupDescription}</p>
        </div>
        <ol class="grid gap-2">
          <For each={steps()}>
            {(step) => (
              <li
                class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                data-setup-step={step.id}
                data-done={step.done}
              >
                <div class="flex min-w-0 items-start gap-2">
                  <i
                    class={
                      step.done
                        ? "ti ti-circle-check mt-0.5 text-emerald-600 dark:text-emerald-400"
                        : "ti ti-circle-dashed mt-0.5 text-dimmed"
                    }
                    aria-hidden="true"
                  />
                  <div class="min-w-0">
                    <p class={`text-sm font-medium ${step.done ? "text-dimmed line-through" : "text-primary"}`}>
                      {copy(step.id).title}
                      <span class="sr-only"> · {step.done ? t().setupDone : t().setupOpen}</span>
                    </p>
                    <p class="text-xs text-dimmed">{copy(step.id).detail}</p>
                  </div>
                </div>
                <Show when={!step.done}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    class="self-start sm:self-auto"
                    onClick={() => props.onOpenSettings(step.tab)}
                  >
                    {copy(step.id).action}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </section>
    </Show>
  );
}
