import { describeCodeSchedule, describeCodeTiming } from "@k2b/cloud/ssr/code-schedule";
import type { CodeAutomation } from "../code-summary";
import { assistantMessages } from "./messages";

// Its own module: the chat's Code block needs only this sentence, so "My apps"' loader and read-model schemas stay out
// of the workspace's first download (the island budget in scripts/checks/island-bundles.ts).

/**
 * When an automation runs, as a sentence that can stand alone: "Mondays at 07:00", "On an event". A schedule Cloud cannot
 * put into words says only that a schedule starts it, never the expression itself.
 */
export const automationTiming = (automation: Pick<CodeAutomation, "kind" | "cron" | "at" | "timeZone">, locale: string): string => {
  const t = assistantMessages.resolve([locale]).t;
  if (automation.kind === "event") return t.appsOnEvent;
  if (automation.kind === "manual") return t.appsByHand;
  if (automation.kind === "route") return t.appsAsPage;
  if (!automation.at && (!automation.cron || describeCodeSchedule(automation.cron, locale) === automation.cron)) return t.appsOnSchedule;
  const text = describeCodeTiming(automation, locale) ?? t.appsOnSchedule;
  const timed = /^(.*\S) (\d{2}:\d{2})$/.exec(text);
  const sentence = timed ? t.appsScheduleAt({ when: timed[1]!, time: timed[2]! }) : text;
  return sentence.charAt(0).toLocaleUpperCase(locale) + sentence.slice(1);
};
