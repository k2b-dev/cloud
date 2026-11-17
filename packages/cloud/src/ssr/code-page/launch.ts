import { codeOwnPath, codePageLinks, isCodePageRoute } from "../../contracts/code-routes";
import type { CodePageAutomation, CodePageReady } from "./data";
import type { CodePageMessages } from "./messages";
import type { PageText } from "./page-kit";
import { describeCodeTiming } from "./schedule";

/** Older checked versions have no page flag; their literal GET/ALL routes keep their existing open path. */
export const opensPage = (automation: CodePageAutomation): boolean =>
  automation.kind === "route" && !automation.isNew && isCodePageRoute(automation.route);

/** Declaration order is kept; the root page, when present, is the home page. */
export const launchPages = (state: CodePageReady) =>
  codePageLinks(
    state.code.id,
    (state.automations ?? []).filter((entry) => !entry.isNew),
  ).map((page) => page.entry);

export const runnable = (state: CodePageReady) =>
  state.permission === "editor" && state.code.state === "active" && !!state.active
    ? (state.automations ?? []).filter((item) => !item.isNew && (item.kind === "schedule" || item.kind === "manual"))
    : [];

export const routeTitle = (automation: CodePageAutomation, t: CodePageMessages) =>
  automation.title ?? (automation.route?.path === "/" && isCodePageRoute(automation.route) ? t.homePage : automation.route!.path);

export const routeHref = (codeId: string, automation: CodePageAutomation) => codeOwnPath(codeId, automation.route!.path);

/** When an automation runs, in words: the read model's sentence, else the schedule, never its stable name. */
export const timing = (automation: CodePageAutomation, text: PageText): string => {
  const t = text.t();
  if (automation.timingText) return automation.timingText;
  const scheduled = describeCodeTiming(automation, text.locale());
  if (scheduled) return scheduled;
  return automation.kind === "event" ? t.triggerEvent : t.manualStart;
};
