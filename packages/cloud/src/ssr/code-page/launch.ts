import { type CodePageLinks, codeOwnPath } from "../../contracts/code-routes";
import type { CodePageAutomation, CodePageReady } from "./data";
import type { PageText } from "./page-kit";
import { describeCodeTiming } from "./schedule";

/** Eligibility and titles come from Core's version projection. */
export const opensPage = (automation: CodePageAutomation): boolean => !automation.isNew && !!automation.pageLink;
export const launchPages = (state: CodePageReady) => state.pages?.pages ?? [];

export const runnable = (state: CodePageReady) =>
  state.permission === "editor" && state.code.state === "active" && !!state.active
    ? (state.automations ?? []).filter((item) => !item.isNew && (item.kind === "schedule" || item.kind === "manual"))
    : [];

export const pageTitle = (page: CodePageLinks["pages"][number], text: Pick<PageText, "t">) =>
  page.title ?? (page.isRoot ? text.t().homePage : page.path);

export const routeTitle = (automation: CodePageAutomation, text: Pick<PageText, "t">) =>
  automation.pageLink ? pageTitle(automation.pageLink, text) : (automation.title ?? automation.route!.path);

export const routeHref = (codeId: string, automation: CodePageAutomation) => codeOwnPath(codeId, automation.route!.path);

/** When an automation runs, in words: the read model's sentence, else the schedule, never its stable name. */
export const timing = (automation: CodePageAutomation, text: PageText): string => {
  const t = text.t();
  if (automation.timingText) return automation.timingText;
  const scheduled = describeCodeTiming(automation, text.locale());
  if (scheduled) return scheduled;
  return automation.kind === "event" ? t.triggerEvent : t.manualStart;
};
