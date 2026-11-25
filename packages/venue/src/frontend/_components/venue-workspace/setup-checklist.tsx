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
